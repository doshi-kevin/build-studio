// @vitest-environment node
//
// Athena console (src/app/api/professor-assistant/route.ts) — does a turn that ran
// Google Search grounding record MORE dollars than one that didn't?
//
// Grounding is billed per SEARCH QUERY, on top of tokens. recordAiUsage prices only
// tokens, so for a while the ledger recorded a grounded Athena message at its token
// cost alone and the super-admin AI Costs page under-reported real spend (#270). The
// fix routes the grounded-query count into the external ledger at the published
// per-query rate. Nothing pinned that on THIS route, though: the equivalent suite
// (assignment-assistant-search-wiring.test.ts) covers the assignment/quiz/grading
// Athena, and no test imports the console route at all — so deleting the
// recordExternalUsage block here goes green.
//
// This suite asserts the accounting outcome in DOLLARS, not the call shape, so it
// stays honest if the rate table or the ledger split changes: the real
// computeCostUsd / computeExternalCostUsd are deliberately NOT mocked, and the
// grounded-vs-ungrounded delta is checked against the published rate.
//
// The three failure modes it locks down:
//   1. under-report — a grounded turn priced at token cost only (the #270 bug).
//   2. over-report / double-count — grounding folded into the TOKEN ledger as well,
//      the shape of the cached-token double-count this repo already ate once.
//   3. collateral drift — an ungrounded turn's cost moving off token-only pricing.
//
// streamText is mocked so we can invoke the captured onFinish with synthetic
// provider payloads. No network, no model, no DB.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { computeCostUsd } from '@/lib/ai/cost'
import { computeExternalCostUsd } from '@/lib/costs/external-rates'

const mockStreamText = vi.fn()
const mockRecordAiUsage = vi.fn()
const mockRecordExternalUsage = vi.fn()
const mockGetUser = vi.fn()
const mockVerifySectionAccess = vi.fn()
const mockReserveAthenaSlot = vi.fn()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let captured: any

vi.mock('ai', () => ({
  streamText: (...args: unknown[]) => mockStreamText(...args),
  convertToModelMessages: async (m: unknown) => m,
  stepCountIs: (n: number) => n,
  smoothStream: () => undefined,
}))

vi.mock('@ai-sdk/google', () => {
  const google = (model: string) => ({ model })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(google as any).tools = { googleSearch: () => ({ providerTool: 'GOOGLE_SEARCH_WEB' }) }
  return { google }
})

// The route's IDOR guard reads athena_conversations before streaming; a brand-new
// conversation has no row, which is the allowed path.
const adminDb = {
  from: () => ({
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
  }),
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: mockGetUser } }),
}))
vi.mock('@/lib/auth/section-access', () => ({
  verifySectionAccess: (...a: unknown[]) => mockVerifySectionAccess(...a),
  canWriteAsStaff: (role: string) => role === 'professor' || role === 'ta',
}))
/* AI kill switch: these tests exercise the AI-ENABLED path — mock the guard
   open so their stubbed DB clients don't trip its fail-closed refusal. The
   disabled/locked paths are covered in ai-kill-switch.test.ts.
   Added when this branch merged main: the switch (#718) landed after this suite
   was written, and its fail-closed refusal turned all four cases into a 403
   before the accounting under test ever ran. */
vi.mock('@/lib/ai/kill-switch', () => ({
  checkAiFeature: vi.fn(async () => ({ allowed: true })),
  checkAiFeatureBySection: vi.fn(async () => ({ allowed: true })),
}))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('@/lib/ai/usage', () => ({ recordAiUsage: (...a: unknown[]) => mockRecordAiUsage(...a) }))
vi.mock('@/lib/costs/external-usage', () => ({
  recordExternalUsage: (...a: unknown[]) => mockRecordExternalUsage(...a),
}))
// The route defers its ledger writes with after() so a client abort can't cancel
// them; there is no request scope here, so run the callback inline.
vi.mock('next/server', () => ({ after: (fn: () => unknown) => fn() }))
vi.mock('@/lib/ai/professor-assistant/rate-limit', () => ({
  reserveAthenaSlot: (...a: unknown[]) => mockReserveAthenaSlot(...a),
}))
vi.mock('@/lib/ai/professor-assistant/context', () => ({
  loadAssistantContext: async () => ({ institutionId: 'inst-1', courseTitle: 'Course', modules: [] }),
}))
vi.mock('@/lib/ai/professor-assistant/prompts', () => ({
  buildProfessorAssistantSystemPrompt: () => 'SYSTEM',
}))
vi.mock('@/lib/ai/professor-assistant/tools', () => ({
  buildAssistantTools: () => ({ draft_assignment: {} }),
}))
vi.mock('@/lib/ai/professor-assistant/attachments', () => ({
  materializeForModel: async () => undefined,
}))
vi.mock('@/lib/ai/professor-assistant/persistence', () => ({
  persistUserMessage: async () => undefined,
  persistAssistantMessage: async () => undefined,
  maybeAutoTitle: async () => undefined,
}))

// Athena's Pro model — a priced row in MODEL_RATES_USD, so the token side of the
// arithmetic below is the real production rate, not the unknown-model fallback.
const MODEL = 'gemini-3.1-pro-preview'
const MODEL_DEF = { id: 'gemini-pro', provider: 'google', model: MODEL, thinkingLevel: 'low' }

// One realistic turn's tokens. Held constant across both cases so any cost
// difference can only come from grounding.
const USAGE = { inputTokens: 12_000, cachedInputTokens: 8_000, outputTokens: 900, reasoningTokens: 400 }

let POST: (req: Request) => Promise<Response>

beforeEach(async () => {
  vi.resetModules()
  // None of these mock implementations throw, so resetting them here is safe
  // (see the vitest-4 caveat in CLAUDE.md / llm-quiz-dedup-types.test.ts).
  mockStreamText.mockReset()
  mockRecordAiUsage.mockReset()
  mockRecordExternalUsage.mockReset()
  mockGetUser.mockReset()
  mockVerifySectionAccess.mockReset()
  mockReserveAthenaSlot.mockReset()
  captured = undefined

  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
  mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb })
  mockReserveAthenaSlot.mockResolvedValue({ accepted: true, modelDef: MODEL_DEF })
  mockStreamText.mockImplementation((args: unknown) => {
    captured = args
    return { toUIMessageStreamResponse: () => new Response('stream') }
  })

  const mod = await import('@/app/api/professor-assistant/route')
  POST = mod.POST
})

function request(): Request {
  return new Request('http://localhost/api/professor-assistant', {
    method: 'POST',
    body: JSON.stringify({
      sectionId: 'sec-1',
      id: '11111111-1111-1111-1111-111111111111',
      messages: [],
    }),
  })
}

interface Recorded {
  /** Everything the ledgers would store for this turn, in USD. */
  totalUsd: number
  tokenUsd: number
  groundingUsd: number
  /** The usage payload handed to recordAiUsage — must stay grounding-free. */
  tokenLedgerUsage: unknown
  externalCalls: number
}

/**
 * Run one turn, finish it with the given provider payload, and price BOTH ledger
 * writes with the real rate tables — i.e. what the AI Costs dashboard would total.
 */
async function recordedCostFor(finishArgs: Record<string, unknown>): Promise<Recorded> {
  // A test may price two turns (grounded vs ungrounded) to compare them, so scope
  // the ledger calls to THIS turn. mockClear inside the test body is safe — the
  // beforeEach caveat in CLAUDE.md is about mocks whose implementation throws, and
  // it preserves the implementations set in beforeEach.
  mockRecordAiUsage.mockClear()
  mockRecordExternalUsage.mockClear()

  const res = await POST(request())
  expect(res.status).toBe(200)

  await captured.onFinish({ usage: USAGE, providerMetadata: undefined, steps: [], ...finishArgs })

  expect(mockRecordAiUsage).toHaveBeenCalledTimes(1)
  const aiArgs = mockRecordAiUsage.mock.calls[0][0]
  const tokenUsd = computeCostUsd(aiArgs.model, aiArgs.usage)

  let groundingUsd = 0
  for (const [args] of mockRecordExternalUsage.mock.calls) {
    const priced = computeExternalCostUsd(args.provider, args.feature, args.quantity)
    // A (provider, feature) with no rate row would silently record $0 — that is
    // itself an under-report, so fail loudly rather than quietly adding nothing.
    expect(priced).not.toBeNull()
    groundingUsd += priced!.costUsd
  }

  return {
    totalUsd: tokenUsd + groundingUsd,
    tokenUsd,
    groundingUsd,
    tokenLedgerUsage: aiArgs.usage,
    externalCalls: mockRecordExternalUsage.mock.calls.length,
  }
}

describe('Athena console — grounding cost reaches the ledger', () => {
  it('records MORE for a grounded turn than an identical ungrounded one', async () => {
    const grounded = await recordedCostFor({
      providerMetadata: { google: { groundingMetadata: { webSearchQueries: ['abet outcomes', 'rubric examples'] } } },
    })
    const ungrounded = await recordedCostFor({
      steps: [{ toolCalls: [{ toolName: 'draft_assignment', input: {} }] }],
    })

    // The whole point of #270: identical tokens, strictly more dollars once the
    // model actually searched. Before the fix these two were equal.
    expect(grounded.totalUsd).toBeGreaterThan(ungrounded.totalUsd)
    // And the gap is exactly the published price of the 2 queries it ran — not
    // some rounding artefact, and not a flat per-message surcharge.
    const twoQueries = computeExternalCostUsd('google', 'search_grounding', 2)!.costUsd
    expect(grounded.totalUsd - ungrounded.totalUsd).toBeCloseTo(twoQueries, 6)
    expect(twoQueries).toBeGreaterThan(0)
  })

  it('leaves an ungrounded turn priced exactly as tokens alone', async () => {
    const ungrounded = await recordedCostFor({
      steps: [{ toolCalls: [{ toolName: 'draft_assignment', input: {} }] }],
    })

    // No external row at all — a turn that never searched must not be charged the
    // grounding rate (that would over-report, the opposite failure).
    expect(ungrounded.externalCalls).toBe(0)
    expect(ungrounded.groundingUsd).toBe(0)
    // Unchanged from token-only behaviour.
    expect(ungrounded.totalUsd).toBe(computeCostUsd(MODEL, USAGE))
  })

  it('keeps grounding OUT of the token ledger, so nothing is double-counted', async () => {
    const grounded = await recordedCostFor({
      providerMetadata: { google: { groundingMetadata: { webSearchQueries: ['a', 'b', 'c'] } } },
    })

    // Grounding is a separate billable unit (queries), so it must not be smuggled
    // into the token row as extra tokens — that would charge it twice once the
    // external row lands. Same tokens in, same token cost out.
    expect(grounded.tokenLedgerUsage).toEqual({
      inputTokens: USAGE.inputTokens,
      cachedInputTokens: USAGE.cachedInputTokens,
      outputTokens: USAGE.outputTokens,
      reasoningTokens: USAGE.reasoningTokens,
    })
    expect(grounded.tokenUsd).toBe(computeCostUsd(MODEL, USAGE))
    // Exactly one external row for the turn, carrying all 3 queries — not one row
    // per query, and not one row per step.
    expect(grounded.externalCalls).toBe(1)
    expect(mockRecordExternalUsage).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'google', feature: 'search_grounding', quantity: 3 }),
    )
  })

  it('bills the provider-executed search shape that reports no groundingMetadata', async () => {
    // The shape a real search-and-draft turn takes. Reading only groundingMetadata
    // logged 0 for genuinely billable searches — the under-count QA caught.
    const grounded = await recordedCostFor({
      steps: [
        { toolCalls: [{ toolName: 'server:GOOGLE_SEARCH_WEB', input: { queries: ['x', 'y'] } }] },
        { toolCalls: [{ toolName: 'draft_assignment', input: {} }] },
      ],
    })

    expect(grounded.groundingUsd).toBeCloseTo(
      computeExternalCostUsd('google', 'search_grounding', 2)!.costUsd,
      6,
    )
  })
})
