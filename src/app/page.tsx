import { DateTime } from 'luxon'
import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { CalendarPage } from '@/components/calendar-page'
import type { CalendarEvent } from '@/components/calendar-view'
import { AppSidebar } from '@/components/app-sidebar'
import { LiturgicalBanner } from '@/components/liturgical-banner'
import { SyncButton } from '@/components/sync-button'
import { RRule } from 'rrule'
import { splitLegacyRrule } from '@/lib/recurrence'

const TZ = 'America/Chicago'

export default async function HomePage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const [profileResp, eventsResp, sharedResp, typesResp] = await Promise.all([
    supabase.from('profiles').select('*').eq('id', user.id).single(),
    supabase.from('events').select('*, meeting_types(id, name, color)').eq('owner_id', user.id).order('starts_at'),
    // Events other people shared with me, already reduced by the DB to what each share allows
    supabase.rpc('shared_events'),
    supabase.from('meeting_types').select('*').eq('owner_id', user.id).order('name'),
  ])

  const profile = profileResp.data
  const rawEvents = [...(eventsResp.data ?? []), ...((sharedResp.data as any[]) ?? [])]
  const meetingTypes = typesResp.data ?? []

  const seen = new Set<string>()
  const calendarEvents: CalendarEvent[] = (rawEvents as any[]).filter((e: any) => {
    // Dedup on title + start to catch Google sync duplicates with different ids
    const key = `${(e.title ?? '').trim().toLowerCase()}|${e.starts_at}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).map((e: any) => ({
    id: e.id,
    title: e.visibility === 'confidential' && e.owner_id !== user.id ? 'Busy' : e.title,
    allDay: e.all_day,
    // When recurring, ONLY pass rrule (omit start/end) so FullCalendar doesn't render both master + instance
    ...(e.rrule
      ? { ...buildRecurring(e), duration: msDiff(e.starts_at, e.ends_at) }
      : { start: ensureUtc(e.starts_at), end: ensureUtc(e.ends_at) }),
    backgroundColor: e.meeting_types?.color ?? colorFromId(e.id),
    borderColor: e.meeting_types?.color ?? colorFromId(e.id),
    extendedProps: {
      busy_level: e.busy_level,
      visibility: e.visibility,
      meeting_type: e.meeting_types?.name,
      location: e.location,
      description: e.description,
    },
  }))

  // Today's count for hero
  const todayStr = DateTime.now().setZone(TZ).toFormat('yyyy-LL-dd')
  const todayCount = calendarEvents.filter(e => {
    const startStr = e.start ?? e.rrule?.dtstart
    if (!startStr) return false
    const d = DateTime.fromISO(startStr, { setZone: true }).setZone(TZ).toFormat('yyyy-LL-dd')
    return d === todayStr
  }).length

  const firstName = profile?.full_name?.split(' ')[0] ?? 'Father'

  return (
    <div className="min-h-screen bg-neutral-50">
      <AppSidebar userName={profile?.full_name ?? user.email ?? ''} userEmail={user.email ?? ''} />

      <div className="lg:pl-64 transition-[padding] duration-200">
        <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">
          <LiturgicalBanner />
          <div className="flex justify-end"><SyncButton /></div>
          {/* Hero card — design-7 inspired, colorful */}
          <div className="rounded-3xl p-6 sm:p-8 relative overflow-hidden border border-neutral-200/80 shadow-sm bg-white">
            <div className="absolute inset-0 -z-0 opacity-90"
                 style={{ background: 'linear-gradient(120deg, #fef3c7 0%, #fce7f3 30%, #ddd6fe 60%, #d1fae5 100%)' }} />
            <div className="absolute -right-20 -top-20 h-64 w-64 rounded-full opacity-40 -z-0"
                 style={{ background: 'radial-gradient(circle, #fbbf24, transparent 70%)' }} />
            <div className="absolute -left-12 -bottom-16 h-48 w-48 rounded-full opacity-40 -z-0"
                 style={{ background: 'radial-gradient(circle, #f472b6, transparent 70%)' }} />

            <div className="relative z-10">
              <p className="text-[11px] uppercase tracking-[0.2em] text-neutral-700 font-semibold">
                {DateTime.now().setZone(TZ).toFormat('cccc')}
              </p>
              <div className="flex items-end justify-between gap-4 mt-1.5">
                <div>
                  <h1 className="text-3xl sm:text-5xl font-bold tracking-tight text-neutral-900 leading-[1.05]">
                    {todayCount === 0 ? 'No meetings today' : `You have ${todayCount} ${todayCount === 1 ? 'meeting' : 'meetings'} today`}
                  </h1>
                  <p className="text-sm sm:text-base text-neutral-700 mt-2">Welcome back, {firstName}</p>
                </div>
                <div className="hidden sm:flex flex-col items-end shrink-0">
                  <p className="text-5xl font-bold text-neutral-900 tabular-nums leading-none">
                    {DateTime.now().setZone(TZ).toFormat('d')}
                  </p>
                  <p className="text-sm text-neutral-700 mt-1 uppercase tracking-wider">
                    {DateTime.now().setZone(TZ).toFormat('LLL yyyy')}
                  </p>
                </div>
              </div>
            </div>
          </div>

          <CalendarPage
            events={calendarEvents}
            rawEvents={rawEvents}
            meetingTypes={meetingTypes}
          />
        </main>
      </div>
    </div>
  )
}

// Parse the full RRULE (FREQ/INTERVAL/BYDAY/BYMONTHDAY/COUNT/UNTIL/...) with the rrule library.
// Exceptions come from events.exdates (plus any legacy ;EXDATE= fragment) and are passed as `exdate`.
function buildRecurring(e: any): { rrule: any; exdate?: string[] } {
  const { rule, legacyExdates } = splitLegacyRrule(e.rrule)
  const exdate = [...(e.exdates ?? []).map((d: string) => ensureUtc(d)), ...legacyExdates]
  try {
    const opts: any = RRule.parseString(rule)
    return { rrule: { ...opts, dtstart: ensureUtc(e.starts_at) }, ...(exdate.length ? { exdate } : {}) }
  } catch {
    return { rrule: { freq: 'weekly', dtstart: ensureUtc(e.starts_at) }, ...(exdate.length ? { exdate } : {}) }
  }
}
function msDiff(a: string, b: string): { milliseconds: number } {
  return { milliseconds: new Date(ensureUtc(b)).getTime() - new Date(ensureUtc(a)).getTime() }
}
function ensureUtc(s: string | null | undefined): string {
  if (!s) return s as any
  const dt = DateTime.fromISO(s, { setZone: true })
  if (dt.isValid) return dt.toUTC().toISO()!
  const sql = DateTime.fromSQL(s, { zone: 'utc' })
  if (sql.isValid) return sql.toUTC().toISO()!
  return s
}

// Soft pastel palette for events without meeting type
const PALETTE = ['#f59e0b', '#ec4899', '#8b5cf6', '#3b82f6', '#10b981', '#f43f5e', '#06b6d4', '#a855f7']
function colorFromId(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return PALETTE[h % PALETTE.length]
}
