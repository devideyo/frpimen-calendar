import crypto from 'crypto'

// Fails closed: CANCEL_SECRET must be set (no fallback, not shared with CRON_SECRET).
function getSecret(): string {
  const secret = process.env.CANCEL_SECRET
  if (!secret || secret.length < 16) {
    throw new Error('CANCEL_SECRET is not configured (min 16 chars)')
  }
  return secret
}

export function signCancel(attendeeId: string, eventId: string): string {
  return crypto.createHmac('sha256', getSecret()).update(`${attendeeId}:${eventId}`).digest('hex').slice(0, 32)
}

export function verifyCancel(attendeeId: string, eventId: string, sig: string | undefined | null): boolean {
  if (!sig) return false
  let expected: string
  try { expected = signCancel(attendeeId, eventId) } catch { return false }
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}
