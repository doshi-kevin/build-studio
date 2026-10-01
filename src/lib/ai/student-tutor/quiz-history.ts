/**
 * The student's own reviewable quiz history — one read, two callers.
 *
 * Extracted when C11 needed the same rows `get_my_quiz_review` reads. Copying
 * them would have copied the retake guard below with them, and a security
 * filter that exists in two places is a security filter that will exist in one
 * of them after the next edit.
 */

import { reviewAnswer } from './quiz-review'
import { resolveJoin } from '@/lib/supabase/resolve-join'
import { canRevealQuizAnswers } from '@/lib/validations/quiz'
import type { AthenaStudentCtx } from './contract'

/** Withheld correct answer when the professor's reveal gate hasn't opened. */
const WITHHELD = '(not shown yet — the professor reveals answers later)'

export interface ReviewedQuestion {
  question: string
  correct: boolean
  earnedPoints: number | null
  points: number | null
  yourAnswer: string
  correctAnswer: string
}

export interface ReviewedQuiz {
  quiz: string
  scorePercent: number | null
  /** Most recent first, matching the attempt order. */
  submittedAt: string | null
  questions: ReviewedQuestion[]
}

/**
 * The caller's own submitted attempts, question by question, most recent first.
 *
 * A retake is the leak this guards: on a quiz the student has already submitted
 * once and is sitting again, the earlier attempt's review IS the answer key for
 * the live one. /api/chat already refuses while any attempt is open, but the key
 * must not be one query away if another caller ever wires these reads up.
 * Student-wide, matching the route — a section-scoped check would miss an
 * attempt open in another course.
 */
export async function fetchReviewableQuizzes(ctx: AthenaStudentCtx): Promise<ReviewedQuiz[]> {
  const { data: openAttempts, error: openErr } = await ctx.adminDb
    .from('quiz_attempts')
    .select('quiz_id')
    .eq('student_id', ctx.userId)
    .eq('status', 'in_progress')
  // Fail CLOSED: if we can't tell what's open, serve no answer keys at all.
  if (openErr) return []
  const openQuizIds = new Set(
    ((openAttempts ?? []) as Array<{ quiz_id: string | null }>)
      .map((a) => a.quiz_id)
      .filter(Boolean),
  )

  let attemptsQuery = ctx.adminDb
    .from('quiz_attempts')
    .select('id, score, submitted_at, quiz_id, quiz:quizzes(title, show_explanations, due_date)')
    .eq('section_id', ctx.sectionId)
    .eq('student_id', ctx.userId)
    .eq('status', 'submitted')
  if (openQuizIds.size > 0) {
    attemptsQuery = attemptsQuery.not('quiz_id', 'in', `(${[...openQuizIds].join(',')})`)
  }
  const { data: attempts } = await attemptsQuery
    .order('submitted_at', { ascending: false })
    .limit(5)

  const attemptIds = ((attempts ?? []) as Array<{ id: string }>).map((a) => a.id)
  if (attemptIds.length === 0) return []

  const { data: answers } = await ctx.adminDb
    .from('quiz_answers')
    .select(
      'attempt_id, question_id, is_correct, earned_points, selected_choice_ids, boolean_answer, text_answer, blank_answers',
    )
    .in('attempt_id', attemptIds)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const answerRows = (answers ?? []) as any[]
  const qIds = [...new Set(answerRows.map((r) => r.question_id))]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let questions: any[] = []
  if (qIds.length) {
    const res = await ctx.adminDb
      .from('quiz_questions')
      .select('id, question_text, question_type, content, points')
      .in('id', qIds)
    questions = res.data ?? []
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byQ = new Map<string, any>(questions.map((q) => [q.id, q]))

  return ((attempts ?? []) as Array<{
    id: string
    score: number | null
    submitted_at: string | null
    quiz:
      | { title?: string; show_explanations?: string | null; due_date?: string | null }
      | { title?: string; show_explanations?: string | null; due_date?: string | null }[]
      | null
  }>).map((att) => {
    const quiz = resolveJoin(att.quiz)
    /* The professor's reveal gate, applied exactly as the human review surface
       does (`getUnifiedResult` → `canReveal`). Until it opens, Athena reports
       right/wrong and points earned — which the human surface shows regardless —
       but withholds the correct answer, so "what did I get wrong" can't hand over
       the answer key before `after_due_date`. */
    const canReveal = canRevealQuizAnswers(
      quiz?.show_explanations as Parameters<typeof canRevealQuizAnswers>[0],
      quiz?.due_date ?? null,
    )
    const rows = answerRows
      .filter((r) => r.attempt_id === att.id)
      .map((r): ReviewedQuestion | null => {
        const q = byQ.get(r.question_id)
        if (!q) return null
        const { yourAnswer, correctAnswer } = reviewAnswer(q, r)
        return {
          question: (q.question_text ?? '').slice(0, 200),
          correct: !!r.is_correct,
          earnedPoints: r.earned_points,
          points: q.points,
          yourAnswer,
          correctAnswer: canReveal ? correctAnswer : WITHHELD,
        }
      })
      .filter((r): r is ReviewedQuestion => r !== null)
    return {
      quiz: quiz?.title ?? 'Untitled quiz',
      scorePercent: att.score,
      submittedAt: att.submitted_at,
      questions: rows,
    }
  })
}
