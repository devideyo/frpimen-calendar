'use server'

import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { revalidatePath } from 'next/cache'
import { DateTime } from 'luxon'
import { z } from 'zod'
import { headers } from 'next/headers'
import { RRule, RRuleSet } from 'rrule'
import { escapeHtml as esc } from '@/lib/html'
import { signCancel } from '@/lib/cancel-token'
import { splitLegacyRrule } from '@/lib/recurrence'

const TZ = 'America/Chicago'

type BookingLink = {
  name: string
  slug: string
  description?: string
  duration_minutes: number
  location?: string
  meeting_type_id?: string | null
  availability_days?: number[]
  availability_start?: string
  availability_end?: string
  buffer_before_minutes?: number
  buffer_after_minutes?: number
  max_per_day?: number | null
}

export async function createBookingLink(input: BookingLink) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'unauthorized' }

  const slug = (input.slug || input.name).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  const { data, error } = await supabase.from('booking_links').insert({
    owner_id: user.id,
    slug,
    name: input.name,
    description: input.description ?? null,
    duration_minutes: input.duration_minutes,
    location: input.location ?? null,
    meeting_type_id: input.meeting_type_id ?? null,
    availability_days: input.availability_days ?? [1,2,3,4,5,6,7],
    availability_start: input.availability_start ?? '09:00',
    availability_end: input.availability_end ?? '17:00',
    buffer_before_minutes: input.buffer_before_minutes ?? 0,
    buffer_after_minutes: input.buffer_after_minutes ?? 15,
    max_per_day: input.max_per_day ?? null,
  }).select().single()
  if (error) return { error: error.message }
  revalidatePath('/booking-links')
  return { success: true, link: data }
}

export async function deleteBookingLink(id: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'unauthorized' }
  const { error } = await supabase.from('booking_links').delete().eq('id', id).eq('owner_id', user.id)
  if (error) return { error: error.message }
  revalidatePath('/booking-links')
  return { success: true }
}

const MAX_DAYS_AHEAD = 90

const slugSchema = z.string().min(1).max(100).regex(/^[a-z0-9-]+$/)
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
// no control characters (prevents header/subject injection)
const noCtl = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\u0000-\u001f\u007f]+$/)
const bookingSchema = z.object({
  slug: slugSchema,
  dateStr: dateSchema,
  time: timeSchema,
  name: noCtl(100),
  email: z.string().trim().toLowerCase().email().max(254),
  phone: z.string().trim().max(30).regex(/^[0-9+()\-.\s]*$/).optional(),
  notes: z.string().trim().max(1000).optional(),
})

// Best-effort in-memory limiter (per server instance). The durable cap in bookSlot is the real backstop.
const hits = new Map<string, number[]>()
function rateLimited(key: string, max: number, windowMs: number): boolean {
  const now = Date.now()
  const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs)
  if (arr.length >= max) { hits.set(key, arr); return true }
  arr.push(now)
  hits.set(key, arr)
  if (hits.size > 5000) hits.clear()
  return false
}

type Range = { start: DateTime; end: DateTime }

// PUBLIC: returns available slots for a given date
export async function getAvailableSlots(slugIn: string, dateIn: string): Promise<string[]> {
  const slugP = slugSchema.safeParse(slugIn)
  const dateP = dateSchema.safeParse(dateIn)
  if (!slugP.success || !dateP.success) return []
  const slug = slugP.data
  const dateStr = dateP.data

  const sb = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const { data: link } = await sb.from('booking_links').select('*').eq('slug', slug).eq('active', true).single()
  if (!link) return []

  const day = DateTime.fromISO(dateStr, { zone: TZ })
  if (!day.isValid) return []
  const weekday = day.weekday  // 1=Mon..7=Sun
  if (!link.availability_days?.includes(weekday)) return []

  // Booking horizon
  const today = DateTime.now().setZone(TZ).startOf('day')
  if (day < today || day > today.plus({ days: MAX_DAYS_AHEAD })) return []

  const [sH, sM] = link.availability_start.split(':').map(Number)
  const [eH, eM] = link.availability_end.split(':').map(Number)
  const dayStart = day.set({ hour: sH, minute: sM, second: 0, millisecond: 0 })
  const dayEnd = day.set({ hour: eH, minute: eM, second: 0, millisecond: 0 })

  const bufBefore = link.buffer_before_minutes ?? 0
  const bufAfter = link.buffer_after_minutes ?? 0
  const winStart = dayStart.minus({ minutes: bufAfter })
  const winEnd = dayEnd.plus({ minutes: bufBefore })

  // Existing events that OVERLAP the window (not just ones that start inside it)
  const { data: existing } = await sb.from('events')
    .select('starts_at, ends_at, busy_level, status, rrule, exdates, source')
    .eq('owner_id', link.owner_id)
    .lt('starts_at', winEnd.toUTC().toISO()!)

  const busy: Range[] = []
  const bookingsToday: Range[] = []
  for (const e of (existing ?? []) as any[]) {
    if (e.status === 'cancelled') continue
    if (e.busy_level === 'free') continue
    const eS = DateTime.fromISO(e.starts_at, { zone: 'utc' })
    const eE = DateTime.fromISO(e.ends_at, { zone: 'utc' })
    const dur = Math.max(0, eE.toMillis() - eS.toMillis())
    const instances: Range[] = []
    if (e.rrule) {
      try {
        const { rule, legacyExdates } = splitLegacyRrule(e.rrule)
        const set = new RRuleSet()
        set.rrule(new RRule({ ...RRule.parseString(rule), dtstart: eS.toJSDate() }))
        for (const x of [...(e.exdates ?? []), ...legacyExdates]) set.exdate(new Date(x))
        for (const d of set.between(winStart.minus({ milliseconds: dur }).toJSDate(), winEnd.toJSDate(), true)) {
          const s = DateTime.fromJSDate(d, { zone: 'utc' })
          instances.push({ start: s, end: s.plus({ milliseconds: dur }) })
        }
      } catch {
        // unparseable rule: fall back to blocking the master occurrence only
        instances.push({ start: eS, end: eE })
      }
    } else if (eE > winStart.toUTC()) {
      instances.push({ start: eS, end: eE })
    }
    for (const i of instances) {
      busy.push(i)
      if (e.source === 'booking' && i.start.setZone(TZ).hasSame(day, 'day')) bookingsToday.push(i)
    }
  }

  // Time blocks (vacations etc.)
  const { data: rangeBlocks } = await sb.from('time_blocks')
    .select('starts_at, ends_at')
    .eq('owner_id', link.owner_id).eq('kind', 'range')
    .gt('ends_at', winStart.toUTC().toISO()!)
    .lt('starts_at', winEnd.toUTC().toISO()!)

  const { data: dailyBlocks } = await sb.from('time_blocks')
    .select('daily_start, daily_end, weekdays')
    .eq('owner_id', link.owner_id).eq('kind', 'recurring_daily')

  const blocked: Range[] = []
  for (const r of rangeBlocks ?? []) {
    blocked.push({
      start: DateTime.fromISO(r.starts_at, { zone: 'utc' }),
      end: DateTime.fromISO(r.ends_at, { zone: 'utc' }),
    })
  }
  for (const d of dailyBlocks ?? []) {
    if (!d.daily_start || !d.daily_end) continue
    const [dsH, dsM] = d.daily_start.split(':').map(Number)
    const [deH, deM] = d.daily_end.split(':').map(Number)
    // Check the previous day too so overnight blocks (e.g. 22:00-06:00) cover this morning
    for (const offset of [-1, 0]) {
      const base = day.plus({ days: offset })
      if (d.weekdays && Array.isArray(d.weekdays) && !d.weekdays.includes(base.weekday)) continue
      const start = base.set({ hour: dsH, minute: dsM, second: 0, millisecond: 0 })
      let end = base.set({ hour: deH, minute: deM, second: 0, millisecond: 0 })
      if (end <= start) end = end.plus({ days: 1 })
      blocked.push({ start: start.toUTC(), end: end.toUTC() })
    }
  }

  const slots: string[] = []
  const step = Math.max(5, link.duration_minutes + bufAfter)
  let cursor: DateTime = dayStart

  // Don't offer slots in the past
  const now = DateTime.now().setZone(TZ)
  if (cursor < now) cursor = now.startOf('minute').plus({ minutes: (15 - (now.minute % 15)) % 15 })

  while (cursor.plus({ minutes: link.duration_minutes }) <= dayEnd) {
    const slotStart = cursor.toUTC()
    const slotEnd = cursor.plus({ minutes: link.duration_minutes }).toUTC()
    // Buffers apply around existing events; blocks are hard ranges
    const sBuf = slotStart.minus({ minutes: bufAfter })
    const eBuf = slotEnd.plus({ minutes: bufBefore })
    const conflicts = busy.some((b) => b.start < eBuf && b.end > sBuf)
      || blocked.some((b) => b.start < slotEnd && b.end > slotStart)
    if (!conflicts) slots.push(cursor.toFormat('HH:mm'))
    cursor = cursor.plus({ minutes: step })
  }

  // Cap by max_per_day (counts bookings only, not all events)
  if (link.max_per_day) {
    const remaining = Math.max(0, link.max_per_day - bookingsToday.length)
    return slots.slice(0, remaining)
  }
  return slots
}

// PUBLIC: book a slot
export async function bookSlot(slug: string, dateStr: string, time: string, name: string, email: string, phone?: string, notes?: string) {
  const parsed = bookingSchema.safeParse({ slug, dateStr, time, name, email, phone: phone || undefined, notes: notes || undefined })
  if (!parsed.success) return { error: 'Please check your details and try again.' }
  const v = parsed.data

  // Rate limiting (best effort per instance; durable cap below)
  const h = await headers()
  const ip = (h.get('x-forwarded-for') ?? '').split(',')[0].trim() || h.get('x-real-ip') || 'unknown'
  if (rateLimited(`ip:${ip}`, 5, 60 * 60_000) || rateLimited(`em:${v.email}`, 3, 60 * 60_000)) {
    return { error: 'Too many booking attempts. Please try again later.' }
  }

  // Fail closed if the cancel-link secret is not configured
  try { signCancel('check', 'check') } catch {
    console.error('CANCEL_SECRET not configured; refusing to book')
    return { error: 'Booking is temporarily unavailable.' }
  }

  const sb = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const { data: link } = await sb.from('booking_links').select('*').eq('slug', v.slug).eq('active', true).single()
  if (!link) return { error: 'Link not found' }

  // Durable backstop: cap bookings created per owner per hour
  const since = new Date(Date.now() - 60 * 60_000).toISOString()
  const { count: recent } = await sb.from('events').select('id', { count: 'exact', head: true })
    .eq('owner_id', link.owner_id).eq('source', 'booking').gte('created_at', since)
  if ((recent ?? 0) >= 20) return { error: 'Too many bookings right now. Please try again later.' }

  const slots = await getAvailableSlots(v.slug, v.dateStr)
  if (!slots.includes(v.time)) return { error: 'Slot no longer available' }

  const start = DateTime.fromISO(`${v.dateStr}T${v.time}`, { zone: TZ })
  const end = start.plus({ minutes: link.duration_minutes })

  const { data: event, error } = await sb.from('events').insert({
    owner_id: link.owner_id,
    title: `${link.name} — ${v.name}`,
    description: v.notes ? `Booked via ${link.slug}\n\n${v.notes}` : `Booked via ${link.slug}`,
    location: link.location,
    starts_at: start.toUTC().toISO(),
    ends_at: end.toUTC().toISO(),
    all_day: false,
    meeting_type_id: link.meeting_type_id,
    busy_level: 'busy',
    visibility: 'default',
    source: 'booking',
  }).select().single()

  if (error) {
    // 23P01 = exclusion violation: someone else just took this slot
    if ((error as any).code === '23P01') return { error: 'Slot no longer available' }
    console.error('booking insert failed', error.message)
    return { error: 'Could not complete booking. Please try again.' }
  }

  const { data: attendee } = await sb.from('event_attendees').insert({
    event_id: event.id,
    email: v.email,
    rsvp_status: 'accepted',
    name: v.name,
    phone: v.phone ?? null,
    notes: v.notes ?? null,
  }).select().single()

  if (!attendee) {
    await sb.from('events').delete().eq('id', event.id)
    return { error: 'Could not complete booking. Please try again.' }
  }

  // Cancel token (HMAC-signed)
  const sig = signCancel(attendee.id, event.id)
  const cancelUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? 'https://frpimen-calendar.vercel.app'}/cancel/${attendee.id}?sig=${sig}`

  // Send emails via Resend (lazy). All user-supplied values are HTML-escaped.
  const ownerEmail = await sb.from('profiles').select('full_name').eq('id', link.owner_id).single()
  const dt = start.toFormat('cccc, LLLL d')
  const tmRange = `${start.toFormat('h:mm a')} – ${end.toFormat('h:mm a')}`

  try {
    const { sendEmail } = await import('@/lib/email/send')
    // Attendee confirmation
    await sendEmail(
      v.email,
      `Confirmed: ${link.name} on ${dt}`,
      `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:24px"><h2 style="margin:0 0 8px">Booking confirmed</h2><p style="color:#525252;margin:0 0 20px">${esc(link.name)} with ${esc(ownerEmail.data?.full_name ?? 'Fr. Pimen')}</p><div style="background:#f5f5f5;border-radius:14px;padding:18px;margin:16px 0"><div style="font-weight:600;font-size:18px">${esc(dt)}</div><div style="color:#525252;margin-top:4px">${esc(tmRange)}</div>${link.location ? `<div style="color:#525252;margin-top:6px">📍 ${esc(link.location)}</div>` : ''}</div><p style="font-size:13px;color:#737373">Need to cancel? <a href="${esc(cancelUrl)}">Click here</a>.</p></div>`
    )
    // Notify priest — fetch their email
    const { data: { user: ownerUser } } = await sb.auth.admin.getUserById(link.owner_id)
    if (ownerUser?.email) {
      await sendEmail(
        ownerUser.email,
        `New booking: ${link.name} — ${v.name}`,
        `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:24px"><h2>${esc(v.name)} booked ${esc(link.name)}</h2><div style="background:#f5f5f5;border-radius:14px;padding:18px;margin:16px 0"><div style="font-weight:600">${esc(dt)}</div><div style="color:#525252">${esc(tmRange)}</div>${link.location ? `<div style="color:#525252;margin-top:4px">📍 ${esc(link.location)}</div>` : ''}</div><p>📧 ${esc(v.email)}${v.phone ? `<br>📞 ${esc(v.phone)}` : ''}</p>${v.notes ? `<p style="color:#525252;font-size:13px"><strong>Notes:</strong> ${esc(v.notes)}</p>` : ''}</div>`
      )
    }
  } catch (e) { console.error('email send failed', e) }

  return { success: true, eventId: event.id }
}
