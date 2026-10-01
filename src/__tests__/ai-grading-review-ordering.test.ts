// requiresManualGrading + orderForReview — the RELATIVE "requires manual grading"
// threshold and the review-order ranking on the professor grader roster (E3).
//
// Why this is pinned: the threshold went from an absolute count to
// `unmapped >= max(1, ceil(gradedQuestionCount / 3))`. The whole point of the
// change is the boundary behaviour — a 1-question rubric must flag on its single
// bad answer, a 20-question exam must NOT flag on one stray unmappable part — and
// the exactly-at-threshold case decides whether a submission gets the loud tag and
// jumps to the top of the pile. orderForReview's rank 0..3 also changed (a new
// severe tier was inserted at 0), so the relative ordering across all four tiers
// is worth one assertion.
//
// Pure functions, no mocking. Only the fields these two read are load-bearing;
// builders keep each test to the axis under test.

import { describe, it, expect } from 'vitest'
import {
  requiresManualGrading,
  orderForReview,
  MANUAL_GRADING_SEVERE_FRACTION,
  type StudentEntry,
} from '@/components/professor/assignments/ProfessorAssignmentGrader'
import type { AiGradeSuggestion } from '@/lib/assignments/ai-grading/types'

// Minimal suggestion — only unmappedQuestionIndexes / flaggedCount / confidence
// are read by the functions under test; the rest satisfy the interface.
function sug(opts: {
  unmapped?: number[]
  flaggedCount?: number
  confidence?: 'high' | 'medium' | 'low'
}): AiGradeSuggestion {
  return {
    criteria: [],
    suggestedRubricScores: [],
    suggestedScore: 0,
    feedback: '',
    confidence: opts.confidence ?? 'high',
    flaggedCount: opts.flaggedCount ?? 0,
    unmappedQuestionIndexes: opts.unmapped ?? [],
    model: 'test',
  }
}

// A StudentEntry carrying (or not carrying) a suggestion. id is the only other
// field orderForReview needs to stay stable/identifiable.
function entry(id: string, suggestion?: AiGradeSuggestion): StudentEntry {
  return {
    id,
    name: id,
    email: `${id}@x.test`,
    submission: suggestion
      ? {
          id: `sub-${id}`,
          status: 'submitted',
          text: '',
          files: [],
          score: null,
          feedback: '',
          submittedAt: '2026-01-01',
          rubricScores: [],
          suggestion,
        }
      : null,
  }
}

describe('requiresManualGrading — relative threshold (E3)', () => {
  it('flags a 1-question rubric on its single unmappable answer (threshold floors at 1)', () => {
    // ceil(1/3) = 1, max(1,1) = 1 → one unmapped question trips it.
    expect(requiresManualGrading(sug({ unmapped: [0] }), 1)).toBe(true)
  })

  it('does NOT flag a 1-question rubric the AI mapped cleanly', () => {
    expect(requiresManualGrading(sug({ unmapped: [] }), 1)).toBe(false)
  })

  it('does NOT flag a 20-question exam on a single stray unmappable part', () => {
    // ceil(20/3) = 7 → one unmapped is far below the bar.
    expect(requiresManualGrading(sug({ unmapped: [3] }), 20)).toBe(false)
  })

  it('is inclusive exactly AT the threshold', () => {
    // 6 graded → ceil(6/3) = 2. Exactly 2 unmapped must trip (>=, not >).
    expect(requiresManualGrading(sug({ unmapped: [0, 1] }), 6)).toBe(true)
  })

  it('stays off one below the threshold', () => {
    // 9 graded → ceil(9/3) = 3. Two unmapped is one short.
    expect(requiresManualGrading(sug({ unmapped: [0, 1] }), 9)).toBe(false)
  })

  it('trips when unmapped count reaches ceil for a count not divisible by 3', () => {
    // 4 graded → ceil(4/3) = 2. Two unmapped trips; one does not.
    expect(requiresManualGrading(sug({ unmapped: [0, 1] }), 4)).toBe(true)
    expect(requiresManualGrading(sug({ unmapped: [0] }), 4)).toBe(false)
  })

  it('treats a zero graded-question count as the floor-1 threshold, not zero', () => {
    // max(1, ceil(0/3)=0) = 1 — must never divide-by-zero into a threshold of 0
    // that flags every clean submission.
    expect(requiresManualGrading(sug({ unmapped: [] }), 0)).toBe(false)
    expect(requiresManualGrading(sug({ unmapped: [0] }), 0)).toBe(true)
  })

  it('is driven by unmapped COUNT, independent of flaggedCount/confidence', () => {
    // A low-confidence, heavily-flagged suggestion with no unmapped questions is
    // NOT severe — that is the flagged tier, not the manual-grading tier.
    expect(
      requiresManualGrading(sug({ unmapped: [], flaggedCount: 5, confidence: 'low' }), 6),
    ).toBe(false)
  })
})

describe('MANUAL_GRADING_SEVERE_FRACTION', () => {
  it('is one third — the fraction of graded questions that must be unmappable', () => {
    expect(MANUAL_GRADING_SEVERE_FRACTION).toBeCloseTo(1 / 3)
  })
})

describe('orderForReview — four-tier ranking with severe first', () => {
  it('orders severe (0) → flagged (1) → clean-suggestion (2) → no-suggestion (3)', () => {
    const gradedQuestionCount = 6 // threshold = ceil(6/3) = 2

    const noSuggestion = entry('none') // rank 3
    const clean = entry('clean', sug({ unmapped: [], flaggedCount: 0, confidence: 'high' })) // rank 2
    const flagged = entry('flagged', sug({ unmapped: [0], flaggedCount: 2, confidence: 'low' })) // rank 1
    const severe = entry('severe', sug({ unmapped: [0, 1] })) // rank 0

    // Feed them in reverse-priority order to prove the sort, not the input order.
    const ordered = orderForReview(
      [noSuggestion, clean, flagged, severe],
      gradedQuestionCount,
    )
    expect(ordered.map((e) => e.id)).toEqual(['severe', 'flagged', 'clean', 'none'])
  })

  it('routes a flagged-but-not-severe suggestion to tier 1, above a clean one', () => {
    const gradedQuestionCount = 9 // threshold = ceil(9/3) = 3
    // 2 unmapped < 3 → not severe, but flaggedCount>0 → flagged tier.
    const flagged = entry('flagged', sug({ unmapped: [0, 1], flaggedCount: 1 }))
    const clean = entry('clean', sug({ unmapped: [], flaggedCount: 0, confidence: 'high' }))

    const ordered = orderForReview([clean, flagged], gradedQuestionCount)
    expect(ordered.map((e) => e.id)).toEqual(['flagged', 'clean'])
  })

  it('is a stable, non-mutating sort (does not touch the input array)', () => {
    const input = [entry('a'), entry('b'), entry('c')]
    const snapshot = input.map((e) => e.id)
    const ordered = orderForReview(input, 3)
    // All same rank (no suggestions) → order preserved, and input untouched.
    expect(ordered.map((e) => e.id)).toEqual(snapshot)
    expect(input.map((e) => e.id)).toEqual(snapshot)
    expect(ordered).not.toBe(input)
  })
})
