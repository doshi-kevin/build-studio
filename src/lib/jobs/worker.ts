// The generic Athenamite worker. Mirrors src/lib/extraction/worker.ts:
// claim a job atomically → dispatch to the registered pipeline for its `type`
// → write status/result/summary → notify. Drains ONE job at a time
// (sequential across jobs); horizontal Cloud Run autoscaling handles queue
// throughput. Any within-job fan-out is the pipeline's own concern.

import 'server-only'
import { randomUUID } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import { getPipeline, listPipelines } from './registry'
import { notifyJobComplete } from './notify'
import type { BackgroundJobRow, JobStatus, ProgressEntry } from './types'
import { checkAiFeature } from '@/lib/ai/kill-switch'
import type { AiFeatureKey } from '@/lib/ai/ai-features'

// Which kill-switch feature group each AI job type belongs to. Non-AI types
// are deliberately absent. Keep in sync with the pipeline registry.
const AI_FEATURE_BY_JOB_TYPE: Record<string, AiFeatureKey> = {
  outcome_alignment: 'athena-professor',
  embed_material: 'content-ai',
  node_check_pool: 'roadmap-skills-ai',
  regenerate_student_insights: 'roadmap-skills-ai',
}

export interface WorkerOptions {
  workerId?: string
  adminClient?: SupabaseClient
  claimTtlSeconds?: number
  /** Restrict this worker to certain job types (default: any type). */
  types?: string[]
  /** When the drain stops claiming (unix ms); passed to the pipeline as ctx.deadline. */
  deadline?: number
}

export interface RunResult {
  claimed: boolean
  jobId?: string
  type?: string
  finalStatus?: JobStatus
  error?: string
}

function getAdmin(opts?: WorkerOptions): SupabaseClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (opts?.adminClient ?? (createAdminClient() as any)) as SupabaseClient
}

/** Claim the next job atomically. Returns null when the queue is empty. */
async function claimNext(
  admin: SupabaseClient,
  workerId: string,
  claimTtlSeconds: number,
  types?: string[],
): Promise<BackgroundJobRow | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (admin as any).rpc('claim_next_job', {
    p_worker_id: workerId,
    p_types: types ?? null,
    p_claim_ttl_seconds: claimTtlSeconds,
  })
  if (error) {
    logger.error('jobs.worker.claimNext: RPC failed', error)
    return null
  }
  // plpgsql composite return: an empty match serialises as an object with all
  // fields NULL rather than SQL NULL. Treat a null id as "queue empty" so the
  // drain loop exits instead of spinning.
  if (!data) return null
  const row = (Array.isArray(data) ? data[0] : data) as BackgroundJobRow | null
  if (!row || !row.id) return null
  return row
}

/**
 * Build the pipeline's `reportProgress`. Delegates to the atomic
 * `append_job_progress` RPC, which dedupes by label (latest transition wins)
 * and appends in a single UPDATE — race-free even when a pipeline reports
 * progress concurrently (the outcome_alignment Map fan-out).
 */
function makeReportProgress(admin: SupabaseClient, jobId: string) {
  return async (entry: ProgressEntry): Promise<void> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin as any).rpc('append_job_progress', { p_job_id: jobId, p_entry: entry })
  }
}

async function writeCompletion(
  admin: SupabaseClient,
  jobId: string,
  status: JobStatus,
  patch: { result?: unknown; summary?: string; error?: string | null },
  /** The claim this worker holds. A worker whose lease expired and was re-claimed by
   * another must not mark the other worker's job finished. */
  workerId?: string,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q = (admin as any)
    .from('background_jobs')
    .update({
      status,
      completed_at: new Date().toISOString(),
      ...(patch.result !== undefined ? { result: patch.result } : {}),
      ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
    })
    .eq('id', jobId)
  if (workerId) q = q.eq('claimed_by', workerId)
  await q
}

/**
 * Claim and run a single job. The kick route wraps this in a drain loop while
 * time remains; tests call it once and inspect the result.
 */
export async function runOneJob(opts: WorkerOptions = {}): Promise<RunResult> {
  const admin = getAdmin(opts)
  const workerId = opts.workerId ?? randomUUID()
  const ttl = opts.claimTtlSeconds ?? 900

  const job = await claimNext(admin, workerId, ttl, opts.types)
  if (!job) return { claimed: false }

  const pipeline = getPipeline(job.type)
  if (!pipeline) {
    const message = `No pipeline registered for type '${job.type}'`
    logger.error('jobs.worker.runOneJob: unknown job type', undefined, { jobId: job.id, type: job.type })
    await writeCompletion(admin, job.id, 'failed', { error: message }, workerId)
    await notifyJobComplete({ id: job.id, type: job.type, status: 'failed', section_id: job.section_id })
    return { claimed: true, jobId: job.id, type: job.type, finalStatus: 'failed', error: message }
  }

  // Institution/platform AI kill switch — one gate covers every AI pipeline.
  // Types not in the map (render_scheduled_deck, test_noop) are not AI and run
  // freely. Terminal 'failed' with an explicit reason: the job does NOT retry,
  // and re-running it after the institution re-enables AI works normally.
  const aiFeature = AI_FEATURE_BY_JOB_TYPE[job.type]
  if (aiFeature && job.institution_id) {
    const verdict = await checkAiFeature(admin, job.institution_id, aiFeature)
    if (!verdict.allowed) {
      const message = 'Skipped: AI features are disabled for this institution.'
      logger.info('jobs.worker.runOneJob: skipped by AI kill switch', { jobId: job.id, type: job.type })
      await writeCompletion(admin, job.id, 'failed', { error: message }, workerId)
      await notifyJobComplete({ id: job.id, type: job.type, status: 'failed', section_id: job.section_id })
      return { claimed: true, jobId: job.id, type: job.type, finalStatus: 'failed', error: message }
    }
  }

  const controller = new AbortController()
  try {
    const { result, summary } = await pipeline.run(job.params ?? {}, {
      adminDb: admin,
      job,
      signal: controller.signal,
      deadline: opts.deadline,
      reportProgress: makeReportProgress(admin, job.id),
    })
    await writeCompletion(admin, job.id, 'done', { result, summary }, workerId)
    await notifyJobComplete({ id: job.id, type: job.type, status: 'done', section_id: job.section_id })
    return { claimed: true, jobId: job.id, type: job.type, finalStatus: 'done' }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown pipeline error'
    logger.error('jobs.worker.runOneJob: pipeline threw', err, { jobId: job.id, type: job.type })
    await writeCompletion(admin, job.id, 'failed', { error: message }, workerId)
    await notifyJobComplete({ id: job.id, type: job.type, status: 'failed', section_id: job.section_id })
    return { claimed: true, jobId: job.id, type: job.type, finalStatus: 'failed', error: message }
  }
}

/**
 * The types this drain may claim with `remainingMs` left. Unchanged (any type, or the
 * caller's list) unless some pipeline needs more time than remains; then every other
 * registered type, so a builder slice is never started with seconds to spare.
 */
export function claimableTypes(remainingMs: number, requested?: string[]): string[] | undefined {
  const pipelines = listPipelines()
  const tooBig = new Set(pipelines.filter((p) => (p.minBudgetMs ?? 0) > remainingMs).map((p) => p.type))
  if (tooBig.size === 0) return requested
  return (requested ?? pipelines.map((p) => p.type)).filter((t) => !tooBig.has(t))
}

/**
 * Drain the queue until empty or until `deadline` (unix ms) is reached. The
 * kick route provides a deadline that leaves a cushion before its maxDuration.
 */
export async function runUntilDrained(
  deadline: number,
  opts: WorkerOptions = {},
): Promise<{ jobsRun: number; lastResult: RunResult | null }> {
  let jobsRun = 0
  let lastResult: RunResult | null = null
  while (Date.now() < deadline) {
    const result = await runOneJob({ ...opts, deadline, types: claimableTypes(deadline - Date.now(), opts.types) })
    if (!result.claimed) return { jobsRun, lastResult }
    jobsRun += 1
    lastResult = result
  }
  return { jobsRun, lastResult }
}
