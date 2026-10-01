import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

// AI kill switch: controllable per-test — the worker consults it only for job
// types in its AI map (see the kill-switch gate tests at the bottom).
const checkAiFeatureMock = vi.fn(async () => ({ allowed: true as const }))
vi.mock('@/lib/ai/kill-switch', () => ({
  checkAiFeature: (...args: unknown[]) => checkAiFeatureMock(...(args as [])),
}))

import { runOneJob, runUntilDrained } from '@/lib/jobs/worker'
import { registerPipeline } from '@/lib/jobs/registry'
import type { BackgroundJobRow, PipelineContext, ProgressEntry } from '@/lib/jobs/types'

// ── In-memory fake admin client ────────────────────────────────
// Implements exactly the surface worker.ts touches: rpc('claim_next_job'),
// from('background_jobs').select().eq().single(), and .update().eq(). Claim
// contention (FOR UPDATE SKIP LOCKED) is a Postgres property verified in the
// local E2E step, not here — this exercises the worker's dispatch, progress,
// completion, and failure-isolation logic.
function makeFakeAdmin(seed: Partial<BackgroundJobRow>[]) {
  const store = new Map<string, BackgroundJobRow>()
  for (const j of seed) {
    const row: BackgroundJobRow = {
      id: j.id!,
      type: j.type!,
      params: j.params ?? {},
      status: j.status ?? 'pending',
      progress: j.progress ?? [],
      result: null,
      summary: null,
      error: null,
      institution_id: 'inst-1',
      section_id: 'sec-1',
      created_by: 'user-1',
      attempts: 0,
      max_attempts: 3,
      claimed_by: null,
      claim_expires_at: null,
      created_at: j.created_at ?? new Date().toISOString(),
      started_at: null,
      completed_at: null,
    }
    store.set(row.id, row)
  }

  const admin = {
    rpc: async (fn: string, args?: { p_job_id?: string; p_entry?: ProgressEntry }) => {
      if (fn === 'append_job_progress') {
        // Model the SQL RPC: atomic dedupe-by-label append.
        const row = args?.p_job_id ? store.get(args.p_job_id) : undefined
        if (row && args?.p_entry) {
          row.progress = [...row.progress.filter((e) => e.label !== args.p_entry!.label), args.p_entry]
        }
        return { data: null, error: null }
      }
      if (fn !== 'claim_next_job') return { data: null, error: null }
      // Oldest pending (or expired-running) claimable job.
      const claimable = [...store.values()]
        .filter((r) => r.attempts < r.max_attempts && r.status === 'pending')
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
      const job = claimable[0]
      if (!job) return { data: null, error: null }
      job.status = 'running'
      job.attempts += 1
      job.started_at = new Date().toISOString()
      return { data: { ...job }, error: null }
    },
    from: () => ({
      select: () => ({
        eq: (_c: string, id: string) => ({
          single: async () => ({ data: store.get(id) ?? null, error: null }),
        }),
      }),
      update: (patch: Partial<BackgroundJobRow>) => ({
        eq: async (_c: string, id: string) => {
          const row = store.get(id)
          if (row) Object.assign(row, patch)
          return { error: null }
        },
      }),
    }),
  }

  return { admin: admin as unknown as SupabaseClient, store }
}

describe('jobs worker', () => {
  beforeEach(() => {
    // Register the fake pipelines fresh each run (registry is a module singleton).
    registerPipeline({
      type: 'fake-ok',
      async run(params, ctx: PipelineContext) {
        const startedAt = new Date().toISOString()
        await ctx.reportProgress({ label: 'a', status: 'running', startedAt })
        await ctx.reportProgress({ label: 'a', status: 'done', startedAt })
        return { result: { ok: true, got: params }, summary: 'fake ok done' }
      },
    })
    registerPipeline({
      type: 'fake-throws',
      async run() {
        throw new Error('boom')
      },
    })
  })

  it('runs a job: claim → pipeline → done with result + summary', async () => {
    const { admin, store } = makeFakeAdmin([{ id: 'j1', type: 'fake-ok', params: { x: 1 } }])
    const result = await runOneJob({ adminClient: admin })

    expect(result).toMatchObject({ claimed: true, jobId: 'j1', finalStatus: 'done' })
    const job = store.get('j1')!
    expect(job.status).toBe('done')
    expect(job.result).toEqual({ ok: true, got: { x: 1 } })
    expect(job.summary).toBe('fake ok done')
    expect(job.completed_at).toBeTruthy()
  })

  it('reportProgress dedupes by label — latest transition wins', async () => {
    const { admin, store } = makeFakeAdmin([{ id: 'j2', type: 'fake-ok' }])
    await runOneJob({ adminClient: admin })

    const progress = store.get('j2')!.progress
    expect(progress).toHaveLength(1)
    expect(progress[0]).toMatchObject({ label: 'a', status: 'done' })
  })

  it('isolates failure: a throwing pipeline → failed with the error, not half-written', async () => {
    const { admin, store } = makeFakeAdmin([{ id: 'j3', type: 'fake-throws' }])
    const result = await runOneJob({ adminClient: admin })

    expect(result).toMatchObject({ claimed: true, finalStatus: 'failed', error: 'boom' })
    const job = store.get('j3')!
    expect(job.status).toBe('failed')
    expect(job.error).toBe('boom')
    expect(job.result).toBeNull()
  })

  it('marks a job with no registered pipeline as failed', async () => {
    const { admin, store } = makeFakeAdmin([{ id: 'j4', type: 'no-such-type' }])
    const result = await runOneJob({ adminClient: admin })

    expect(result.finalStatus).toBe('failed')
    expect(store.get('j4')!.error).toContain('No pipeline registered')
  })

  it('returns claimed:false when the queue is empty', async () => {
    const { admin } = makeFakeAdmin([])
    expect(await runOneJob({ adminClient: admin })).toEqual({ claimed: false })
  })

  it('runUntilDrained drains every job then stops', async () => {
    const { admin, store } = makeFakeAdmin([
      { id: 'd1', type: 'fake-ok', created_at: '2026-01-01T00:00:00.000Z' },
      { id: 'd2', type: 'fake-ok', created_at: '2026-01-01T00:00:01.000Z' },
    ])
    const { jobsRun } = await runUntilDrained(Date.now() + 10_000, { adminClient: admin })

    expect(jobsRun).toBe(2)
    expect(store.get('d1')!.status).toBe('done')
    expect(store.get('d2')!.status).toBe('done')
  })

  describe('AI kill-switch gate', () => {
    it('skips an AI job type terminally (no retry) with the skip reason when refused', async () => {
      checkAiFeatureMock.mockResolvedValueOnce({ allowed: false, lockedBy: 'institution' } as never)
      const pipelineRan = vi.fn()
      registerPipeline({
        type: 'embed_material',
        async run() {
          pipelineRan()
          return { result: { ok: true }, summary: 'should not happen' }
        },
      })
      const { admin, store } = makeFakeAdmin([{ id: 'ai1', type: 'embed_material' }])
      const result = await runOneJob({ adminClient: admin })

      expect(result).toMatchObject({ claimed: true, jobId: 'ai1', finalStatus: 'failed' })
      expect(pipelineRan).not.toHaveBeenCalled()
      const job = store.get('ai1')!
      expect(job.status).toBe('failed')
      expect(job.error).toContain('AI features are disabled')
      expect(checkAiFeatureMock).toHaveBeenCalledWith(expect.anything(), 'inst-1', 'content-ai')
    })

    it('non-AI job types never consult the guard', async () => {
      checkAiFeatureMock.mockClear()
      const { admin, store } = makeFakeAdmin([{ id: 'j9', type: 'fake-ok' }])
      await runOneJob({ adminClient: admin })
      expect(store.get('j9')!.status).toBe('done')
      expect(checkAiFeatureMock).not.toHaveBeenCalled()
    })
  })
})
