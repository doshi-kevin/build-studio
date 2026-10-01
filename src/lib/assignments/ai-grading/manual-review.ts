/**
 * Manual-review routing for confident rejections.
 *
 * The flag/confidence machinery only reacts to uncertain POSITIVE claims — an
 * unverifiable ticked criterion, a keyword miss, a missing model verdict. A
 * confident REJECTION ("ticked=false, here is the wrong answer, here is why")
 * raises nothing. But an all-or-nothing miss of a high-value criterion is exactly
 * where the grader silently under-credits partial work: a real 48% comes back as
 * a confident 4%. This routes those questions to manual grading so a near-zero on
 * attempted work can never be released as a finished grade.
 *
 * Pure + server-agnostic so both graders (whole-mode and hybrid) share one rule.
 */
import type { CriterionRef, SuggestedCriterion } from './types'

/**
 * A rejected criterion worth at least this many points, or an attempted question
 * scored zero out of at least this, routes that question to manual grading.
 * Sized to the rubric's high-stakes chunks (a 6- or 12-point criterion) while
 * leaving small single-point deductions alone. Tunable.
 */
export const MANUAL_REVIEW_POINTS = 5

/**
 * Question indexes that need manual grading because a confident rejection is
 * high-stakes — NOT because the answer was unlocatable. Two triggers per question:
 *   - a rejected criterion worth >= MANUAL_REVIEW_POINTS (a big binary miss), or
 *   - the student clearly attempted it yet earned 0 out of a possible
 *     >= MANUAL_REVIEW_POINTS. "Attempted" = the whole-mode grader quoted verbatim
 *     evidence, OR (hybrid mode, where rejected criteria carry no evidence) the
 *     criterion produced a similarity signal — both mean the student wrote something
 *     the grader could locate, not a blank.
 * `suggested` must be index-aligned with `criteria` (both graders build it so).
 */
export function manualReviewQuestions(
  criteria: CriterionRef[],
  suggested: SuggestedCriterion[],
): number[] {
  type Agg = { earned: number; possible: number; attempted: boolean; materialMiss: boolean }
  const byQuestion = new Map<number, Agg>()
  for (let i = 0; i < criteria.length; i++) {
    const c = criteria[i]
    const s = suggested[i]
    if (!s) continue
    const a = byQuestion.get(c.questionIndex) ?? { earned: 0, possible: 0, attempted: false, materialMiss: false }
    a.possible += c.points
    if (s.tick) a.earned += s.suggestedPoints
    // Whole-mode grader signals attempt via verbatim evidence; hybrid rejections carry no
    // evidence, so a present similarity signal is its attempt marker.
    if (s.evidence.trim() || s.similarity !== null) a.attempted = true
    if (!s.tick && c.points >= MANUAL_REVIEW_POINTS) a.materialMiss = true
    byQuestion.set(c.questionIndex, a)
  }
  const out: number[] = []
  for (const [qIdx, a] of byQuestion) {
    const attemptedButZeroed = a.attempted && a.earned <= 0 && a.possible >= MANUAL_REVIEW_POINTS
    if (a.materialMiss || attemptedButZeroed) out.push(qIdx)
  }
  return out.sort((x, y) => x - y)
}
