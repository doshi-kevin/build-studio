/**
 * Quiz "results available" notifications (Scholera Pulse).
 *
 * A quiz's SCORE is shown to the student the moment they submit, but when a quiz is set to
 * reveal answers "after due date" (show_explanations = 'after_due_date'), the correct answers
 * and explanations stay hidden until the due date passes. That due date is the natural
 * "results released" moment — so once it passes, this sweep notifies every student who
 * submitted the quiz that their full results are now available.
 *
 * Runs from /api/notifications/cron (every 5 min). Idempotent at the feed-item level:
 * emitEvent dedups on (recipient, type, entity_id = quiz id), so the 5-minute cadence and
 * retries never double-notify — no claim table needed. A rolling 48h window on due_date
 * bounds the work so long-past quizzes aren't reprocessed forever (best-effort, mirroring
 * the digest window). `force` widens the window for local testing. Never throws.
 */

import { logger } from '@/lib/logger'
import { emitEvent } from '@/lib/events/emit'

/** Only quizzes whose due date passed within this window are swept, so the query stays bounded. */
const WINDOW_MS = 2 * 24 * 60 * 60 * 1000 // 48h
const MAX_QUIZZES = 500
const MAX_ATTEMPTS = 20000

export interface QuizResultsSweepResult {
  dueQuizzes: number
  emitted: number
  skipped?: string
}

export async function runQuizResultsSweep(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminDb: any,
  opts: { force?: boolean } = {},
): Promise<QuizResultsSweepResult> {
  const now = new Date()
  const nowIso = now.toISOString()
  const windowStartIso = new Date(now.getTime() - WINDOW_MS).toISOString()

  // 1. Published "after due date" quizzes whose due date has just passed (rolling window).
  let query = adminDb
    .from('quizzes')
    .select('id, section_id, title, due_date')
    .eq('status', 'published')
    .eq('show_explanations', 'after_due_date')
    .not('due_date', 'is', null)
    .lt('due_date', nowIso)
    .order('due_date', { ascending: false })
    .limit(MAX_QUIZZES)
  if (!opts.force) query = query.gte('due_date', windowStartIso)

  const { data: quizRows, error } = await query
  if (error) {
    logger.error('runQuizResultsSweep: quizzes query failed', error)
    return { dueQuizzes: 0, emitted: 0 }
  }
  const quizzes = (quizRows ?? []) as Array<{ id: string; section_id: string; title: string }>
  if (quizzes.length === 0) {
    return { dueQuizzes: 0, emitted: 0, skipped: 'no due quizzes in window' }
  }

  // 2. Students who actually submitted (graded, not practice) — one batched query, no N+1.
  const quizIds = quizzes.map((q) => q.id)
  const { data: attemptRows } = await adminDb
    .from('quiz_attempts')
    .select('quiz_id, student_id')
    .in('quiz_id', quizIds)
    .eq('status', 'submitted')
    .eq('mode', 'graded')
    .limit(MAX_ATTEMPTS)
  const attempts = (attemptRows ?? []) as Array<{ quiz_id: string; student_id: string }>
  if (attempts.length === MAX_ATTEMPTS) {
    logger.warn('runQuizResultsSweep: attempts read hit row cap', { cap: MAX_ATTEMPTS })
  }
  const studentsByQuiz = new Map<string, Set<string>>()
  for (const a of attempts) {
    const set = studentsByQuiz.get(a.quiz_id) ?? new Set<string>()
    set.add(a.student_id) // a student may have several attempts — dedup here
    studentsByQuiz.set(a.quiz_id, set)
  }

  // 3. One notification per quiz to its attempters. emitEvent dedups per (recipient, type,
  //    quiz) so re-runs within the window are no-ops, and drops anyone who muted "Quiz results".
  let emitted = 0
  for (const quiz of quizzes) {
    const students = Array.from(studentsByQuiz.get(quiz.id) ?? [])
    if (students.length === 0) continue
    await emitEvent({
      type: 'quiz_result_released',
      sectionId: quiz.section_id,
      actorId: null, // system/time-based — never dropped as a self-notify
      audience: students,
      entity: { type: 'quiz', id: quiz.id },
      title: `Results available: ${quiz.title}`,
      linkUrl: `/student/courses/${quiz.section_id}/quizzes/${quiz.id}`,
      actionable: false,
    })
    emitted += 1
  }

  logger.info('runQuizResultsSweep: emitted', { emitted, dueQuizzes: quizzes.length })
  return { dueQuizzes: quizzes.length, emitted }
}
