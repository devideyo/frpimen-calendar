'use server'

import { createClient as createServiceClient } from '@supabase/supabase-js'
import { verifyCancel } from '@/lib/cancel-token'
import { escapeHtml } from '@/lib/html'

export async function cancelAttendee(id: string, sig: string) {
  const sb = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

  const { data: attendee } = await sb
    .from('event_attendees')
    .select('id, event_id, email, name, canceled_at')
    .eq('id', id)
    .single()
  if (!attendee) return { error: 'not found' }

  // Fails closed (invalid) when CANCEL_SECRET is unset; constant-time compare
  if (!verifyCancel(attendee.id, attendee.event_id, sig)) return { error: 'invalid signature' }
  if (attendee.canceled_at) return { error: 'already cancelled' }

  // Read the event BEFORE deleting it so we can notify the priest
  const { data: event } = await sb.from('events').select('*').eq('id', attendee.event_id).single()

  const isBooking = !!event && (event.source === 'booking' || (event.description ?? '').startsWith('Booked via '))

  await sb.from('event_attendees').update({ canceled_at: new Date().toISOString(), rsvp_status: 'declined' }).eq('id', id)
  // Only delete events that were created through a booking link; otherwise just mark the attendee declined
  if (event && isBooking) {
    await sb.from('events').delete().eq('id', attendee.event_id)
  }

  // Notify priest
  try {
    if (event) {
      const { sendEmail } = await import('@/lib/email/send')
      const { data: { user: ownerUser } } = await sb.auth.admin.getUserById(event.owner_id)
      if (ownerUser?.email) {
        await sendEmail(
          ownerUser.email,
          `Cancelled: ${event.title}`.replace(/[\r\n]+/g, ' '),
          `<div style="font-family:system-ui,sans-serif;padding:24px"><p>${escapeHtml(attendee.name ?? attendee.email)} cancelled their booking.</p><p style="color:#525252">${escapeHtml(event.title)} — ${escapeHtml(new Date(event.starts_at).toLocaleString('en-US', { timeZone: 'America/Chicago', dateStyle: 'full', timeStyle: 'short' }))}</p></div>`
        )
      }
    }
  } catch (e) { console.error('cancel notify failed', e) }

  return { success: true }
}
