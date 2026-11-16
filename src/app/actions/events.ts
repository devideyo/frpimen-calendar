'use server'

import { createClient } from '@/lib/supabase/server'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { escapeHtml as esc } from '@/lib/html'

const eventSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  location: z.string().optional(),
  starts_at: z.string(),
  ends_at: z.string(),
  all_day: z.boolean().default(false),
  meeting_type_id: z.string().uuid().optional().nullable(),
  busy_level: z.enum(['free','tentative','busy','blocked']).default('busy'),
  visibility: z.enum(['default','private','confidential','public']).default('default'),
  rrule: z.string().optional().nullable(),
  attendee_emails: z.string().optional(),
  recurrence: z.enum(['none','daily','weekly','monthly']).default('none'),
  recurrence_count: z.number().int().min(1).max(365).optional(),
}).superRefine((v, ctx) => {
  const s = Date.parse(v.starts_at)
  const e = Date.parse(v.ends_at)
  if (Number.isNaN(s)) ctx.addIssue({ code: 'custom', path: ['starts_at'], message: 'Invalid start date' })
  if (Number.isNaN(e)) ctx.addIssue({ code: 'custom', path: ['ends_at'], message: 'Invalid end date' })
  if (!Number.isNaN(s) && !Number.isNaN(e) && e < s) ctx.addIssue({ code: 'custom', path: ['ends_at'], message: 'End must be after start' })
})

// Returns an ISO string, or '' when the input is not a valid date (rejected by eventSchema)
function toIso(v: FormDataEntryValue | null): string {
  const d = new Date(v?.toString() ?? '')
  return Number.isNaN(d.getTime()) ? '' : d.toISOString()
}

function parseEmails(raw: string | undefined): string[] {
  return Array.from(new Set((raw ?? '').split(',').map((e) => e.trim().toLowerCase()).filter((e) => e.length > 0)))
}
const emailSchema = z.string().email().max(254)

function parseFormData(formData: FormData) {
  return {
    title: formData.get('title')?.toString() ?? '',
    description: formData.get('description')?.toString() || undefined,
    location: formData.get('location')?.toString() || undefined,
    starts_at: toIso(formData.get('starts_at')),
    ends_at: toIso(formData.get('ends_at')),
    all_day: formData.get('all_day') === 'on',
    meeting_type_id: formData.get('meeting_type_id')?.toString() || null,
    busy_level: (formData.get('busy_level')?.toString() as any) ?? 'busy',
    visibility: (formData.get('visibility')?.toString() as any) ?? 'default',
    rrule: formData.get('rrule')?.toString() || null,
    attendee_emails: formData.get('attendee_emails')?.toString() || undefined,
    recurrence: (formData.get('recurrence')?.toString() as any) ?? 'none',
    recurrence_count: formData.get('recurrence_count')
      ? parseInt(formData.get('recurrence_count')!.toString())
      : undefined,
  }
}

export async function createEvent(formData: FormData) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const parsed = eventSchema.safeParse(parseFormData(formData))
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid data' }
  const data = parsed.data

  let recurrence_rule: string | null = null
  if (data.recurrence !== 'none') {
    const freq = data.recurrence.toUpperCase()
    const count = data.recurrence_count ?? 10
    recurrence_rule = `FREQ=${freq};COUNT=${count}`
  }

  const { data: event, error } = await supabase
    .from('events')
    .insert({
      owner_id: user.id,
      title: data.title,
      description: data.description,
      location: data.location,
      starts_at: data.starts_at,
      ends_at: data.ends_at,
      all_day: data.all_day,
      meeting_type_id: data.meeting_type_id,
      busy_level: data.busy_level,
      visibility: data.visibility,
      rrule: data.rrule,
      recurrence_rule,
    })
    .select()
    .single()

  if (error) return { error: error.message }

  if (data.attendee_emails && event) {
    const emails = parseEmails(data.attendee_emails)
    if (!emails.every((e) => emailSchema.safeParse(e).success)) {
      return { success: true, eventId: event.id, warning: 'Event saved, but some attendee emails were invalid and were skipped.' }
    }
    if (emails.length > 0) {
      await supabase.from('event_attendees').insert(
        emails.map((email) => ({ event_id: event.id, email, rsvp_status: 'pending' }))
      )
      await sendInviteEmails(event, user.email ?? null, emails)
    }
  }

  revalidatePath('/')
  return { success: true, eventId: event?.id }
}

export async function updateEvent(id: string, formData: FormData) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const parsed = eventSchema.safeParse(parseFormData(formData))
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid data' }
  const data = parsed.data

  const { data: updated, error } = await supabase
    .from('events')
    .update({
      title: data.title,
      description: data.description,
      location: data.location,
      starts_at: data.starts_at,
      ends_at: data.ends_at,
      all_day: data.all_day,
      meeting_type_id: data.meeting_type_id,
      busy_level: data.busy_level,
      visibility: data.visibility,
      rrule: data.rrule,
    })
    .eq('id', id)
    .eq('owner_id', user.id)
    .select('id, title, starts_at, ends_at, location')

  if (error) return { error: error.message }
  // Nothing matched: not the owner (or no such event). Do not notify anyone.
  if (!updated || updated.length === 0) return { error: 'Event not found' }
  const event = updated[0]

  // Sync the attendee list when the form sent one
  if (formData.has('attendee_emails')) {
    const wanted = parseEmails(data.attendee_emails)
    if (wanted.every((e) => emailSchema.safeParse(e).success)) {
      const { data: current } = await supabase.from('event_attendees').select('email').eq('event_id', id)
      const have = new Set((current ?? []).map((a: any) => String(a.email).toLowerCase()))
      const toAdd = wanted.filter((e) => !have.has(e))
      const toRemove = [...have].filter((e) => !wanted.includes(e))
      if (toRemove.length) await supabase.from('event_attendees').delete().eq('event_id', id).in('email', toRemove)
      if (toAdd.length) {
        await supabase.from('event_attendees').insert(toAdd.map((email) => ({ event_id: id, email, rsvp_status: 'pending' })))
        await sendInviteEmails({ ...event, description: data.description ?? null }, user.email ?? null, toAdd)
      }
    }
  }

  const { data: attendees } = await supabase.from('event_attendees').select('email, name').eq('event_id', id)
  await notifyAttendees(event, attendees ?? [], 'updated', user.email ?? null)
  revalidatePath('/')
  return { success: true }
}

export async function deleteEvent(id: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Ownership check first (RLS-scoped reads; nothing is read with the service role)
  const { data: event } = await supabase
    .from('events').select('id, title, starts_at, ends_at, location').eq('id', id).eq('owner_id', user.id).single()
  if (!event) return { error: 'Event not found' }
  const { data: attendees } = await supabase.from('event_attendees').select('email, name').eq('event_id', id)

  const { data: deleted, error } = await supabase.from('events').delete().eq('id', id).eq('owner_id', user.id).select('id')
  if (error) return { error: error.message }
  if (deleted && deleted.length > 0) {
    await notifyAttendees(event, attendees ?? [], 'cancelled', user.email ?? null)
  }
  revalidatePath('/')
  return { success: true }
}

type EventSnapshot = { title: string; starts_at: string; ends_at: string; location?: string | null; description?: string | null }

// Callers must have verified ownership; this only sends mail from a snapshot they pass in.
async function notifyAttendees(
  event: EventSnapshot,
  attendees: { email: string; name?: string | null }[],
  type: 'updated' | 'cancelled',
  ownerEmail: string | null,
) {
  if (!attendees.length) return
  try {
    const { sendEmail } = await import('@/lib/email/send')
    const subject = (type === 'cancelled' ? `Cancelled: ${event.title}` : `Updated: ${event.title}`).replace(/[\r\n]+/g, ' ')
    const when = new Date(event.starts_at).toLocaleString('en-US', { timeZone: 'America/Chicago', dateStyle: 'full', timeStyle: 'short' })
    const body = `<div style="font-family:system-ui,sans-serif;padding:24px;max-width:520px;margin:0 auto"><h2>${esc(subject)}</h2><p style="color:#525252">${type === 'cancelled' ? 'This event has been cancelled.' : 'The event details have changed.'}</p><div style="background:#f5f5f5;border-radius:14px;padding:16px;margin:16px 0"><div style="font-weight:600">${esc(event.title)}</div><div style="color:#525252;margin-top:4px">${esc(when)}</div>${event.location ? `<div style="color:#525252;margin-top:4px">📍 ${esc(event.location)}</div>` : ''}</div></div>`
    for (const a of attendees) {
      await sendEmail(a.email, subject, body, { replyTo: ownerEmail ?? undefined }).catch(() => {})
    }
  } catch (e) { console.error('notify attendees failed', e) }
}

async function sendInviteEmails(event: EventSnapshot, ownerEmail: string | null, attendeeEmails: string[]) {
  if (!attendeeEmails.length) return
  try {
    const { sendEmail } = await import('@/lib/email/send')
    const dt = new Date(event.starts_at).toLocaleString('en-US', { timeZone: 'America/Chicago', dateStyle: 'full', timeStyle: 'short' })
    const subject = `Invite: ${event.title}`.replace(/[\r\n]+/g, ' ')
    const body = `<div style="font-family:system-ui,sans-serif;padding:24px;max-width:520px;margin:0 auto"><h2>${esc(event.title)}</h2><div style="background:#f5f5f5;border-radius:14px;padding:16px;margin:16px 0"><div style="color:#525252">${esc(dt)}</div>${event.location ? `<div style="color:#525252;margin-top:4px">📍 ${esc(event.location)}</div>` : ''}</div>${event.description ? `<p style="color:#525252;font-size:13px">${esc(event.description)}</p>` : ''}<p style="color:#737373;font-size:12px">This invitation was sent on behalf of Fr. Pimen.</p></div>`
    for (const email of attendeeEmails) {
      await sendEmail(email, subject, body, { replyTo: ownerEmail ?? undefined }).catch(() => {})
    }
  } catch (e) { console.error('sendInviteEmails failed', e) }
}
