// The rank math behind the retrieval eval gate (`eval/retrieval/`). It lives in
// CI even though the gate itself doesn't: the live run needs Pinecone, Supabase
// and an embedding key, but the metric definitions are pure — and a gate whose
// arithmetic is wrong is worse than no gate.

import { describe, it, expect } from 'vitest'

import {
  contextPrecision,
  firstGoldRank,
  meanOf,
  mrr,
  pageKey,
  recallAtK,
} from '../../eval/retrieval/metrics'

const A = pageKey('item-a', 1)
const B = pageKey('item-a', 2)
const C = pageKey('item-b', 7)
const NOISE = [pageKey('item-c', 3), pageKey('item-c', 4), pageKey('item-c', 5)]

describe('recallAtK', () => {
  it('counts only the gold pages inside the window', () => {
    // B sits at rank 5, outside k=4 — so half the gold is found, not all of it.
    const ranked = [A, ...NOISE, B]
    expect(recallAtK(ranked, new Set([A, B]), 4)).toBe(0.5)
    expect(recallAtK(ranked, new Set([A, B]), 5)).toBe(1)
  })

  it('is n/a (null) for a case with no gold, so refusal cases cannot drag the mean down', () => {
    expect(recallAtK([A], new Set(), 10)).toBeNull()
  })
})

describe('mrr', () => {
  it('is the reciprocal rank of the FIRST gold page', () => {
    expect(mrr([NOISE[0], NOISE[1], A, B], new Set([A, B]))).toBeCloseTo(1 / 3)
  })

  it('is 0 when gold exists but was never retrieved — a miss, not n/a', () => {
    expect(mrr(NOISE, new Set([A]))).toBe(0)
  })
})

describe('contextPrecision', () => {
  it('rewards gold at the top over the same gold further down', () => {
    const top = contextPrecision([A, B, ...NOISE], new Set([A, B]))!
    const bottom = contextPrecision([...NOISE, A, B], new Set([A, B]))!
    expect(top).toBe(1)
    expect(bottom).toBeLessThan(top)
  })

  it('does not punish a one-gold query for the other five slots', () => {
    // Raw precision@6 would score this perfect result 0.17 (1 of 6) — the
    // R-Precision caveat. The rank-weighted form asks what we care about:
    // is the gold page on top of what reaches the prompt?
    expect(contextPrecision([A, ...NOISE], new Set([A]))).toBe(1)
  })

  it('is 0 when gold exists but none of it reached the context', () => {
    expect(contextPrecision(NOISE, new Set([A]))).toBe(0)
  })

  it('scores the gold it FOUND, without re-charging for the gold it missed', () => {
    // One of two gold pages retrieved, and it is rank 1. Precision asks "is what
    // we found on top", so this is 1 — dividing by gold.size instead would fold
    // recall in and score it 0.5, double-counting a miss recallContext already
    // reports. Every other fixture retrieves all the gold or none, so this is
    // the only case that separates the two divisors.
    expect(contextPrecision([A, ...NOISE], new Set([A, B]))).toBe(1)
    expect(recallAtK([A, ...NOISE], new Set([A, B]), 4)).toBe(0.5)
  })
})

describe('firstGoldRank', () => {
  it('is 1-based, and null when nothing gold was retrieved', () => {
    expect(firstGoldRank([NOISE[0], C], new Set([C]))).toBe(2)
    expect(firstGoldRank(NOISE, new Set([C]))).toBeNull()
  })
})

describe('meanOf', () => {
  it('ignores n/a entries rather than treating them as zero', () => {
    expect(meanOf([1, null, 0.5])).toBe(0.75)
    expect(meanOf([null, null])).toBe(0)
  })
})
