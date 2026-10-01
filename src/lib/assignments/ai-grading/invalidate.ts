import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'

/**
 * Mark live AI grade suggestions as superseded so they stop showing to the professor.
 *
 * A suggestion is computed against a specific rubric AND a specific submission. When either
 * changes, the draft grade is stale: approving it would apply points derived from an outdated
 * rubric or a replaced submission. The professor's review query filters `status = 'suggested'`,
 * so flipping a row to 'superseded' removes it from view — the professor re-drafts against the
 * current state. Scope with whichever ids you hold (all present keys are ANDed):
 *   - `{ assignmentId }` — the rubric was re-saved, so EVERY submission's suggestion is stale.
 *   - `{ submissionId }` — a real grade was committed for that submission.
 *   - `{ assignmentId, studentId }` — the student resubmitted (the submit upsert keys on
 *     assignment+student, so the submission id isn't in hand).
 *
 * Only touches rows still `status = 'suggested'` (never re-touches already-superseded ones).
 * Best-effort: logs on failure and never throws — invalidation must not fail the rubric save,
 * the student submit, or the grade commit it hangs off. Requires the service-role admin client
 * (the table has no client write policy).
 */
export async function supersedeAiSuggestions(
  adminDb: SupabaseClient,
  filter: { assignmentId?: string; submissionId?: string; studentId?: string; institutionId?: string },
  reason: 'rubric-changed' | 'resubmitted' | 'graded',
): Promise<void> {
  // Guard against an unscoped update wiping every institution's suggestions.
  if (!filter.assignmentId && !filter.submissionId) {
    logger.warn('supersedeAiSuggestions: refused unscoped filter', { source: 'ai-grading.invalidate', reason })
    return
  }
  let q = adminDb
    .from('assignment_ai_grade_suggestions')
    .update({ status: 'superseded', updated_at: new Date().toISOString() })
    .eq('status', 'suggested')
  // institution_id is defence-in-depth: assignment_id/submission_id are already
  // globally-unique per institution, but scope explicitly when the caller has it (#16).
  if (filter.institutionId) q = q.eq('institution_id', filter.institutionId)
  if (filter.assignmentId) q = q.eq('assignment_id', filter.assignmentId)
  if (filter.submissionId) q = q.eq('submission_id', filter.submissionId)
  if (filter.studentId) q = q.eq('student_id', filter.studentId)
  const { error } = await q
  if (error) {
    logger.warn('supersedeAiSuggestions: failed', {
      source: 'ai-grading.invalidate',
      reason,
      ...filter,
      err: String(error),
    })
  }
}
