/**
 * iCal Feed API Route — serves calendar feeds for Outlook/Calendar subscriptions.
 *
 * GET /api/feeds/{64-char-hex-token}.ics
 *
 * Token-based auth (no cookies needed). Outlook polls this URL periodically
 * and automatically syncs events to the user's calendar.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { generateICalFeed } from '@/lib/calendar/ical'
import { buildFeedEvents } from '@/lib/calendar/feed-builder'
import { logger } from '@/lib/logger'

// Validate token format: 64 hex characters
const TOKEN_REGEX = /^[a-f0-9]{64}$/

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token: rawToken } = await params

    // Strip .ics suffix if present
    const token = rawToken.endsWith('.ics')
      ? rawToken.slice(0, -4)
      : rawToken

    // Validate token format
    if (!TOKEN_REGEX.test(token)) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 400 })
    }

    // Look up token → user
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    const { data: tokenRow, error: tokenErr } = await adminDb
      .from('calendar_tokens')
      .select('id, user_id, is_active, access_count')
      .eq('token', token)
      .eq('is_active', true)
      .maybeSingle()

    if (tokenErr || !tokenRow) {
      return NextResponse.json({ error: 'Token not found' }, { status: 404 })
    }

    // Fetch user profile for role + name
    const { data: profile, error: profileErr } = await adminDb
      .from('profiles')
      .select('id, name, email, role')
      .eq('id', tokenRow.user_id)
      .single()

    if (profileErr || !profile) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // Build events based on role
    const events = await buildFeedEvents(
      adminDb,
      profile.id,
      profile.role as 'student' | 'professor',
      profile.name || profile.email
    )

    // Generate iCal feed
    const calName = `Scholera — ${profile.name || profile.email}`
    const icalContent = generateICalFeed(events, calName)

    // Update access tracking (fire-and-forget)
    adminDb
      .from('calendar_tokens')
      .update({
        last_accessed_at: new Date().toISOString(),
        access_count: tokenRow.access_count ? tokenRow.access_count + 1 : 1,
      })
      .eq('id', tokenRow.id)
      .then(() => {})
      .catch(() => {})

    // Return iCal response
    return new NextResponse(icalContent, {
      status: 200,
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': 'inline; filename="scholera-calendar.ics"',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      },
    })
  } catch (error) {
    logger.error('Feed API: Unexpected error', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
