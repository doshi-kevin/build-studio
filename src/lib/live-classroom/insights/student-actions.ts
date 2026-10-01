// Student-facing Class Insights reader. Returns the PII-free study blob plus
// THIS student's own per-quiz numbers, computed live from their own responses.
//
// Security (prevents IDOR): the "you" is always the authenticated caller —
// the action never accepts a studentId, and only ever reads the caller's own
// lc_responses. Enrollment is verified before any data crosses back; the blob
// is PII-free by construction and RLS is the backstop.

'use server'

import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import { getAuthUser, loadRoom, isEnrolled } from '@/lib/live-classroom/room-auth'
import { generateClassInsights } from '@/lib/live-classroom/insights/generate'
import { triggerClassInsights } from '@/lib/live-classroom/insights/trigger'
import { checkAiFeatureBySection } from '@/lib/ai/kill-switch'
import { aiRefusalMessage } from '@/lib/ai/ai-features'
import type { StudentInsightsContent } from '@/lib/validations/lc-class-insights'

const roomIdSchema = z.string().uuid()

/** A 'generating' row older than this is treated as crashed → re-kick. */
const STALE_GENERATING_MS = 5 * 60 * 1000

export interface MyQuizResult {
  interactionId: string
  /** Questions the student answered that exist in the quiz. */
  myTotal: number
  myCorrect: number
  /** % correct of answered questions; null if the student answered none. */
  myAccuracy: number | null
  /** questionId → the choice the student picked (for review highlighting). */
  myAnswers: Record<string, string>
}

export interface StudentInsightsResult {
  status: 'ready' | 'generating' | 'empty' | 'error'
  content?: StudentInsightsContent
  myQuizzes?: MyQuizResult[]
  error?: string
}

function pct(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0
}

export async function getStudentClassInsights(roomId: string): Promise<StudentInsightsResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { status: 'error', error: 'Not authenticated' }

    const parsed = roomIdSchema.safeParse(roomId)
    if (!parsed.success) return { status: 'error', error: 'Invalid room ID' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    const room = await loadRoom(adminDb, parsed.data)
    if (!room) return { status: 'error', error: 'Class not found' }
    if (room.status !== 'ended') return { status: 'error', error: 'This class is still live' }

    // Enrollment gate (the professor doesn't use this student endpoint).
    const enrolled = await isEnrolled(adminDb, room.section_id, user.id)
    if (!enrolled) return { status: 'error', error: 'You are not enrolled in this section' }

    let row = await readInsightsRow(adminDb, parsed.data)

    // Lazy recovery: never generated, or a crashed/failed run. Do NOT block the
    // request on the 30–60s LLM job (server-action timeout) and do NOT let many
    // students each fire a full generation — kick the async route and return
    // 'generating' so the client polls. Only when the kick can't fire (e.g.
    // local dev with no secret) fall back to in-process generation, which is
    // herd-safe because the orchestrator holds an atomic claim.
    /* The `ready` + extrasPending case is the one that used to strand a student
       permanently. Step A writes the deterministic content as `ready` with
       extrasPending true, then Step B patches it false. If Step B dies in between,
       the row is `ready` forever and the client polls forever on SUCCESSFUL
       responses — its own give-up counter only trips on fetch failures, so it never
       fires. Treating a long-pending row as stale gives the generation one more
       chance instead of spinning. Same window as a stalled `generating` row. */
    const stale = (at: string) => Date.now() - new Date(at).getTime() > STALE_GENERATING_MS
    const needsGenerate =
      !row ||
      row.status === 'failed' ||
      (row.status === 'generating' && stale(row.generated_at)) ||
      (row.status === 'ready' && row.content.extrasPending && stale(row.generated_at))
    if (needsGenerate) {
      // Institution/platform AI kill switch — refuse with a clear message instead
      // of kicking a generation that generateClassInsights would refuse anyway
      // (the student would poll 'generating' forever). Existing ready insights
      // above stay viewable.
      const aiVerdict = await checkAiFeatureBySection(adminDb, room.section_id, 'live-classroom-ai')
      if (!aiVerdict.allowed) return { status: 'error', error: aiRefusalMessage(aiVerdict.lockedBy) }
      const { kicked } = await triggerClassInsights(parsed.data)
      if (kicked) return { status: 'generating' }
      await generateClassInsights(parsed.data)
      row = await readInsightsRow(adminDb, parsed.data)
    }

    if (!row) return { status: 'error', error: 'Insights are not available for this class' }
    if (row.status === 'generating') return { status: 'generating' }
    if (row.content.empty) return { status: 'empty' }

    const myQuizzes = await computeMyQuizzes(adminDb, user.id, row.content)
    return { status: 'ready', content: row.content, myQuizzes }
  } catch (error) {
    logger.error('getStudentClassInsights: unexpected error', error)
    return { status: 'error', error: 'An unexpected error occurred' }
  }
}

interface InsightsRow {
  content: StudentInsightsContent
  status: 'generating' | 'ready' | 'failed'
  generated_at: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readInsightsRow(adminDb: any, roomId: string): Promise<InsightsRow | null> {
  const { data } = await adminDb
    .from('lc_class_insights_student')
    .select('content, status, generated_at')
    .eq('room_id', roomId)
    .maybeSingle()
  return (data as InsightsRow | null) ?? null
}

/** Compute the caller's own per-quiz score from their own responses only. */
async function computeMyQuizzes(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminDb: any,
  userId: string,
  content: StudentInsightsContent,
): Promise<MyQuizResult[]> {
  const quizIds = content.quizzes.map((q) => q.interactionId)
  if (quizIds.length === 0) return []

  const { data: rows } = await adminDb
    .from('lc_responses')
    .select('interaction_id, response')
    .eq('student_id', userId)
    .in('interaction_id', quizIds)
  const myResponseByQuiz = new Map<string, Record<string, string>>()
  for (const r of (rows ?? []) as Array<{ interaction_id: string; response: { answers?: Record<string, string> } }>) {
    myResponseByQuiz.set(r.interaction_id, r.response?.answers ?? {})
  }

  return content.quizzes.map((quiz) => {
    const myAnswers = myResponseByQuiz.get(quiz.interactionId) ?? {}
    const correctById = new Map(quiz.questions.map((q) => [q.id, q.correctChoiceId]))
    let myTotal = 0
    let myCorrect = 0
    for (const [qid, choiceId] of Object.entries(myAnswers)) {
      if (!correctById.has(qid)) continue
      myTotal++
      if (choiceId === correctById.get(qid)) myCorrect++
    }
    return {
      interactionId: quiz.interactionId,
      myTotal,
      myCorrect,
      myAccuracy: myTotal > 0 ? pct(myCorrect, myTotal) : null,
      myAnswers,
    }
  })
}
