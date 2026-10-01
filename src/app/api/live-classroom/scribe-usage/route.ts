// Cost-ledger heartbeat for live Scribe transcription. The professor's browser
// streams audio DIRECTLY to ElevenLabs (never through us), so connection time —
// what ElevenLabs actually bills — is metered client-side and reported here
// every 60s plus a final flush. One external_usage_events row per transcription
// session (upsert on dedup_key), quantity = cumulative connected seconds.
//
// Trust model: the reporter is the room's professor (verified), the value is a
// duration clamped to the room's real wall-clock age, and under-reporting only
// hurts the professor's own institution's cost visibility. Reconciliation
// against the ElevenLabs invoice on the Cost Analysis page catches drift.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { recordExternalUsage } from '@/lib/costs/external-usage'
import { logger } from '@/lib/logger'

export const runtime = 'nodejs'

const MAX_SESSION_SECONDS = 24 * 3600

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const { roomId, sessionKey, seconds } = (body ?? {}) as Record<string, unknown>
    if (typeof roomId !== 'string' || !/^[0-9a-f-]{36}$/i.test(roomId)) {
      return NextResponse.json({ error: 'roomId must be a UUID' }, { status: 400 })
    }
    if (typeof sessionKey !== 'string' || !/^[0-9a-f-]{36}$/i.test(sessionKey)) {
      return NextResponse.json({ error: 'sessionKey must be a UUID' }, { status: 400 })
    }
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
      return NextResponse.json({ error: 'seconds must be a positive number' }, { status: 400 })
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    const { data: room, error: roomError } = await adminDb
      .from('lc_rooms')
      .select('id, prof_id, section_id, created_at')
      .eq('id', roomId)
      .single()
    if (roomError || !room) return NextResponse.json({ error: 'Room not found' }, { status: 404 })
    // Room may already be 'ended' when the final flush lands — allow it; only
    // the professor who owns the room can report.
    if (room.prof_id !== user.id) {
      return NextResponse.json({ error: 'Only the room professor can report transcription usage' }, { status: 403 })
    }

    // A duration can never exceed the room's wall-clock age (+2 min slack).
    const roomAge = (Date.now() - new Date(room.created_at).getTime()) / 1000 + 120
    const clamped = Math.min(Math.round(seconds), Math.round(roomAge), MAX_SESSION_SECONDS)

    await recordExternalUsage({
      provider: 'elevenlabs',
      feature: 'live_transcription',
      quantity: clamped,
      sectionId: room.section_id,
      userId: user.id,
      dedupKey: `scribe:${roomId}:${sessionKey}`,
      metadata: { model: 'scribe_v2_realtime', roomId },
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    logger.error('POST /api/live-classroom/scribe-usage: exception', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
