/**
 * The validator's background jobs (docs/reference/studio-plugin-validator.md).
 *
 *   studio_validator_runtime     one cloud Stage 2 run: dispatch starts its execution; the
 *                                upkeep, on every jobs kick, collects finished executions.
 *   studio_validator_revalidate  one institution's re-checks after the minimum ruleset was
 *                                raised. Works through pages until its drain's time runs
 *                                out or a Stage 2 or classifier cap is reached, then ends
 *                                with where to resume; the upkeep queues the continuation
 *                                on a later kick, so a full lane never spins a drain.
 */
import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { BackgroundPipeline } from '@/lib/jobs/types'
import { logger } from '@/lib/logger'
import * as db from '../db'
import { cloudConfig, collectCloudRuns, dispatchCloudRun, googleCloudClient, type CollectStore, type DispatchStore } from './cloud-runner'
import { runnerMode } from './runtime-runner'
import { finishRuntimeRun, REVALIDATE_SUBJECT, revalidateInstitutionPage, STUDIO_VALIDATOR_REVALIDATE_JOB, STUDIO_VALIDATOR_RUNTIME_JOB } from './service'
/** A page of re-checks can call the classifier for each tool; don't start one with less left. */
const PAGE_BUDGET_MS = 60_000

const failRun = async (validationId: string, code: string, message: string) => {
  await db.finishValidation(validationId, { status: 'error', runner: 'cloud', error: { code, message } })
}

const dispatchStore: DispatchStore = {
  loadRun: async (id) => {
    const run = await db.loadValidation(id)
    return run ? { id: run.id, stage: run.stage, status: run.status, versionId: run.versionId, runnerMode: run.runnerMode } : null
  },
  loadArtifact: async (versionId) => {
    const v = await db.loadVersionArtifact(versionId)
    return v ? { manifest: v.manifest, studentBundle: v.studentBundle, professorBundle: v.professorBundle } : null
  },
  dispatch: (id, payloadSha256, execution, image, callbackSha256) => db.dispatchValidation(id, 'cloud', payloadSha256, execution, image, callbackSha256),
  fail: failRun,
}

const collectStore: CollectStore = {
  listDispatched: (limit) => db.listDispatchedCloudRuns(limit),
  fail: failRun,
  finish: (id, envelope) => finishRuntimeRun(id, envelope, 'cloud'),
}

export const validatorRuntimePipeline: BackgroundPipeline = {
  type: STUDIO_VALIDATOR_RUNTIME_JOB,
  run: async (params) => {
    const validationId = typeof params.validationId === 'string' ? params.validationId : ''
    const config = runnerMode() === 'cloud' ? cloudConfig() : null
    if (!config) {
      // The mode changed after the run was queued: end it rather than leave it pending.
      if (validationId) await failRun(validationId, 'runner_unavailable', 'Browser checks can’t run in this environment yet.')
      return { result: { outcome: 'unavailable' }, summary: 'Browser checks: runner unavailable' }
    }
    const outcome = await dispatchCloudRun(validationId, { cloud: googleCloudClient(config), config, store: dispatchStore })
    return { result: { outcome }, summary: `Browser checks: ${outcome}` }
  },
  upkeep: async () => {
    const config = runnerMode() === 'cloud' ? cloudConfig() : null
    if (!config) return
    const counts = await collectCloudRuns({ cloud: googleCloudClient(config), config, store: collectStore, now: Date.now })
    if (counts.finished || counts.failed) logger.info('studio/validator.collect', counts)
  },
}

/** What a revalidation job leaves behind for its continuation. */
interface RevalidateResult {
  next: number | null
  minRuleset: number | null
  checked: number
  waiting: boolean
}

export async function runRevalidation(
  institutionId: string,
  actorId: string,
  params: Record<string, unknown>,
  deadline: number | undefined,
  now: () => number = Date.now,
): Promise<RevalidateResult> {
  let offset = typeof params.offset === 'number' && Number.isInteger(params.offset) && params.offset >= 0 ? params.offset : 0
  let minRuleset = typeof params.minRuleset === 'number' ? params.minRuleset : null
  let checked = 0
  for (;;) {
    const page = await revalidateInstitutionPage(institutionId, actorId, offset)
    checked += page.checked
    if (page.waiting) return { next: page.next, minRuleset, checked, waiting: true }
    if (page.next === null) {
      // Raised again while this ran: the tools already passed over need another look.
      const current = await db.loadMinAcceptedRuleset()
      if (current !== null && minRuleset !== null && current > minRuleset) {
        minRuleset = current
        offset = 0
      } else {
        return { next: null, minRuleset, checked, waiting: false }
      }
    } else {
      offset = page.next
    }
    if (deadline !== undefined && deadline - now() < PAGE_BUDGET_MS) return { next: offset, minRuleset, checked, waiting: false }
  }
}

/**
 * Queues the continuation of every institution whose newest revalidation job ended with
 * more to do. Inserted directly, without a kick: the drain this upkeep precedes claims
 * them, so a full lane is retried once per kick instead of kicking itself in a loop.
 */
export async function continueRevalidations(adminDb: SupabaseClient): Promise<number> {
  const { data, error } = await adminDb
    .from('background_jobs')
    .select('institution_id, status, result, created_by, created_at')
    .eq('type', STUDIO_VALIDATOR_REVALIDATE_JOB)
    .order('created_at', { ascending: false })
    .limit(500)
  if (error) {
    logger.error('studio/validator.continueRevalidations', error)
    return 0
  }
  const newest = new Map<string, { status: string; result: unknown; created_by: string | null }>()
  for (const row of data ?? []) if (!newest.has(row.institution_id)) newest.set(row.institution_id, row)
  let queued = 0
  for (const [institutionId, job] of newest) {
    const r = job.result as Partial<RevalidateResult> | null
    if (job.status !== 'done' || typeof r?.next !== 'number' || !job.created_by) continue
    const { error: insertError } = await adminDb.from('background_jobs').insert({
      type: STUDIO_VALIDATOR_REVALIDATE_JOB,
      params: { offset: r.next, minRuleset: r.minRuleset ?? null },
      status: 'pending',
      institution_id: institutionId,
      section_id: null,
      subject_key: REVALIDATE_SUBJECT,
      created_by: job.created_by,
    })
    // 23505: one is already active for this institution.
    if (!insertError) queued += 1
    else if (insertError.code !== '23505') logger.error('studio/validator.continueRevalidations: insert', insertError, { institutionId })
  }
  return queued
}

export const validatorRevalidatePipeline: BackgroundPipeline = {
  type: STUDIO_VALIDATOR_REVALIDATE_JOB,
  minBudgetMs: PAGE_BUDGET_MS,
  run: async (params, ctx) => {
    // The super admin who raised the minimum; a job without one does nothing.
    if (!ctx.job.created_by) return { result: { next: null, minRuleset: null, checked: 0, waiting: false }, summary: 'Revalidation: no actor' }
    const result = await runRevalidation(ctx.job.institution_id, ctx.job.created_by, params, ctx.deadline)
    const tail = result.next === null ? 'done' : result.waiting ? 'waiting for capacity' : 'continuing'
    return { result, summary: `Revalidation: ${result.checked} re-checked, ${tail}` }
  },
  upkeep: async ({ adminDb }) => {
    const queued = await continueRevalidations(adminDb)
    if (queued) logger.info('studio/validator.revalidate.upkeep', { queued })
  },
}
