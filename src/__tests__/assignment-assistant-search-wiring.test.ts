// @vitest-environment node
//
// Route-level wiring for web search on the assignment/quiz/grading Athena
// (src/app/api/assignment-assistant/route.ts). Three things live ONLY here, in the
// route body, so no other suite can reach them:
//
//  1. The search tool is attached in the ROUTE, not in buildAssignmentAssistantTools
//     — it's a provider tool, gated on modelDef.provider === 'google'. That means the
//     exact-tool-set assertions in assignment-assistant-tools.test.ts describe the
//     FACTORY's output, not the set the model actually receives. This file pins the
//     effective set (and that the spread didn't clobber the factory's tools).
//  2. The grounded-query counter, which is the ONLY billing trail for search. Google
//     bills grounded queries per-1,000, separately from tokens, so recordAiUsage
//     (token-priced) does not see them. The first cut read only
//     providerMetadata.google.groundingMetadata and logged 0 for genuinely billable
//     searches — QA caught 1-3 real queries recorded as none. The fix reads a SECOND
//     shape (provider-executed 'server:GOOGLE_SEARCH_WEB' tool calls across steps[])
//     and combines with Math.max. Both shapes and the max are exercised below.
//  3. sendSources: true — without it the grounding citations never reach the client
//     and the panel's source chips are dead code (the panel side is covered by
//     athena-panel-fill-chip.test.tsx; this is the server half of that contract).
//
// streamText is mocked so we can read the tools object it was handed and invoke the
// captured onFinish with synthetic provider payloads. No network, no model.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockStreamText = vi.fn()
const mockToUIMessageStreamResponse = vi.fn(() => new Response('stream'))
const mockLogEvent = vi.fn()
const mockRecordAiUsage = vi.fn()
const mockRecordExternalUsage = vi.fn()
const mockGetUser = vi.fn()
const mockVerifySectionAccess = vi.fn()
const mockReserveAthenaSlot = vi.fn()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let captured: any

/* AI kill switch: these tests exercise the AI-ENABLED path — mock the guard
   open so their stubbed DB clients don't trip its fail-closed refusal. The
   disabled/locked paths are covered in ai-kill-switch.test.ts. */
vi.mock('@/lib/ai/kill-switch', () => ({
  checkAiFeature: vi.fn(async () => ({ allowed: true })),
  checkAiFeatureBySection: vi.fn(async () => ({ allowed: true })),
}))

vi.mock('ai', () => ({
  streamText: (...args: unknown[]) => mockStreamText(...args),
  // Identity: the route's history trim / orphan strip is covered elsewhere; here we
  // only care what reaches `tools` and `onFinish`.
  convertToModelMessages: async (m: unknown) => m,
  stepCountIs: (n: number) => n,
  smoothStream: () => undefined,
}))

vi.mock('@ai-sdk/google', () => {
  const google = (model: string) => ({ model })
  // The provider tool factory the route calls: google.tools.googleSearch({}).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(google as any).tools = { googleSearch: () => ({ providerTool: 'GOOGLE_SEARCH_WEB' }) }
  return { google }
})

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: mockGetUser } }),
}))
vi.mock('@/lib/auth/section-access', () => ({
  verifySectionAccess: (...a: unknown[]) => mockVerifySectionAccess(...a),
  canWriteAsStaff: (role: string) => role === 'professor' || role === 'ta',
}))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: (...a: unknown[]) => mockLogEvent(...a) }))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('@/lib/ai/professor-assistant/rate-limit', () => ({
  reserveAthenaSlot: (...a: unknown[]) => mockReserveAthenaSlot(...a),
}))
vi.mock('@/lib/ai/usage', () => ({ recordAiUsage: (...a: unknown[]) => mockRecordAiUsage(...a) }))
vi.mock('@/lib/costs/external-usage', () => ({
  recordExternalUsage: (...a: unknown[]) => mockRecordExternalUsage(...a),
}))
// The route defers its ledger writes with after() so a client abort can't
// cancel them; there is no request scope here, so run the callback inline.
vi.mock('next/server', () => ({ after: (fn: () => unknown) => fn() }))
vi.mock('@/lib/ai/professor-assistant/context', () => ({
  loadAssistantContext: async () => ({ institutionId: 'inst-1', courseTitle: 'Course', modules: [] }),
}))
vi.mock('@/lib/ai/assignment-assistant/context', () => ({
  loadGradeContext: async () => undefined,
  // Which rate-limit pool the turn draws from. Irrelevant to search wiring; the
  // real resolver is covered in athena-rate-limit.test.ts.
  resolveAthenaLimitScope: async () => 'assignment',
}))
vi.mock('@/lib/ai/assignment-assistant/prompts', () => ({
  buildAssignmentAssistantSystemPrompt: () => 'SYSTEM',
}))
// Two stand-in factory tools: enough to prove the spread preserves them.
vi.mock('@/lib/ai/assignment-assistant/tools', () => ({
  buildAssignmentAssistantTools: () => ({ apply_edits: {}, get_class_struggles: {} }),
}))

const GOOGLE_MODEL = {
  id: 'gemini-flash',
  provider: 'google',
  model: 'gemini-3-flash-preview',
  thinkingLevel: 'minimal',
  // Non-optional on the real AthenaModelDef. The route reads maxFiles on every
  // turn now that chat attachments are not gated to one kind, so a mock without
  // it throws where production cannot.
  attachments: { maxFiles: 5, maxBytesPerFile: 20 * 1024 * 1024, maxOfficeBytes: 10 * 1024 * 1024, acceptedExt: ['pdf'] },
}

/** A conversation id every real client always sends (useChat's own id); the
 *  route now needs one for every turn to persist against. */
const CONVERSATION_ID = '11111111-2222-4333-8444-555555555555'

/** A minimal but functional admin-client stub — the route now runs conversation-
 *  persistence queries (the IDOR ownership check, ensureConversation's upsert,
 *  the append RPC, updated_at/title updates) on every turn, which need
 *  something to chain onto and await or they throw before ever reaching the
 *  search-wiring behavior these tests care about. `.maybeSingle()` resolves to
 *  no existing row, so the IDOR guard always treats it as a brand-new thread. */
function fakeAdminDb() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {
    select: () => chain,
    insert: () => chain,
    update: () => chain,
    upsert: () => chain,
    eq: () => chain,
    is: () => chain,
    order: () => chain,
    limit: () => chain,
    maybeSingle: async () => ({ data: null, error: null }),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve),
  }
  return { from: () => chain, rpc: async () => ({ data: 1, error: null }) }
}

let POST: (req: Request) => Promise<Response>

beforeEach(async () => {
  vi.resetModules()
  // None of these mock implementations throw, so resetting them here is safe
  // (see the vitest-4 caveat in CLAUDE.md / llm-quiz-dedup-types.test.ts).
  mockStreamText.mockReset()
  mockToUIMessageStreamResponse.mockReset()
  mockLogEvent.mockReset()
  mockRecordAiUsage.mockReset()
  mockRecordExternalUsage.mockReset()
  mockGetUser.mockReset()
  mockVerifySectionAccess.mockReset()
  mockReserveAthenaSlot.mockReset()
  captured = undefined

  mockToUIMessageStreamResponse.mockImplementation(() => new Response('stream'))
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
  mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb: fakeAdminDb() })
  mockReserveAthenaSlot.mockResolvedValue({ accepted: true, modelDef: GOOGLE_MODEL })
  mockStreamText.mockImplementation((args: unknown) => {
    captured = args
    return { toUIMessageStreamResponse: mockToUIMessageStreamResponse }
  })

  const mod = await import('@/app/api/assignment-assistant/route')
  POST = mod.POST
})

function request(body: Record<string, unknown> = {}): Request {
  return new Request('http://localhost/api/assignment-assistant', {
    method: 'POST',
    body: JSON.stringify({
      sectionId: 'sec-1',
      surface: 'authoring',
      messages: [],
      screen: { authoring: { kind: 'files' } },
      id: CONVERSATION_ID,
      ...body,
    }),
  })
}

describe('assignment-assistant route — search tool attachment', () => {
  it('hands the model the factory tools PLUS google_search on a Gemini turn', async () => {
    const res = await POST(request())

    expect(res.status).toBe(200)
    // The effective set, which no factory-level test can see.
    expect(Object.keys(captured.tools).sort()).toEqual(
      ['apply_edits', 'get_class_struggles', 'google_search'].sort(),
    )
  })

  it('charges the resolved SCOPE, so each Athena surface draws its own pool', async () => {
    // Nothing else pins the wiring between the scope resolver and the reserve call.
    // Drop `scope` from the route's reserveAthenaSlot args and every surface silently
    // collapses back into one shared pool — with no type error and no other red test.
    await POST(request())

    expect(mockReserveAthenaSlot).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: 'assignment' }),
    )
  })

  it('attaches search on the grade surface too (fact-checking a submission)', async () => {
    await POST(request({ surface: 'grade', screen: { grade: { submissionId: 'sub-1' } } }))

    expect('google_search' in captured.tools).toBe(true)
  })

  it('omits search when the reserved model is not a Google provider', async () => {
    // Guards the gate itself: the union is google-only today, but rate-limit failover
    // picks the modelDef, so the day a non-Gemini model is added this must not hand it
    // a Gemini provider tool (the provider rejects the request outright).
    mockReserveAthenaSlot.mockResolvedValue({
      accepted: true,
      modelDef: { ...GOOGLE_MODEL, provider: 'anthropic' },
    })

    await POST(request())

    expect('google_search' in captured.tools).toBe(false)
    // …and the surface's own tools still get through.
    expect(Object.keys(captured.tools).sort()).toEqual(['apply_edits', 'get_class_struggles'])
  })

  it('forwards grounding sources to the client (the panel chips depend on it)', async () => {
    await POST(request())

    // onFinish is now also present (it persists the assistant's turn) —
    // this test only cares that sendSources rode along with it.
    expect(mockToUIMessageStreamResponse).toHaveBeenCalledWith(
      expect.objectContaining({ sendSources: true, onFinish: expect.any(Function) }),
    )
  })
})

describe('assignment-assistant route — grounded-query billing counter', () => {
  /** Run a turn, then invoke the captured onFinish and read back what got logged. */
  async function groundingQueriesFor(finishArgs: Record<string, unknown>): Promise<unknown> {
    await POST(request())
    mockLogEvent.mockClear()
    await captured.onFinish({ usage: {}, providerMetadata: undefined, steps: [], ...finishArgs })
    expect(mockLogEvent).toHaveBeenCalledTimes(1)
    return mockLogEvent.mock.calls[0][0].metadata.groundingQueries
  }

  it('counts classic grounding metadata queries', async () => {
    expect(
      await groundingQueriesFor({
        providerMetadata: { google: { groundingMetadata: { webSearchQueries: ['a', 'b'] } } },
      }),
    ).toBe(2)
  })

  it('counts provider-executed search tool calls when there is NO groundingMetadata', async () => {
    // The exact shape that silently logged 0 for billable searches.
    expect(
      await groundingQueriesFor({
        steps: [
          { toolCalls: [{ toolName: 'server:GOOGLE_SEARCH_WEB', input: { queries: ['x', 'y', 'z'] } }] },
        ],
      }),
    ).toBe(3)
  })

  it('sums search queries across every step of the agent loop', async () => {
    // A re-search on thin results is a second billable step, not a rounding error.
    expect(
      await groundingQueriesFor({
        steps: [
          { toolCalls: [{ toolName: 'server:GOOGLE_SEARCH_WEB', input: { queries: ['a', 'b'] } }] },
          { toolCalls: [{ toolName: 'apply_edits', input: {} }] },
          { toolCalls: [{ toolName: 'server:GOOGLE_SEARCH_WEB', input: { queries: ['c'] } }] },
        ],
      }),
    ).toBe(3)
  })

  it('charges a search call with no queries array as one query, never zero', async () => {
    expect(
      await groundingQueriesFor({
        steps: [{ toolCalls: [{ toolName: 'server:GOOGLE_SEARCH_WEB', input: {} }] }],
      }),
    ).toBe(1)
    expect(
      await groundingQueriesFor({
        steps: [{ toolCalls: [{ toolName: 'google_search', input: null }] }],
      }),
    ).toBe(1)
  })

  it('takes the MAX of the two shapes, so a turn reporting both is not double-counted', async () => {
    expect(
      await groundingQueriesFor({
        providerMetadata: { google: { groundingMetadata: { webSearchQueries: ['a', 'b'] } } },
        steps: [{ toolCalls: [{ toolName: 'server:GOOGLE_SEARCH_WEB', input: { queries: ['a', 'b'] } }] }],
      }),
    ).toBe(2)
  })

  it('does not undercount when only one shape is populated', async () => {
    // Max must not clamp to the smaller side: 3 tool-call queries with an empty
    // metadata array still bills 3.
    expect(
      await groundingQueriesFor({
        providerMetadata: { google: { groundingMetadata: { webSearchQueries: [] } } },
        steps: [{ toolCalls: [{ toolName: 'server:GOOGLE_SEARCH_WEB', input: { queries: ['a', 'b', 'c'] } }] }],
      }),
    ).toBe(3)
  })

  it('logs zero for a turn that never searched, and never omits the field', async () => {
    const queries = await groundingQueriesFor({
      steps: [{ toolCalls: [{ toolName: 'apply_edits', input: { ops: [] } }, { toolName: 'list_modules', input: {} }] }],
    })
    // 0, not undefined — the ledger must be able to tell "didn't search" from "unknown".
    expect(queries).toBe(0)
  })

  it('survives a malformed provider payload rather than throwing away the whole event', async () => {
    // groundingMetadata present but webSearchQueries not an array, and a null toolCall.
    expect(
      await groundingQueriesFor({
        providerMetadata: { google: { groundingMetadata: { webSearchQueries: 'two' } } },
        steps: [{ toolCalls: [null, { toolName: 'server:GOOGLE_SEARCH_WEB', input: { queries: ['a'] } }] }],
      }),
    ).toBe(1)
  })

  it('writes the priced grounding row for a turn that searched, and none otherwise', async () => {
    await groundingQueriesFor({
      providerMetadata: { google: { groundingMetadata: { webSearchQueries: ['a', 'b'] } } },
    })
    expect(mockRecordExternalUsage).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'google', feature: 'search_grounding', quantity: 2 }),
    )

    mockRecordExternalUsage.mockClear()
    await groundingQueriesFor({ steps: [{ toolCalls: [{ toolName: 'apply_edits', input: {} }] }] })
    expect(mockRecordExternalUsage).not.toHaveBeenCalled()
  })
})
