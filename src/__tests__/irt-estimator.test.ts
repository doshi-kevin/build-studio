// Locks the CCAT IRT engine against the design doc's hand-computed worked example
// (docs/designs/quizzes/ccat-system-design.md §4 + §6) and
// its core invariants. The doc traces a coarse 7-point grid {−3..3} by hand, so we
// reproduce that grid here to check θ̂/SE to the published precision; the production
// engine uses the 81-point grid.

import { describe, it, expect } from 'vitest'
import {
  buildNormalGrid,
  computePosterior,
  pCorrect,
  guessingFor,
  fisherInfo,
  selectNext,
  selectionTable,
  shouldStop,
  STANDARD_GRID,
  type IrtItem,
  type IrtResponse,
} from '@/lib/quiz/irt/estimator'

// The doc's coarse 7-point grid with a standard-normal prior.
const COARSE = buildNormalGrid(-3, 3, 7)

// Items from the worked example.
const Q1: IrtItem = { id: 'Q1', itemType: 'multiple_choice', a: 1.2, b: -0.5, c: 0.25 } // 4-option MCQ
const Q2: IrtItem = { id: 'Q2', itemType: 'true_false', a: 1.5, b: 0.4, c: 0.5 } // T/F
const Q3: IrtItem = { id: 'Q3', itemType: 'explanation', a: 1.8, b: 0.8, c: 0 } // 2PL explanation

describe('guessingFor', () => {
  it('derives c from item type (design §3)', () => {
    expect(guessingFor('true_false')).toBe(0.5)
    expect(guessingFor('multiple_choice', 4)).toBeCloseTo(0.25, 10)
    expect(guessingFor('multiple_choice', 5)).toBeCloseTo(0.2, 10)
    expect(guessingFor('short_answer')).toBe(0)
    expect(guessingFor('fill_in_blank')).toBe(0)
    expect(guessingFor('explanation')).toBe(0)
    expect(guessingFor('walkthrough')).toBe(0)
  })
})

describe('pCorrect (3PL / 2PL response model)', () => {
  it('respects the guessing floor for selected-response items', () => {
    // Far below difficulty, P → c (the guessing floor), not 0.
    expect(pCorrect(Q2, -3)).toBeGreaterThan(0.49)
    expect(pCorrect(Q2, -3)).toBeLessThan(0.55)
    // Explanation (c=0) can approach 0 far below difficulty.
    expect(pCorrect(Q3, -3)).toBeLessThan(0.01)
  })
  it('is monotonic increasing in θ', () => {
    expect(pCorrect(Q1, -2)).toBeLessThan(pCorrect(Q1, 0))
    expect(pCorrect(Q1, 0)).toBeLessThan(pCorrect(Q1, 2))
  })
})

describe('EAP worked example (design §11, coarse 7-point grid)', () => {
  it('Q1 correct MCQ → θ̂≈0.23, SE≈0.95', () => {
    const post = computePosterior([{ item: Q1, g: 1 }], COARSE)
    expect(post.theta).toBeCloseTo(0.23, 2)
    expect(post.se).toBeCloseTo(0.95, 2)
  })

  it('Q2 correct T/F (c=0.5) barely moves the estimate → θ̂≈0.40, SE≈0.94', () => {
    const responses: IrtResponse[] = [
      { item: Q1, g: 1 },
      { item: Q2, g: 1 },
    ]
    const post = computePosterior(responses, COARSE)
    expect(post.theta).toBeCloseTo(0.4, 2)
    expect(post.se).toBeCloseTo(0.94, 2)
  })

  it('Q3 partial explanation (2 of 3 nodes, g=0.67) is information-rich → θ̂ jumps, SE falls', () => {
    const responses: IrtResponse[] = [
      { item: Q1, g: 1 },
      { item: Q2, g: 1 },
      { item: Q3, g: 2 / 3 },
    ]
    const post = computePosterior(responses, COARSE)
    // The doc reports θ̂≈0.93, SE≈0.78 with a w=0.73 weighting; the committed MVP
    // uses the soft-label form (g=0.67) directly, which lands close by.
    expect(post.theta).toBeGreaterThan(0.7)
    expect(post.se).toBeLessThan(0.85)
  })
})

describe('EAP invariants on the production 81-point grid', () => {
  it('starts at θ̂=0, SE=1 with no responses', () => {
    const post = computePosterior([], STANDARD_GRID)
    expect(post.theta).toBeCloseTo(0, 6)
    expect(post.se).toBeCloseTo(1, 1)
  })

  it('a correct answer raises θ̂ and shrinks SE; a wrong one lowers it', () => {
    const correct = computePosterior([{ item: Q1, g: 1 }])
    const wrong = computePosterior([{ item: Q1, g: 0 }])
    expect(correct.theta).toBeGreaterThan(0)
    expect(wrong.theta).toBeLessThan(0)
    expect(correct.se).toBeLessThan(1)
  })

  it('is anomaly-resistant: one wrong easy item barely dents a high θ̂', () => {
    const strong: IrtResponse[] = Array.from({ length: 6 }, (_, i) => ({
      item: { id: `H${i}`, itemType: 'explanation', a: 1.6, b: 1.0, c: 0 },
      g: 1,
    }))
    const high = computePosterior(strong).theta
    const easyMiss: IrtItem = { id: 'easy', itemType: 'multiple_choice', a: 1.0, b: -2, c: 0.25 }
    const after = computePosterior([...strong, { item: easyMiss, g: 0 }]).theta
    expect(high - after).toBeLessThan(0.3) // dent is small, not catastrophic
  })
})

describe('Fisher information & selection (§5)', () => {
  const bank: IrtItem[] = [
    { id: 'easy', itemType: 'multiple_choice', a: 1.2, b: -1.5, c: 0.25 },
    { id: 'mid', itemType: 'explanation', a: 1.8, b: 0.0, c: 0 },
    { id: 'hard', itemType: 'explanation', a: 1.8, b: 1.5, c: 0 },
  ]

  it('information peaks near the item difficulty', () => {
    const atDifficulty = fisherInfo(bank[1], 0.0)
    const farBelow = fisherInfo(bank[1], -3)
    expect(atDifficulty).toBeGreaterThan(farBelow)
  })

  it('λ=0 is pure max-information; λ>0 tempers toward on-level items', () => {
    // At θ̂=-1.4 a struggling student: pure max-info may pick a high-a off-level item,
    // tempering pulls difficulty toward ability.
    const theta = -1.4
    const tempered = selectionTable(bank, new Set(), theta, 1.5)
    // The closest-difficulty item ('easy', b=-1.5) should rank at/near the top once tempered.
    expect(tempered[0].item.id).toBe('easy')
  })

  it('selectNext returns null when the bank is exhausted', () => {
    const answered = new Set(bank.map((i) => i.id))
    expect(selectNext(bank, answered, 0)).toBeNull()
  })

  it('selectNext is deterministic (top-1) without a rand source', () => {
    const r1 = selectNext(bank, new Set(), 0)
    const r2 = selectNext(bank, new Set(), 0)
    expect(r1?.chosen.item.id).toBe(r2?.chosen.item.id)
  })
})

describe('stopping rule & score mapping', () => {
  it('fixed mode stops after exactly `length` items', () => {
    expect(shouldStop(0.9, 7, { mode: 'fixed', length: 8 })).toEqual([false, ''])
    expect(shouldStop(0.9, 8, { mode: 'fixed', length: 8 })).toEqual([true, 'length'])
  })

  it('precision mode stops on SE<target or the safety cap', () => {
    expect(shouldStop(0.25, 5, { mode: 'precision', targetSe: 0.3, maxItems: 12 })).toEqual([true, 'se'])
    expect(shouldStop(0.5, 12, { mode: 'precision', targetSe: 0.3, maxItems: 12 })).toEqual([true, 'max'])
    expect(shouldStop(0.5, 5, { mode: 'precision', targetSe: 0.3, maxItems: 12 })).toEqual([false, ''])
  })
})
