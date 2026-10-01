// computeWithheldKeys — which criteria get evidence-first forcing (phase 2c).
//
// The boundary IS the behaviour: flagged, low-confidence-suggestion, or points >=
// HIGH_STAKES_POINTS criteria are withheld (never pre-ticked, verdict on request);
// everything else keeps the fast pre-filled path. A wrong boundary either floods the
// professor with friction (adoption dies) or pre-ticks exactly the criteria where a
// wrong draft costs the most (the automation-bias trap).

import { describe, it, expect } from 'vitest'
import {
  computeWithheldKeys,
  HIGH_STAKES_POINTS,
} from '@/components/professor/assignments/ProfessorAssignmentGrader'
import type { AiGradeSuggestion, SuggestedCriterion } from '@/lib/assignments/ai-grading/types'
import type { AssignmentRubric } from '@/lib/validations/assignment'

const rubric = {
  questions: [
    {
      label: 'Q1',
      points: 6,
      criteria: [
        { description: 'small clean', points: 1 },
        { description: 'small flagged', points: 1 },
        { description: 'big', points: HIGH_STAKES_POINTS },
        { description: 'just under', points: HIGH_STAKES_POINTS - 1 },
      ],
    },
  ],
} as AssignmentRubric

function crit(key: string, flagged: boolean): SuggestedCriterion {
  return { key, tick: true, suggestedPoints: 1, rationale: 'r', flagged, evidence: 'e', similarity: null }
}

function sug(criteria: SuggestedCriterion[], confidence: 'high' | 'medium' | 'low'): AiGradeSuggestion {
  return {
    criteria,
    suggestedRubricScores: criteria.filter((c) => c.tick).map((c) => c.key),
    suggestedScore: 0,
    feedback: '',
    confidence,
    flaggedCount: criteria.filter((c) => c.flagged).length,
    unmappedQuestionIndexes: [],
    model: 'test',
  }
}

describe('computeWithheldKeys', () => {
  it('withholds flagged criteria and >= HIGH_STAKES_POINTS criteria; leaves small clean ones fast', () => {
    const s = sug([crit('0:0', false), crit('0:1', true), crit('0:2', false), crit('0:3', false)], 'high')
    const withheld = computeWithheldKeys(rubric, s)
    expect(withheld.has('0:0')).toBe(false) // 1pt, clean → fast path
    expect(withheld.has('0:1')).toBe(true) // flagged
    expect(withheld.has('0:2')).toBe(true) // exactly at the points threshold
    expect(withheld.has('0:3')).toBe(false) // one under the threshold
  })

  it('withholds EVERY criterion of a low-confidence suggestion', () => {
    const s = sug([crit('0:0', false), crit('0:3', false)], 'low')
    const withheld = computeWithheldKeys(rubric, s)
    expect(withheld).toEqual(new Set(['0:0', '0:3']))
  })

  it('ignores keys that no longer resolve in the rubric, and handles missing inputs', () => {
    const s = sug([crit('9:9', true), crit('bad-key', true)], 'high')
    expect(computeWithheldKeys(rubric, s).size).toBe(0)
    expect(computeWithheldKeys(null, s).size).toBe(0)
    expect(computeWithheldKeys(rubric, undefined).size).toBe(0)
  })
})
