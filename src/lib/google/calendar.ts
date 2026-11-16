export async function refreshGoogleToken(refreshToken: string) {
    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    })
    if (!resp.ok) {
      const text = await resp.text()
      throw new Error(`Token refresh failed: ${text}`)
    }
    const data = await resp.json()
    return {
      access_token: data.access_token as string,
      expires_in: data.expires_in as number,
    }
  }
  
  export async function listGoogleEvents(
    accessToken: string,
    timeMin: string,
    timeMax: string
  ) {
    const all: GoogleCalendarEvent[] = []
    let pageToken: string | undefined
    let pages = 0
    do {
      const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events')
      url.searchParams.set('timeMin', timeMin)
      url.searchParams.set('timeMax', timeMax)
      url.searchParams.set('maxResults', '250')
      url.searchParams.set('singleEvents', 'true')
      url.searchParams.set('orderBy', 'startTime')
      if (pageToken) url.searchParams.set('pageToken', pageToken)

      const resp = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (!resp.ok) {
        const text = await resp.text()
        throw new Error(`Google Calendar API error: ${resp.status} ${text}`)
      }
      const data = await resp.json()
      all.push(...((data.items ?? []) as GoogleCalendarEvent[]))
      pageToken = data.nextPageToken
      pages++
    } while (pageToken && pages < 20)
    // Incomplete listing: throw so callers never treat a partial list as complete (deletions depend on it)
    if (pageToken) throw new Error('Google Calendar returned too many events to sync')
    return all
  }
  
  export type GoogleCalendarEvent = {
    id: string
    summary?: string
    description?: string
    location?: string
    start: { dateTime?: string; date?: string; timeZone?: string }
    end: { dateTime?: string; date?: string; timeZone?: string }
    status?: string
    visibility?: string
    transparency?: string
    recurringEventId?: string
  }