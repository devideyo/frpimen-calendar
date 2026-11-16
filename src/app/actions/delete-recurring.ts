'use server'

import { createClient } from '@/lib/supabase/server'
import { revalidatePath } from 'next/cache'
import { splitLegacyRrule } from '@/lib/recurrence'

type Scope = 'occurrence' | 'future' | 'series'

export async function deleteRecurring(eventId: string, scope: Scope, occurrenceDate?: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'unauthorized' }

  const { data: event } = await supabase
    .from('events').select('*').eq('id', eventId).eq('owner_id', user.id).single()
  if (!event) return { error: 'not found' }

  if (!event.rrule || scope === 'series') {
    await supabase.from('events').delete().eq('id', eventId).eq('owner_id', user.id)
    revalidatePath('/')
    return { success: true }
  }

  if (scope === 'future' && occurrenceDate) {
    const occ = new Date(occurrenceDate)
    if (Number.isNaN(occ.getTime())) return { error: 'invalid date' }
    // First occurrence: deleting this-and-future removes the whole series
    if (occ.getTime() <= new Date(event.starts_at).getTime()) {
      await supabase.from('events').delete().eq('id', eventId).eq('owner_id', user.id)
      revalidatePath('/')
      return { success: true }
    }
    // End the series just before this occurrence. UNTIL and COUNT are mutually exclusive in RFC 5545.
    const until = new Date(occ.getTime() - 1000)
    const untilStr = until.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
    const { rule } = splitLegacyRrule(event.rrule)
    const newRrule = rule
      .split(';')
      .filter((p) => !/^(UNTIL|COUNT)=/i.test(p))
      .concat(`UNTIL=${untilStr}`)
      .join(';')
    await supabase.from('events').update({ rrule: newRrule }).eq('id', eventId).eq('owner_id', user.id)
    revalidatePath('/')
    return { success: true }
  }

  if (scope === 'occurrence' && occurrenceDate) {
    const occ = new Date(occurrenceDate)
    if (Number.isNaN(occ.getTime())) return { error: 'invalid date' }
    // Exceptions live in a separate timestamptz[] column (events.exdates), not inside the RRULE string.
    // Also migrate any legacy ";EXDATE=" fragment out of the rule.
    const { rule, legacyExdates } = splitLegacyRrule(event.rrule)
    const existing: string[] = (event.exdates ?? []).map((d: string) => new Date(d).toISOString())
    const all = Array.from(new Set([...existing, ...legacyExdates, occ.toISOString()]))
    const { error } = await supabase.from('events').update({ rrule: rule, exdates: all }).eq('id', eventId).eq('owner_id', user.id)
    if (error) return { error: error.message }
    revalidatePath('/')
    return { success: true }
  }

  return { error: 'invalid request' }
}
