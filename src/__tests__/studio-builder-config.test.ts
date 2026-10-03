/**
 * The builder with a piece of its configuration missing. Each case removes one setting
 * a deployment could forget and checks the builder refuses, or ends the run with a fixed
 * reason, instead of running unsafely. No network: fetch is stubbed and must stay unused
 * wherever a setting is missing.
 *
 * Proved elsewhere, not repeated here: the kick route answers 401 when
 * BACKGROUND_JOBS_SECRET is unset (jobs-kick-route.test.ts); startBuild refuses with the
 * studio-builder switch off (studio-builder-service.test.ts); studioOrigins turns the
 * runtime off for an unset, malformed, same-site or plain-http origin
 * (studio-runtime.test.ts).
 */
import { readdirSync, readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/ai/kill-switch', () => ({ checkAiFeature: vi.fn() }))
vi.mock('@/lib/studio/validator/service', () => ({ validateAfterPublish: vi.fn(), currentVerdict: vi.fn() }))
vi.mock('@/lib/studio/access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/studio/access')>()),
  studioAccess: vi.fn(),
  studioKillSwitchEngaged: vi.fn(async () => false),
}))
vi.mock('@/lib/studio/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/studio/context')>()),
  builderActor: vi.fn(),
  requireProfessor: vi.fn(),
}))
vi.mock('@/lib/studio/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/studio/db')>()
  return {
    ...real,
    builderRpcs: { ...real.builderRpcs, start: vi.fn() },
    loadInstitutionBuilderSpend: vi.fn(),
    loadBuilderProject: vi.fn(),
    loadSnapshot: vi.fn(),
    loadSnapshotBundle: vi.fn(),
  }
})

const db = await import('@/lib/studio/db')
const { builderActor, requireProfessor } = await import('@/lib/studio/context')
const { studioAccess } = await import('@/lib/studio/access')
const { checkAiFeature } = await import('@/lib/ai/kill-switch')
const { runBuilderSlice, realHarnessDeps } = await import('@/lib/studio/builder/harness')
const { createGeminiModel } = await import('@/lib/studio/builder/model')
const { kickWorker } = await import('@/lib/jobs/enqueue')
const { startBuild, issueDraftPreview } = await import('@/lib/studio/builder/service')
const { draftFrameUrl, signDraftFrameTicket } = await import('@/lib/studio/runtime/frame-ticket')
const { draftFrameResponse } = await import('@/lib/studio/runtime/frame')
const { STUDIO_BUILDER_MODEL } = await import('@/lib/ai/config')
const { isPricedModel } = await import('@/lib/ai/cost')
const { createMemoryStore, newRun } = await import('./helpers/builder-memory-store')
const { call, scriptedModel } = await import('./helpers/builder-fixtures')

const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }))

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fetchSpy)
  vi.mocked(studioAccess).mockResolvedValue('full')
  vi.mocked(checkAiFeature).mockResolvedValue({ allowed: true })
  vi.mocked(builderActor).mockResolvedValue({ ok: true, actor: {} } as never)
  vi.mocked(db.loadInstitutionBuilderSpend).mockResolvedValue(0)
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

/** A slice on the in-memory store, with the given model and gate. */
function slice(model: Parameters<typeof runBuilderSlice>[2]['model'], gate: Parameters<typeof runBuilderSlice>[2]['gate']) {
  const run = newRun({ status: 'queued' })
  const mem = createMemoryStore(run)
  const recordUsage = vi.fn(async () => {})
  const go = () =>
    runBuilderSlice({ runId: run.id, sliceNo: mem.state.run.sliceNo }, { id: mem.currentJob().id, deadline: Date.now() + 15 * 60_000 }, {
      store: mem.store,
      model,
      loadSliceData: async () => ({ slug: 'tool-abc12345', published: null, publishedVersions: [], base: null, course: null, skills: null, history: [], materialSources: [] }),
      loadMemories: async () => [],
      gate,
      runChecks: async () => {
        throw new Error('no checks in these cases')
      },
      searchMaterial: async () => ({ ok: false as const }),
      rehydrateMaterial: async () => [],
      recordUsage,
      audit: vi.fn(),
      kick: vi.fn(),
      now: () => Date.now(),
      heartbeatMs: 5,
    })
  return { mem, recordUsage, go }
}

describe('no model key', () => {
  it('the real Gemini adapter refuses before any request, and the run ends failed with model_unavailable', async () => {
    vi.stubEnv('GOOGLE_GENERATIVE_AI_API_KEY', undefined)
    const s = slice(createGeminiModel(), async () => null)
    await s.go()
    expect(s.mem.state.run.status).toBe('failed')
    expect(s.mem.state.run.errorCode).toBe('model_unavailable')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(s.recordUsage).not.toHaveBeenCalled()
    expect(s.mem.state.snapshots.size).toBe(0)
  })
})

describe('the studio-builder switch, through the real gate', () => {
  const run = newRun({ status: 'running' })

  it.each([
    ['switched off by the school', { allowed: false, lockedBy: 'institution' }],
    ['locked by the platform', { allowed: false, lockedBy: 'platform' }],
    ['unreadable (the policy read failed)', { allowed: false, lockedBy: 'error' }],
  ] as const)('%s: ai_disabled', async (_label, verdict) => {
    vi.mocked(checkAiFeature).mockResolvedValue(verdict as never)
    expect(await realHarnessDeps(scriptedModel([])).gate(run)).toBe('ai_disabled')
    expect(vi.mocked(checkAiFeature).mock.calls[0][2]).toBe('studio-builder')
  })

  it('an unreadable school spend stops the build (limit_daily_cost)', async () => {
    vi.mocked(db.loadInstitutionBuilderSpend).mockResolvedValue(null)
    expect(await realHarnessDeps(scriptedModel([])).gate(run)).toBe('limit_daily_cost')
  })

  it('a live run ends blocked with ai_disabled at the next model call after the switch goes off', async () => {
    const model = scriptedModel([
      () => {
        vi.mocked(checkAiFeature).mockResolvedValue({ allowed: false, lockedBy: 'institution' } as never)
        return [call('get_kit_reference', { component: 'Button' })]
      },
      { calls: [call('get_kit_reference', { component: 'Card' })] },
    ])
    const s = slice(model, realHarnessDeps(model).gate)
    await s.go()
    expect(model.prompts).toHaveLength(1)
    expect(s.mem.state.run.status).toBe('blocked')
    expect(s.mem.state.run.errorCode).toBe('ai_disabled')
  })
})

describe('no jobs secret or kick URL', () => {
  const PROFESSOR = { userId: crypto.randomUUID(), sectionId: crypto.randomUUID(), institutionId: crypto.randomUUID() }

  it('a kick without BACKGROUND_JOBS_SECRET sends nothing', async () => {
    vi.stubEnv('BACKGROUND_JOBS_SECRET', undefined)
    vi.stubEnv('BACKGROUND_JOBS_KICK_URL', 'https://app.example/api/jobs-worker/kick')
    await kickWorker('job-1')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('without a kick URL the kick stays on this machine and never reaches another host', async () => {
    vi.stubEnv('BACKGROUND_JOBS_SECRET', 's'.repeat(40))
    vi.stubEnv('BACKGROUND_JOBS_KICK_URL', undefined)
    vi.stubEnv('NEXT_PUBLIC_APP_URL', undefined)
    vi.stubEnv('VERCEL_URL', undefined)
    await kickWorker('job-1')
    expect(new URL(String((fetchSpy.mock.calls[0] as unknown[])[0])).hostname).toBe('localhost')
  })

  it('a kick whose request fails never throws to the caller', async () => {
    vi.stubEnv('BACKGROUND_JOBS_SECRET', 's'.repeat(40))
    fetchSpy.mockRejectedValueOnce(new TypeError('fetch failed'))
    await expect(kickWorker('job-1')).resolves.toMatchObject({ kicked: false })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('a build still starts: the run and its job are written before the kick, which sends nothing', async () => {
    vi.stubEnv('BACKGROUND_JOBS_SECRET', undefined)
    vi.mocked(requireProfessor).mockResolvedValue(PROFESSOR as never)
    vi.mocked(db.builderRpcs.start).mockResolvedValue({ outcome: 'started', run_id: 'run-1', project_id: 'project-1', job_id: 'job-1' })
    const r = await startBuild({ sectionId: PROFESSOR.sectionId, pluginProjectId: null, request: 'Flashcards for chapter 3', clientRequestId: crypto.randomUUID() })
    expect(r).toEqual({ ok: true, value: { runId: 'run-1', pluginProjectId: 'project-1' } })
    expect(db.builderRpcs.start).toHaveBeenCalledTimes(1)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('no runtime origin or frame ticket secret', () => {
  const SECRET = 'x'.repeat(40)
  const APP = 'https://app.scholera.example'
  const RUNTIME = 'https://plugins.example'
  const PROJECT = crypto.randomUUID()
  const HASH = 'a'.repeat(64)
  const configure = (env: { origin?: string; secret?: string }) => {
    vi.stubEnv('SITE_URL', APP)
    vi.stubEnv('STUDIO_RUNTIME_ORIGIN', env.origin)
    vi.stubEnv('STUDIO_FRAME_TICKET_SECRET', env.secret)
  }

  it.each([
    ['no secret', { origin: RUNTIME }],
    ['a secret under 32 characters', { origin: RUNTIME, secret: 'short' }],
    ['no runtime origin', { secret: SECRET }],
    ['the app origin as the runtime origin', { origin: APP, secret: SECRET }],
  ] as const)('%s: no draft frame URL, so no unsigned frame and none on the app origin', (_label, env) => {
    configure(env)
    expect(draftFrameUrl(PROJECT, HASH, 'student')).toBeNull()
  })

  it('the professor is told previews are unavailable, and nothing is signed', async () => {
    configure({ origin: RUNTIME })
    const professor = { userId: crypto.randomUUID(), sectionId: crypto.randomUUID(), institutionId: crypto.randomUUID() }
    vi.mocked(requireProfessor).mockResolvedValue(professor as never)
    vi.mocked(db.loadBuilderProject).mockResolvedValue({ id: PROJECT, ownerId: professor.userId, institutionId: professor.institutionId } as never)
    const { FLASHCARDS_MANIFEST } = await import('./helpers/builder-fixtures')
    vi.mocked(db.loadSnapshot).mockResolvedValue({
      projectId: PROJECT,
      hash: HASH,
      manifest: {
        ...FLASHCARDS_MANIFEST, manifestVersion: 2, id: 'tool-abc12345', version: '0.0.0', bridgeVersion: 'v1',
        views: { student: { entry: 'views/student.tsx', capabilities: [] }, professor: { entry: 'views/professor.tsx', capabilities: [] } },
      },
    } as never)
    const r = await issueDraftPreview({ sectionId: professor.sectionId, pluginProjectId: PROJECT, snapshotHash: HASH, view: 'student' })
    expect(r).toEqual({ ok: false, error: 'Previews aren’t available here right now.' })
  })

  it.each([
    ['no secret', { origin: RUNTIME }],
    ['no runtime origin', { secret: SECRET }],
  ] as const)('%s: the draft frame route 404s a ticket signed before, without loading code', async (_label, env) => {
    const ticket = signDraftFrameTicket({ projectId: PROJECT, hash: HASH, view: 'student', expiresAt: Date.now() + 60_000 }, SECRET)
    configure(env)
    const res = await draftFrameResponse(new URL(RUNTIME).host, PROJECT, 'student', ticket)
    expect(res.status).toBe(404)
    expect(db.loadSnapshotBundle).not.toHaveBeenCalled()
  })
})

describe('the model id', () => {
  it('has its own price row, so the run and school cost caps never fall back to a cheaper rate', () => {
    expect(isPricedModel(STUDIO_BUILDER_MODEL)).toBe(true)
  })

  it('only the AgentModel adapter imports a provider SDK or names a model', () => {
    const dir = 'src/lib/studio/builder'
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts') && f !== 'model.ts' && f !== 'check-worker.generated.ts')) {
      const source = readFileSync(`${dir}/${file}`, 'utf8')
      expect(source, file).not.toMatch(/from ['"](?:ai|@ai-sdk\/[^'"]+)['"]/)
      expect(source, file).not.toMatch(/['"]gemini-/)
    }
  })
})

describe('a kick route that never answers', () => {
  it('is abandoned after 2 s, so a caller awaiting the kick is never held by the drain', async () => {
    vi.stubEnv('BACKGROUND_JOBS_SECRET', 's'.repeat(40))
    vi.useFakeTimers()
    try {
      fetchSpy.mockImplementationOnce(
        (...args: unknown[]) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = (args[1] as RequestInit | undefined)?.signal
            signal?.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')))
          }),
      )
      let settled: unknown = 'pending'
      const kick = kickWorker('job-1').then((r) => (settled = r))
      await vi.advanceTimersByTimeAsync(1_999)
      expect(settled).toBe('pending')
      await vi.advanceTimersByTimeAsync(1)
      await kick
      // The request left; the drain runs as its own request, so this counts as kicked.
      expect(settled).toEqual({ kicked: true })
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
