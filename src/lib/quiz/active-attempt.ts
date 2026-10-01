// Is this student sitting a graded quiz right now?
//
// One definition, two callers: `/api/chat` (which refuses outright — G8) and the
// Athena shell's server action (which takes the button off the screen). They must
// agree, or the UI hides Athena when the route would answer, or worse the reverse.
//
// Two things the naive `status = 'in_progress'` read gets wrong:
//   · it is STUDENT-wide, not section-wide. A section-scoped lock is a one-tab
//     bypass — open another enrolled course and Athena answers there.
//   · an attempt that can no longer be submitted is not "in progress". Nothing
//     server-side ever flips an abandoned row to submitted (the timer is enforced
//     in the player), so without this an unsubmitted attempt would cost the
//     student Athena for the rest of the term.

import { resolveJoin } from '@/lib/supabase/resolve-join'
import { dueDeadlineMs } from '@/lib/quiz/utils'

/** Slack after a deadline before an attempt is considered un-submittable. */
const GRACE_MINUTES = 5

/** Backstop for attempts with neither a time limit nor a due date, so an
 *  abandoned one can't lock Athena forever. */
const OPEN_ENDED_MAX_HOURS = 24

export interface LiveQuizAttempt {
  quizTitle: string
}

interface AttemptRow {
  started_at: string | null
  quiz:
    | { title?: string | null; due_date?: string | null; time_limit_minutes?: number | null }
    | { title?: string | null; due_date?: string | null; time_limit_minutes?: number | null }[]
    | null
}

/** The moment after which this attempt can no longer be submitted. */
function deadlineOf(row: AttemptRow): number {
  const quiz = resolveJoin(row.quiz)
  const started = row.started_at ? Date.parse(row.started_at) : NaN
  const grace = GRACE_MINUTES * 60_000

  if (quiz?.time_limit_minutes && Number.isFinite(started)) {
    return started + quiz.time_limit_minutes * 60_000 + grace
  }
  // Same deadline as the server's checkDueDate — a date-only due date expires at the
  // END of that day. Parsing it raw put this ~24h earlier, so the attempt read as
  // dead (releasing the Athena lockdown and the live-attempt lock) while
  // submitAttempt was still accepting it (#311).
  const due = quiz?.due_date ? dueDeadlineMs(quiz.due_date) : NaN
  if (Number.isFinite(due)) return due + grace
  if (Number.isFinite(started)) return started + OPEN_ENDED_MAX_HOURS * 3_600_000
  // No started_at and no deadline to reason about: treat as live (fail closed).
  return Number.POSITIVE_INFINITY
}

/**
 * The student's live graded attempt in ANY course, or null.
 *
 * Throws if the read fails — a lock that silently fails open is worse than no
 * lock, so each caller decides explicitly (the route refuses, the UI doesn't).
 */
export async function findLiveQuizAttempt(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminDb: any,
  userId: string,
  nowMs: number = Date.now(),
): Promise<LiveQuizAttempt | null> {
  const { data, error } = await adminDb
    .from('quiz_attempts')
    .select('id, started_at, quiz:quizzes(title, due_date, time_limit_minutes)')
    .eq('student_id', userId)
    .eq('status', 'in_progress')
    .order('started_at', { ascending: false })
    .limit(20)

  if (error) throw new Error(`quiz_attempts read failed: ${error.message ?? 'unknown error'}`)

  for (const row of (data ?? []) as AttemptRow[]) {
    if (nowMs >= deadlineOf(row)) continue
    const quiz = resolveJoin(row.quiz)
    return { quizTitle: quiz?.title || 'a quiz' }
  }
  return null
}
