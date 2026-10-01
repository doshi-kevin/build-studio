// manualReviewQuestions — the confident-rejection routing rule shared by the
// whole-mode and hybrid graders. It is the ONLY thing that catches the failure
// mode where all-or-nothing grading silently under-credits attempted work: a
// high-value criterion confidently rejected, or an attempted question zeroed,
// raises no flag on its own, so without this a real 48% ships as a confident 4%.
//
// Pure function, no mocking. These pin the two triggers, the point boundary at
// exactly MANUAL_REVIEW_POINTS, attempted-vs-not, and the per-question rollup.

import { describe, it, expect } from 'vitest'
import {
  manualReviewQuestions,
  MANUAL_REVIEW_POINTS,
} from '@/lib/assignments/ai-grading/manual-review'
import type { CriterionRef, SuggestedCriterion } from '@/lib/assignments/ai-grading/types'

// Only the fields manualReviewQuestions reads are load-bearing; the rest satisfy
// the interfaces. Builders keep each test to just the axis under test.
function crit(questionIndex: number, points: number, criterionIndex = 0): CriterionRef {
  return {
    key: `${questionIndex}:${criterionIndex}`,
    questionIndex,
    questionLabel: `Q${questionIndex}`,
    criterionIndex,
    description: 'c',
    points,
    referenceAnswer: null,
    absoluteKeywords: [],
    keywordAliases: [],
    keywordResult: null,
    similarity: null,
  }
}

function sug(
  key: string,
  opts: { tick?: boolean; points?: number; evidence?: string },
): SuggestedCriterion {
  return {
    key,
    tick: opts.tick ?? false,
    suggestedPoints: opts.points ?? 0,
    rationale: 'r',
    flagged: false,
    evidence: opts.evidence ?? '',
    similarity: null,
  }
}

describe('manualReviewQuestions — material rejection trigger', () => {
  it('routes a rejected criterion worth exactly MANUAL_REVIEW_POINTS (boundary is inclusive)', () => {
    const criteria = [crit(0, MANUAL_REVIEW_POINTS)]
    const suggested = [sug('0:0', { tick: false })]
    expect(manualReviewQuestions(criteria, suggested)).toEqual([0])
  })

  it('leaves a rejected criterion one point below the threshold alone', () => {
    const criteria = [crit(0, MANUAL_REVIEW_POINTS - 1)]
    const suggested = [sug('0:0', { tick: false })]
    expect(manualReviewQuestions(criteria, suggested)).toEqual([])
  })

  it('does not route a high-value criterion that was TICKED (a confident accept, not a miss)', () => {
    const criteria = [crit(0, 12)]
    const suggested = [sug('0:0', { tick: true, points: 12 })]
    expect(manualReviewQuestions(criteria, suggested)).toEqual([])
  })
})

describe('manualReviewQuestions — attempted-but-zeroed trigger', () => {
  it('routes an attempted question scored zero out of a possible >= MANUAL_REVIEW_POINTS', () => {
    // Two small criteria (each below the material-miss bar) that sum past the
    // threshold; student attempted (evidence present) but earned nothing.
    const criteria = [crit(0, 3), crit(0, 3, 1)]
    const suggested = [
      sug('0:0', { tick: false, evidence: 'the student wrote this' }),
      sug('0:1', { tick: false, evidence: 'and this' }),
    ]
    expect(manualReviewQuestions(criteria, suggested)).toEqual([0])
  })

  it('does NOT route a zeroed question with no evidence (never attempted)', () => {
    const criteria = [crit(0, 3), crit(0, 3, 1)]
    const suggested = [
      sug('0:0', { tick: false, evidence: '' }),
      sug('0:1', { tick: false, evidence: '   ' }), // whitespace-only counts as no evidence
    ]
    expect(manualReviewQuestions(criteria, suggested)).toEqual([])
  })

  it('does NOT route an attempted question that earned partial credit', () => {
    const criteria = [crit(0, 3), crit(0, 3, 1)]
    const suggested = [
      sug('0:0', { tick: true, points: 3, evidence: 'attempted' }),
      sug('0:1', { tick: false, evidence: 'attempted' }),
    ]
    expect(manualReviewQuestions(criteria, suggested)).toEqual([])
  })

  it('does NOT route an attempted zeroed question whose total possible is below the threshold', () => {
    const criteria = [crit(0, 2), crit(0, 2, 1)] // possible 4 < 5
    const suggested = [
      sug('0:0', { tick: false, evidence: 'attempted' }),
      sug('0:1', { tick: false, evidence: 'attempted' }),
    ]
    expect(manualReviewQuestions(criteria, suggested)).toEqual([])
  })
})

describe('manualReviewQuestions — rollup and shape', () => {
  it('aggregates criteria by questionIndex and returns each flagged question once, sorted', () => {
    // Q2 has a material miss; Q0 is attempted-but-zeroed across two criteria;
    // Q1 is clean. Result must be sorted and deduped.
    const criteria = [
      crit(2, 8),
      crit(0, 3),
      crit(0, 3, 1),
      crit(1, 10),
    ]
    const suggested = [
      sug('2:0', { tick: false }), // material miss (8 >= 5)
      sug('0:0', { tick: false, evidence: 'x' }), // attempted, zeroed
      sug('0:1', { tick: false, evidence: 'y' }),
      sug('1:0', { tick: true, points: 10, evidence: 'z' }), // clean
    ]
    expect(manualReviewQuestions(criteria, suggested)).toEqual([0, 2])
  })

  it('skips criteria with no index-aligned suggestion instead of throwing', () => {
    const criteria = [crit(0, 8), crit(1, 8)]
    const suggested = [sug('0:0', { tick: false })] // only one suggestion
    expect(manualReviewQuestions(criteria, suggested)).toEqual([0])
  })

  it('returns [] for empty input', () => {
    expect(manualReviewQuestions([], [])).toEqual([])
  })
})
