// enqueueJob — the server-side handshake that puts a background job on the
// queue and kicks the worker. Mirrors enqueueExtractionJob.
//
// Sequence:
//   1. INSERT a pending background_jobs row. A partial unique index enforces
//      at most one PENDING job per (institution, subject, type, subject_key);
//      on a unique violation we return the existing pending job id (idempotent
//      — "a run is already queued"), so a double-click never double-runs.
//      RUNNING jobs deliberately do NOT block a new enqueue: a state change
//      landing mid-run queues one follow-up job that reconciles the final
//      state after the current run finishes (deduping against running jobs
//      would swallow the change forever).
//   2. Fire-and-forget POST to /api/jobs-worker/kick (dedicated secret). The
//      route returns fast; the drain continues server-side. If the kick is
//      lost (cold start, restart), the scheduled sweep re-kicks and the job
//      drains anyway.
//
// Runs under the admin client (bypasses RLS). Callers MUST authorize the user
// against the subject BEFORE calling this — it does not re-check.

import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'

export interface EnqueueJobInput {
  type: string
  params?: Record<string, unknown>
  institutionId: string
  /** null / omitted = an institution-level job. */
  sectionId?: string | null
  /** The user who triggered the job (audit). */
  createdBy?: string | null
  /**
   * Per-entity dedup key (e.g. a module_item id). With it, "one active job"
   * is enforced per (section, type, subjectKey) instead of per (section, type)
   * — required for job types that run once per entity, like embed_material.
   */
  subjectKey?: string | null
}

export interface EnqueueJobResult {
  jobId: string
  /** True when an active job for this subject+type already existed. */
  alreadyActive: boolean
  kicked: boolean
  kickError?: string
}

function resolveKickUrl(): string {
  const fromEnv = process.env.BACKGROUND_JOBS_KICK_URL
  if (fromEnv) return fromEnv
  const siteUrl =
    process.env.NEXT_PUBLIC_APP_URL ?? process.env.VERCEL_URL ?? 'http://localhost:3000'
  const base = siteUrl.startsWith('http') ? siteUrl : `https://${siteUrl}`
  return `${base.replace(/\/$/, '')}/api/jobs-worker/kick`
}

export async function enqueueJob(input: EnqueueJobInput): Promise<EnqueueJobResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminClient() as any
  const sectionId = input.sectionId ?? null
  const subjectKey = input.subjectKey ?? null

  // 1. Insert the pending row.
  const { data: inserted, error: insertError } = await admin
    .from('background_jobs')
    .insert({
      type: input.type,
      params: input.params ?? {},
      status: 'pending',
      institution_id: input.institutionId,
      section_id: sectionId,
      subject_key: subjectKey,
      created_by: input.createdBy ?? null,
    })
    .select('id')
    .single()

  if (insertError) {
    // 23505 = unique_violation → an IN-FLIGHT job for this subject+type already
    // exists (uq_background_jobs_active). Return it — idempotent by design.
    //
    // 'running' as well as 'pending': the index used to cover pending only, so a
    // second job could start the moment the first was claimed (#630). Looking up
    // only 'pending' here would now find nothing on that exact conflict and throw
    // instead of reporting the run already under way.
    if ((insertError as { code?: string }).code === '23505') {
      let query = admin
        .from('background_jobs')
        .select('id')
        .eq('type', input.type)
        .eq('institution_id', input.institutionId)
        .in('status', ['pending', 'running'])
        .order('created_at', { ascending: false })
        .limit(1)
      query = sectionId === null ? query.is('section_id', null) : query.eq('section_id', sectionId)
      query = subjectKey === null ? query.is('subject_key', null) : query.eq('subject_key', subjectKey)
      const { data: existing } = await query.maybeSingle()
      if (existing?.id) {
        // Still nudge the worker in case the prior kick was lost.
        const kick = await kickWorker(existing.id)
        return { jobId: existing.id, alreadyActive: true, ...kick }
      }
    }
    logger.error('enqueueJob: insert failed', insertError, { type: input.type })
    throw new Error((insertError as { message?: string }).message ?? 'Failed to enqueue job')
  }

  const jobId = (inserted as { id: string }).id

  // 2. Fire-and-forget kick.
  const kick = await kickWorker(jobId)
  return { jobId, alreadyActive: false, ...kick }
}

/** Fire-and-forget POST to the kick route. Never throws — the sweep recovers. */
async function kickWorker(jobId: string): Promise<{ kicked: boolean; kickError?: string }> {
  const secret = process.env.BACKGROUND_JOBS_SECRET ?? ''
  if (!secret) {
    logger.warn('enqueueJob: BACKGROUND_JOBS_SECRET not set, skipping kick (sweep will pick up)', {
      jobId,
    })
    return { kicked: false, kickError: 'secret not set' }
  }

  const kickUrl = resolveKickUrl()
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 2000)
  try {
    const res = await fetch(kickUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-background-jobs-secret': secret,
      },
      body: JSON.stringify({ jobId }),
      signal: controller.signal,
    })
    return res.ok ? { kicked: true } : { kicked: false, kickError: `kick responded ${res.status}` }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // AbortError is expected — we intentionally don't wait for the full drain.
    if (message.toLowerCase().includes('abort')) return { kicked: true }
    logger.warn('enqueueJob: kick fetch failed (sweep will pick up)', { jobId, error: message })
    return { kicked: false, kickError: message }
  } finally {
    clearTimeout(timeoutId)
  }
}
