// The AI ledger's output count: reasoning (thinking) tokens are PART of the
// SDK's outputTokens, so they must be billed once. The usage objects below are
// copied from a live probe (ai 6.0.208, @ai-sdk/google 3.0.83, 2026-10-02);
// `raw` is Google's usageMetadata for the same call.
//
// Rates (per MTok): gemini-3.1-pro-preview $2 in / $0.20 cached / $12 out;
// gemini-3-flash-preview $0.50 / $0.05 / $3.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { insert, streamTextMock } = vi.hoisted(() => ({
  insert: vi.fn<(row: Record<string, unknown>) => Promise<{ error: null }>>(async () => ({ error: null })),
  streamTextMock: vi.fn(),
}))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => ({
      insert,
      // recordAiUsage resolves a section's institution when only sectionId is given.
      select: () => ({ eq: () => ({ single: async () => ({ data: { institution_id: 'inst-1' } }) }) }),
    }),
  }),
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }))
vi.mock('ai', () => ({ streamText: streamTextMock, stepCountIs: () => () => false }))
vi.mock('@ai-sdk/google', () => ({ google: (id: string) => id }))
vi.mock('@/lib/ai/athena-core/persistence', () => ({ appendStudentMessage: vi.fn() }))

import { computeCostUsd, billedOutputTokens } from '@/lib/ai/cost'
import { recordAiUsage } from '@/lib/ai/usage'
import { mapUsage } from '@/lib/studio/builder/model'
import { streamAthenaAnswer } from '@/lib/ai/athena-core/turn'

// gemini-3.1-pro-preview, thinkingLevel low: 11 visible + 222 thinking.
const PRO_THINKING = {
  inputTokens: 33,
  inputTokenDetails: { noCacheTokens: 33, cacheReadTokens: 0 },
  outputTokens: 233,
  outputTokenDetails: { textTokens: 11, reasoningTokens: 222 },
  totalTokens: 266,
  reasoningTokens: 222,
  cachedInputTokens: 0,
  raw: { promptTokenCount: 33, candidatesTokenCount: 11, thoughtsTokenCount: 222, totalTokenCount: 266 },
}

// gemini-3-flash-preview, thinkingLevel minimal: no thinking at all.
const FLASH_NO_THINKING = {
  inputTokens: 33,
  inputTokenDetails: { noCacheTokens: 33, cacheReadTokens: 0 },
  outputTokens: 11,
  outputTokenDetails: { textTokens: 11, reasoningTokens: 0 },
  totalTokens: 44,
  reasoningTokens: 0,
  cachedInputTokens: 0,
}

// gemini-3-flash-preview, the second of two calls sharing a long prefix
// (implicit cache hit). Cached tokens are part of inputTokens.
const FLASH_CACHED = {
  inputTokens: 14_418,
  inputTokenDetails: { noCacheTokens: 2_160, cacheReadTokens: 12_258 },
  outputTokens: 3,
  outputTokenDetails: { textTokens: 3, reasoningTokens: 0 },
  totalTokens: 14_421,
  reasoningTokens: 0,
  cachedInputTokens: 12_258,
}

describe('computeCostUsd with SDK usage', () => {
  it('a call with no reasoning: input + visible output', () => {
    // (33·0.5 + 11·3) / 1e6
    expect(computeCostUsd('gemini-3-flash-preview', FLASH_NO_THINKING)).toBe(0.00005)
  })

  it('a thinking call bills its reasoning once, inside outputTokens', () => {
    // (33·2 + 233·12) / 1e6 = 0.002862. Adding reasoningTokens again gave 0.005526.
    expect(computeCostUsd('gemini-3.1-pro-preview', PRO_THINKING)).toBe(0.002862)
  })

  it('matches Google usageMetadata: candidates + thoughts is the billed output', () => {
    const { raw } = PRO_THINKING
    expect(billedOutputTokens(PRO_THINKING)).toBe(raw.candidatesTokenCount + raw.thoughtsTokenCount)
    expect(PRO_THINKING.inputTokens + billedOutputTokens(PRO_THINKING)).toBe(raw.totalTokenCount)
  })

  it('a provider with no reasoning field or output details bills outputTokens as is', () => {
    expect(computeCostUsd('gemini-3.1-pro-preview', { inputTokens: 33, outputTokens: 233 })).toBe(0.002862)
  })

  it('bills cached input at the cached rate and the rest at the input rate', () => {
    // (2160·0.5 + 12258·0.05 + 3·3) / 1e6 = 0.0017019 → 0.001702
    expect(computeCostUsd('gemini-3-flash-preview', FLASH_CACHED)).toBe(0.001702)
  })

  it('a caller holding visible output and thinking apart passes their sum and gets the SDK cost', () => {
    const fromMetadata = { inputTokens: 33, outputTokens: 11 + 222, reasoningTokens: 222 }
    expect(computeCostUsd('gemini-3.1-pro-preview', fromMetadata)).toBe(
      computeCostUsd('gemini-3.1-pro-preview', PRO_THINKING),
    )
  })

  it('reasoning above output is malformed: the floor keeps thinking billed, text is lost', () => {
    // A caller passing visible output only (11) with 222 thinking. The true
    // count is 233; the floor bills 222, so it under-bills the 11 text tokens.
    // The type can't tell the two meanings apart, so callers must pass the sum.
    expect(billedOutputTokens({ outputTokens: 11, reasoningTokens: 222 })).toBe(222)
  })
})

describe('recordAiUsage ledger row', () => {
  beforeEach(() => insert.mockClear())

  it('stores output_tokens once and a cost that recomputes from the row', async () => {
    await recordAiUsage({ feature: 'test', model: 'gemini-3.1-pro-preview', institutionId: 'inst-1', usage: PRO_THINKING })
    const row = insert.mock.calls[0][0]
    expect(row).toMatchObject({
      input_tokens: 33,
      cached_input_tokens: 0,
      output_tokens: 233,
      cost_usd: 0.002862,
      metadata: { reasoning_tokens: 222, reasoning_in_output: true },
    })
    const recomputed = computeCostUsd(row.model as string, {
      inputTokens: row.input_tokens as number,
      cachedInputTokens: row.cached_input_tokens as number,
      outputTokens: row.output_tokens as number,
    })
    expect(recomputed).toBe(row.cost_usd)
  })

  it('a call without thinking writes no reasoning stamp', async () => {
    await recordAiUsage({ feature: 'test', model: 'gemini-3-flash-preview', institutionId: 'inst-1', usage: FLASH_CACHED })
    const row = insert.mock.calls[0][0]
    expect(row).toMatchObject({ input_tokens: 14_418, cached_input_tokens: 12_258, output_tokens: 3, cost_usd: 0.001702 })
    expect(row.metadata).toEqual({})
  })
})

describe('Studio Builder usage mapping', () => {
  it('maps SDK usage to the same billed tokens and cost the ledger computes', () => {
    const u = mapUsage(PRO_THINKING)
    expect(u).toEqual({ input: 33, cachedInput: 0, output: 233, reasoning: 222 })
    // The harness prices a turn from these fields (harness.ts runSlice).
    const harnessCost = computeCostUsd('gemini-3.1-pro-preview', {
      inputTokens: u.input,
      cachedInputTokens: u.cachedInput,
      outputTokens: u.output,
      reasoningTokens: u.reasoning,
    })
    expect(harnessCost).toBe(computeCostUsd('gemini-3.1-pro-preview', PRO_THINKING))
  })

  it('maps a provider with no output details', () => {
    expect(mapUsage({ inputTokens: 10, outputTokens: 5 })).toEqual({ input: 10, cachedInput: 0, output: 5, reasoning: 0 })
  })
})

describe('Athena student turn ledger', () => {
  it('records the whole tool loop (totalUsage), not the final step', async () => {
    insert.mockClear()
    streamAthenaAnswer({
      model: 'gemini-3-flash-preview',
      system: 's',
      messages: [],
      tools: {},
      maxSteps: 3,
      meter: { sectionId: 'sec-1', userId: 'u-1' },
      persist: { adminDb: null, conversationId: null, institutionId: 'inst-1', sectionId: 'sec-1', userId: 'u-1', run: () => [] },
    })
    const { onFinish } = streamTextMock.mock.calls[0][0]
    // From the probe's two-step streamText: step 0 (tool call) 72/16, step 1 106/12.
    await onFinish({
      text: '',
      usage: { inputTokens: 106, outputTokens: 12, reasoningTokens: 0, cachedInputTokens: 0 },
      totalUsage: { inputTokens: 178, outputTokens: 28, reasoningTokens: 0, cachedInputTokens: 0 },
    })
    // recordStudentUsage is fire-and-forget; let its insert land.
    await vi.waitFor(() => expect(insert).toHaveBeenCalledTimes(1))
    expect(insert.mock.calls[0][0]).toMatchObject({ input_tokens: 178, output_tokens: 28 })
  })
})
