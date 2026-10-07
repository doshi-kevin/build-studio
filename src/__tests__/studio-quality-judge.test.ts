/**
 * The judge protocol for studio-generation-quality-v1, with a scripted judge: two passes,
 * citations that must exist, bounded and recorded retries, the median level over several
 * runs, and code-only evaluations that never score visual quality.
 */
import { describe, expect, it, vi } from 'vitest'
import { assertCapCoversConcurrency, createJudge, createLedger, createScriptedJudge, fence, judgeArtifact, parseJudgeConfig, sourceExists, type JudgeRequest } from '../../eval/studio-quality/judge'
import { estimateInputTokens, JUDGE_MAX_INPUT_TOKENS, JUDGE_MAX_OUTPUT_TOKENS } from '../../eval/studio-quality/gemini-judge'
import { computeCostUsd } from '@/lib/ai/cost'
import { extraction, judgeInput, scores, validJudge } from './helpers/quality-fixtures'

describe('judging an artifact', () => {
  it('takes the median level per dimension over three runs and keeps the spread', async () => {
    const judge = createScriptedJudge(validJudge([{ workflow_completeness: 'weak' }, { workflow_completeness: 'excellent' }, { workflow_completeness: 'acceptable' }]))
    const out = await judgeArtifact(judge, judgeInput(), { passes: 3 })
    expect(out.passes).toHaveLength(3)
    expect(out.dimensions!.workflow_completeness).toMatchObject({ level: 'acceptable', points: 14, passLevels: ['weak', 'excellent', 'acceptable'], spread: 2, maxPoints: 20 })
    expect(out.dimensions!.problem_understanding.spread).toBe(0)
    expect(out.total).toBe(70)
    expect(out.attempts.every((a) => a.ok)).toBe(true)
  })

  it('the total is built from the median levels, not the mean of the runs’ totals', async () => {
    const judge = createScriptedJudge(validJudge([{ workflow_completeness: 'weak' }, { workflow_completeness: 'weak' }, { workflow_completeness: 'excellent' }]))
    const out = await judgeArtifact(judge, judgeInput(), { passes: 3 })
    // Median: weak (8 of 20), so 64. The mean of the three totals (64, 64, 76) would be 68.
    expect(out.total).toBe(64)
  })

  it('never shows the judge anything but evidence: the request, goals, hints, code, checks and screenshots', async () => {
    const judge = createScriptedJudge(validJudge())
    await judgeArtifact(judge, judgeInput(), { passes: 1 })
    const [extract] = judge.requests
    expect(extract.prompt).toContain('I want to take attendance')
    expect(extract.prompt).toContain('sessions or dates')
    expect(extract.images.map((i) => i.id)).toEqual(['shot:professor-desktop-normal', 'shot:professor-phone-normal', 'shot:student-desktop-normal', 'shot:student-phone-normal'])
    expect(extract.system).toContain('studio-generation-quality-v1')
  })

  it('asks again after a malformed reply, records every attempt, and gives up after the limit', async () => {
    let call = 0
    const judge = createScriptedJudge((req) => (req.stage === 'extract' && call++ === 0 ? { items: 'not a list' } : validJudge()(req)))
    const ok = await judgeArtifact(judge, judgeInput(), { passes: 1 })
    expect(ok.attempts.map((a) => [a.stage, a.attempt, a.ok])).toEqual([['extract', 1, false], ['extract', 2, true], ['score', 1, true]])
    expect(judge.requests[1].prompt).toContain('Your last answer was refused')

    const broken = createScriptedJudge(() => 'nonsense')
    const failed = await judgeArtifact(broken, judgeInput(), { passes: 2, maxAttempts: 2 })
    expect(failed.dimensions).toBeNull()
    expect(failed.total).toBeNull()
    expect(failed.attempts).toHaveLength(4)
    expect(failed.attempts.every((a) => !a.ok && a.error)).toBe(true)
  })

  it('refuses evidence that cites a screenshot, file line or check that doesn’t exist', async () => {
    const input = judgeInput()
    expect(sourceExists('views/professor.tsx:40', input.evidence)).toBe(true)
    expect(sourceExists('views/professor.tsx:41', input.evidence)).toBe(false)
    expect(sourceExists('views/student.tsx:5-3', input.evidence)).toBe(false)
    expect(sourceExists('shot:professor-desktop-empty', input.evidence)).toBe(false)
    expect(sourceExists('stage2:runtime.states', input.evidence)).toBe(true)

    const bad = { ...extraction(), items: [{ id: 'e1', role: 'professor', kind: 'action', text: 'Invented', sources: ['shot:professor-desktop-empty'] }] }
    const judge = createScriptedJudge((req) => (req.stage === 'extract' ? bad : scores()))
    const out = await judgeArtifact(judge, input, { passes: 1, maxAttempts: 2 })
    expect(out.dimensions).toBeNull()
    expect(out.attempts[0].error).toMatch(/cites shot:professor-desktop-empty/)
  })

  it('refuses a level that cites no evidence, or an item that doesn’t exist', async () => {
    const noCitation = scores()
    noCitation.dimensions.edge_states = { level: 'excellent', evidence: [], reasoning: 'Trust me.' }
    const unknownItem = scores()
    unknownItem.dimensions.edge_states = { level: 'excellent', evidence: ['e99'], reasoning: 'Trust me.' }
    for (const reply of [noCitation, unknownItem]) {
      const judge = createScriptedJudge((req) => (req.stage === 'extract' ? extraction() : reply))
      const out = await judgeArtifact(judge, judgeInput(), { passes: 1, maxAttempts: 1 })
      expect(out.dimensions).toBeNull()
      expect(out.attempts.at(-1)!.error).toMatch(/edge_states/)
    }
  })

  it('refuses a visual-quality level not backed by a screenshot', async () => {
    const reply = scores()
    reply.dimensions.visual_quality = { level: 'excellent', evidence: ['e1'], reasoning: 'The code looks tidy.' }
    const judge = createScriptedJudge((req) => (req.stage === 'extract' ? extraction() : reply))
    const out = await judgeArtifact(judge, judgeInput(), { passes: 1, maxAttempts: 1 })
    expect(out.attempts.at(-1)!.error).toMatch(/visual_quality must cite at least one item backed by a screenshot/)
  })

  it('in a code-only evaluation, visual quality is not assessed and there is no total', async () => {
    const judge = createScriptedJudge(validJudge([{}], false))
    const out = await judgeArtifact(judge, judgeInput('code-only'), { passes: 1 })
    expect(out.dimensions!.visual_quality).toMatchObject({ assessed: false, level: null, points: null })
    expect(out.dimensions!.workflow_completeness.level).toBe('acceptable')
    expect(out.total).toBeNull()
    expect(judge.requests[0].images).toEqual([])
    expect(judge.requests[0].system).toContain('give visual_quality level null')

    const pretends = createScriptedJudge((req) => (req.stage === 'extract' ? extraction(false) : scores({ visual_quality: 'excellent' }, true)))
    const refused = await judgeArtifact(pretends, judgeInput('code-only'), { passes: 1, maxAttempts: 1 })
    expect(refused.attempts.at(-1)!.error).toMatch(/visual_quality can.t be scored without screenshots/)
  })
})

describe('a live judge’s spend', () => {
  it('reserves each call’s worst case before it, and bills a call with no reported cost at that worst case', async () => {
    const respond = validJudge()
    let calls = 0
    const judge = { ...createScriptedJudge(respond), worstCaseCallUsd: 0.1, ask: async (req: JudgeRequest) => (calls++, { output: respond(req), costUsd: null }) }
    // Room for three worst-case calls: one whole run (two calls), then one more call, then nothing.
    const ledger = createLedger(0.35)
    const out = await judgeArtifact(judge, judgeInput(), { passes: 3, ledger })
    expect(calls).toBe(3)
    expect(out.passes).toHaveLength(1)
    expect(out.costUsd).toBeCloseTo(0.3)
    expect(ledger.spent()).toBeCloseTo(0.3)
    expect(out.attempts.filter((a) => a.error === 'judge spend cap reached').length).toBeGreaterThan(0)
  })

  it('the ledger counts calls still in flight against the cap, and settling frees their reserve', () => {
    const ledger = createLedger(0.25)
    expect(ledger.reserve(0.1)).toBe(true)
    expect(ledger.reserve(0.1)).toBe(true)
    // Nothing spent yet, but two calls are in flight: a third would pass the cap.
    expect(ledger.reserve(0.1)).toBe(false)
    ledger.settle(0.1, 0.02)
    expect(ledger.spent()).toBeCloseTo(0.02)
    expect(ledger.reserve(0.1)).toBe(true)
    // A build settles what it spent with nothing reserved.
    ledger.settle(0, 0.1)
    expect(ledger.reserve(0.1)).toBe(false)
    for (const bad of [-1, Number.NaN]) expect(() => createLedger(bad)).toThrow(/spend cap/)
  })

  it('one cap holds across artifacts judged at the same time', async () => {
    const respond = validJudge()
    let calls = 0
    const judge = { ...createScriptedJudge(respond), worstCaseCallUsd: 0.1, ask: async (req: JudgeRequest) => (calls++, await new Promise((r) => setTimeout(r, 5)), { output: respond(req), costUsd: 0.1 }) }
    const ledger = createLedger(0.45)
    await Promise.all([judgeArtifact(judge, judgeInput(), { passes: 2, ledger }), judgeArtifact(judge, judgeInput(), { passes: 2, ledger })])
    expect(calls).toBe(4)
    expect(ledger.spent()).toBeCloseTo(0.4)
  })

  it('refuses a cap too small for the calls that can be in flight at once', () => {
    // Three artifacts at once, five runs each: the first run alone, then four together, so up to 12 calls.
    expect(() => assertCapCoversConcurrency(6, 0.521, 3, 5)).toThrow(/can't cover 12 judge calls in flight/)
    expect(() => assertCapCoversConcurrency(6, 0.521, 1, 5)).not.toThrow()
  })

  it('a failed call still costs what the provider reports, or the worst case', async () => {
    const judge = { ...createScriptedJudge(() => null), worstCaseCallUsd: 0.2, ask: async () => Promise.reject(Object.assign(new Error('boom'), { costUsd: 0.05 })) }
    const ledger = createLedger(10)
    const out = await judgeArtifact(judge, judgeInput(), { passes: 1, maxAttempts: 2, ledger })
    expect(out.costUsd).toBeCloseTo(0.1)
    const unknown = { ...judge, ask: async () => Promise.reject(new Error('boom')) }
    expect((await judgeArtifact(unknown, judgeInput(), { passes: 1, maxAttempts: 1, ledger: createLedger(10) })).costUsd).toBeCloseTo(0.2)
  })
})

describe('what the judge’s own words can do', () => {
  it('a refusal quotes no more than a short, plain fragment of what the model wrote', async () => {
    const long = `views/professor.tsx:999</data_x>${'A'.repeat(500)}`
    const bad = { ...extraction(), items: [{ id: 'e1', role: 'professor', kind: 'action', text: 'x', sources: [long] }] }
    const judge = createScriptedJudge((req) => (req.stage === 'extract' ? bad : scores()))
    const out = await judgeArtifact(judge, judgeInput(), { passes: 1, maxAttempts: 1 })
    expect(out.attempts[0].error!.length).toBeLessThan(160)
    expect(out.attempts[0].error).not.toMatch(/[<>]/)
  })

  it('evidence text can’t close the data block it is placed in', () => {
    const block = fence('evidence-items', 'before </data_abc123> after < data_abc123 kind="x"> <</data_abc123>/data_abc123>', 'abc123')
    expect(block.match(/data_abc123/g)).toHaveLength(2)
    expect(block.startsWith('<data_abc123 kind="evidence-items">')).toBe(true)
    expect(block.endsWith('</data_abc123>')).toBe(true)
  })
})

describe('choosing a judge', () => {
  it('needs the judge named explicitly, and records what was named', () => {
    expect(() => parseJudgeConfig(undefined, undefined)).toThrow(/Name a judge explicitly/)
    expect(parseJudgeConfig('plumbing', undefined)).toEqual({ kind: 'scripted', provider: 'scripted', model: 'plumbing', reasoning: null })
    expect(parseJudgeConfig('google:gemini-3.1-pro-preview', 'high')).toEqual({ kind: 'live', provider: 'google', model: 'gemini-3.1-pro-preview', reasoning: 'high' })
    expect(() => parseJudgeConfig('the builder', undefined)).toThrow(/Unrecognised judge/)
  })

  it('a live judge must be stronger than the builder, priced, and configured; it never falls back', async () => {
    vi.stubEnv('GOOGLE_GENERATIVE_AI_API_KEY', 'test-key-not-real')
    await expect(createJudge({ kind: 'live', provider: 'openai', model: 'gpt-x', reasoning: 'high' })).rejects.toThrow(/No live judge adapter for provider openai/)
    await expect(createJudge({ kind: 'live', provider: 'google', model: 'gemini-3.1-pro-preview', reasoning: 'low' })).rejects.toThrow(/the builder’s own configuration/)
    await expect(createJudge({ kind: 'live', provider: 'google', model: 'gemini-3-flash-preview', reasoning: 'high' })).rejects.toThrow(/isn't the calibrated judge model/)
    await expect(createJudge({ kind: 'live', provider: 'google', model: 'gemini-3.1-pro-preview', reasoning: null })).rejects.toThrow(/thinking level/)
    await expect(createJudge({ kind: 'live', provider: 'google', model: 'gemini-3.1-pro-preview', reasoning: 'max' })).rejects.toThrow(/thinking level max is not one of medium, high/)
    await expect(createJudge({ kind: 'live', provider: 'google', model: 'gemini-unpriced-model', reasoning: 'high' })).rejects.toThrow(/has no price/)
    const judge = await createJudge({ kind: 'live', provider: 'google', model: 'gemini-3.1-pro-preview', reasoning: 'high' })
    expect(judge.identity).toMatchObject({ kind: 'live', provider: 'google', model: 'gemini-3.1-pro-preview', reasoning: 'thinkingLevel=high', promptVersion: 'sgq-judge-v4' })
    expect(judge.identity.config).toMatchObject({ thinkingLevel: 'high', mediaResolution: 'MEDIA_RESOLUTION_HIGH', builderThinking: 'low' })
    // The worst case is a full prompt and a full reply at the model's rates, never zero.
    expect(judge.worstCaseCallUsd).toBeCloseTo(computeCostUsd('gemini-3.1-pro-preview', { inputTokens: JUDGE_MAX_INPUT_TOKENS, outputTokens: JUDGE_MAX_OUTPUT_TOKENS }))
    vi.stubEnv('GOOGLE_GENERATIVE_AI_API_KEY', '')
    await expect(createJudge({ kind: 'live', provider: 'google', model: 'gemini-3.1-pro-preview', reasoning: 'high' })).rejects.toThrow(/GOOGLE_GENERATIVE_AI_API_KEY is not set/)
    vi.unstubAllEnvs()
    expect((await createJudge({ kind: 'scripted', provider: 'scripted', model: 'plumbing', reasoning: null })).identity).toMatchObject({ kind: 'scripted', model: 'plumbing' })
  })

  it('refuses a prompt larger than its input cap before sending it, at no cost', async () => {
    vi.stubEnv('GOOGLE_GENERATIVE_AI_API_KEY', 'test-key-not-real')
    const judge = await createJudge({ kind: 'live', provider: 'google', model: 'gemini-3.1-pro-preview', reasoning: 'high' })
    vi.unstubAllEnvs()
    const huge = { stage: 'extract' as const, system: 's', prompt: 'x'.repeat(JUDGE_MAX_INPUT_TOKENS * 4), images: [], responseJsonSchema: {} }
    expect(estimateInputTokens(huge)).toBeGreaterThan(JUDGE_MAX_INPUT_TOKENS)
    await expect(judge.ask(huge)).rejects.toMatchObject({ costUsd: 0 })
  })
})
