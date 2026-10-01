// Cost-Analysis math: external (non-LLM) rate table + the LLM cost changes
// made for the super-admin Cost Analysis feature (reasoning-token billing,
// unpriced-model detection). Rates verified 2026-07-06 — if a rate is
// deliberately changed, update the expected values here in the same commit.

import { describe, it, expect } from 'vitest'
import { computeExternalCostUsd, EXTERNAL_RATES } from '@/lib/costs/external-rates'
import { computeCostUsd, isPricedModel } from '@/lib/ai/cost'

describe('computeExternalCostUsd', () => {
  it('prices live Scribe at $0.39/hour of connection time', () => {
    const oneHour = computeExternalCostUsd('elevenlabs', 'live_transcription', 3600)
    expect(oneHour?.costUsd).toBeCloseTo(0.39, 6)
    expect(oneHour?.rateVerified).toBe(true)
  })

  it('prices TTS at $0.05 per 1k characters', () => {
    expect(computeExternalCostUsd('elevenlabs', 'primer_tts', 4500)?.costUsd).toBeCloseTo(0.225, 6)
    expect(computeExternalCostUsd('elevenlabs', 'verbal_tts', 1000)?.costUsd).toBeCloseTo(0.05, 6)
  })

  it('prices email at the Pro effective marginal rate', () => {
    expect(computeExternalCostUsd('resend', 'email', 1)?.costUsd).toBeCloseTo(0.0004, 6)
  })

  it('flags the unverified batch-STT rate so the ledger can mark rows', () => {
    const r = computeExternalCostUsd('elevenlabs', 'verbal_stt', 3600)
    expect(r?.rateVerified).toBe(false)
  })

  it('returns null for an unknown provider/feature (writer records $0 + unpriced flag)', () => {
    expect(computeExternalCostUsd('unknown-vendor', 'whatever', 100)).toBeNull()
  })

  it('every rate row declares a unit the ledger understands', () => {
    for (const rate of Object.values(EXTERNAL_RATES)) {
      expect(['audio_seconds', 'characters', 'emails', 'queries', 'read_units', 'write_units']).toContain(
        rate.unit,
      )
    }
  })

  it('prices Google Search grounding at $14 per 1,000 queries', () => {
    const r = computeExternalCostUsd('google', 'search_grounding', 3)
    expect(r?.costUsd).toBeCloseTo(0.042, 6)
    expect(r?.rateVerified).toBe(true)
  })

  it('prices Pinecone RUs/WUs at the published range floor, flagged unverified', () => {
    // $16/1M RU, $4/1M WU — exact gcp/us-central1 rate pending bill reconciliation.
    const query = computeExternalCostUsd('pinecone', 'material_query', 1_000_000)
    expect(query?.costUsd).toBeCloseTo(16, 6)
    expect(query?.rateVerified).toBe(false)
    const upsert = computeExternalCostUsd('pinecone', 'material_upsert', 1300)
    expect(upsert?.costUsd).toBeCloseTo(0.0052, 6)
    expect(upsert?.rateVerified).toBe(false)
    expect(computeExternalCostUsd('pinecone', 'material_delete', 1_000_000)?.costUsd).toBeCloseTo(4, 6)
    expect(computeExternalCostUsd('pinecone', 'material_list', 2)?.costUsd).toBeCloseTo(0.000032, 6)
  })
})

describe('computeCostUsd — reasoning tokens', () => {
  it('bills reasoning (thinking) tokens at the output rate', () => {
    // Flash: $3.00/MTok output. 1M output + 1M reasoning = $6.00.
    const cost = computeCostUsd('gemini-3-flash-preview', {
      inputTokens: 0,
      outputTokens: 1_000_000,
      reasoningTokens: 1_000_000,
    })
    expect(cost).toBeCloseTo(6.0, 6)
  })

  it('is unchanged for calls without reasoning tokens', () => {
    const cost = computeCostUsd('gemini-3-flash-preview', { inputTokens: 1_000_000, outputTokens: 0 })
    expect(cost).toBeCloseTo(0.5, 6)
  })
})

describe('isPricedModel', () => {
  it('recognizes models with explicit rate rows', () => {
    expect(isPricedModel('gemini-3-flash-preview')).toBe(true)
    expect(isPricedModel('gemini-3.1-pro-preview')).toBe(true)
  })

  it('flags unknown model ids so a provider swap cannot silently misprice', () => {
    expect(isPricedModel('claude-sonnet-5')).toBe(false)
    expect(isPricedModel('')).toBe(false)
  })
})
