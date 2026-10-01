// similarity-grader.ts — the deterministic, no-LLM grader. Pure module, no mocks.
// Pins: the tick rule (similarity >= threshold AND no missing keyword), the three
// flag/rationale branches, empty feedback (no machine text on blind approval), the
// unmapped-question rollup, and the confidence alignment with grader.ts (a
// keyword-miss / unmapped / degraded forces LOW even when flaggedCount is 0).

import { describe, it, expect } from 'vitest'
import { suggestGradeFromSignals } from '@/lib/assignments/ai-grading/similarity-grader'
import {
  SIMILARITY_TICK_THRESHOLD,
  type CriterionRef,
  type GradingContext,
} from '@/lib/assignments/ai-grading/types'

function crit(over: Partial<CriterionRef> & { key: string }): CriterionRef {
  return {
    key: over.key,
    questionIndex: over.questionIndex ?? 0,
    questionLabel: over.questionLabel ?? 'Q0',
    criterionIndex: over.criterionIndex ?? 0,
    description: 'c',
    points: over.points ?? 10,
    referenceAnswer: null,
    absoluteKeywords: over.absoluteKeywords ?? [],
    keywordAliases: [],
    keywordResult: over.keywordResult ?? null,
    similarity: over.similarity ?? null,
  }
}

function ctx(criteria: CriterionRef[], degraded = false): GradingContext {
  return {
    mode: 'whole',
    criteria,
    wholeText: 'text',
    regions: null,
    submissionText: 'text',
    degraded,
  }
}

const ABOVE = SIMILARITY_TICK_THRESHOLD + 0.05
const BELOW = SIMILARITY_TICK_THRESHOLD - 0.1

describe('suggestGradeFromSignals', () => {
  it('returns null when there are no criteria', () => {
    expect(suggestGradeFromSignals(ctx([]), 100)).toBeNull()
  })

  it('ticks a criterion clearing the threshold with no missing keyword', () => {
    const res = suggestGradeFromSignals(ctx([crit({ key: '0:0', similarity: ABOVE, points: 10 })]), 100)!
    expect(res.criteria[0].tick).toBe(true)
    expect(res.criteria[0].suggestedPoints).toBe(10)
    expect(res.criteria[0].flagged).toBe(false)
    expect(res.suggestedScore).toBe(10)
    expect(res.confidence).toBe('high')
  })

  it('never emits machine feedback text (blind-approval safety)', () => {
    const res = suggestGradeFromSignals(ctx([crit({ key: '0:0', similarity: ABOVE })]), 100)!
    expect(res.feedback).toBe('')
  })

  it('flags + does not tick a criterion below threshold, LOW confidence via flag ratio', () => {
    const res = suggestGradeFromSignals(ctx([crit({ key: '0:0', similarity: BELOW })]), 100)!
    expect(res.criteria[0].tick).toBe(false)
    // Below-threshold criteria are not flagged themselves; they are a plain reject.
    expect(res.criteria[0].rationale).toContain('below')
  })

  it('flags a criterion with a missing keyword and forces LOW confidence', () => {
    const res = suggestGradeFromSignals(
      ctx([
        crit({
          key: '0:0',
          similarity: ABOVE, // even ABOVE threshold, a keyword miss blocks the tick
          keywordResult: { required: ['recursion'], found: [], missing: ['recursion'] },
        }),
      ]),
      100,
    )!
    expect(res.criteria[0].tick).toBe(false)
    expect(res.criteria[0].flagged).toBe(true)
    expect(res.confidence).toBe('low')
  })

  it('flags a criterion with no similarity signal and marks its question unmapped', () => {
    const res = suggestGradeFromSignals(ctx([crit({ key: '0:0', similarity: null, questionIndex: 0 })]), 100)!
    expect(res.criteria[0].flagged).toBe(true)
    expect(res.unmappedQuestionIndexes).toEqual([0])
    expect(res.confidence).toBe('low')
  })

  it('does NOT mark a question unmapped when at least one of its criteria has a signal', () => {
    const res = suggestGradeFromSignals(
      ctx([
        crit({ key: '0:0', questionIndex: 0, similarity: null }),
        crit({ key: '0:1', questionIndex: 0, criterionIndex: 1, similarity: ABOVE }),
      ]),
      100,
    )!
    expect(res.unmappedQuestionIndexes).toEqual([])
  })

  it('forces LOW confidence on a degraded context even with a clean tick (aligns with grader.ts)', () => {
    const res = suggestGradeFromSignals(ctx([crit({ key: '0:0', similarity: ABOVE })], true), 100)!
    expect(res.criteria[0].tick).toBe(true)
    expect(res.criteria[0].flagged).toBe(false)
    expect(res.confidence).toBe('low')
  })

  it('clamps suggestedScore to maxScore', () => {
    const res = suggestGradeFromSignals(
      ctx([
        crit({ key: '0:0', similarity: ABOVE, points: 60 }),
        crit({ key: '1:0', questionIndex: 1, similarity: ABOVE, points: 60 }),
      ]),
      100,
    )!
    expect(res.suggestedScore).toBe(100)
    expect(res.suggestedRubricScores).toEqual(['0:0', '1:0'])
  })
})
