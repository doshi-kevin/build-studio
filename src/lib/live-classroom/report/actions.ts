// Post-session report for the professor. Generated once per ended room
// (deterministic stats via computeSessionStats + a best-effort Gemini
// narrative), stored in lc_session_reports, and served from there on
// every later visit. The end-of-class orchestrator (insights/generate.ts)
// pre-generates this at room end; this action is the lazy fallback for
// rooms whose generation never ran, plus the narrative-retry path.
// See docs/designs/live-classroom/live-classroom-class-insights-design.md.
//
// Security: professor-only — the report contains absent/non-responder
// names and struggle analytics. Authenticates, then requires
// room.prof_id === caller before any data crosses back. All reads/writes
// use the admin client only after that check; lc_session_reports RLS
// (prof-only SELECT) is the backstop.

'use server'

import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { logEvent } from '@/lib/supabase/event-logger'
import { logger } from '@/lib/logger'
import { getAuthUser } from '@/lib/live-classroom/room-auth'
import { checkAiFeatureBySection } from '@/lib/ai/kill-switch'
import { aiRefusalMessage } from '@/lib/ai/ai-features'
import { type SessionReport } from './compute'
import {
  fetchDecksWithTranscripts,
  fetchSessionInputs,
  generateNarrative,
  buildProfessorReport,
} from '@/lib/live-classroom/insights/professor-report'

const roomIdSchema = z.string().uuid()

/** A 'generating' placeholder older than this is considered crashed. */
const GENERATING_TAKEOVER_MS = 2 * 60 * 1000

export interface SessionReportResult {
  report?: SessionReport
  /** Another request is building the report — poll again shortly. */
  generating?: boolean
  error?: string
}

interface GeneratingPlaceholder {
  status: 'generating'
}

export async function getOrGenerateSessionReport(
  roomId: string,
  options?: { retryNarrative?: boolean },
): Promise<SessionReportResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = roomIdSchema.safeParse(roomId)
    if (!parsed.success) return { error: 'Invalid room ID' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    const { data: room, error: roomError } = await adminDb
      .from('lc_rooms')
      .select('id, section_id, prof_id, status, created_at, started_at, ended_at')
      .eq('id', parsed.data)
      .single()

    if (roomError || !room) return { error: 'Session not found' }
    if (room.prof_id !== user.id) return { error: 'Session not found' }
    if (room.status !== 'ended') return { error: 'The class is still live — end it to get its report' }

    // Institution/platform AI kill switch. Already-generated reports stay
    // viewable (they're stored data, not a new model call); only NEW generation
    // and narrative retries are refused below.
    const aiVerdict = await checkAiFeatureBySection(adminDb, room.section_id, 'live-classroom-ai')

    // ── Cache / in-flight check ──
    const { data: existing } = await adminDb
      .from('lc_session_reports')
      .select('report, generated_at')
      .eq('room_id', parsed.data)
      .maybeSingle()

    if (existing) {
      const stored = existing.report as SessionReport | GeneratingPlaceholder
      if ((stored as GeneratingPlaceholder).status === 'generating') {
        const ageMs = Date.now() - new Date(existing.generated_at).getTime()
        if (ageMs < GENERATING_TAKEOVER_MS) return { generating: true }
        if (!aiVerdict.allowed) return { error: aiRefusalMessage(aiVerdict.lockedBy) }
        // Crashed mid-generation. Atomically re-claim before regenerating —
        // compare-and-swap on the stale generated_at we just read, so two
        // requests hitting this takeover path together don't both fire the
        // paid LLM call. The loser sees zero rows and polls instead.
        const { data: reclaimed } = await adminDb
          .from('lc_session_reports')
          .update({ generated_at: new Date().toISOString() })
          .eq('room_id', parsed.data)
          .eq('generated_at', existing.generated_at)
          .select('room_id')
        if (!reclaimed || reclaimed.length === 0) return { generating: true }
      } else {
        const report = stored as SessionReport
        if (options?.retryNarrative && report.narrativeFailed && !report.empty && aiVerdict.allowed) {
          return retryNarrativeOnly(adminDb, parsed.data, report)
        }
        return { report }
      }
    } else {
      if (!aiVerdict.allowed) return { error: aiRefusalMessage(aiVerdict.lockedBy) }
      // ── Double-generation guard: claim the room_id PK. Losing the race
      // (row already exists) means another request is generating — poll.
      const placeholder: GeneratingPlaceholder = { status: 'generating' }
      const { data: claimed } = await adminDb
        .from('lc_session_reports')
        .upsert(
          { room_id: parsed.data, report: placeholder, generated_at: new Date().toISOString() },
          { onConflict: 'room_id', ignoreDuplicates: true },
        )
        .select('room_id')
      if (!claimed || claimed.length === 0) return { generating: true }
    }

    // ── Fetch + compute (pure) + narrate (best-effort) ──
    const input = await fetchSessionInputs(adminDb, room)
    const report = await buildProfessorReport(input)

    const { error: storeError } = await adminDb
      .from('lc_session_reports')
      .update({ report, status: 'ready', generated_at: new Date().toISOString() })
      .eq('room_id', parsed.data)

    if (storeError) {
      logger.error('getOrGenerateSessionReport: store failed', storeError, { roomId: parsed.data })
      // Report was computed fine — serve it even if persisting failed.
    }

    logEvent({
      userId: user.id,
      eventType: 'lc_room.session_report_generated',
      eventCategory: 'professor',
      metadata: {
        roomId: parsed.data,
        empty: report.empty,
        narrativeFailed: report.narrativeFailed,
        quizCount: report.quizzes.length,
        attendedCount: report.attendance.attendedCount,
      },
      sectionId: room.section_id,
    })

    return { report }
  } catch (error) {
    logger.error('getOrGenerateSessionReport: Unexpected error', error)
    return { error: 'An unexpected error occurred' }
  }
}

/**
 * Re-run only the narrative for a stored report whose AI step failed.
 * Stats are never recomputed — they're already final.
 */
async function retryNarrativeOnly(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminDb: any,
  roomId: string,
  report: SessionReport,
): Promise<SessionReportResult> {
  const decks = await fetchDecksWithTranscripts(adminDb, roomId)
  const hasTranscript = decks.some((d) => d.transcriptions.some((t) => t.text.trim().length > 0))
  if (!hasTranscript) return { report }

  const { narrative, failed } = await generateNarrative(report, decks)
  if (failed) return { report } // unchanged; UI keeps the retry affordance

  const updated: SessionReport = { ...report, aiNarrative: narrative, narrativeFailed: false }
  const { error } = await adminDb
    .from('lc_session_reports')
    .update({ report: updated })
    .eq('room_id', roomId)
  if (error) {
    logger.warn('retryNarrativeOnly: store failed', { roomId, error: String(error?.message ?? error) })
  }
  return { report: updated }
}
