/**
 * Similarity-only grader (experimental, no LLM call).
 *
 * Deterministic replacement for suggestGradeFromContext, enabled via
 * AI_GRADING_SIMILARITY_ONLY=1 (see suggest.ts): a criterion is ticked when
 *   - its max passage cosine >= SIMILARITY_TICK_THRESHOLD, AND
 *   - no required keyword is missing.
 * Criteria without a similarity signal (no reference answer, embed failure)
 * are never ticked and are flagged for manual review.
 *
 * Evidence is always empty (there is no model to quote a passage) and feedback
 * is left blank so no machine text can reach a student on blind approval.
 *
 * Pure: no server-only import, no I/O — unit-testable directly.
 */

import {
  SIMILARITY_TICK_THRESHOLD,
  type GradingContext,
  type SuggestedCriterion,
  type AiGradeSuggestion,
} from './types'

export const SIMILARITY_ONLY_MODEL = 'similarity-only-v1'

export function suggestGradeFromSignals(
  context: GradingContext,
  maxScore: number,
): AiGradeSuggestion | null {
  const { criteria } = context
  if (criteria.length === 0) return null

  let flaggedCount = 0
  const simByQuestion = new Map<number, boolean[]>()

  const suggestedCriteria: SuggestedCriterion[] = criteria.map((crit) => {
    const missing = crit.keywordResult?.missing ?? []
    let tick = false
    let flagged = false
    let rationale: string

    if (crit.similarity === null) {
      flagged = true
      rationale = 'No similarity signal for this criterion, review manually.'
    } else if (missing.length > 0) {
      flagged = true
      rationale = `Missing required term(s): ${missing.join(', ')}.`
    } else if (crit.similarity >= SIMILARITY_TICK_THRESHOLD) {
      tick = true
      rationale =
        `Similarity ${crit.similarity.toFixed(2)} meets the ${SIMILARITY_TICK_THRESHOLD} threshold` +
        (crit.absoluteKeywords.length > 0 ? ', all required terms present.' : '.')
    } else {
      rationale = `Similarity ${crit.similarity.toFixed(2)} is below the ${SIMILARITY_TICK_THRESHOLD} threshold.`
    }

    if (flagged) flaggedCount++
    if (!simByQuestion.has(crit.questionIndex)) simByQuestion.set(crit.questionIndex, [])
    simByQuestion.get(crit.questionIndex)!.push(crit.similarity !== null)

    return {
      key: crit.key,
      tick,
      suggestedPoints: tick ? crit.points : 0,
      rationale,
      flagged,
      evidence: '',
      similarity: crit.similarity,
    }
  })

  // Unmapped = questions where no criterion had any similarity signal.
  const unmappedQuestionIndexes = Array.from(simByQuestion.entries())
    .filter(([, hasSignal]) => hasSignal.every((h) => !h))
    .map(([qIdx]) => qIdx)
    .sort((a, b) => a - b)

  const rawScore = suggestedCriteria.reduce((sum, c) => sum + (c.tick ? c.suggestedPoints : 0), 0)
  const suggestedScore = Math.min(Math.max(Math.round(rawScore * 100) / 100, 0), maxScore)

  // Same confidence rules as the LLM grader (grader.ts) so UI triage behaves identically:
  // unmapped / degraded / keyword-miss force LOW *regardless* of flaggedCount — a
  // `flaggedCount === 0` short-circuit to 'high' would bury a signal-blind or
  // unlocatable-answer grade (aligns branch order with grader.ts #1).
  const hasKeywordMiss = criteria.some((c) => (c.keywordResult?.missing.length ?? 0) > 0)
  let confidence: 'high' | 'medium' | 'low'
  if (
    hasKeywordMiss ||
    unmappedQuestionIndexes.length > 0 ||
    context.degraded ||
    flaggedCount / suggestedCriteria.length > 1 / 3
  ) {
    confidence = 'low'
  } else if (flaggedCount === 0) {
    confidence = 'high'
  } else {
    confidence = 'medium'
  }

  return {
    criteria: suggestedCriteria,
    suggestedRubricScores: suggestedCriteria.filter((c) => c.tick).map((c) => c.key),
    suggestedScore,
    feedback: '',
    confidence,
    flaggedCount,
    unmappedQuestionIndexes,
    model: SIMILARITY_ONLY_MODEL,
  }
}
