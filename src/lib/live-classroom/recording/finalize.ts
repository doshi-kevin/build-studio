// Recording finalize orchestrator. Concatenates each audio session's raw chunks
// into one playable WebM object and marks the recording ready.
//
// Byte-concatenation is valid because all chunks of ONE MediaRecorder session
// share a single container/header lineage (chunk 0 carries the header; the rest
// are clusters of the same stream). We NEVER concat across sessions — a tab
// reload starts a fresh session with its own header, so those stay separate
// objects the player switches between. No ffmpeg needed (Cloud Run's image
// doesn't ship it).
//
// Concurrency: an atomic status claim (recording|failed → processing, or a stale
// 'processing' reclaim) prevents two triggers (endRoom + GHA sweep) from racing.
// Raw chunks are kept until status flips to 'ready', so a mid-way crash is
// retriable.

import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import { RECORDING_TIMESLICE_MS } from './types'

const BUCKET = 'live-classroom-recordings'
const STALE_CLAIM_MS = 5 * 60 * 1000
// storage.list() defaults to 100 objects — at a 15s timeslice that's only 25 min
// of audio, so a longer lecture would be silently truncated. Ask for enough to
// cover many hours of chunks (10000 × 15s ≈ 41h).
const CHUNK_LIST_LIMIT = 10000

/** Parse the seq from a `chunk-<n>.webm` object name, or -1 if it doesn't match. */
function chunkSeq(name: string): number {
  const m = /^chunk-(\d+)\.webm$/.exec(name)
  return m ? Number(m[1]) : -1
}

export async function finalizeRecording(roomId: string): Promise<{ ok: boolean; error?: string }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any

  // Atomic claim: recording|failed → processing.
  const { data: claimed } = await adminDb
    .from('lc_recordings')
    .update({ status: 'processing', generation_started_at: new Date().toISOString() })
    .eq('room_id', roomId)
    .in('status', ['recording', 'failed'])
    .select('room_id')

  if (!claimed || claimed.length === 0) {
    // Maybe a previous attempt is stuck in 'processing' — reclaim if stale.
    const staleBefore = new Date(Date.now() - STALE_CLAIM_MS).toISOString()
    const { data: reclaimed } = await adminDb
      .from('lc_recordings')
      .update({ status: 'processing', generation_started_at: new Date().toISOString() })
      .eq('room_id', roomId)
      .eq('status', 'processing')
      .lt('generation_started_at', staleBefore)
      .select('room_id')
    if (!reclaimed || reclaimed.length === 0) {
      // Already ready, no recording, or another worker holds a fresh claim.
      return { ok: true }
    }
  }

  try {
    const { data: sessions } = await adminDb
      .from('lc_recording_sessions')
      .select('*')
      .eq('room_id', roomId)
      .order('started_at', { ascending: true })

    let totalDuration = 0
    for (const s of sessions ?? []) {
      if (s.path) {
        // Already concatenated on a prior attempt.
        totalDuration += s.duration_ms ?? 0
        continue
      }
      // Discover chunks from storage (robust to finishAudioSession timing) and
      // concatenate in seq order. Same-session chunks share one WebM header
      // lineage, so raw byte concat is valid.
      const dir = `${roomId}/${s.id}`
      const { data: entries } = await adminDb.storage.from(BUCKET).list(dir, { limit: CHUNK_LIST_LIMIT })
      const chunkNames = (entries ?? [])
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((e: any) => e.name as string)
        .filter((n: string) => chunkSeq(n) >= 0)
        .sort((a: string, b: string) => chunkSeq(a) - chunkSeq(b))
      const parts: Uint8Array[] = []
      for (const name of chunkNames) {
        const { data: blob, error } = await adminDb.storage.from(BUCKET).download(`${dir}/${name}`)
        if (error || !blob) {
          logger.warn('finalizeRecording: missing chunk, skipping', { roomId, sessionId: s.id, name })
          continue
        }
        parts.push(new Uint8Array(await blob.arrayBuffer()))
      }
      if (parts.length === 0) continue
      // Prefer the client-reported length; fall back to an estimate from the
      // number of timeslice chunks when a session closed without reporting.
      const sessionDuration = s.duration_ms ?? parts.length * RECORDING_TIMESLICE_MS

      const totalBytes = parts.reduce((n, p) => n + p.length, 0)
      const merged = new Uint8Array(totalBytes)
      let offset = 0
      for (const p of parts) {
        merged.set(p, offset)
        offset += p.length
      }

      const finalPath = `${roomId}/${s.id}.webm`
      const { error: upErr } = await adminDb.storage
        .from(BUCKET)
        .upload(finalPath, merged, { contentType: 'audio/webm', upsert: true })
      if (upErr) {
        logger.error('finalizeRecording: upload failed', upErr, { roomId, sessionId: s.id })
        throw upErr
      }
      // Persist path + resolved duration so getRecording (which filters on
      // duration_ms != null) includes this session even if it never reported.
      await adminDb
        .from('lc_recording_sessions')
        .update({ path: finalPath, duration_ms: sessionDuration })
        .eq('id', s.id)
      totalDuration += sessionDuration
    }

    await adminDb
      .from('lc_recordings')
      .update({ status: 'ready', duration_ms: totalDuration, ended_at: new Date().toISOString() })
      .eq('room_id', roomId)

    // Now safe to remove raw chunks — the concatenated objects exist and the
    // recording is marked ready.
    for (const s of sessions ?? []) {
      const dir = `${roomId}/${s.id}`
      const { data: entries } = await adminDb.storage.from(BUCKET).list(dir, { limit: CHUNK_LIST_LIMIT })
      if (entries?.length) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await adminDb.storage.from(BUCKET).remove(entries.map((e: any) => `${dir}/${e.name}`))
      }
    }

    return { ok: true }
  } catch (err) {
    await adminDb.from('lc_recordings').update({ status: 'failed' }).eq('room_id', roomId)
    logger.error('finalizeRecording: failed', err, { roomId })
    return { ok: false, error: 'finalize failed' }
  }
}
