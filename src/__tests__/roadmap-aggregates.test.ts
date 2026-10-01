// Tests for the pure Slice 2 aggregation maths (src/lib/roadmap/aggregates.ts):
// point-biserial item discrimination, attempts-without-improvement,
// slow-and-wrong detection, and absence-gap matching.

import { describe, it, expect } from 'vitest'
import {
  pointBiserialByQuestion,
  noImprovementByQuiz,
  slowWrongQuizIds,
  absenceGapMatches,
  computeTrends,
  openCounts,
  reDownloadCounts,
  depthContrast,
} from '@/lib/roadmap/aggregates'

describe('pointBiserialByQuestion', () => {
  // Four attempts spanning a score range; high scorers vs low scorers.
  const attempts = [
    { id: 'a1', score: 90 },
    { id: 'a2', score: 80 },
    { id: 'a3', score: 40 },
    { id: 'a4', score: 30 },
  ]

  it('gives a high positive discrimination when strong students pass and weak fail', () => {
    const answers = [
      { attemptId: 'a1', questionId: 'good', isCorrect: true },
      { attemptId: 'a2', questionId: 'good', isCorrect: true },
      { attemptId: 'a3', questionId: 'good', isCorrect: false },
      { attemptId: 'a4', questionId: 'good', isCorrect: false },
    ]
    const stat = pointBiserialByQuestion(attempts, answers).get('good')!
    expect(stat.difficulty).toBe(0.5)
    expect(stat.n).toBe(4)
    expect(stat.discrimination).toBeGreaterThan(0.5) // strongly discriminating
  })

  it('gives a low discrimination when correctness is uncorrelated with score', () => {
    const answers = [
      { attemptId: 'a1', questionId: 'poor', isCorrect: true },
      { attemptId: 'a2', questionId: 'poor', isCorrect: false },
      { attemptId: 'a3', questionId: 'poor', isCorrect: true },
      { attemptId: 'a4', questionId: 'poor', isCorrect: false },
    ]
    const stat = pointBiserialByQuestion(attempts, answers).get('poor')!
    expect(Math.abs(stat.discrimination!)).toBeLessThan(0.3) // poor item — the P6 flag
  })

  it('returns null discrimination when the item is not estimable (all correct / too few)', () => {
    const allRight = pointBiserialByQuestion(attempts, [
      { attemptId: 'a1', questionId: 'easy', isCorrect: true },
      { attemptId: 'a2', questionId: 'easy', isCorrect: true },
      { attemptId: 'a3', questionId: 'easy', isCorrect: true },
      { attemptId: 'a4', questionId: 'easy', isCorrect: true },
    ]).get('easy')!
    expect(allRight.difficulty).toBe(1)
    expect(allRight.discrimination).toBeNull()

    const tooFew = pointBiserialByQuestion(attempts, [{ attemptId: 'a1', questionId: 'lonely', isCorrect: true }]).get('lonely')!
    expect(tooFew.discrimination).toBeNull()
  })

  it('returns null (not NaN) when scores have zero variance, even with mixed correctness', () => {
    // Two attempts, same score, one right one wrong: sd = 0 → the formula would
    // divide by zero. The sd>0 guard must yield null, never NaN in the cache.
    const flat = pointBiserialByQuestion(
      [{ id: 'a1', score: 50 }, { id: 'a2', score: 50 }],
      [
        { attemptId: 'a1', questionId: 'q', isCorrect: true },
        { attemptId: 'a2', questionId: 'q', isCorrect: false },
      ],
    ).get('q')!
    expect(flat.discrimination).toBeNull()
    expect(flat.difficulty).toBe(0.5)
    expect(flat.n).toBe(2)
  })

  it('ignores ungraded (null) answers and answers with no matching attempt score', () => {
    const stat = pointBiserialByQuestion(attempts, [
      { attemptId: 'a1', questionId: 'q', isCorrect: true },
      { attemptId: 'a2', questionId: 'q', isCorrect: null }, // ungraded → skipped
      { attemptId: 'ghost', questionId: 'q', isCorrect: false }, // no score → skipped
    ]).get('q')!
    expect(stat.n).toBe(1)
  })
})

describe('noImprovementByQuiz', () => {
  it('flags a retaken quiz with no score gain, ignores gains and single attempts', () => {
    const out = noImprovementByQuiz([
      { quizId: 'stuck', score: 55, startedAt: '2026-01-01T00:00:00Z' },
      { quizId: 'stuck', score: 52, startedAt: '2026-01-02T00:00:00Z' }, // later, no better
      { quizId: 'better', score: 40, startedAt: '2026-01-01T00:00:00Z' },
      { quizId: 'better', score: 70, startedAt: '2026-01-02T00:00:00Z' }, // improved
      { quizId: 'once', score: 30, startedAt: '2026-01-01T00:00:00Z' },
    ])
    expect(out).toContainEqual({ quizId: 'stuck', attempts: 2 })
    expect(out.map((o) => o.quizId)).not.toContain('better')
    expect(out.map((o) => o.quizId)).not.toContain('once')
  })

  it('orders by started_at, not array order, before comparing first vs last', () => {
    const out = noImprovementByQuiz([
      { quizId: 'q', score: 80, startedAt: '2026-01-02T00:00:00Z' }, // actually the later attempt
      { quizId: 'q', score: 50, startedAt: '2026-01-01T00:00:00Z' }, // earlier
    ])
    expect(out).toHaveLength(0) // 50 → 80 is improvement once ordered
  })
})

describe('slowWrongQuizIds', () => {
  const attemptToQuiz = new Map([['a1', 'quizA']])
  const expected = new Map<string, number>([['q1', 30], ['q2', 30], ['q3', 30]])

  it('flags a quiz only for answers that are BOTH slow and wrong', () => {
    const out = slowWrongQuizIds(
      [
        { attemptId: 'a1', questionId: 'q1', isCorrect: false, timeSpent: 100 }, // slow + wrong → flag
        { attemptId: 'a1', questionId: 'q2', isCorrect: false, timeSpent: 10 }, // wrong but fast
        { attemptId: 'a1', questionId: 'q3', isCorrect: true, timeSpent: 100 }, // slow but right
      ],
      attemptToQuiz,
      expected,
    )
    expect([...out]).toEqual(['quizA'])
  })

  it('skips items with no expected time', () => {
    const out = slowWrongQuizIds(
      [{ attemptId: 'a1', questionId: 'unknown', isCorrect: false, timeSpent: 9999 }],
      attemptToQuiz,
      new Map(),
    )
    expect(out.size).toBe(0)
  })
})

describe('computeTrends', () => {
  it('returns only keys present in both maps with a rounded change', () => {
    const baseline = new Map([['a', 64], ['b', 40], ['c', 50]])
    const latest = new Map([['a', 52], ['b', 78], ['c', 50.2], ['d', 90]])
    const out = computeTrends(baseline, latest)
    expect(out).toContainEqual({ key: 'a', from: 64, to: 52 }) // slip
    expect(out).toContainEqual({ key: 'b', from: 40, to: 78 }) // gain
    expect(out.map((t) => t.key)).not.toContain('c') // 50 → 50 (rounds equal) — no change
    expect(out.map((t) => t.key)).not.toContain('d') // no baseline
  })
})

describe('openCounts', () => {
  const now = 1_000_000_000_000
  const day = 24 * 3600 * 1000
  it('counts distinct students recently and ever, per item', () => {
    const out = openCounts(
      [
        { itemId: 'x', studentId: 's1', at: now - day }, // recent
        { itemId: 'x', studentId: 's1', at: now - 2 * day }, // same student, dedup
        { itemId: 'x', studentId: 's2', at: now - 20 * day }, // old, not recent
        { itemId: 'y', studentId: 's3', at: now - day },
      ],
      now,
      7 * day,
    )
    expect(out.get('x')).toEqual({ recent: 1, ever: 2 }) // s1 recent; s1+s2 ever
    expect(out.get('y')).toEqual({ recent: 1, ever: 1 })
  })
})

describe('reDownloadCounts', () => {
  it('counts students who downloaded an item >= repeatMin times', () => {
    const at = 0
    const out = reDownloadCounts(
      [
        { itemId: 'ref', studentId: 's1', at }, { itemId: 'ref', studentId: 's1', at }, // s1 x2 → repeater
        { itemId: 'ref', studentId: 's2', at }, { itemId: 'ref', studentId: 's2', at }, { itemId: 'ref', studentId: 's2', at }, // s2 x3 → repeater
        { itemId: 'ref', studentId: 's3', at }, // s3 x1 → not
        { itemId: 'once', studentId: 's1', at }, // single pull → absent from map
      ],
      2,
    )
    expect(out.get('ref')).toBe(2) // s1 + s2
    expect(out.has('once')).toBe(false)
  })

  it('respects a higher repeatMin — the revisit signal calls this with 3, not 2', () => {
    const at = 0
    const events = [
      { itemId: 'ref', studentId: 's1', at }, { itemId: 'ref', studentId: 's1', at }, // x2
      { itemId: 'ref', studentId: 's2', at }, { itemId: 'ref', studentId: 's2', at }, { itemId: 'ref', studentId: 's2', at }, // x3
    ]
    expect(reDownloadCounts(events, 3).get('ref')).toBe(1) // only s2 clears the revisit bar
  })
})

describe('absenceGapMatches', () => {
  it('matches a missed session concept to a weak skill, case-insensitively', () => {
    const out = absenceGapMatches(
      [
        { title: 'Lecture 5', concepts: ['RNNs', 'Backprop'] },
        { title: 'Lecture 6', concepts: ['Attention'] },
      ],
      ['rnns', 'optimization'],
    )
    expect(out).toEqual([{ sessionTitle: 'Lecture 5', topic: 'RNNs' }]) // Lecture 6 has no overlap
  })

  it('returns nothing when no missed session overlaps a weak skill', () => {
    expect(absenceGapMatches([{ title: 'L', concepts: ['X'] }], ['y'])).toEqual([])
  })
})

// ── depthContrast (P24/S23, slice 4) ─────────────────────────────
describe('depthContrast', () => {
  const slides = (mins: number[]) => mins.map((minutes, i) => ({ slide: i + 1, minutes }))

  it('names the deep and the skimmed slide when the contrast is real', () => {
    const out = depthContrast(slides([2.0, 11.8, 1.5, 0.6]))
    expect(out).toEqual({ deepSlide: 2, deepMinutes: 12, skimmedSlide: 4, skimmedSeconds: 35 })
  })

  it('an evenly taught deck is the normal case and gets nothing', () => {
    expect(depthContrast(slides([4, 5, 4.5, 5.5]))).toBeNull()
  })

  it('a busy deck with a long deep slide is not a skim story', () => {
    // The thinnest slide still got two full minutes of teaching. Calling that
    // "skimmed" would put "120s on slide 2" on a deck nobody rushed — and the
    // ratio alone would let it through (12 ≥ 2×4).
    expect(depthContrast(slides([12, 2, 3, 4]))).toBeNull()
  })

  it('needs enough spoken slides to show a pattern', () => {
    expect(depthContrast(slides([12, 0.2, 0.3]))).toBeNull() // 3 slides — no pattern
  })

  it('a shallow deck with no real dwell says nothing', () => {
    // Deep slide under 3 min: everything was skimmed, which is not a contrast.
    expect(depthContrast(slides([2.5, 0.3, 0.4, 0.5]))).toBeNull()
  })

  it('floors the skim at 5s — "0s on slide 9" reads as a bug', () => {
    const out = depthContrast(slides([12, 5, 4, 0.0]))
    expect(out?.skimmedSeconds).toBe(5)
  })
})
