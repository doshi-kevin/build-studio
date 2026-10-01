// Student "Catch me up" — AI summary of the lecture so far, shared by
// the whole room. The summary is cached on lc_rooms.lecture_summary and
// regenerated at most every 2 minutes, so LLM cost is ~1 call per room
// per 2 minutes regardless of class size.
//
// Security: authenticates, then authorizes (enrolled student OR the
// room's professor) before any data crosses back. The section is always
// derived from the admin-fetched room row — never from client input.
// The summary contains only slide text + the professor's spoken words,
// which students already see/hear live.

'use server'

import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { logEvent } from '@/lib/supabase/event-logger'
import { logger } from '@/lib/logger'
import { getAuthUser, loadRoom, isEnrolled } from '@/lib/live-classroom/room-auth'
import { buildLectureContext } from '@/lib/live-classroom/lecture-context'
import { summarizeLectureContent } from '@/lib/ai/llm-client'
import { checkAiFeatureBySection } from '@/lib/ai/kill-switch'
import { aiRefusalMessage } from '@/lib/ai/ai-features'
import type { ExtractionPageData } from '@/lib/validations/document-extraction'

/** Serve the cached summary instead of regenerating when younger than this. */
const SUMMARY_CACHE_MS = 2 * 60 * 1000

const roomIdSchema = z.string().uuid()

export interface LectureSummaryResult {
  summary?: string
  generatedAt?: string
  /** True when an existing summary was served without a new AI call. */
  cached?: boolean
  error?: string
}

interface StoredSummary {
  text: string
  slidesCovered: number
  generatedAt: string
  /** The deck this summary covers. The cache is keyed to it so a deck switch
   *  invalidates the previous deck's summary instead of serving it for the new
   *  one. Absent on summaries cached before multi-deck shipped. */
  deckId?: string
}

export async function getLectureSummary(roomId: string): Promise<LectureSummaryResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = roomIdSchema.safeParse(roomId)
    if (!parsed.success) return { error: 'Invalid room ID' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    const room = await loadRoom(adminDb, parsed.data)
    if (!room) return { error: 'Room not found' }

    const isProf = room.prof_id === user.id
    if (!isProf) {
      const enrolled = await isEnrolled(adminDb, room.section_id, user.id)
      if (!enrolled) return { error: 'You are not enrolled in this section' }
    }

    // loadRoom selects a narrow column set; fetch the summary cache + active deck
    // + the per-session toggle.
    const { data: roomData, error: roomError } = await adminDb
      .from('lc_rooms')
      .select('lecture_summary, active_deck_id, lecture_summary_enabled')
      .eq('id', parsed.data)
      .single()

    if (roomError || !roomData) {
      logger.error('getLectureSummary: room fetch failed', roomError, { roomId: parsed.data })
      return { error: 'Failed to load lecture summary' }
    }

    // Per-session professor toggle. Gated for students (the only ones with a
    // "Catch me up" button); the professor can still inspect it. Checked before
    // both the live and ended-room paths so a disabled summary can't be served
    // retrospectively either. Defaults on when the column is absent (old rows).
    if (roomData.lecture_summary_enabled === false && !isProf) {
      return { error: 'Your professor has turned off Catch me up for this class.' }
    }

    const existing = roomData.lecture_summary as StoredSummary | null
    const activeDeckId = roomData.active_deck_id as string | null

    // Ended room: serve whatever exists (a student opening the recap right
    // after class shouldn't get an error), but never regenerate.
    if (room.status !== 'live') {
      if (existing) {
        return { summary: existing.text, generatedAt: existing.generatedAt, cached: true }
      }
      return { error: 'This class has ended' }
    }

    if (!activeDeckId) {
      return { error: 'Nothing to summarize yet — check back once the lecture is underway.' }
    }

    // Fresh cache, shared across the class — but only if it covers the deck
    // that's active now (a switch invalidates the previous deck's summary).
    if (
      existing &&
      existing.deckId === activeDeckId &&
      Date.now() - new Date(existing.generatedAt).getTime() < SUMMARY_CACHE_MS
    ) {
      return { summary: existing.text, generatedAt: existing.generatedAt, cached: true }
    }

    // Institution/platform AI kill switch — cached summaries above stay served
    // (stored data); only a NEW model call is refused.
    const aiVerdict = await checkAiFeatureBySection(adminDb, room.section_id, 'live-classroom-ai')
    if (!aiVerdict.allowed) return { error: aiRefusalMessage(aiVerdict.lockedBy) }

    // Stale or missing: regenerate for the active deck. Concurrent stale
    // requests may rarely double-generate — acceptable (last-write-wins).
    const { data: transcriptions, error: txError } = await adminDb
      .from('lc_transcriptions')
      .select('page_number, text')
      .eq('deck_id', activeDeckId)
      .order('page_number', { ascending: true })

    if (txError) {
      logger.error('getLectureSummary: transcription fetch failed', txError, { roomId: parsed.data })
      return { error: 'Failed to load lecture summary' }
    }

    const txRows = (transcriptions ?? []) as Array<{ page_number: number; text: string }>
    if (txRows.length === 0) {
      // Nothing taught yet — no AI call, nothing cached.
      return { error: 'Nothing to summarize yet — check back once the lecture is underway.' }
    }

    const { data: activeDeck } = await adminDb
      .from('lc_decks')
      .select('extraction')
      .eq('id', activeDeckId)
      .maybeSingle()

    const { slideContent, transcriptionContent, slidesCovered } = buildLectureContext(
      (activeDeck?.extraction ?? null) as { pages?: ExtractionPageData[] } | null,
      txRows,
    )

    const result = await summarizeLectureContent(
      {
        slideContent,
        transcription: transcriptionContent,
        slidesCovered,
      },
      { sectionId: room.section_id, userId: user.id },
    )

    if (result.error || !result.summary) {
      logger.error('getLectureSummary: generation failed', null, {
        roomId: parsed.data,
        error: result.error,
      })
      return { error: 'Could not generate a summary right now — please try again.' }
    }

    const stored: StoredSummary = {
      text: result.summary,
      slidesCovered,
      generatedAt: new Date().toISOString(),
      deckId: activeDeckId,
    }

    const { error: updateError } = await adminDb
      .from('lc_rooms')
      .update({ lecture_summary: stored })
      .eq('id', parsed.data)

    if (updateError) {
      // Cache write failed but the summary is valid — still serve it.
      logger.warn('getLectureSummary: cache write failed', { roomId: parsed.data, error: String(updateError?.message ?? updateError) })
    }

    logEvent({
      userId: user.id,
      eventType: 'lc_room.lecture_summary_generated',
      eventCategory: isProf ? 'professor' : 'student',
      metadata: { roomId: parsed.data, slidesCovered },
      sectionId: room.section_id,
    })

    return { summary: stored.text, generatedAt: stored.generatedAt, cached: false }
  } catch (error) {
    logger.error('getLectureSummary: Unexpected error', error)
    return { error: 'An unexpected error occurred' }
  }
}
