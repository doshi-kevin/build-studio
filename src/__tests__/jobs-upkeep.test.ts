/**
 * Pipeline upkeep: the kick runs every registered pipeline's upkeep after the reaper and
 * before the drain, one pipeline's failure never stops the others or the drain, and the
 * Studio builder's upkeep is the stalled-run sweep with the limits from limits.ts. The
 * sweep itself is tested against real Postgres in src/__tests__/db/studio-builder-upkeep.test.ts.
 */
import { describe, it, expect, vi } from 'vitest'
import type { NextRequest } from 'next/server'

const events: string[] = []

const sweep = vi.fn<(staleMs: number, maxResumes: number, limit: number) => Promise<Record<string, unknown> | null>>(async () => {
  events.push('sweep')
  return { none: 0, expired: 1, requeued: 2, failed: 0, cancelled: 0, job_ids: ['job-1', 'job-2'] }
})
vi.mock('@/lib/studio/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/studio/db')>()
  return { ...actual, builderRpcs: { ...actual.builderRpcs, sweep: (s: number, r: number, l: number) => sweep(s, r, l) } }
})

const info = vi.fn()
vi.mock('@/lib/logger', () => ({ logger: { info: (...a: unknown[]) => info(...a), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }))

// The reaper's admin client: no abandoned jobs.
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ lt: async () => ({ data: [], error: null }) }) }) }),
  }),
}))

vi.mock('@/lib/jobs/worker', async () => {
  const actual = await vi.importActual<typeof import('@/lib/jobs/worker')>('@/lib/jobs/worker')
  return {
    ...actual,
    runUntilDrained: vi.fn(async () => {
      events.push('drain')
      return { jobsRun: 0, lastResult: null }
    }),
  }
})

const { registerPipeline } = await import('@/lib/jobs/registry')
const { runPipelineUpkeep } = await import('@/lib/jobs/worker')
const { POST } = await import('@/app/api/jobs-worker/kick/route')
const { builderSlicePipeline } = await import('@/lib/studio/builder/harness')
const { STUDIO_BUILDER_HEARTBEAT_STALE_MS, STUDIO_BUILDER_MAX_RESUMES, STUDIO_BUILDER_SWEEP_LIMIT } = await import('@/lib/studio/limits')

const noRun = async () => ({ result: null, summary: '' })
registerPipeline({
  type: 'test_upkeep_throws',
  run: noRun,
  upkeep: async () => {
    events.push('throws')
    throw new Error('upkeep failed')
  },
})
registerPipeline({ type: 'test_upkeep_ok', run: noRun, upkeep: async () => void events.push('ok') })

const SECRET = 'kick-secret-for-tests'
const kick = () =>
  POST({ headers: { get: (h: string) => (h === 'x-background-jobs-secret' ? SECRET : null) } } as unknown as NextRequest)

describe('pipeline upkeep in the kick', () => {
  it('runs every upkeep before the drain, and a throwing one stops neither the others nor the drain', async () => {
    process.env.BACKGROUND_JOBS_SECRET = SECRET
    events.length = 0
    const res = await kick()
    expect(res.status).toBe(200)
    expect(events).toEqual(['sweep', 'throws', 'ok', 'drain'])
  })

  it('runPipelineUpkeep resolves even when an upkeep throws', async () => {
    events.length = 0
    await expect(runPipelineUpkeep()).resolves.toBeUndefined()
    expect(events).toEqual(['sweep', 'throws', 'ok'])
  })
})

describe('the builder pipeline’s upkeep', () => {
  it('sweeps with the heartbeat, resume and sweep limits, and logs only the counts', async () => {
    sweep.mockClear()
    info.mockClear()
    await builderSlicePipeline.upkeep!({ adminDb: {} as never })
    expect(sweep).toHaveBeenCalledWith(STUDIO_BUILDER_HEARTBEAT_STALE_MS, STUDIO_BUILDER_MAX_RESUMES, STUDIO_BUILDER_SWEEP_LIMIT)
    expect(info).toHaveBeenCalledWith('studio/builder.upkeep', { requeued: 2, failed: 0, cancelled: 0, expired: 1, error: 0 })
  })

  it('logs nothing when the sweep tended nothing or its RPC failed', async () => {
    info.mockClear()
    sweep.mockResolvedValueOnce({ none: 0, expired: 0, requeued: 0, failed: 0, cancelled: 0, job_ids: [] })
    await builderSlicePipeline.upkeep!({ adminDb: {} as never })
    sweep.mockResolvedValueOnce(null)
    await builderSlicePipeline.upkeep!({ adminDb: {} as never })
    expect(info).not.toHaveBeenCalled()
  })
})
