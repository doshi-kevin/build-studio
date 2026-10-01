/**
 * Resolve the score to persist when the professor saves a grade.
 *
 * The score comes from exactly one source, decided by the grader UI (no silent cleverness):
 *   - the manual score field — when there's no rubric, or the professor chose "Keep this score"
 *     on a pre-rubric submission (`useManualField` true), OR
 *   - the rubric total — when grading with the rubric (ticked criteria summed; 0 ticks ⇒ 0,
 *     "start fresh" from the rubric).
 *
 * A submission graded before the rubric existed no longer auto-preserves its score on a stray
 * tick: the grader presents an explicit "Keep this score / Grade with the rubric" choice, and that
 * choice sets `useManualField`, so ticking a criterion can never silently overwrite the old score.
 *
 * Pure so the one-line decision is unit-tested independently of the component.
 */
export function resolveGradeValue(opts: {
  /** True when the score is the manual field (no rubric, or the professor kept the existing score). */
  useManualField: boolean
  /** The manual score-field value parsed to a number (may be NaN when blank). */
  manualScore: number
  /** Sum of the currently-ticked rubric criteria. */
  rubricTotal: number
}): number {
  return opts.useManualField ? opts.manualScore : opts.rubricTotal
}
