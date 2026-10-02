/**
 * Builder failure recovery and run budgets at their exact boundaries, hermetic: the real
 * harness, a scripted model and the in-memory run store (helpers/builder-memory-store.ts).
 * The same rules in SQL, and the races between them, are in
 * src/__tests__/db/studio-builder-budgets.test.ts.
 *
 * Covered elsewhere and not repeated here: three malformed turns in a row, model
 * unavailability, Stop mid-call, a stale slice's writes, the turn cap and the run's
 * own spend tripping the cost cap (studio-builder-harness.test.ts); the worker's
 * time limit with a real compile (studio-builder-compile.test.ts).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/jobs/enqueue', () => ({ kickWorker: vi.fn(async () => ({ kicked: true })) }))
vi.mock('@/lib/ai/kill-switch', () => ({ checkAiFeature: vi.fn(async () => ({ allowed: true })) }))
vi.mock('@/lib/studio/access', () => ({ studioAccess: vi.fn(async () => 'full'), studioKillSwitchEngaged: vi.fn(async () => false), STUDIO_PAUSED: 'Studio is paused right now. Try again later.' }))
vi.mock('@/lib/studio/context', () => ({ requireProfessor: vi.fn(), sessionUserId: vi.fn(), builderActor: vi.fn(async () => ({ ok: true, actor: {} })) }))
vi.mock('@/lib/studio/db', () => ({
  builderRpcs: {
    start: vi.fn(), stop: vi.fn(), decide: vi.fn(), answer: vi.fn(), tend: vi.fn(async () => ({ outcome: 'none' })),
    claim: vi.fn(), heartbeat: vi.fn(), addCost: vi.fn(), recordTurn: vi.fn(), apply: vi.fn(), pause: vi.fn(), handoff: vi.fn(), end: vi.fn(),
  },
  memoryRpcs: { propose: vi.fn(), decide: vi.fn(), save: vi.fn(), remove: vi.fn(), expire: vi.fn(async () => 0) },
  listActiveMemories: vi.fn(async () => []),
  listRunMemoryProposals: vi.fn(async () => []),
  loadBuilderRun: vi.fn(),
  listBuilderSteps: vi.fn(async () => []),
  loadBuilderProject: vi.fn(),
  listProjectRuns: vi.fn(async () => []),
  loadInstitutionBuilderSpend: vi.fn(async () => 0),
}))
vi.mock('@/lib/studio/validator/service', () => ({ validateAfterPublish: vi.fn(), currentVerdict: vi.fn() }))
// A stand-in check worker whose behaviour the student view's text picks, so the real
// check-worker.ts (thread, limits, replacement) can be driven through a crash or a hang.
vi.mock('@/lib/studio/builder/check-worker.generated', () => ({
  CHECK_WORKER_SOURCE: `
    const { parentPort } = require('node:worker_threads')
    parentPort.on('message', (m) => {
      const s = m.files['views/student.tsx']
      if (s === 'CRASH') throw new Error('worker crashed')
      if (s === 'EXIT') process.exit(1)
      if (s === 'SILENT') return
      parentPort.postMessage({ id: m.id, result: { compiler: 'stub', compile: {}, typecheck: { total: 0 } } })
    })`,
}))

const db = await import('@/lib/studio/db')
const { requireProfessor, sessionUserId } = await import('@/lib/studio/context')
const { runBuilderSlice, realHarnessDeps, WORST_CASE_CALL_USD } = await import('@/lib/studio/builder/harness')
type HarnessDeps = import('@/lib/studio/builder/harness').HarnessDeps
type RunStore = import('@/lib/studio/builder/harness').RunStore
type SliceData = import('@/lib/studio/builder/harness').SliceData
const { runDraftChecks } = await import('@/lib/studio/builder/checks')
const { runWorkerCheck, CheckFault, CheckTimeout } = await import('@/lib/studio/builder/check-worker')
const { computeCostUsd } = await import('@/lib/ai/cost')
const { parseManifest } = await import('@/lib/studio/manifest')
const service = await import('@/lib/studio/builder/service')
const limits = await import('@/lib/studio/limits')
const { createMemoryStore, newRun } = await import('./helpers/builder-memory-store')
const { call, finish, FLASHCARDS_MANIFEST, inProcessWorkerCheck, plan, PROFESSOR_VIEW, proposeManifest, scriptedModel, STUDENT_VIEW, write } = await import('./helpers/builder-fixtures')
type ScriptedTurn = import('./helpers/builder-fixtures').ScriptedTurn
type BuilderRunRow = import('@/lib/studio/db').BuilderRunRow

const SLUG = 'tool-abc12345'
const views = { 'views/student.tsx': STUDENT_VIEW, 'views/professor.tsx': PROFESSOR_VIEW }
/** What one scripted turn costs (scriptedModel's fixed usage). */
const TURN_USD = computeCostUsd('gemini-3.1-pro-preview', { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 200, reasoningTokens: 100 })
const kit = (component = 'Button') => call('get_kit_reference', { component })

function base(): SliceData['base'] {
  const parsed = parseManifest({
    ...FLASHCARDS_MANIFEST,
    manifestVersion: 2,
    id: SLUG,
    version: '0.0.0',
    bridgeVersion: 'v1',
    views: { student: { entry: 'views/student.tsx', capabilities: [] }, professor: { entry: 'views/professor.tsx', capabilities: [] } },
  })
  if (!parsed.ok || parsed.manifest.manifestVersion !== 2) throw new Error('fixture')
  return { manifest: parsed.manifest, files: { ...views } }
}

interface Setup {
  counters?: Partial<BuilderRunRow['counters']>
  base?: SliceData['base']
  gate?: HarnessDeps['gate']
  runChecks?: HarnessDeps['runChecks']
  /** Advanced by the test; the harness reads time only through deps.now(). */
  clock?: { t: number }
}

function harness(script: ScriptedTurn[], setup: Setup = {}) {
  const b = setup.base === undefined ? base() : setup.base
  const run = newRun({ baseHash: b ? 'b'.repeat(64) : null, baseRev: b ? 1 : 0, counters: { ...newRun().counters, ...setup.counters } })
  const mem = createMemoryStore(run)
  const model = scriptedModel(script)
  const now = () => setup.clock?.t ?? Date.now()
  const deps: HarnessDeps = {
    store: mem.store,
    model,
    loadSliceData: async () => ({ slug: SLUG, published: null, publishedVersions: [], base: b, course: { code: 'BIO 101', title: 'Biology' }, skills: [], history: [] }),
    loadMemories: async () => [],
    gate: setup.gate ?? (async () => null),
    runChecks: setup.runChecks ?? (async (_run, data, work) => runDraftChecks(work, { workerCheck: inProcessWorkerCheck, rosterFullNames: [], published: data.published })),
    recordUsage: vi.fn(async () => {}),
    audit: vi.fn(),
    kick: vi.fn(),
    now,
    heartbeatMs: 5,
  }
  const slice = (d: HarnessDeps = deps, deadline = now() + 15 * 60_000) =>
    runBuilderSlice({ runId: run.id, sliceNo: mem.state.run.sliceNo }, { id: mem.currentJob().id, deadline }, d)
  return { mem, model, deps, slice, run }
}

/** A store whose instance stops answering for good once `dies` matches: Cloud Run shut it down. */
function mortal(store: RunStore, dies: (method: string, args: unknown[]) => boolean): RunStore {
  let dead = false
  const wrapped: Record<string, unknown> = {}
  for (const [name, fn] of Object.entries(store) as [string, (...a: unknown[]) => Promise<unknown>][]) {
    wrapped[name] = async (...args: unknown[]) => {
      if (!dead && dies(name, args)) dead = true
      if (dead) throw new Error('instance stopped')
      return fn(...args)
    }
  }
  return wrapped as unknown as RunStore
}
const stepId = (args: unknown[]) => String((args[0] as { step?: { tool_call_id?: string } }).step?.tool_call_id ?? '')

describe('Cloud Run stops a slice mid-turn', () => {
  it('a live slice keeps its claim; once its heartbeat is stale the next claim marks the unrecorded calls interrupted and the run ends', async () => {
    const h = harness([{ calls: [kit('Button'), kit('Text'), kit('Card')] }, { calls: [finish('blocked', 'Nothing to change.')] }])
    // The instance dies after the turn's first call is recorded, before the second.
    const dying = { ...h.deps, store: mortal(h.mem.store, (m, a) => m === 'apply' && stepId(a).endsWith('.1')) }
    expect(await h.slice(dying)).toBe('faulted')
    const turn = h.mem.state.steps.find((s) => s.kind === 'model_turn')!
    expect(h.mem.state.run.status).toBe('running')
    expect(h.mem.state.steps.map((s) => s.toolCallId)).toContain(`${turn.seq}.0`)
    expect(h.mem.state.steps.map((s) => s.toolCallId)).not.toContain(`${turn.seq}.1`)

    // The heartbeat is still fresh: nobody may take the run over yet.
    expect(await h.slice()).toBe('not claimed')
    h.mem.state.heartbeatAt = Date.now() - limits.STUDIO_BUILDER_HEARTBEAT_STALE_MS - 1
    expect(await h.slice()).toBe('stopped')

    const byId = new Map(h.mem.state.steps.map((s) => [s.toolCallId, s]))
    expect(byId.get(`${turn.seq}.0`)?.status).toBe('done')
    expect(byId.get(`${turn.seq}.1`)?.status).toBe('interrupted')
    expect(byId.get(`${turn.seq}.2`)?.status).toBe('interrupted')
    // The recorded turn isn't re-asked; the resumed prompt says what happened.
    expect(h.model.prompts).toHaveLength(2)
    expect(h.model.prompts[1].prompt).toContain('The build was interrupted and resumed')
    expect(h.mem.state.run.resumeCount).toBe(1)
    expect(h.mem.state.run).toMatchObject({ status: 'blocked', errorCode: 'agent_blocked' })
  })

  it('dying between the model reply and its record re-asks that one turn, and its spend stays on the run', async () => {
    const h = harness([{ calls: [kit()] }, { calls: [finish('blocked', 'x')] }])
    const dying = { ...h.deps, store: mortal(h.mem.store, (m) => m === 'recordTurn') }
    expect(await h.slice(dying)).toBe('faulted')
    expect(h.mem.state.run.counters.modelTurns).toBe(0)
    expect(h.mem.state.run.counters.costUsd).toBeCloseTo(TURN_USD, 9)

    h.mem.state.heartbeatAt = Date.now() - limits.STUDIO_BUILDER_HEARTBEAT_STALE_MS - 1
    await h.slice()
    expect(h.model.prompts).toHaveLength(2)
    expect(h.mem.state.run.counters.modelTurns).toBe(1)
    expect(h.mem.state.run.counters.costUsd).toBeCloseTo(2 * TURN_USD, 9)
    expect(h.mem.state.run.status).toBe('blocked')
  })
})

describe('the provider times out or fails', () => {
  it('one timed-out turn is refused, charged at the worst case, and the next turn carries on', async () => {
    const h = harness([{ timeout: true }, { calls: [finish('blocked', 'x')] }])
    await h.slice()
    const turns = h.mem.state.steps.filter((s) => s.kind === 'model_turn')
    expect(turns.map((t) => [t.status, t.resultSummary.reason ?? null])).toEqual([['refused', 'turn_timeout'], ['done', null]])
    // The ledger gets what the provider reported; the budgets assume the worst for the timed-out call.
    expect(h.deps.recordUsage).toHaveBeenCalledTimes(2)
    expect(h.mem.state.run.counters.costUsd).toBeCloseTo(WORST_CASE_CALL_USD + TURN_USD, 9)
    expect(h.mem.state.run).toMatchObject({ status: 'blocked', errorCode: 'agent_blocked' })
  })

  it('an unavailable provider ends the run on the first failure, never retrying past the harness', async () => {
    const h = harness([{ calls: [kit()] }, { unavailable: true }, { calls: [kit()] }])
    await h.slice()
    expect(h.model.prompts).toHaveLength(2)
    expect(h.mem.state.run).toMatchObject({ status: 'failed', errorCode: 'model_unavailable', work: null })
    // The successful turn's spend stays; the failed call reported nothing, so it is charged at the worst case.
    expect(h.mem.state.run.counters.costUsd).toBeCloseTo(TURN_USD + WORST_CASE_CALL_USD, 9)
  })
})

describe('the check worker crashes or runs over', () => {
  const edited = STUDENT_VIEW.replace('>Next<', '>Skip<')
  const throwing = (error: Error): HarnessDeps['runChecks'] => async () => {
    throw error
  }

  it.each([
    ['a crashed worker', new CheckTimeout('crashed'), 'check_timeout'],
    ['a worker that exited', new CheckTimeout('exited'), 'check_timeout'],
    ['a worker past its time limit', new CheckTimeout('time'), 'check_timeout'],
    ['a compiler fault', new CheckFault('module syntax in bundle'), 'internal'],
  ])('%s during run_checks ends the run failed, saving nothing and counting no check run', async (_name, error, code) => {
    const h = harness([{ calls: [write('views/student.tsx', edited), call('run_checks')] }, { calls: [finish()] }], { runChecks: throwing(error) })
    expect(await h.slice()).toBe('stopped')
    expect(h.model.prompts).toHaveLength(1)
    expect(h.mem.state.run).toMatchObject({ status: 'failed', errorCode: code, work: null })
    expect(h.mem.state.run.counters).toMatchObject({ checkRuns: 0, repairRounds: 0 })
    expect(h.mem.state.steps.find((s) => s.tool === 'run_checks')?.status).toBe('error')
    expect(h.mem.state.snapshots.size).toBe(0)
  })

  it('a check timeout inside the completion gate ends the run the same way', async () => {
    const h = harness([{ calls: [write('views/student.tsx', edited), finish()] }], { runChecks: throwing(new CheckTimeout('time')) })
    expect(await h.slice()).toBe('stopped')
    expect(h.mem.state.run).toMatchObject({ status: 'failed', errorCode: 'check_timeout' })
    expect(h.mem.state.project.draftHeadHash).toBe('b'.repeat(64))
  })

  it('an unexpected error from the checks is a harness fault: the run ends failed (internal)', async () => {
    const h = harness([{ calls: [write('views/student.tsx', edited), call('run_checks')] }], { runChecks: throwing(new TypeError('x is undefined')) })
    expect(await h.slice()).toBe('faulted')
    expect(h.mem.state.run).toMatchObject({ status: 'failed', errorCode: 'internal' })
  })

  describe('the real worker thread', () => {
    const files = (student: string) => ({ 'views/student.tsx': student, 'views/professor.tsx': '' })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('a thread that throws or exits rejects that check, and the next check gets a fresh worker', async () => {
      await expect(runWorkerCheck(files('CRASH'))).rejects.toThrow(new CheckTimeout('crashed'))
      expect((await runWorkerCheck(files('OK'))).compiler).toBe('stub')
      await expect(runWorkerCheck(files('EXIT'))).rejects.toThrow(new CheckTimeout('exited'))
      expect((await runWorkerCheck(files('OK'))).compiler).toBe('stub')
    })

    it('a silent worker is stopped at exactly the check time limit', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      let settled: unknown = 'pending'
      const pending = runWorkerCheck(files('SILENT')).catch((e: unknown) => (settled = e))
      await vi.advanceTimersByTimeAsync(limits.STUDIO_BUILDER_CHECK_TIMEOUT_MS - 1)
      expect(settled).toBe('pending')
      await vi.advanceTimersByTimeAsync(1)
      await pending
      expect(settled).toEqual(new CheckTimeout('time'))
      vi.useRealTimers()
      expect((await runWorkerCheck(files('OK'))).compiler).toBe('stub')
    })
  })
})

describe('the claim is lost', () => {
  it('a newer claim reaches the old slice through its heartbeat: the model call is aborted and the slice writes nothing more', async () => {
    const h = harness([{ hang: true }])
    const running = h.slice()
    await vi.waitFor(() => expect(h.model.prompts).toHaveLength(1))
    const before = h.mem.state.steps.length
    h.mem.state.token = 'the-newer-slice'
    expect(await running).toBe('fence lost')
    expect(h.mem.state.steps).toHaveLength(before)
    expect(h.mem.state.run.status).toBe('running')
    expect(h.mem.state.token).toBe('the-newer-slice')
    // The cut-off call reported nothing, so the budgets charge it at the worst case.
    expect(h.mem.state.run.counters.costUsd).toBeCloseTo(WORST_CASE_CALL_USD, 9)
  })

  it('a reply that lands after the claim moved is not recorded as a turn, but its spend is', async () => {
    const h = harness([
      () => {
        h.mem.state.token = 'the-newer-slice'
        return [kit()]
      },
    ])
    expect(await h.slice()).toBe('fence lost')
    expect(h.mem.state.run.counters.modelTurns).toBe(0)
    expect(h.mem.state.run.counters.costUsd).toBeCloseTo(TURN_USD, 9)
  })
})

describe('the professor refreshes the page', () => {
  it('progress and the conversation are rebuilt from the stored run and steps alone', async () => {
    const h = harness(
      [
        { calls: [plan(), proposeManifest()] },
        { calls: [write('views/student.tsx', STUDENT_VIEW), write('views/professor.tsx', PROFESSOR_VIEW), call('run_checks')] },
        { calls: [call('ask_professor', { question: 'Terms or definitions first?' })] },
        { calls: [finish('completed', 'Built the flashcards.')] },
      ],
      { base: null },
    )
    vi.mocked(sessionUserId).mockResolvedValue(h.run.ownerId)
    vi.mocked(requireProfessor).mockResolvedValue({ userId: h.run.ownerId, institutionId: h.run.institutionId, sectionId: h.run.sectionId } as never)
    vi.mocked(db.loadBuilderProject).mockResolvedValue({ id: h.run.projectId, ownerId: h.run.ownerId, institutionId: h.run.institutionId } as never)
    // A fresh page load: nothing but what the database holds.
    vi.mocked(db.loadBuilderRun).mockImplementation(async () => structuredClone(h.mem.state.run))
    type StepRows = Awaited<ReturnType<typeof db.listBuilderSteps>>
    vi.mocked(db.listBuilderSteps).mockImplementation(async (_id, after = 0) => h.mem.state.steps.filter((s) => s.seq > after).map((s) => ({ ...s, ms: 0 })) as StepRows)
    vi.mocked(db.listProjectRuns).mockImplementation(async () => [structuredClone(h.mem.state.run)])
    const read = () => service.readProgress(h.run.id, 0)

    await h.slice()
    const card = h.mem.state.run.pendingApproval as { proposal_id: string; delta_hash: string; items: { line: string }[] }
    expect(await read()).toMatchObject({
      status: 'waiting_for_approval',
      approval: { proposalId: card.proposal_id, deltaHash: card.delta_hash, items: card.items.map((i) => i.line) },
      question: null,
      ending: null,
      turns: { used: 1, max: limits.STUDIO_BUILDER_MAX_MODEL_TURNS },
    })
    expect((await read())!.events.map((e) => e.label)).toContain('Waiting for your approval')

    h.mem.professor.decide(card.proposal_id, card.delta_hash, true)
    await h.slice()
    const question = h.mem.state.run.questions[0]
    expect(await read()).toMatchObject({ status: 'waiting_for_professor', approval: null, question: { id: question.id, text: 'Terms or definitions first?' }, checks: 1 })

    h.mem.professor.answer(question.id, 'Terms first.')
    await h.slice()
    const done = await read()
    expect(done).toMatchObject({
      status: 'preview_ready',
      question: null,
      ending: service.endingCopy('preview_ready', null),
      result: { summary: 'Built the flashcards.', previewHash: h.mem.state.run.resultHash, passed: true, filesChanged: ['views/student.tsx', 'views/professor.tsx'] },
    })
    // Reading from the last seen step returns only what came after it.
    expect((await service.readProgress(h.run.id, done!.lastSeq))!.events).toEqual([])
    expect(await service.loadConversation({ sectionId: h.run.sectionId!, pluginProjectId: h.run.projectId })).toEqual([
      expect.objectContaining({ runId: h.run.id, request: h.run.request, status: 'preview_ready', summary: 'Built the flashcards.' }),
    ])
  })
})

describe('the professor closes the page', () => {
  it('a build hands off between slices and reaches its end on job kicks alone, with no progress read', async () => {
    vi.mocked(db.builderRpcs.tend).mockClear()
    vi.mocked(db.loadBuilderRun).mockClear()
    const clock = { t: Date.UTC(2026, 9, 2) }
    // Each turn takes 10 s, and each slice has 1 s in hand past its cushion: one turn per slice.
    const turn = (calls: { name: string; input: unknown }[]) => () => ((clock.t += 10_000), calls)
    const h = harness(
      [
        turn([call('read_file', { path: 'views/student.tsx' })]),
        turn([call('edit_file', { path: 'views/student.tsx', old_text: '>I know this<', new_text: '>Got it<' }), call('run_checks')]),
        turn([finish()]),
      ],
      { clock },
    )
    const slices: Promise<string>[] = []
    const sliceDeadline = () => clock.t + limits.STUDIO_BUILDER_SLICE_CUSHION_MS + 1_000
    const deps: HarnessDeps = { ...h.deps, kick: vi.fn(() => void slices.push(h.slice(deps, sliceDeadline()))) }
    slices.push(h.slice(deps, sliceDeadline()))
    for (let i = 0; i < slices.length; i++) await slices[i]

    expect(await Promise.all(slices)).toEqual(['handed off', 'handed off', 'stopped'])
    expect(deps.kick).toHaveBeenCalledTimes(2)
    expect(h.mem.state.run.status).toBe('preview_ready')
    expect(h.mem.state.run.sliceNo).toBe(3)
    expect(db.builderRpcs.tend).not.toHaveBeenCalled()
    expect(db.loadBuilderRun).not.toHaveBeenCalled()
  })
})

describe('run budgets at their exact boundaries', () => {
  const max = limits.STUDIO_BUILDER_MAX_TOOL_CALLS

  it('tool calls: the last allowed call runs, the next in the same turn is never run, and the run ends before another model call', async () => {
    const h = harness([{ calls: [kit('Button'), kit('Text'), kit('Card')] }, { calls: [kit()] }], { counters: { toolCalls: max - 2 } })
    await h.slice()
    expect(h.mem.state.steps.filter((s) => s.tool === 'get_kit_reference').map((s) => s.status)).toEqual(['done', 'done', 'interrupted'])
    expect(h.mem.state.run.counters.toolCalls).toBe(max)
    expect(h.model.prompts).toHaveLength(1)
    expect(h.mem.state.run).toMatchObject({ status: 'budget_exhausted', errorCode: 'limit_tool_calls' })
  })

  it('tool calls: at the cap no model call is made', async () => {
    const h = harness([{ calls: [kit()] }], { counters: { toolCalls: max } })
    await h.slice()
    expect(h.model.prompts).toHaveLength(0)
    expect(h.mem.state.run.errorCode).toBe('limit_tool_calls')
  })

  it('active time: one millisecond under the cap allows a call, and its time then ends the run', async () => {
    const clock = { t: Date.UTC(2026, 9, 2) }
    const h = harness([() => ((clock.t += 1_000), [kit()]), { calls: [kit()] }], { clock, counters: { activeMs: limits.STUDIO_BUILDER_RUN_MAX_ACTIVE_MS - 1 } })
    await h.slice()
    expect(h.model.prompts).toHaveLength(1)
    expect(h.mem.state.run.counters.activeMs).toBeGreaterThanOrEqual(limits.STUDIO_BUILDER_RUN_MAX_ACTIVE_MS)
    expect(h.mem.state.run).toMatchObject({ status: 'budget_exhausted', errorCode: 'limit_active_time' })

    const atCap = harness([{ calls: [kit()] }], { counters: { activeMs: limits.STUDIO_BUILDER_RUN_MAX_ACTIVE_MS } })
    await atCap.slice()
    expect(atCap.model.prompts).toHaveLength(0)
    expect(atCap.mem.state.run.errorCode).toBe('limit_active_time')
  })

  it('cost: spend exactly the cap minus a worst-case call still allows that call; a millionth of a dollar more does not', async () => {
    const exact = harness([{ calls: [kit()] }, { calls: [kit()] }], { counters: { costUsd: limits.STUDIO_BUILDER_RUN_MAX_COST_USD - WORST_CASE_CALL_USD } })
    await exact.slice()
    expect(exact.model.prompts).toHaveLength(1)
    expect(exact.mem.state.run.errorCode).toBe('limit_cost')

    const over = harness([{ calls: [kit()] }], { counters: { costUsd: limits.STUDIO_BUILDER_RUN_MAX_COST_USD - WORST_CASE_CALL_USD + 0.000001 } })
    await over.slice()
    expect(over.model.prompts).toHaveLength(0)
    expect(over.mem.state.run).toMatchObject({ status: 'budget_exhausted', errorCode: 'limit_cost' })
  })

  it('the school’s daily spend: the real gate allows a call that lands exactly on the cap and refuses one that would cross it', async () => {
    const gate = realHarnessDeps(scriptedModel([])).gate
    const run = newRun({ status: 'running' })
    const cap = limits.STUDIO_BUILDER_INSTITUTION_DAILY_COST_USD
    vi.mocked(db.loadInstitutionBuilderSpend).mockResolvedValueOnce(cap - WORST_CASE_CALL_USD)
    expect(await gate(run)).toBeNull()
    vi.mocked(db.loadInstitutionBuilderSpend).mockResolvedValueOnce(cap - WORST_CASE_CALL_USD + 0.000001)
    expect(await gate(run)).toBe('limit_daily_cost')
    // Unreadable spend fails closed.
    vi.mocked(db.loadInstitutionBuilderSpend).mockResolvedValueOnce(null)
    expect(await gate(run)).toBe('limit_daily_cost')
  })

  it('a model reply’s spend is stored before the next gate reads the run, and a school-spend refusal ends it budget_exhausted', async () => {
    const order: string[] = []
    let gateRuns: BuilderRunRow[] = []
    const h = harness([{ calls: [kit()] }, { calls: [kit()] }], {
      gate: async (run) => {
        order.push('gate')
        gateRuns = [...gateRuns, run]
        return gateRuns.length > 1 ? 'limit_daily_cost' : null
      },
    })
    const addCost = h.mem.store.addCost
    h.mem.store.addCost = async (...a) => (order.push('addCost'), addCost(...a))
    await h.slice()
    expect(order).toEqual(['gate', 'addCost', 'gate'])
    expect(gateRuns[1].counters.costUsd).toBeCloseTo(TURN_USD, 9)
    expect(h.mem.state.run).toMatchObject({ status: 'budget_exhausted', errorCode: 'limit_daily_cost' })
  })
})
