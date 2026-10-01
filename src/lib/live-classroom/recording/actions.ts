// Live Classroom Recording — server actions.
//
// Capture (professor, opt-in): startRecording seeds the recording row; each
// browser MediaRecorder session calls addAudioSession then uploads chunks via
// createChunkUploadUrl and closes with finishAudioSession. The slide timeline is
// captured by a DB trigger, not here. Read (prof + enrolled student):
// getRecording assembles the playback blob with signed URLs.
//
// All writes go through the admin client AFTER an ownership/enrollment check —
// the client is untrusted (see .claude/rules/security-server-actions.md).

'use server'

import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logEvent } from '@/lib/supabase/event-logger'
import { logger } from '@/lib/logger'
import { signMany, LIVE_CLASSROOM_SIGNED_URL_TTL } from '@/lib/supabase/signed-urls'
import { triggerRecordingFinalize } from './trigger'
import type { RecordingData } from './types'

const DECKS_BUCKET = 'live-classroom-decks'
const RECORDINGS_BUCKET = 'live-classroom-recordings'

const uuid = z.string().uuid()

async function getAuthUser() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  return user
}

// Admin fetch + professor-ownership check — mirrors the private
// verifyRoomOwnership in the professor live-classroom actions. Only the owning
// professor may drive capture.
async function verifyRoomOwnership(roomId: string, userId: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any
  const { data: room } = await adminDb.from('lc_rooms').select('*').eq('id', roomId).single()
  if (!room || room.prof_id !== userId) return { ok: false as const, room: null, adminDb }
  return { ok: true as const, room, adminDb }
}

// Read access: the owning professor OR an enrolled student of the room's
// section (mirrors the lc_class_insights_student read predicate).
async function verifyRecordingAccess(roomId: string, userId: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any
  const { data: room } = await adminDb
    .from('lc_rooms')
    .select('id, prof_id, section_id, status')
    .eq('id', roomId)
    .single()
  if (!room) return { ok: false as const, adminDb, room: null }
  if (room.prof_id === userId) return { ok: true as const, adminDb, room }
  const { data: enrollment } = await adminDb
    .from('enrollments')
    .select('id')
    .eq('section_id', room.section_id)
    .eq('student_id', userId)
    .in('status', ['enrolled', 'completed'])
    .maybeSingle()
  return { ok: Boolean(enrollment), adminDb, room }
}

// ── Capture ───────────────────────────────────────────────────────

/** Opt-in start. Idempotent — a stop→start just adds another audio session. */
export async function startRecording(input: {
  roomId: string
}): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }
    const parsed = z.object({ roomId: uuid }).safeParse(input)
    if (!parsed.success) return { error: 'Invalid input' }
    const { roomId } = parsed.data

    const { ok, room, adminDb } = await verifyRoomOwnership(roomId, user.id)
    if (!ok || !room) return { error: 'Room not found or you do not own this room' }
    if (room.status !== 'live') return { error: 'Room has ended' }

    // Re-open an existing recording if there is one (so a stop→Record-again on
    // the same room resumes into the same recording — its new audio session gets
    // finalized instead of being orphaned). update returns 0 rows if none exists,
    // in which case we insert a fresh row. The insert seeds the timeline with the
    // slide showing right now, using ts:0 so it always maps to the START of the
    // audio (avoids any app-vs-DB clock skew — all later entries come from the DB
    // trigger, and this one is anchored to zero by construction).
    const { data: reopened, error: reopenError } = await adminDb
      .from('lc_recordings')
      .update({ status: 'recording', ended_at: null, generation_started_at: null })
      .eq('room_id', roomId)
      .select('room_id')
    if (reopenError) {
      logger.error('startRecording: reopen failed', reopenError, { roomId })
      return { error: 'Failed to start recording' }
    }
    if (!reopened || reopened.length === 0) {
      const { error: insertError } = await adminDb.from('lc_recordings').upsert(
        {
          room_id: roomId,
          status: 'recording',
          started_at: new Date().toISOString(),
          timeline: [
            {
              ts: 0,
              deck_id: room.active_deck_id ?? null,
              slide_index: room.current_slide ?? 0,
            },
          ],
        },
        { onConflict: 'room_id', ignoreDuplicates: true },
      )
      if (insertError) {
        logger.error('startRecording: insert failed', insertError, { roomId })
        return { error: 'Failed to start recording' }
      }
    }

    logEvent({
      userId: user.id,
      eventType: 'lc_recording.started',
      eventCategory: 'professor',
      metadata: { roomId },
      sectionId: room.section_id,
    })
    return { success: true }
  } catch (error) {
    logger.error('startRecording: unexpected error', error)
    return { error: 'An unexpected error occurred' }
  }
}

/** Register a new continuous audio session; returns the id used in chunk paths. */
export async function addAudioSession(input: {
  roomId: string
}): Promise<{ sessionId?: string; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }
    const parsed = z.object({ roomId: uuid }).safeParse(input)
    if (!parsed.success) return { error: 'Invalid input' }
    const { roomId } = parsed.data

    const { ok, adminDb } = await verifyRoomOwnership(roomId, user.id)
    if (!ok) return { error: 'Room not found or you do not own this room' }

    const { data, error } = await adminDb
      .from('lc_recording_sessions')
      .insert({ room_id: roomId })
      .select('id')
      .single()
    if (error || !data) {
      logger.error('addAudioSession: insert failed', error, { roomId })
      return { error: 'Failed to start audio session' }
    }
    return { sessionId: data.id }
  } catch (error) {
    logger.error('addAudioSession: unexpected error', error)
    return { error: 'An unexpected error occurred' }
  }
}

/** Signed upload URL for one audio chunk of a session. */
export async function createChunkUploadUrl(input: {
  roomId: string
  sessionId: string
  seq: number
}): Promise<{ signedUrl?: string; token?: string; path?: string; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }
    const parsed = z
      .object({ roomId: uuid, sessionId: uuid, seq: z.number().int().min(0) })
      .safeParse(input)
    if (!parsed.success) return { error: 'Invalid input' }
    const { roomId, sessionId, seq } = parsed.data

    const { ok, adminDb } = await verifyRoomOwnership(roomId, user.id)
    if (!ok) return { error: 'Room not found or you do not own this room' }

    const path = `${roomId}/${sessionId}/chunk-${seq}.webm`
    const { data, error } = await adminDb.storage
      .from(RECORDINGS_BUCKET)
      .createSignedUploadUrl(path, { upsert: true })
    if (error || !data) {
      logger.error('createChunkUploadUrl: mint failed', error, { roomId, sessionId, seq })
      return { error: 'Failed to prepare upload' }
    }
    return { signedUrl: data.signedUrl, token: data.token, path: data.path }
  } catch (error) {
    logger.error('createChunkUploadUrl: unexpected error', error)
    return { error: 'An unexpected error occurred' }
  }
}

/** Close an audio session with its recorded length + chunk count. */
export async function finishAudioSession(input: {
  roomId: string
  sessionId: string
  durationMs: number
  chunkCount: number
}): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }
    const parsed = z
      .object({
        roomId: uuid,
        sessionId: uuid,
        durationMs: z.number().int().min(0),
        chunkCount: z.number().int().min(0),
      })
      .safeParse(input)
    if (!parsed.success) return { error: 'Invalid input' }
    const { roomId, sessionId, durationMs, chunkCount } = parsed.data

    const { ok, adminDb } = await verifyRoomOwnership(roomId, user.id)
    if (!ok) return { error: 'Room not found or you do not own this room' }

    const { error } = await adminDb
      .from('lc_recording_sessions')
      .update({ duration_ms: durationMs, chunk_count: chunkCount })
      .eq('id', sessionId)
      .eq('room_id', roomId)
    if (error) {
      logger.error('finishAudioSession: update failed', error, { roomId, sessionId })
      return { error: 'Failed to finish audio session' }
    }
    return { success: true }
  } catch (error) {
    logger.error('finishAudioSession: unexpected error', error)
    return { error: 'An unexpected error occurred' }
  }
}

/**
 * Kick finalization for a room's recording. Called by the client once its
 * MediaRecorder has stopped and finishAudioSession has completed, so session
 * durations are accurate before the concat job runs. Idempotent (the finalize
 * worker claims atomically).
 */
export async function stopRecording(input: {
  roomId: string
}): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }
    const parsed = z.object({ roomId: uuid }).safeParse(input)
    if (!parsed.success) return { error: 'Invalid input' }
    const { roomId } = parsed.data

    const { ok } = await verifyRoomOwnership(roomId, user.id)
    if (!ok) return { error: 'Room not found or you do not own this room' }

    await triggerRecordingFinalize(roomId)
    return { success: true }
  } catch (error) {
    logger.error('stopRecording: unexpected error', error)
    return { error: 'An unexpected error occurred' }
  }
}

// ── Read (playback) ────────────────────────────────────────────────

/**
 * Assemble the playback blob for a room's recording. Access-gated (prof or
 * enrolled student). Returns { status:'none' } when there is no recording or the
 * caller lacks access; a non-'ready' status is surfaced so the player can show a
 * processing/failed state.
 */
export async function getRecording(roomId: string): Promise<RecordingData> {
  try {
    const user = await getAuthUser()
    if (!user) return { status: 'none' }
    if (!uuid.safeParse(roomId).success) return { status: 'none' }

    const { ok, adminDb, room } = await verifyRecordingAccess(roomId, user.id)
    if (!ok) return { status: 'none' }

    const { data: rec } = await adminDb.from('lc_recordings').select('*').eq('room_id', roomId).single()
    if (!rec) return { status: 'none' }
    if (rec.status !== 'ready') {
      // Lazy-on-view backstop: if the room has ended but the recording never got
      // finalized (the client stop kick was lost), kick it now. Fire-and-forget;
      // the caller polls the 'processing' state. Idempotent finalize claim.
      if (rec.status !== 'failed' && room?.status === 'ended') {
        void triggerRecordingFinalize(roomId)
        return { status: 'processing' }
      }
      return { status: rec.status }
    }

    // Audio sessions (sorted) → signed URLs.
    const { data: sessions } = await adminDb
      .from('lc_recording_sessions')
      .select('id, started_at, duration_ms, path')
      .eq('room_id', roomId)
      .order('started_at', { ascending: true })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sessionRows = (sessions ?? []).filter((s: any) => s.path && s.duration_ms != null)
    const audioSigned = await signMany(
      RECORDINGS_BUCKET,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionRows.map((s: any) => s.path),
      LIVE_CLASSROOM_SIGNED_URL_TTL,
    )
    const audio = sessionRows
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((s: any) => ({
        startedAt: new Date(s.started_at).getTime(),
        durationMs: s.duration_ms as number,
        url: audioSigned.get(s.path) ?? '',
      }))
      .filter((a: { startedAt: number; durationMs: number; url: string }) => a.url)

    // Slide-change spine.
    const timeline = Array.isArray(rec.timeline) ? rec.timeline : []
    const deckIds = Array.from(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new Set(timeline.map((t: any) => t.deck_id).filter(Boolean)),
    ) as string[]

    // Slide images per deck (one batch sign for the whole recording).
    const slideUrls: Record<string, string[]> = {}
    if (deckIds.length) {
      const { data: decks } = await adminDb
        .from('lc_decks')
        .select('id, deck_url, page_count')
        .in('id', deckIds)
      const allPaths: string[] = []
      const deckPaths: Record<string, string[]> = {}
      for (const d of decks ?? []) {
        if (!d.deck_url || !d.page_count) {
          deckPaths[d.id] = []
          continue
        }
        const prefix = d.deck_url.startsWith(`${DECKS_BUCKET}/`)
          ? d.deck_url.slice(DECKS_BUCKET.length + 1)
          : d.deck_url
        const paths = Array.from({ length: d.page_count }, (_, i) => `${prefix}/page-${i + 1}.webp`)
        deckPaths[d.id] = paths
        allPaths.push(...paths)
      }
      const signed = await signMany(DECKS_BUCKET, allPaths, LIVE_CLASSROOM_SIGNED_URL_TTL)
      for (const id of Object.keys(deckPaths)) {
        slideUrls[id] = deckPaths[id].map((p) => signed.get(p) ?? '')
      }
    }

    // Annotations (rendered on the current slide when their mapped time <= t).
    const { data: annos } = await adminDb
      .from('lc_slide_annotations')
      .select('deck_id, slide_index, stroke, created_at')
      .eq('room_id', roomId)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const annotations = (annos ?? []).map((a: any) => ({
      deckId: a.deck_id,
      slideIndex: a.slide_index,
      ts: new Date(a.created_at).getTime(),
      stroke: a.stroke,
    }))

    return {
      status: 'ready',
      durationMs: rec.duration_ms ?? undefined,
      audio,
      timeline,
      slideUrls,
      annotations,
    }
  } catch (error) {
    logger.error('getRecording: unexpected error', error)
    return { status: 'none' }
  }
}
