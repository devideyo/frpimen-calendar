import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

// Only same-origin relative paths: must start with a single '/', no '//', '\\', '@' tricks.
function safeNext(raw: string | null, origin: string): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '/'
  try {
    const u = new URL(raw, origin)
    if (u.origin !== origin) return '/'
    return u.pathname + u.search
  } catch {
    return '/'
  }
}

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const next = safeNext(searchParams.get('next'), origin)

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=missing_code`)
  }

  const supabase = await createClient()
  const { data, error } = await supabase.auth.exchangeCodeForSession(code)

  if (error || !data.session) {
    return NextResponse.redirect(`${origin}/login?error=session_failed`)
  }

  // Check allowed emails
  const allowed = (process.env.ALLOWED_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)

  const userEmail = data.session.user.email?.toLowerCase()
  if (allowed.length > 0 && userEmail && !allowed.includes(userEmail)) {
    await supabase.auth.signOut()
    return NextResponse.redirect(`${origin}/login?error=not_authorized`)
  }

  // Save Google tokens for Calendar API access
  const providerToken = data.session.provider_token
  const providerRefreshToken = data.session.provider_refresh_token

  if (providerRefreshToken) {
    await supabase
      .from('profiles')
      .update({
        google_access_token: providerToken,
        google_refresh_token: providerRefreshToken,
        google_token_expires_at: new Date(Date.now() + 3500 * 1000).toISOString(),
      })
      .eq('id', data.session.user.id)
  }

  return NextResponse.redirect(new URL(next, origin))
}