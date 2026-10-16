/**
 * The builder's Anthropic adapter (the 12B provider migration): what it sends, how it
 * normalizes replies, usage and cost, a missing key, no fallback to Gemini, and one full
 * build through the real harness on Anthropic-shaped replies. No network: the SDK client
 * is a stand-in.
 */
import { describe, expect, it, vi } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'

vi.mock('@ai-sdk/google', () => ({ google: vi.fn(() => { throw new Error('Gemini must not be called') }) }))

const { google } = await import('@ai-sdk/google')
const { logger } = await import('@/lib/logger')
const { computeCostUsd } = await import('@/lib/ai/cost')
const { ANTHROPIC_FAST_MODEL_SUFFIX, STUDIO_BUILDER_ANTHROPIC_EFFORT, STUDIO_BUILDER_ANTHROPIC_FAST, STUDIO_BUILDER_ANTHROPIC_FAST_MAX_OUTPUT_TOKENS, STUDIO_BUILDER_ANTHROPIC_MAX_OUTPUT_TOKENS, STUDIO_BUILDER_ANTHROPIC_MODEL } = await import('@/lib/ai/config')
const { STUDIO_BUILDER_CONTEXT_MAX_TOKENS, STUDIO_BUILDER_MAX_OUTPUT_TOKENS } = await import('@/lib/studio/limits')
const { anthropicUsage, BuilderAbort, createAnthropicModel, ModelUnavailable } = await import('@/lib/studio/builder/model')
const { runBuilderSlice, realHarnessDeps, WORST_CASE_CALL_USD } = await import('@/lib/studio/builder/harness')
const { runDraftChecks } = await import('@/lib/studio/builder/checks')
const { createMemoryStore, newRun } = await import('./helpers/builder-memory-store')
const { call, finish, inProcessWorkerCheck, plan, PROFESSOR_VIEW, proposeManifest, STUDENT_VIEW, write } = await import('./helpers/builder-fixtures')
type HarnessDeps = import('@/lib/studio/builder/harness').HarnessDeps
type ModelStepInput = import('@/lib/studio/builder/model').ModelStepInput

const message = (content: unknown[], stop: string = 'tool_use', usage: Partial<Anthropic.Usage> = { input_tokens: 1000, output_tokens: 200 }) =>
  ({ id: 'msg_1', type: 'message', role: 'assistant', model: STUDIO_BUILDER_ANTHROPIC_MODEL, content, stop_reason: stop, stop_sequence: null, usage }) as unknown as Anthropic.Message

/** An SDK stand-in that answers each call with the next message and records the requests. */
function fakeClient(replies: (Anthropic.Message | Error)[]) {
  const requests: Anthropic.MessageStreamParams[] = []
  let i = 0
  return {
    requests,
    messages: {
      stream: vi.fn((params: Anthropic.MessageStreamParams) => {
        requests.push(params)
        const next = replies[i++]
        return { finalMessage: async () => { if (next instanceof Error) throw next; return next } }
      }),
    },
  }
}

const stepInput = (over: Partial<ModelStepInput> = {}): ModelStepInput => ({
  system: 'SYSTEM',
  prompt: 'PROMPT',
  tools: [{ name: 'run_checks', description: 'Run the checks.', inputSchema: z.strictObject({}) }, { name: 'finish', description: 'End.', inputSchema: z.strictObject({ status: z.enum(['completed', 'blocked']), summary: z.string() }) }],
  maxOutputTokens: 24_000,
  abortSignal: new AbortController().signal,
  timeoutMs: 60_000,
  ...over,
})

describe('the Anthropic adapter', () => {
  it('sends the system, the prompt, schemas from the tool registry, auto tool choice and the configured effort', async () => {
    const client = fakeClient([message([{ type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 'toolu_1', name: 'run_checks', input: {} }])])
    const image = { label: 'professor view', mediaType: 'image/png' as const, bytes: new Uint8Array([1, 2, 3]) }
    const r = await createAnthropicModel(undefined, undefined, client).step(stepInput({ images: [image] }))

    const req = client.requests[0]
    expect(req).toMatchObject({ model: 'claude-opus-5-5', max_tokens: 24_000, system: 'SYSTEM', tool_choice: { type: 'auto' }, output_config: { effort: STUDIO_BUILDER_ANTHROPIC_EFFORT } })
    expect(req.tools!.map((t) => (t as Anthropic.Tool).input_schema)).toEqual([expect.objectContaining({ type: 'object' }), expect.objectContaining({ type: 'object', required: ['status', 'summary'] })])
    expect(req.messages[0].content).toEqual([
      { type: 'text', text: 'PROMPT' },
      { type: 'text', text: 'professor view' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } },
    ])
    expect(r).toMatchObject({ toolCalls: [{ name: 'run_checks', input: {}, invalid: false }], textLength: 9, finishReason: 'tool-calls', timedOut: false, modelId: 'claude-opus-5-5' })
  })

  it('fast mode goes to the beta endpoint with its flag, is priced at its own rate, and a rate limit falls back to standard speed, same model', async () => {
    const fastRequests: Record<string, unknown>[] = []
    const reply = message([{ type: 'tool_use', id: 'toolu_1', name: 'run_checks', input: {} }])
    const { RateLimitError } = (await import('@anthropic-ai/sdk')).default
    const replies: (Anthropic.Message | Error)[] = [reply, new RateLimitError(429, undefined, 'fast mode rate limited', new Headers())]
    let j = 0
    const fastOptions: unknown[] = []
    const client = { ...fakeClient([reply, reply]), beta: { messages: { stream: vi.fn((params: never, options?: unknown) => {
      fastRequests.push(params)
      fastOptions.push(options)
      const next = replies[j++]
      return { finalMessage: async () => { if (next instanceof Error) throw next; return next } }
    }) } } }
    const model = createAnthropicModel(undefined, undefined, client)
    const served = await model.step(stepInput({ speed: 'fast' }))
    expect(fastRequests[0]).toMatchObject({ model: 'claude-opus-5-5', speed: 'fast', betas: ['fast-mode-2026-02-01'] })
    expect(served.modelId).toBe('claude-opus-5-5' + ANTHROPIC_FAST_MODEL_SUFFIX)
    // No SDK retries in fast mode: its rate limit goes straight to standard speed.
    expect(fastOptions[0]).toMatchObject({ maxRetries: 0 })
    // Rate-limited in fast mode: the same request at standard speed, priced as standard.
    const fallback = await model.step(stepInput({ speed: 'fast' }))
    expect(client.requests).toHaveLength(1)
    expect(client.requests[0]).not.toHaveProperty('speed')
    expect(fallback.modelId).toBe('claude-opus-5-5')
    // Without fast mode asked for, the standard endpoint.
    await model.step(stepInput())
    expect(client.requests).toHaveLength(2)
    expect(google).not.toHaveBeenCalled()
  })

  it('a fast attempt cut off by its timeout is reported at the fast rate', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    const client = { ...fakeClient([]), beta: { messages: { stream: vi.fn(() => ({ finalMessage: async () => { throw timeout } })) } } }
    const r = await createAnthropicModel(undefined, undefined, client).step(stepInput({ speed: 'fast' }))
    expect(r).toMatchObject({ timedOut: true, modelId: 'claude-opus-5-5' + ANTHROPIC_FAST_MODEL_SUFFIX })
  })

  it('a turn that names its own effort gets it; the rest keep the configured one', async () => {
    const client = fakeClient([message([{ type: 'tool_use', id: 'toolu_1', name: 'run_checks', input: {} }]), message([{ type: 'tool_use', id: 'toolu_2', name: 'run_checks', input: {} }])])
    const model = createAnthropicModel(undefined, undefined, client)
    await model.step(stepInput({ effort: 'low' }))
    await model.step(stepInput())
    expect(client.requests.map((r) => (r as { output_config?: { effort?: string } }).output_config?.effort)).toEqual(['low', STUDIO_BUILDER_ANTHROPIC_EFFORT])
  })

  it('marks arguments that are not an object invalid, and maps a cut-off reply to length', async () => {
    const client = fakeClient([
      message([{ type: 'tool_use', id: 'toolu_1', name: 'finish', input: 'not an object' }, { type: 'tool_use', id: 'toolu_2', name: 'finish', input: [1] }]),
      message([], 'max_tokens'),
    ])
    const model = createAnthropicModel(undefined, undefined, client)
    expect((await model.step(stepInput())).toolCalls.map((c) => c.invalid)).toEqual([true, true])
    // The harness refuses a cut-off turn on 'length' (turn_truncated).
    expect(await model.step(stepInput())).toMatchObject({ toolCalls: [], finishReason: 'length' })
  })

  it('a Stop or lost claim mid-call aborts the run, and a timeout returns as a timeout with no usage', async () => {
    const stop = new AbortController()
    stop.abort()
    await expect(createAnthropicModel(undefined, undefined, fakeClient([new Error('aborted')])).step(stepInput({ abortSignal: stop.signal }))).rejects.toBeInstanceOf(BuilderAbort)
    const timeout = Object.assign(new Error('request timed out'), { name: 'TimeoutError' })
    expect(await createAnthropicModel(undefined, undefined, fakeClient([timeout])).step(stepInput())).toMatchObject({ timedOut: true, finishReason: 'timeout', toolCalls: [], usage: { input: 0, output: 0 } })
  })

  it('reports the configured model id even when the API names a dated snapshot, so cost keeps its rate row', async () => {
    const reply = { ...message([{ type: 'tool_use', id: 'toolu_1', name: 'run_checks', input: {} }]), model: 'claude-opus-5-5-20261001' } as Anthropic.Message
    expect((await createAnthropicModel(undefined, undefined, fakeClient([reply])).step(stepInput())).modelId).toBe('claude-opus-5-5')
  })

  it('maps usage into the budget ledger and prices it at the model’s own rates', () => {
    const u = anthropicUsage({ input_tokens: 1000, cache_read_input_tokens: 200, cache_creation_input_tokens: 50, output_tokens: 500 })
    expect(u).toEqual({ input: 1250, cachedInput: 200, output: 500, reasoning: 0 })
    const cost = computeCostUsd('claude-opus-5-5', { inputTokens: u.input, cachedInputTokens: u.cachedInput, outputTokens: u.output, reasoningTokens: u.reasoning })
    expect(cost).toBeCloseTo((1050 * 4 + 200 * 0.2 + 500 * 20) / 1e6, 10)
    // The run's cost cap reserves a full prompt and a full reply at the live model's rates, at its own
    // reply cap, in fast mode when it's on (twice the standard rates).
    const [inRate, outRate] = STUDIO_BUILDER_ANTHROPIC_FAST ? [8, 40] : [4, 20]
    const reply = STUDIO_BUILDER_ANTHROPIC_FAST ? STUDIO_BUILDER_ANTHROPIC_FAST_MAX_OUTPUT_TOKENS : STUDIO_BUILDER_ANTHROPIC_MAX_OUTPUT_TOKENS
    expect(WORST_CASE_CALL_USD).toBeCloseTo((STUDIO_BUILDER_CONTEXT_MAX_TOKENS * inRate + reply * outRate) / 1e6, 10)
    expect(computeCostUsd(STUDIO_BUILDER_ANTHROPIC_MODEL + ANTHROPIC_FAST_MODEL_SUFFIX, { inputTokens: 1000, outputTokens: 500 })).toBeCloseTo(2 * computeCostUsd(STUDIO_BUILDER_ANTHROPIC_MODEL, { inputTokens: 1000, outputTokens: 500 }), 10)
    expect(createAnthropicModel().maxOutputTokens).toBe(STUDIO_BUILDER_ANTHROPIC_MAX_OUTPUT_TOKENS)
    expect(STUDIO_BUILDER_ANTHROPIC_MAX_OUTPUT_TOKENS).toBeGreaterThan(STUDIO_BUILDER_MAX_OUTPUT_TOKENS)
  })

  it('without ANTHROPIC_API_KEY the call fails clearly, and nothing falls back to Gemini', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    const error = vi.spyOn(logger, 'error')
    await expect(createAnthropicModel().step(stepInput())).rejects.toBeInstanceOf(ModelUnavailable)
    expect(error).toHaveBeenCalledWith('studio.builder.model.no_key: ANTHROPIC_API_KEY is not set', { model: 'claude-opus-5-5' })
    // A provider error ends the call too, with no second provider tried.
    const client = fakeClient([new Error('overloaded')])
    await expect(createAnthropicModel(undefined, undefined, client).step(stepInput())).rejects.toBeInstanceOf(ModelUnavailable)
    expect(google).not.toHaveBeenCalled()
    expect(realHarnessDeps().model.id).toBe(STUDIO_BUILDER_ANTHROPIC_MODEL)
    // Product Intelligence is on Anthropic too: without the key it fails, and never tries Gemini.
    const firstBuild = newRun({ request: 'My students struggle to understand confidence intervals.', baseHash: null })
    await expect(realHarnessDeps().productIntelligence!(firstBuild, { course: null, skills: null } as never, async () => true)).rejects.toBeInstanceOf(ModelUnavailable)
    expect(google).not.toHaveBeenCalled()
    error.mockRestore()
    vi.unstubAllEnvs()
  })
})

describe('a build on Anthropic replies through the real harness', () => {
  it('plans, waits for the manifest card, writes, checks, is reviewed and ends Preview ready', async () => {
    const turns = [[plan()], [proposeManifest()], [write('views/student.tsx', STUDENT_VIEW), write('views/professor.tsx', PROFESSOR_VIEW), call('run_checks')], [finish()], [call('submit_review', { verdict: 'ready', unmet_requirements: [], major_issues: [], minor_issues: [] })]]
    const client = fakeClient(turns.map((calls) => message(calls.map((c, i) => ({ type: 'tool_use', id: `toolu_${i}`, name: c.name, input: c.input })))))
    const run = newRun({ status: 'queued' })
    const mem = createMemoryStore(run)
    const deps: HarnessDeps = {
      store: mem.store,
      model: createAnthropicModel(undefined, undefined, client),
      loadSliceData: async () => ({ slug: 'tool-abc12345', published: null, publishedVersions: [], base: null, course: { code: 'BIO 101', title: 'Biology' }, skills: [], history: [], materialSources: [] }),
      loadMemories: async () => [],
      gate: async () => null,
      runChecks: async (_run, data, work) => runDraftChecks(work, { workerCheck: inProcessWorkerCheck, rosterFullNames: ['Maria Lopez'], published: data.published, disclosureSources: [] }),
      searchMaterial: async () => ({ ok: false as const }),
      rehydrateMaterial: async () => [],
      recordUsage: vi.fn(async () => {}),
      renderPreview: async () => ({ ok: false as const, reason: 'unavailable' as const }),
      audit: vi.fn(),
      kick: vi.fn(),
      now: () => Date.now(),
      heartbeatMs: 5,
    }
    const slice = () => runBuilderSlice({ runId: run.id, sliceNo: mem.state.run.sliceNo }, { id: mem.currentJob().id, deadline: Date.now() + 15 * 60_000 }, deps)

    expect(await slice()).toBe('stopped')
    expect(mem.state.run.status).toBe('waiting_for_approval')
    const card = mem.state.run.pendingApproval as { proposal_id: string; delta_hash: string }
    expect(mem.professor.decide(card.proposal_id, card.delta_hash, true)).toBe('decided')
    expect(await slice()).toBe('stopped')

    expect(mem.state.run.status).toBe('preview_ready')
    expect(mem.state.snapshots.size).toBe(1)
    // Every turn was recorded against the Anthropic model, at its rates.
    expect(client.requests).toHaveLength(5)
    expect(vi.mocked(deps.recordUsage).mock.calls.map((c) => c[2])).toEqual(Array(5).fill('claude-opus-5-5'))
    expect(mem.state.run.counters.costUsd).toBeCloseTo(5 * computeCostUsd('claude-opus-5-5', { inputTokens: 1000, outputTokens: 200 }), 10)
  })
})
