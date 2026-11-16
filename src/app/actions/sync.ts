'use server'

import { createClient } from '@/lib/supabase/server'
import { revalidatePath } from 'next/cache'
import { DateTime } from 'luxon'
import { refreshGoogleToken, listGoogleEvents } from '@/lib/google/calendar'

export async function syncGoogleCalendar() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { error: 'Not logged in' }

  const { data: profile } = await supabase
    .from('profiles')
    .select('google_refresh_token')
    .eq('id', user.id)
    .single()

  if (!profile?.google_refresh_token) {
    return { error: 'Google not connected. Sign out and sign in again to authorize calendar access.' }
  }

  let access_token: string
  let expires_in: number
  try {
    const res = await refreshGoogleToken(profile.google_refresh_token)
    access_token = res.access_token
    expires_in = res.expires_in
  } catch (e: any) {
    return { error: `Token refresh failed. Sign out + sign in again. (${e.message})` }
  }

  await supabase
    .from('profiles')
    .update({
      google_access_token: access_token,
      google_token_expires_at: new Date(Date.now() + (expires_in - 60) * 1000).toISOString(),
    })
    .eq('id', user.id)

  const now = new Date()
  const timeMin = new Date(now.getFullYear(), now.getMonth() - 3, 1).toISOString()
  const timeMax = new Date(now.getFullYear(), now.getMonth() + 6, 0).toISOString()

  let events
  try {
    events = await listGoogleEvents(access_token, timeMin, timeMax)
  } catch (e: any) {
    return { error: e.message }
  }

  const { data: defaultType } = await supabase
    .from('meeting_types')
    .select('id')
    .eq('owner_id', user.id)
    .eq('name', 'Other')
    .single()

  // All-day events come as plain dates: anchor them to local midnight, not UTC midnight
  const toUtc = (dt?: string, d?: string) =>
    dt ?? (d ? DateTime.fromISO(d, { zone: 'America/Chicago' }).toUTC().toISO() : null)

  const usable = events.filter((ev) => ev.start && ev.end)
  const cancelledIds = usable.filter((ev) => ev.status === 'cancelled').map((ev) => ev.id)
  const rows = usable
    .filter((ev) => ev.status !== 'cancelled')
    .map((ev) => ({
      owner_id: user.id,
      google_event_id: ev.id,
      title: ev.summary ?? 'Untitled',
      description: ev.description ?? null,
      location: ev.location ?? null,
      starts_at: toUtc(ev.start.dateTime, ev.start.date),
      ends_at: toUtc(ev.end.dateTime, ev.end.date),
      all_day: !ev.start.dateTime,
      meeting_type_id: defaultType?.id ?? null,
      busy_level: ev.transparency === 'transparent' ? 'free' : 'busy',
      visibility: ev.visibility === 'private' ? 'private' : 'default',
      status: 'confirmed',
    }))

  if (rows.length > 0) {
    const { error } = await supabase
      .from('events')
      .upsert(rows, { onConflict: 'google_event_id' })
    if (error) return { error: error.message }
  }

  // Remove local copies of events that were deleted/cancelled in Google.
  // Only touches Google-synced rows (google_event_id not null) inside the synced window,
  // and only after a complete listing (listGoogleEvents throws on partial results).
  const liveIds = new Set(rows.map((r) => r.google_event_id))
  const { data: local } = await supabase
    .from('events')
    .select('id, google_event_id')
    .eq('owner_id', user.id)
    .not('google_event_id', 'is', null)
    .gte('starts_at', timeMin)
    .lte('starts_at', timeMax)
  const staleIds = (local ?? [])
    .filter((l: any) => !liveIds.has(l.google_event_id) || cancelledIds.includes(l.google_event_id))
    .map((l: any) => l.id)
  if (staleIds.length > 0) {
    await supabase.from('events').delete().eq('owner_id', user.id).in('id', staleIds)
  }

  revalidatePath('/')
  return { success: true, count: rows.length }
}