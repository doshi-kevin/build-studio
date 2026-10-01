// Tests for the AI cost layer:
//  A. computeCostUsd — exact per-model math + unknown-model fallback (cost.ts).
//  B. aggregateUsage — exact platform/feature/institution/professor rollups and
//     the per-institution→per-professor Athena breakdown that powers the
//     super-admin drill-down (cost-aggregate.ts).
//
// Rates under test (per MTok, gemini-3-flash-preview): input $0.5, cached
// $0.05, output $3.0. Cost sums use toBeCloseTo(_, 6) because accumulating
// decimals is not binary-exact; 6 dp matches the ledger's numeric(12,6).

import { describe, it, expect } from 'vitest'
import { computeCostUsd } from '@/lib/ai/cost'
import { aggregateUsage, type AggregatableRow } from '@/lib/ai/cost-aggregate'

describe('computeCostUsd', () => {
  it('charges the input rate: 1M input tokens === $0.5', () => {
    expect(computeCostUsd('gemini-3-flash-preview', { inputTokens: 1_000_000 })).toBe(0.5)
  })

  it('charges a fully-cached prompt at the cached rate: 1M input, all cached === $0.05', () => {
    // inputTokens is the TOTAL prompt (cached is a subset of it), so a fully
    // cached prompt bills only the cached rate — not input + cached.
    expect(
      computeCostUsd('gemini-3-flash-preview', {
        inputTokens: 1_000_000,
        cachedInputTokens: 1_000_000,
      }),
    ).toBe(0.05)
  })

  it('clamps cached tokens to the input total (defensive, cached ⊆ input)', () => {
    // cached > input is malformed usage data; clamp instead of going negative.
    expect(
      computeCostUsd('gemini-3-flash-preview', {
        inputTokens: 1000,
        cachedInputTokens: 5000,
      }),
    ).toBe(computeCostUsd('gemini-3-flash-preview', { inputTokens: 1000, cachedInputTokens: 1000 }))
  })

  it('charges the output rate: 1M output tokens === $3', () => {
    expect(computeCostUsd('gemini-3-flash-preview', { outputTokens: 1_000_000 })).toBe(3)
  })

  it('sums a mixed call and rounds to 6 dp', () => {
    // cached (500) is a subset of input (1500) → 1000 fresh + 500 cached:
    // (1000·0.5 + 500·0.05 + 800·3.0) / 1e6 = 2925/1e6 → 0.002925
    expect(
      computeCostUsd('gemini-3-flash-preview', {
        inputTokens: 1500,
        cachedInputTokens: 500,
        outputTokens: 800,
      }),
    ).toBe(0.002925)
  })

  it('returns 0 for empty usage', () => {
    expect(computeCostUsd('gemini-3-flash-preview', {})).toBe(0)
  })

  it('falls back to the flash rate for an unknown model (locks silent fallback)', () => {
    const usage = { inputTokens: 12_345, cachedInputTokens: 6_789, outputTokens: 2_468 }
    // Unknown model must produce the SAME cost as the known flash rate — this is
    // the current silent-fallback behavior, asserted so it is intentional.
    expect(computeCostUsd('some-future-model', usage)).toBe(
      computeCostUsd('gemini-3-flash-preview', usage),
    )
  })

  it('prices embedding models on input only: 1M tokens === $0.15 (001) / $0.20 (2)', () => {
    expect(computeCostUsd('gemini-embedding-001', { inputTokens: 1_000_000 })).toBe(0.15)
    expect(computeCostUsd('gemini-embedding-2', { inputTokens: 1_000_000 })).toBe(0.2)
  })

  it('bills image tokens at the image rate on multimodal models', () => {
    // gemini-embedding-2: text $0.20/MTok, images $0.45/MTok. A 100-page run at
    // ~258 image tokens/page: (100000·0.20 + 25800·0.45)/1e6 = 0.031610
    expect(
      computeCostUsd('gemini-embedding-2', { inputTokens: 100_000, imageTokens: 25_800 }),
    ).toBe(0.03161)
    expect(computeCostUsd('gemini-embedding-2', { imageTokens: 1_000_000 })).toBe(0.45)
  })

  it('ignores imageTokens on text-only models instead of inventing a charge', () => {
    expect(
      computeCostUsd('gemini-3-flash-preview', { inputTokens: 1000, imageTokens: 50_000 }),
    ).toBe(computeCostUsd('gemini-3-flash-preview', { inputTokens: 1000 }))
  })

  it('prices the hosted reranker per REQUEST, not per token', () => {
    // $2 per 1,000 rerank requests — flat, regardless of documents or length.
    expect(computeCostUsd('semantic-ranker-default-004', { requests: 1 })).toBe(0.001)
    expect(computeCostUsd('semantic-ranker-default-004', { requests: 3 })).toBe(0.003)
    // Tokens are not what it bills on, so a caller passing them changes nothing.
    expect(computeCostUsd('semantic-ranker-default-004', { inputTokens: 1_000_000, requests: 1 })).toBe(0.001)
  })

  it('never lets a token-billed model pick up a flat per-request charge', () => {
    // `requests` is set on every rerank row in the same ledger; a model without
    // a perRequestUsd rate must ignore it rather than invent a price.
    expect(computeCostUsd('gemini-3-flash-preview', { inputTokens: 1000, requests: 5 })).toBe(
      computeCostUsd('gemini-3-flash-preview', { inputTokens: 1000 }),
    )
    // Including the unknown-model fallback, which has no per-request rate.
    expect(computeCostUsd('some-future-model', { requests: 5 })).toBe(0)
  })

  it('prices flash-lite at its own row, not the Flash fallback', () => {
    // $0.25 in / $0.025 cached / $1.50 out per MTok.
    expect(
      computeCostUsd('gemini-3.1-flash-lite-preview', {
        inputTokens: 1_000_000,
        cachedInputTokens: 1_000_000,
        outputTokens: 1_000_000,
      }),
    ).toBe(0.025 + 1.5)
    expect(computeCostUsd('gemini-3.1-flash-lite-preview', { inputTokens: 1_000_000 })).toBe(0.25)
  })
})

describe('aggregateUsage', () => {
  // Synthetic ledger. Includes the criteria worked anchor (inst X: P1 0.10/1000,
  // P2 0.04/400 → Athena 0.14/1400/2), a non-Athena row for P1 in X (must be
  // excluded from the Athena drill-down but counted in totals), and a userless
  // row in Y (counted in totals + byInstitution, excluded from byProfessor).
  const rows: AggregatableRow[] = [
    { feature: 'professor_assistant', institution_id: 'X', user_id: 'P1', cost_usd: 0.1, total_tokens: 1000 },
    { feature: 'professor_assistant', institution_id: 'X', user_id: 'P2', cost_usd: 0.04, total_tokens: 400 },
    { feature: 'quiz_generation', institution_id: 'X', user_id: 'P1', cost_usd: 0.05, total_tokens: 500 },
    { feature: 'professor_assistant', institution_id: 'Y', user_id: 'P3', cost_usd: 0.2, total_tokens: 2000 },
    { feature: 'ai_tutor', institution_id: 'Y', user_id: null, cost_usd: 0.01, total_tokens: 100 },
  ]
  const agg = aggregateUsage(rows)

  it('computes the platform total over every row', () => {
    expect(agg.total.cost).toBeCloseTo(0.4, 6)
    expect(agg.total.tokens).toBe(4000)
    expect(agg.total.calls).toBe(5)
  })

  it('computes per-feature totals', () => {
    expect(agg.byFeature.get('professor_assistant')).toMatchObject({ tokens: 3400, calls: 3 })
    expect(agg.byFeature.get('professor_assistant')!.cost).toBeCloseTo(0.34, 6)
    expect(agg.byFeature.get('quiz_generation')).toEqual({ cost: 0.05, tokens: 500, calls: 1 })
    expect(agg.byFeature.get('ai_tutor')).toEqual({ cost: 0.01, tokens: 100, calls: 1 })
  })

  it('computes per-institution totals (across all features)', () => {
    expect(agg.byInstitution.get('X')).toMatchObject({ tokens: 1900, calls: 3 })
    expect(agg.byInstitution.get('X')!.cost).toBeCloseTo(0.19, 6)
    expect(agg.byInstitution.get('Y')).toMatchObject({ tokens: 2100, calls: 2 })
    expect(agg.byInstitution.get('Y')!.cost).toBeCloseTo(0.21, 6)
  })

  it('computes per-professor totals and excludes userless rows', () => {
    expect(agg.byProfessor.get('P1')).toMatchObject({ tokens: 1500, calls: 2 })
    expect(agg.byProfessor.get('P1')!.cost).toBeCloseTo(0.15, 6)
    expect(agg.byProfessor.get('P2')).toEqual({ cost: 0.04, tokens: 400, calls: 1 })
    expect(agg.byProfessor.get('P3')).toEqual({ cost: 0.2, tokens: 2000, calls: 1 })
    expect(agg.byProfessor.size).toBe(3) // null-user ai_tutor row contributes no professor
  })

  it('breaks Athena down per institution → per professor (drill-down source)', () => {
    const x = agg.athenaByInstitution.get('X')!
    expect(x.size).toBe(2)
    expect(x.get('P1')).toEqual({ cost: 0.1, tokens: 1000, calls: 1 })
    expect(x.get('P2')).toEqual({ cost: 0.04, tokens: 400, calls: 1 })
    // institution X Athena total = 0.14 / 1400 / 2 (worked anchor)
    const xTotal = [...x.values()].reduce(
      (s, a) => ({ cost: s.cost + a.cost, tokens: s.tokens + a.tokens, calls: s.calls + a.calls }),
      { cost: 0, tokens: 0, calls: 0 },
    )
    expect(xTotal.cost).toBeCloseTo(0.14, 6)
    expect(xTotal.tokens).toBe(1400)
    expect(xTotal.calls).toBe(2)

    const y = agg.athenaByInstitution.get('Y')!
    expect(y.size).toBe(1)
    expect(y.get('P3')).toEqual({ cost: 0.2, tokens: 2000, calls: 1 })
  })

  it("excludes non-Athena rows from the Athena breakdown (P1's quiz_generation row)", () => {
    // P1 in X has only its professor_assistant cost here, not the quiz_generation 0.05.
    expect(agg.athenaByInstitution.get('X')!.get('P1')!.cost).toBeCloseTo(0.1, 6)
  })

  it('returns empty structures for no rows', () => {
    const empty = aggregateUsage([])
    expect(empty.total).toEqual({ cost: 0, tokens: 0, calls: 0 })
    expect(empty.byFeature.size).toBe(0)
    expect(empty.athenaByInstitution.size).toBe(0)
  })
})
