// Helpers for recurring events. Exceptions (EXDATE) live in events.exdates (timestamptz[]);
// legacy rows may have ";EXDATE=..." embedded in the rrule string, which is split out here.

export function splitLegacyRrule(rrule: string): { rule: string; legacyExdates: string[] } {
  const legacy: string[] = []
  const rule = rrule
    .replace(/^RRULE:/i, '')
    .split(';')
    .filter((part) => {
      if (/^EXDATE=/i.test(part)) {
        for (const d of part.slice(7).split(',')) {
          const m = d.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/)
          if (m) legacy.push(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z`)
        }
        return false
      }
      return part.length > 0
    })
    .join(';')
  return { rule, legacyExdates: legacy }
}
