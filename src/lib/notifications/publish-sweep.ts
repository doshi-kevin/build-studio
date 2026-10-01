/**
 * Deferred-publish notification sweep (Scholera Pulse).
 *
 * Assignments published by the `publish_scheduled_assignments()` pg_cron job go
 * live via a direct SQL UPDATE — no server action runs, so the inline emit never
 * fires. This sweep closes that gap: it finds assignments that are published but
 * whose students haven't been notified yet, and emits `assignment_published`.
 *
 * Atomic claim-then-act (per `.claude/rules/data-access.md`): a SINGLE update stamps
 * `publish_notified_at` on every published-but-unnotified row and RETURNs the claimed
 * rows; we emit only for what this call actually claimed. A concurrent or retried
 * sweep matches zero of those rows in its WHERE, so no assignment is announced twice.
 *
 * Inline publish paths stamp `publish_notified_at` themselves, so the sweep only ever
 * picks up the scheduled path. emitEvent resolves the enrolled audience + writes the
 * shared feed_items.
 */

import { logger } from '@/lib/logger'
import { emitEvent } from '@/lib/events/emit'

interface ClaimedAssignment {
  id: string
  section_id: string
  title: string
  due_at: string | null
}

/**
 * Emit for assignments that went live without an inline emit (scheduled
 * auto-publishes). Returns how many assignments were claimed/emitted.
 *
 * @param adminDb a service-role Supabase client (bypasses RLS)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function sweepAssignmentPublishNotifications(adminDb: any): Promise<{
  claimed: number
}> {
  // Atomically claim published-but-unnotified assignments.
  const { data: claimedData, error: claimErr } = await adminDb
    .from('assignments')
    .update({ publish_notified_at: new Date().toISOString() })
    .eq('status', 'published')
    .is('publish_notified_at', null)
    .select('id, section_id, title, due_at')

  if (claimErr) {
    logger.error('sweepAssignmentPublishNotifications: claim failed', claimErr)
    return { claimed: 0 }
  }

  const claimed = (claimedData ?? []) as ClaimedAssignment[]
  if (claimed.length === 0) return { claimed: 0 }

  // Emit one event per claimed assignment; emitEvent resolves the enrolled audience.
  for (const a of claimed) {
    await emitEvent({
      type: 'assignment_published',
      sectionId: a.section_id,
      entity: { type: 'assignment', id: a.id },
      title: `New assignment: ${a.title}`,
      linkUrl: `/student/courses/${a.section_id}/assignments/${a.id}`,
      actionable: true,
      dueAt: a.due_at,
    })
  }

  logger.info('sweepAssignmentPublishNotifications: emitted', { claimed: claimed.length })
  return { claimed: claimed.length }
}

interface ClaimedQuiz {
  id: string
  section_id: string
  title: string
  due_date: string | null
}

/**
 * Quiz counterpart of the assignment sweep. Emits for quizzes that went live without an
 * inline emit — specifically the schedule_quiz_publish() pg_cron path, which flips a
 * scheduled quiz to 'published' via a direct SQL UPDATE (no server action, so no inline
 * notification). Same atomic claim-then-act shape: a single update stamps
 * publish_notified_at on every published-but-unnotified quiz and RETURNs the claimed rows.
 * Inline paths (publishQuiz, autoPublishScheduledQuizzes) stamp publish_notified_at
 * themselves, so this only ever picks up the pg_cron scheduled path.
 *
 * @param adminDb a service-role Supabase client (bypasses RLS)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function sweepQuizPublishNotifications(adminDb: any): Promise<{
  claimed: number
}> {
  const { data: claimedData, error: claimErr } = await adminDb
    .from('quizzes')
    .update({ publish_notified_at: new Date().toISOString() })
    .eq('status', 'published')
    .is('publish_notified_at', null)
    .select('id, section_id, title, due_date')

  if (claimErr) {
    logger.error('sweepQuizPublishNotifications: claim failed', claimErr)
    return { claimed: 0 }
  }

  const claimed = (claimedData ?? []) as ClaimedQuiz[]
  if (claimed.length === 0) return { claimed: 0 }

  // Time-based publish → no actor. emitEvent resolves the enrolled audience + dedups.
  for (const q of claimed) {
    await emitEvent({
      type: 'quiz_published',
      sectionId: q.section_id,
      entity: { type: 'quiz', id: q.id },
      title: `New quiz: ${q.title}`,
      linkUrl: `/student/courses/${q.section_id}/quizzes/${q.id}`,
      actionable: true,
      dueAt: q.due_date,
    })
  }

  logger.info('sweepQuizPublishNotifications: emitted', { claimed: claimed.length })
  return { claimed: claimed.length }
}
