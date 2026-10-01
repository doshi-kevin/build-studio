// Mints a single-use ElevenLabs WebSocket token for Scribe v2 real-time
// transcription. The browser opens a direct WebSocket to ElevenLabs with
// this token — raw audio never touches our server. Rate limiting uses
// the events table so it works across multiple server instances.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logEvent } from '@/lib/supabase/event-logger'
import { logger } from '@/lib/logger'
import { checkAiFeatureBySection } from '@/lib/ai/kill-switch'
import { aiRefusalMessage } from '@/lib/ai/ai-features'

export const runtime = 'nodejs'

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY ?? ''
const ELEVENLABS_TOKEN_URL = 'https://api.elevenlabs.io/v1/single-use-token/realtime_scribe'
const MAX_TOKENS_PER_ROOM_PER_HOUR = 60

export async function POST(request: NextRequest) {
  try {
    if (!ELEVENLABS_API_KEY) {
      return NextResponse.json({ error: 'Transcription is not configured' }, { status: 503 })
    }

    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const roomId = (body as Record<string, unknown>)?.roomId
    if (typeof roomId !== 'string' || roomId.length < 10) {
      return NextResponse.json({ error: 'roomId is required' }, { status: 400 })
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    const { data: room, error: roomError } = await adminDb
      .from('lc_rooms')
      .select('id, prof_id, status, section_id')
      .eq('id', roomId)
      .single()

    if (roomError || !room) {
      return NextResponse.json({ error: 'Room not found' }, { status: 404 })
    }
    if (room.prof_id !== user.id) {
      return NextResponse.json({ error: 'Only the room professor can start transcription' }, { status: 403 })
    }
    if (room.status !== 'live') {
      return NextResponse.json({ error: 'Room has ended' }, { status: 400 })
    }

    // Institution/platform AI kill switch — transcription is an AI service.
    const aiVerdict = await checkAiFeatureBySection(adminDb, room.section_id, 'live-classroom-ai')
    if (!aiVerdict.allowed) {
      return NextResponse.json({ error: aiRefusalMessage(aiVerdict.lockedBy) }, { status: 403 })
    }

    // DB-backed rate limit — counts recent token grants from the events
    // table. Works across multiple server instances / deploys.
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const { count, error: countError } = await adminDb
      .from('events')
      .select('id', { count: 'exact', head: true })
      .eq('event_type', 'lc_room.scribe_token_granted')
      .eq('metadata->>roomId', roomId)
      .gte('created_at', hourAgo)

    if (!countError && (count ?? 0) >= MAX_TOKENS_PER_ROOM_PER_HOUR) {
      return NextResponse.json(
        { error: 'Too many transcription sessions. Please wait before starting a new one.' },
        { status: 429 },
      )
    }

    const response = await fetch(ELEVENLABS_TOKEN_URL, {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    })

    if (!response.ok) {
      const text = await response.text().catch(() => 'Unknown error')
      logger.error('scribe-token: ElevenLabs token request failed', null, {
        status: response.status,
        body: text.slice(0, 200),
      })
      return NextResponse.json({ error: 'Failed to get transcription token' }, { status: 502 })
    }

    const data = await response.json()
    const token = data?.token

    if (typeof token !== 'string') {
      logger.error('scribe-token: unexpected response shape', null, { data })
      return NextResponse.json({ error: 'Invalid token response' }, { status: 502 })
    }

    // Log the grant so the rate limiter can count it across instances
    logEvent({
      userId: user.id,
      eventType: 'lc_room.scribe_token_granted',
      eventCategory: 'professor',
      metadata: { roomId },
      sectionId: room.section_id,
    })

    return NextResponse.json({ token })
  } catch (error) {
    logger.error('scribe-token: Unexpected error', error)
    return NextResponse.json({ error: 'An unexpected error occurred' }, { status: 500 })
  }
}
