-- =========================================================================
-- Fr. Pimen Calendar — v14: audit security fixes
-- NOT applied automatically. Review, then run once in the Supabase SQL editor.
-- Idempotent. Run AFTER all earlier *.sql files (and do not re-run
-- rls-hardening.sql afterwards: it recreates the old auth.users-based policies).
-- =========================================================================

-- -------------------------------------------------------------------------
-- 1. time_blocks: drop world-readable policy.
--    The public booking page reads blocks with the service role, so anon
--    access is not needed (and exposed every user's `reason` text).
-- -------------------------------------------------------------------------
drop policy if exists "blocks_public_read" on public.time_blocks;

-- -------------------------------------------------------------------------
-- 2. events: new columns used by booking + recurring-event exceptions
-- -------------------------------------------------------------------------
alter table public.events add column if not exists source  text;
alter table public.events add column if not exists exdates timestamptz[] not null default '{}';
create index if not exists events_source_idx on public.events(owner_id, source) where source is not null;

-- -------------------------------------------------------------------------
-- 3. Double-booking guard: no two public bookings for one owner may overlap.
--    Partial constraint so normal (manual / synced) events can still overlap.
--    A concurrent insert fails with SQLSTATE 23P01, handled in bookSlot().
-- -------------------------------------------------------------------------
create extension if not exists btree_gist;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'events_no_double_booking') then
    alter table public.events
      add constraint events_no_double_booking
      exclude using gist (
        owner_id with =,
        tstzrange(starts_at, ends_at, '[)') with &&
      ) where (source = 'booking');
  end if;
end $$;

-- -------------------------------------------------------------------------
-- 4. Share access levels + confidential enforced in the database.
--    Share recipients no longer SELECT public.events directly (that gave them
--    every column of every event). They call shared_events(), which returns
--    rows already reduced to what their share allows:
--      see_busy              -> time only (title "Busy", no location/description)
--      see_titles            -> title + time
--      see_details / edit    -> everything
--    visibility = 'private' is always reduced to busy; 'confidential' is
--    reduced to busy unless the share has can_see_confidential.
-- -------------------------------------------------------------------------
drop policy if exists "events_shared_read" on public.events;

create or replace function public.shared_events()
returns setof public.events
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_populate_record(
    null::public.events,
    case
      when lvl >= 2 then to_jsonb(e)
      when lvl = 1  then to_jsonb(e) || jsonb_build_object('description', null, 'location', null, 'google_event_id', null)
      else               to_jsonb(e) || jsonb_build_object('title', 'Busy', 'description', null, 'location', null,
                                                           'meeting_type_id', null, 'google_event_id', null)
    end
  )
  from (
    select e.*,
      case
        when e.visibility = 'private' then 0
        when e.visibility = 'confidential' and not coalesce(cs.can_see_confidential, false) then 0
        when cs.access_level in ('see_details', 'edit') then 2
        when cs.access_level = 'see_titles' then 1
        else 0
      end as lvl
    from public.events e
    join public.calendar_shares cs
      on cs.owner_id = e.owner_id
     and lower(cs.shared_with_email) = lower(auth.jwt() ->> 'email')
     and cs.revoked_at is null
    where e.owner_id <> auth.uid()
  ) e;
$$;

revoke all on function public.shared_events() from public, anon;
grant execute on function public.shared_events() to authenticated;

-- jwt()-based policies (replace the auth.users subquery versions in rls-hardening.sql)
drop policy if exists "shares_recipient_read" on public.calendar_shares;
create policy "shares_recipient_read" on public.calendar_shares
  for select using (lower(shared_with_email) = lower(auth.jwt() ->> 'email'));

drop policy if exists "attendees_self_read" on public.event_attendees;
create policy "attendees_self_read" on public.event_attendees
  for select using (lower(email) = lower(auth.jwt() ->> 'email'));

-- -------------------------------------------------------------------------
-- 5. event_attendees: an attendee may only change their RSVP, not the row's
--    identity/contact columns. Event owners keep full access.
-- -------------------------------------------------------------------------
drop policy if exists "attendees_self_update" on public.event_attendees;
create policy "attendees_self_update" on public.event_attendees
  for update using (lower(email) = lower(auth.jwt() ->> 'email'))
  with check (lower(email) = lower(auth.jwt() ->> 'email'));

create or replace function public.attendee_update_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- service role / server-side jobs have no end-user JWT
  if auth.uid() is null then return new; end if;
  -- the event owner may edit anything
  if exists (select 1 from public.events e where e.id = old.event_id and e.owner_id = auth.uid()) then
    return new;
  end if;
  if new.id         is distinct from old.id
  or new.event_id   is distinct from old.event_id
  or new.email      is distinct from old.email
  or new.name       is distinct from old.name
  or new.phone      is distinct from old.phone
  or new.notes      is distinct from old.notes
  or new.canceled_at is distinct from old.canceled_at then
    raise exception 'attendees may only update their RSVP';
  end if;
  return new;
end;
$$;

drop trigger if exists attendee_update_guard on public.event_attendees;
create trigger attendee_update_guard
  before update on public.event_attendees
  for each row execute function public.attendee_update_guard();
