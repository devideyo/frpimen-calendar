import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import webpush from 'web-push'
import { RRule, RRuleSet } from 'rrule'
import { splitLegacyRrule } from '@/lib/recurrence'

// Runs every 5 min via Vercel cron. Sends push for events starting in next 15 min.
export async function GET(req: Request) {
  const reqUrl = new URL(req.url)
  const queryKey = reqUrl.searchParams.get('key')
  const headerKey = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/, '')
  const secret = process.env.CRON_SECRET
  // Fail closed when CRON_SECRET is unset (otherwise undefined/'' could match)
  if (!secret || (queryKey !== secret && headerKey !== secret)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
  const sb = createClient(url, serviceKey)

  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT ?? 'mailto:contact@example.com',
    process.env.VAPID_PUBLIC_KEY!,
    process.env.VAPID_PRIVATE_KEY!,
  )

  const now = new Date()
  // Window must cover the ping interval (UPTIME_ROBOT.md: every 5 min) so no event is skipped.
  // Events starting 10-15 min from now are reminded on the tick where they enter that window.
  const WINDOW_MIN = Number(process.env.REMINDER_INTERVAL_MIN ?? 5)
  const lead = 15
  const winStart = new Date(now.getTime() + (lead - WINDOW_MIN) * 60_000)
  const winEnd = new Date(now.getTime() + lead * 60_000)

  const { data: single } = await sb
    .from('events')
    .select('id, title, owner_id, starts_at, location, status, all_day')
    .is('rrule', null)
    .gte('starts_at', winStart.toISOString())
    .lt('starts_at', winEnd.toISOString())

  // Recurring masters: expand occurrences that fall inside the window
  const { data: masters } = await sb
    .from('events')
    .select('id, title, owner_id, starts_at, location, status, all_day, rrule, exdates')
    .not('rrule', 'is', null)
    .lte('starts_at', winEnd.toISOString())

  const events: { id: string; title: string; owner_id: string; location: string | null }[] = (single ?? [])
    .filter((e: any) => e.status !== 'cancelled' && !e.all_day)
  for (const m of (masters ?? []) as any[]) {
    if (m.status === 'cancelled' || m.all_day) continue
    try {
      const { rule, legacyExdates } = splitLegacyRrule(m.rrule)
      const set = new RRuleSet()
      set.rrule(new RRule({ ...RRule.parseString(rule), dtstart: new Date(m.starts_at) }))
      for (const x of [...(m.exdates ?? []), ...legacyExdates]) set.exdate(new Date(x))
      if (set.between(winStart, winEnd, true).some((d) => d.getTime() >= winStart.getTime() && d.getTime() < winEnd.getTime())) {
        events.push(m)
      }
    } catch { /* skip unparseable rule */ }
  }

  if (!events.length) return NextResponse.json({ sent: 0 })

  let sent = 0
  for (const ev of events) {
    const { data: subs } = await sb.from('push_subscriptions').select('*').eq('user_id', ev.owner_id)
    if (!subs?.length) continue
    const payload = JSON.stringify({
      title: `In 15 min: ${ev.title}`,
      body: ev.location ? `📍 ${ev.location}` : 'Tap to view',
      url: '/',
    })
    for (const s of subs) {
      try {
        await webpush.sendNotification({
          endpoint: s.endpoint,
          keys: { p256dh: s.keys_p256dh, auth: s.keys_auth },
        }, payload)
        sent++
      } catch (err: any) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          await sb.from('push_subscriptions').delete().eq('id', s.id)
        }
      }
    }
  }

  return NextResponse.json({ sent, eventCount: events.length })
}
