// Class Insights generation orchestrator. Runs once when a live class ends
// (fired by endRoom via the internal /api/live-classroom/generate-insights
// route; the GHA sweep re-runs failures). Idempotent on room_id.
//
// Split fast/slow (per design review): the deterministic professor report and
// the deterministic student blob are written FIRST so the analytics + quiz
// review are available quickly; the slow best-effort LLM extras (lecture
// summary, flashcards, practice quiz) are patched into the student blob after.
// A trivially-empty room skips all LLM work.
//
// Security: server-only, admin client. The caller (the internal route) is
// gated by a shared secret; this never trusts a user session. The student blob
// is PII-free by construction (see compute-student.ts).

import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import { checkAiFeatureBySection } from '@/lib/ai/kill-switch'
import { aiRefusalMessage } from '@/lib/ai/ai-features'
import { buildLectureContext } from '@/lib/live-classroom/lecture-context'
import { LIVE_QUIZ_MAX_CONTEXT_CHARS } from '@/lib/ai/config'
import {
  summarizeLectureContent,
  generateFlashcards,
  generatePracticeQuiz,
} from '@/lib/ai/llm-client'
import type { ExtractionPageData } from '@/lib/validations/document-extraction'
import type { SessionReportInput } from '@/lib/live-classroom/report/compute'
import { fetchSessionInputs, buildProfessorReport, type ReportRoom } from './professor-report'
import { computeStudentInsights } from './compute-student'
import { runTranscriptExtraction } from './transcript-insights'
import { runTranscriptEmbedding } from '@/lib/pinecone/transcript-ingest'
import type { ExtractionDeck } from './transcript-extraction'
import type { StudentInsightsContent } from '@/lib/validations/lc-class-insights'

export interface GenerateInsightsResult {
  ok: boolean
  empty?: boolean
  /** Another run already holds the generation claim — this call did nothing. */
  alreadyRunning?: boolean
  error?: string
}

/** A 'generating' claim older than this is treated as crashed and reclaimed. */
const STALE_CLAIM_MS = 5 * 60 * 1000

/**
 * Atomically claim the student insights row for this room so concurrent
 * triggers (a failed kick + 50 students opening + the sweep) don't all run the
 * paid LLM generation. Returns true if we won the claim, false if someone else
 * holds a fresh one. Mirrors the report action's compare-and-set pattern.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function claimGeneration(adminDb: any, roomId: string): Promise<boolean> {
  const placeholder = { version: 1, empty: false } // overwritten by step A; never read while 'generating'
  const now = new Date().toISOString()

  const { data: existing } = await adminDb
    .from('lc_class_insights_student')
    .select('status, generated_at')
    .eq('room_id', roomId)
    .maybeSingle()

  if (!existing) {
    const { data: claimed } = await adminDb
      .from('lc_class_insights_student')
      .upsert(
        { room_id: roomId, content: placeholder, status: 'generating', generated_at: now },
        { onConflict: 'room_id', ignoreDuplicates: true },
      )
      .select('room_id')
    return !!claimed && claimed.length > 0
  }

  if (existing.status === 'generating' && Date.now() - new Date(existing.generated_at).getTime() < STALE_CLAIM_MS) {
    return false // a fresh run is in flight
  }

  // Stale / ready / failed → reclaim by compare-and-set on the value we read.
  const { data: reclaimed } = await adminDb
    .from('lc_class_insights_student')
    .update({ status: 'generating', generated_at: now })
    .eq('room_id', roomId)
    .eq('generated_at', existing.generated_at)
    .select('room_id')
  return !!reclaimed && reclaimed.length > 0
}

/**
 * Build one combined lecture context (slide text + spoken transcript) across
 * every deck in the session, labelled per deck and truncated to the budget.
 * Page numbers repeat across decks, so each deck is processed independently
 * (like the report narrative) before concatenation.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildSessionLectureContext(adminDb: any, input: SessionReportInput) {
  const deckIds = input.decks.map((d) => d.id)
  const extractionByDeck = new Map<string, { pages?: ExtractionPageData[] } | null>()
  if (deckIds.length > 0) {
    const { data: rows } = await adminDb
      .from('lc_decks')
      .select('id, extraction')
      .in('id', deckIds)
    for (const r of (rows ?? []) as Array<{ id: string; extraction: unknown }>) {
      extractionByDeck.set(r.id, (r.extraction ?? null) as { pages?: ExtractionPageData[] } | null)
    }
  }

  let slideContent = ''
  let transcription = ''
  let slidesCovered = 0
  // The same decks in the shape the transcript extraction needs: per-slide
  // spoken rows kept apart (not concatenated into prose) so every extracted
  // quote can be anchored back to the slide it was said on.
  const extractionDecks: ExtractionDeck[] = []
  for (const deck of input.decks) {
    const extraction = extractionByDeck.get(deck.id) ?? null
    const ctx = buildLectureContext(extraction, deck.transcriptions)
    const label = deck.title?.trim() || `Deck ${deck.position}`
    if (ctx.slideContent.trim()) slideContent += `\n\n===== ${label} =====${ctx.slideContent}`
    if (ctx.transcriptionContent.trim()) transcription += `\n\n===== ${label} =====${ctx.transcriptionContent}`
    slidesCovered += ctx.slidesCovered
    extractionDecks.push({
      id: deck.id,
      title: deck.title,
      position: deck.position,
      transcriptions: deck.transcriptions,
      pages: (extraction?.pages ?? []).map((p) => ({ pageNumber: p.pageNumber, text: p.text })),
    })
  }

  const cap = (s: string) =>
    s.length > LIVE_QUIZ_MAX_CONTEXT_CHARS ? s.slice(0, LIVE_QUIZ_MAX_CONTEXT_CHARS) + '\n[...truncated]' : s
  return { slideContent: cap(slideContent), transcription: cap(transcription), slidesCovered, extractionDecks }
}

/**
 * Whether the session has any real lecture material to feed the LLM. With both
 * empty, Gemini gets no context and hallucinates (refusal text as the "summary",
 * questions about its own JSON system prompt) — so the extras are skipped.
 * Mirrors the professor narrative's `hasTranscript` guard.
 */
export function hasLectureMaterials(slideContent: string, transcription: string): boolean {
  return slideContent.trim().length > 0 || transcription.trim().length > 0
}

export async function generateClassInsights(roomId: string): Promise<GenerateInsightsResult> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    const { data: room, error: roomError } = await adminDb
      .from('lc_rooms')
      .select('id, section_id, name, created_at, started_at, ended_at, status, course_sections!inner(institution_id)')
      .eq('id', roomId)
      .single()
    if (roomError || !room) return { ok: false, error: 'Room not found' }
    if (room.status !== 'ended') return { ok: false, error: 'Room is not ended' }
    const sectionJoin = Array.isArray(room.course_sections) ? room.course_sections[0] : room.course_sections
    const institutionId: string | undefined = sectionJoin?.institution_id

    // Institution/platform AI kill switch — covers the secret-authenticated kick
    // route, the sweep, and the lazy student/professor fallbacks (they all funnel
    // here). Refuses BEFORE claiming, so the room can generate normally later if
    // the institution re-enables AI.
    const aiVerdict = await checkAiFeatureBySection(adminDb, room.section_id, 'live-classroom-ai')
    if (!aiVerdict.allowed) {
      return { ok: false, error: aiRefusalMessage(aiVerdict.lockedBy) }
    }

    // Atomic claim — bail if another run is already generating for this room.
    const won = await claimGeneration(adminDb, roomId)
    if (!won) return { ok: true, alreadyRunning: true }

    const reportRoom: ReportRoom = {
      id: room.id,
      section_id: room.section_id,
      created_at: room.created_at,
      started_at: room.started_at ?? null,
      ended_at: room.ended_at,
    }

    const input = await fetchSessionInputs(adminDb, reportRoom)

    // ── Step A: deterministic, written first so views render immediately ──
    // Student deterministic content (quiz review + suppressed aggregates) is
    // pure/instant — store it as `ready` right away with extrasPending=true so
    // the student sees their study content while the LLM extras generate.
    const studentContent = computeStudentInsights(input)
    await adminDb
      .from('lc_class_insights_student')
      .upsert(
        { room_id: roomId, content: studentContent, status: 'ready', generated_at: new Date().toISOString() },
        { onConflict: 'room_id' },
      )

    // Professor report (deterministic + its quick narrative LLM call).
    const report = await buildProfessorReport(input, { sectionId: room.section_id })
    await adminDb
      .from('lc_session_reports')
      .upsert(
        { room_id: roomId, report, status: 'ready', generated_at: new Date().toISOString() },
        { onConflict: 'room_id' },
      )

    // ── Min-content gate: nothing worth an LLM call (extrasPending already false) ──
    if (studentContent.empty) {
      return { ok: true, empty: true }
    }

    // ── Step B: slow, best-effort student study materials ──
    // Patch the already-`ready` row with the LLM extras and clear extrasPending.
    // The individual generators are best-effort (they return errors, not throws);
    // a throw here (e.g. context fetch) still clears extrasPending so the view
    // stops waiting and shows the per-section failed states.
    let finalContent: StudentInsightsContent
    try {
      const { slideContent, transcription, slidesCovered, extractionDecks } =
        await buildSessionLectureContext(adminDb, input)

      // No lecture audio/slide text (e.g. a quiz-only session) → don't call the
      // LLM with an empty context (it hallucinates). Mark noMaterials and stop;
      // the deterministic quiz review still renders.
      if (!hasLectureMaterials(slideContent, transcription)) {
        finalContent = { ...studentContent, extrasPending: false, noMaterials: true }
        await adminDb
          .from('lc_class_insights_student')
          .update({ content: finalContent, status: 'ready', generated_at: new Date().toISOString() })
          .eq('room_id', roomId)
        return { ok: true }
      }

      const attribution = { sectionId: room.section_id }
      const [summaryRes, flashRes, quizRes] = await Promise.all([
        summarizeLectureContent({ slideContent, transcription, slidesCovered }, attribution),
        generateFlashcards({ slideContent, transcription }, attribution),
        generatePracticeQuiz({ slideContent, transcription }, attribution),
        // Writes its own row (lc_transcript_insights) and never throws, so it
        // rides along here for the parallelism without joining the student
        // blob — different audience gate, different lifecycle.
        runTranscriptExtraction(adminDb, roomId, extractionDecks, attribution),
        // N1 — same posture: embeds the per-slide spoken text into Pinecone
        // (content class lecture_transcript) and never throws. Visibility is
        // enforced at hydration, so it runs regardless of the replay toggle.
        institutionId
          ? runTranscriptEmbedding({
              scope: { institutionId, sectionId: room.section_id },
              roomId,
              roomName: (room.name as string | null)?.trim() || 'Live class',
              decks: extractionDecks,
            })
          : Promise.resolve(
              logger.error('generateClassInsights: no institution for section — transcript not embedded', undefined, { roomId }),
            ),
      ])
      finalContent = {
        ...studentContent,
        extrasPending: false,
        summary: summaryRes.error ? null : summaryRes.summary,
        summaryFailed: !!summaryRes.error,
        flashcards: flashRes.error ? null : flashRes.cards,
        flashcardsFailed: !!flashRes.error,
        practiceQuiz: quizRes.error ? null : { questions: quizRes.questions },
        practiceQuizFailed: !!quizRes.error,
      }
    } catch (stepBError) {
      logger.error('generateClassInsights: study-materials step failed', stepBError, { roomId })
      finalContent = {
        ...studentContent,
        extrasPending: false,
        summaryFailed: true,
        flashcardsFailed: true,
        practiceQuizFailed: true,
      }
    }

    await adminDb
      .from('lc_class_insights_student')
      .update({ content: finalContent, status: 'ready', generated_at: new Date().toISOString() })
      .eq('room_id', roomId)

    return { ok: true }
  } catch (error) {
    logger.error('generateClassInsights: unexpected error', error, { roomId })
    // Mark the student blob failed so the view can offer a retry / the sweep
    // can pick it up; deterministic stats (if written) remain.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const adminDb = createAdminClient() as any
      await adminDb
        .from('lc_class_insights_student')
        .update({ status: 'failed' })
        .eq('room_id', roomId)
        .eq('status', 'generating')
    } catch {
      // best effort
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
