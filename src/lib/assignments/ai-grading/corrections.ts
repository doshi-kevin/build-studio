import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import type { SuggestedCriterion } from './types'

/**
 * Capture the criterion-level diff between a live AI grade suggestion and the grade the
 * professor just committed (calibration flywheel, phase 1a). One row per criterion the AI
 * judged, upserted on (submission_id, criterion_key) so a re-grade replaces the prior rows.
 *
 * Ghost-diff guard: the grader page sends the `updated_at` of the suggestion it rendered
 * (updated_at, not created_at — a re-suggest UPSERTS the row, so created_at survives and
 * cannot distinguish drafts). If the live suggestion was re-drafted since (bulk re-suggest
 * in another tab), the professor's decisions were made against a draft we no longer hold —
 * capturing a diff against the newer draft would corrupt the calibration signal, so skip.
 *
 * Best-effort: logs and returns on any failure — capture must never fail the grade save.
 * Requires the service-role admin client (the table has no client write policy).
 */
export async function captureGradingCorrections(
  adminDb: SupabaseClient,
  input: {
    submissionId: string
    /** Suggestion updated_at as the grader's page saw it. Absent → skip (stale bundle / no suggestion shown). */
    reviewedSuggestionUpdatedAt: string | undefined
    /** Criterion keys the professor committed as ticked. */
    committedRubricScores: string[]
    graderId: string
    /** aiGrading.embeddedAt from the assignment settings the caller already holds. A live
     *  'suggested' row implies the rubric wasn't re-saved since drafting (rubric saves
     *  supersede), so the current stamp is the version the suggestion was graded against. */
    rubricVersion: string | null
  },
): Promise<void> {
  const { submissionId, reviewedSuggestionUpdatedAt, committedRubricScores, graderId, rubricVersion } = input

  if (!reviewedSuggestionUpdatedAt) return

  try {
    // Tenant ids are read off the suggestion row itself (written server-side by the
    // version-guarded RPC), never from the caller.
    // The version match is a WHERE clause, not a JS comparison: Postgres compares
    // timestamptz at full microsecond precision and parses either ISO serialization
    // ("+00:00" or "Z") itself, while Date.parse truncates to milliseconds — which would
    // let two drafts stamped inside the same millisecond compare equal. No row back means
    // no current draft matching what the professor reviewed, so there is nothing to record.
    const { data: sugg, error } = await adminDb
      .from('assignment_ai_grade_suggestions')
      .select(
        'institution_id, section_id, assignment_id, student_id, rationale, confidence, model, updated_at',
      )
      .eq('submission_id', submissionId)
      .eq('status', 'suggested')
      .eq('updated_at', reviewedSuggestionUpdatedAt)
      .maybeSingle()
    if (error) {
      logger.warn('captureGradingCorrections: suggestion read failed, skipping capture', {
        source: 'ai-grading.corrections',
        submissionId,
        err: String(error),
      })
      return
    }
    if (!sugg) {
      logger.info('captureGradingCorrections: no live draft matching the reviewed version, skipping capture', {
        source: 'ai-grading.corrections',
        submissionId,
      })
      return
    }

    const criteria = (sugg.rationale ?? []) as SuggestedCriterion[]
    if (criteria.length === 0) return

    const ticked = new Set(committedRubricScores)
    const rows = criteria.map((c) => ({
      institution_id: sugg.institution_id,
      section_id: sugg.section_id,
      assignment_id: sugg.assignment_id,
      submission_id: submissionId,
      student_id: sugg.student_id,
      grader_id: graderId,
      criterion_key: c.key,
      ai_tick: c.tick,
      ai_points: c.suggestedPoints,
      ai_flagged: c.flagged,
      ai_confidence: sugg.confidence,
      ai_has_evidence: (c.evidence ?? '').trim().length > 0,
      professor_tick: ticked.has(c.key),
      model: sugg.model,
      rubric_version: rubricVersion,
      suggestion_updated_at: sugg.updated_at,
      updated_at: new Date().toISOString(),
    }))

    const { error: upsertError } = await adminDb
      .from('assignment_grading_corrections')
      .upsert(rows, { onConflict: 'submission_id,criterion_key' })
    if (upsertError) {
      logger.warn('captureGradingCorrections: upsert failed', {
        source: 'ai-grading.corrections',
        submissionId,
        err: String(upsertError),
      })
    }
  } catch (err) {
    logger.warn('captureGradingCorrections: unexpected failure, grade save unaffected', {
      source: 'ai-grading.corrections',
      submissionId,
      err: String(err),
    })
  }
}
