// Quiz history for the live-classroom "Past quizzes" surfaces (student +
// professor). Returns the closed quizzes of a section plus the caller's own
// data: a student's answers (answered-only) or the professor's stored report.
//
// Security: authenticates, then authorizes (section professor/staff OR enrolled
// student) BEFORE any data crosses back. All reads use the caller's RLS-scoped
// client (never the admin client), so even a logic gap can't leak another
// student's answers or another tenant's quizzes. Only CLOSED quizzes are
// returned, so correct answers are never exposed for an in-progress quiz.

'use server'

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { verifySectionAccess } from '@/lib/auth/section-access'
import { liveClassroomQueries } from '@/lib/supabase/queries'
import { logger } from '@/lib/logger'
import type { QuizReviewQuestion } from '@/lib/live-classroom/quiz-review'
import type { QuizReport } from '@/app/(dashboard)/professor/courses/[sectionId]/live-classroom/actions'

export interface QuizHistoryEntry {
  interactionId: string
  roomId: string
  title: string
  closedAt: string | null
  questions: QuizReviewQuestion[]
  /** Student mode: the caller's own answers ({ questionId: choiceId }). null for professors. */
  myAnswers: Record<string, string> | null
  /** Professor mode: the stored results report (null on quizzes closed without one). */
  report: QuizReport | null
}

export async function getSectionQuizHistory(
  sectionId: string,
): Promise<{ entries: QuizHistoryEntry[]; isProfessor: boolean; error?: string }> {
  try {
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return { entries: [], isProfessor: false, error: 'Not authenticated' }

    // Authorize: section professor/staff, OR an enrolled student of the section.
    const access = await verifySectionAccess(sectionId, user.id)
    const isProfessor = access.ok
    if (!isProfessor) {
      const { data: enrollment } = await supabase
        .from('enrollments')
        .select('id')
        .eq('section_id', sectionId)
        .eq('student_id', user.id)
        .in('status', ['enrolled', 'completed'])
        .maybeSingle()
      if (!enrollment) return { entries: [], isProfessor: false, error: 'Forbidden' }
    }

    const quizzes = await liveClassroomQueries.getClosedQuizzesForSection(supabase, sectionId)
    if (quizzes.length === 0) return { entries: [], isProfessor }

    // Student: attach their own answers (used for review + answered-only filter).
    const answersById = new Map<string, Record<string, string>>()
    if (!isProfessor) {
      const responses = await liveClassroomQueries.getMyResponsesForInteractions(
        supabase,
        quizzes.map((q) => q.id),
        user.id,
      )
      for (const r of responses) {
        const a = (r.response as { answers?: unknown })?.answers
        if (a && typeof a === 'object') answersById.set(r.interaction_id, a as Record<string, string>)
      }
    }

    const entries: QuizHistoryEntry[] = quizzes
      .map((q) => {
        const payload = q.payload as {
          title?: string
          questions?: QuizReviewQuestion[]
          report?: QuizReport
        }
        return {
          interactionId: q.id,
          roomId: q.room_id,
          title: payload.title ?? 'Quiz',
          closedAt: q.closed_at,
          // Professors don't need per-question correctChoiceId client-side
          // beyond the report, but students do for the review — both are
          // closed quizzes so exposure is intentional.
          questions: payload.questions ?? [],
          myAnswers: isProfessor ? null : answersById.get(q.id) ?? null,
          report: isProfessor ? payload.report ?? null : null,
        }
      })
      // Student list = answered-only.
      .filter((e) => isProfessor || e.myAnswers !== null)

    return { entries, isProfessor }
  } catch (error) {
    logger.error('getSectionQuizHistory', error, { sectionId })
    return { entries: [], isProfessor: false, error: 'Failed to load quiz history' }
  }
}

/**
 * Server-gated quiz answer reveal. Returns the full questions (with
 * correctChoiceId + explanation) ONLY when the caller is entitled — the room's
 * professor/staff, OR an enrolled student for whom the answers are unlocked:
 * the quiz is closed, or it has revealAnswers=true and they've submitted.
 *
 * This is THE delivery path for quiz answers to a student — the live payload
 * (snapshot + broadcast) is sanitized, so the reveal-on-submit and
 * reveal-on-close UIs fetch from here. Uses the admin client + explicit checks
 * so it stays correct independent of row-level read policies.
 */
export async function getQuizReveal(
  interactionId: string,
): Promise<{ questions?: QuizReviewQuestion[]; error?: string }> {
  try {
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return { error: 'Not authenticated' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    const { data: interaction } = await adminDb
      .from('lc_interactions')
      .select('id, room_id, kind, payload, status')
      .eq('id', interactionId)
      .single()
    if (!interaction || interaction.kind !== 'quiz') return { error: 'Quiz not found' }

    const { data: room } = await adminDb
      .from('lc_rooms')
      .select('section_id, prof_id')
      .eq('id', interaction.room_id)
      .single()
    if (!room) return { error: 'Quiz not found' }

    const payload = interaction.payload as {
      revealAnswers?: boolean
      questions?: QuizReviewQuestion[]
    }

    // Entitlement. Membership is checked FIRST, for everyone who is not the room's
    // professor — a 'closed' status is a reason to reveal answers to the class, not a
    // reason to skip asking who is asking. Previously `entitled` short-circuited on
    // status === 'closed' before the enrollment lookup, so anyone authenticated who
    // knew an interaction id could pull the full answer key and explanations for a
    // closed quiz in any section of any institution (the admin client bypasses the
    // lc_interactions RLS policy that would otherwise scope this read).
    const isProf = room.prof_id === user.id
    let entitled = isProf
    if (!isProf) {
      const { data: enrollment } = await adminDb
        .from('enrollments')
        .select('id')
        .eq('section_id', room.section_id)
        .eq('student_id', user.id)
        .in('status', ['enrolled', 'completed'])
        .maybeSingle()
      if (!enrollment) return { error: 'Forbidden' }

      if (interaction.status === 'closed') {
        // Quiz is over: the whole class may review it.
        entitled = true
      } else if (payload.revealAnswers === true) {
        // Still open: only if the prof opted into reveal-on-submit AND this
        // student has actually submitted.
        const { data: response } = await adminDb
          .from('lc_responses')
          .select('id')
          .eq('interaction_id', interactionId)
          .eq('student_id', user.id)
          .maybeSingle()
        entitled = !!response
      }
    }

    if (!entitled) return { error: 'Answers are not available yet' }
    return { questions: payload.questions ?? [] }
  } catch (error) {
    logger.error('getQuizReveal', error, { interactionId })
    return { error: 'Failed to load answers' }
  }
}
