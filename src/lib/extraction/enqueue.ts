// enqueueExtractionJob — the server-side handshake that moves a
// professor's file upload from "saved in Storage" to "pending in the
// extraction queue". Called from EditItemDialog after a successful
// createModuleItem / updateModuleItem.
//
// Sequence:
//   1. cancel_pending_extraction_jobs(moduleItemId)
//        — supersedes any prior pending/running jobs for the same
//          item, so a re-upload doesn't race the old worker against
//          the new file.
//   2. INSERT into extraction_jobs (status='pending')
//   3. fire-and-forget POST to /api/extraction-worker/kick
//        — returns immediately; the route drains whatever's pending.
//   4. return the new jobId to the caller so UI can reference it.
//
// Every call runs under the admin client (bypasses RLS on
// extraction_jobs). Callers must have already verified ownership of
// the module item; this helper does NOT re-check.

import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'

// ── Types ──────────────────────────────────────────────────────

export interface EnqueueExtractionJobInput {
  moduleItemId: string
  sectionId: string
  /**
   * Optional payload — defaults to an empty object. Used by the
   * backfill script to tag its jobs with an originating admin id.
   */
  payload?: Record<string, unknown>
  /** Override the job kind (e.g. 'backfill-extraction'). Defaults to 'extract'. */
  kind?: 'extract' | 'backfill-extraction'
}

/**
 * Resolve a section's institution so the job row can carry it.
 *
 * extraction_jobs.institution_id exists so /admin/extraction-jobs can be scoped in
 * SQL (migration 20260807153351); before it, that page mixed tenants. Resolved here
 * rather than taken as a parameter so no caller can pass a foreign institution — and
 * so existing call sites need no change.
 *
 * Returns null when the section can't be resolved. The job is still enqueued (a
 * missing tenant tag must not stop extraction from running) but stays invisible to
 * every tenant's admin view, which is the fail-closed direction.
 */
async function institutionForSection(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
  sectionId: string,
): Promise<string | null> {
  if (!sectionId) return null
  const { data, error } = await admin
    .from('course_sections')
    .select('institution_id')
    .eq('id', sectionId)
    .maybeSingle()
  if (error) {
    logger.warn('institutionForSection: lookup failed', { sectionId, error: error.message })
    return null
  }
  return (data?.institution_id as string | undefined) ?? null
}

export interface EnqueueExtractionJobResult {
  jobId: string
  supersededCount: number
  kicked: boolean
  kickError?: string
}

// ── Kick-url resolution ─────────────────────────────────────────
// The /kick route lives on the same app as this server action, so in
// prod we hit our own public URL. In local dev that's http://localhost:3000.
// Tests can override via `opts.kickUrlOverride`.

function resolveKickUrl(): string {
  const fromEnv = process.env.EXTRACTION_WORKER_KICK_URL
  if (fromEnv) return fromEnv
  const siteUrl =
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.VERCEL_URL ??
    'http://localhost:3000'
  const base = siteUrl.startsWith('http') ? siteUrl : `https://${siteUrl}`
  return `${base.replace(/\/$/, '')}/api/extraction-worker/kick`
}

// ── Main ────────────────────────────────────────────────────────

export async function enqueueExtractionJob(
  input: EnqueueExtractionJobInput,
): Promise<EnqueueExtractionJobResult> {

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminClient() as any
  const kind = input.kind ?? 'extract'

  // 1. Supersede existing jobs for this item. Returns the count of rows
  //    that got flipped to 'failed'. Safe to call even if none exist.
  const { data: supersededData, error: supersedeError } = await admin.rpc(
    'cancel_pending_extraction_jobs',
    { p_module_item_id: input.moduleItemId },
  )
  if (supersedeError) {
    logger.warn('enqueueExtractionJob: supersede RPC failed, continuing', {
      moduleItemId: input.moduleItemId,
      error: supersedeError.message,
    })
  }
  const supersededCount = typeof supersededData === 'number' ? supersededData : 0

  // 2. Insert the new pending row.
  const { data: inserted, error: insertError } = await admin
    .from('extraction_jobs')
    .insert({
      kind,
      module_item_id: input.moduleItemId,
      institution_id: await institutionForSection(admin, input.sectionId),
      status: 'pending',
      payload: {
        sectionId: input.sectionId,
        ...(input.payload ?? {}),
      },
    })
    .select('id')
    .single()

  if (insertError || !inserted) {
    logger.error('enqueueExtractionJob: insert failed', insertError, {
      moduleItemId: input.moduleItemId,
    })
    throw new Error(insertError?.message ?? 'Failed to enqueue extraction job')
  }
  const jobId = (inserted as { id: string }).id

  // 3. Fire-and-forget kick — the route returns 202 quickly and drains
  //    server-side. If the kick fails, the GHA sweep eventually catches up.
  const { kicked, kickError } = await kickWorker(jobId)
  return { jobId, supersededCount, kicked, kickError }
}

/**
 * Fire-and-forget POST to /api/extraction-worker/kick to start draining the
 * queue. We await only enough to know the request was accepted (2s budget),
 * not the full drain. Any failure is non-fatal — the 5-min GHA sweep recovers.
 * Shared by extraction enqueue and mastery-recompute enqueue.
 */
async function kickWorker(jobId: string): Promise<{ kicked: boolean; kickError?: string }> {
  const secret = process.env.EXTRACTION_WORKER_SECRET ?? ''
  if (!secret) {
    logger.warn('kickWorker: EXTRACTION_WORKER_SECRET not set, skipping kick', { jobId })
    return { kicked: false, kickError: 'secret not set' }
  }
  const kickUrl = resolveKickUrl()
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 2000)
    try {
      const res = await fetch(kickUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-extraction-worker-secret': secret },
        body: JSON.stringify({ jobId, hint: 'new-job' }),
        signal: controller.signal,
      })
      return res.ok ? { kicked: true } : { kicked: false, kickError: `kick responded ${res.status}` }
    } catch (err) {
      // AbortError is expected — we bail on the response body on purpose.
      const message = err instanceof Error ? err.message : String(err)
      if (message.toLowerCase().includes('abort')) return { kicked: true }
      return { kicked: false, kickError: message }
    } finally {
      clearTimeout(timeoutId)
    }
  } catch (err) {
    const kickError = err instanceof Error ? err.message : String(err)
    logger.warn('kickWorker: kick fetch failed (sweep will pick up)', { jobId, error: kickError })
    return { kicked: false, kickError }
  }
}

/**
 * Enqueue a section-scoped Topic-Mastery recompute on the shared queue.
 * Coalesces: supersedes any *pending* recompute for the same section so a burst
 * of grades collapses to ~one rebuild. A grade landing mid-run inserts a fresh
 * pending job that the worker picks up after the current one finishes (so
 * nothing is lost). NEVER throws — mastery freshness must not break a grade
 * write; the 5-min sweep + nightly coverage job recover anything dropped here.
 */
/**
 * Batch variant for the nightly coverage sweep: insert one pending recompute job
 * per section and fire a single kick. Idempotent — duplicate pending jobs only
 * cause a redundant (idempotent) rebuild. Never throws.
 */
export async function enqueueMasteryRecomputeMany(sectionIds: string[]): Promise<{ enqueued: number }> {
  const ids = [...new Set(sectionIds.filter(Boolean))]
  if (!ids.length) return { enqueued: 0 }
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const admin = createAdminClient() as any
    /* Batch-resolve the tenant for every section in one query rather than N. */
    const { data: sectionRows } = await admin
      .from('course_sections')
      .select('id, institution_id')
      .in('id', ids)
    const instBySection = new Map<string, string>()
    for (const r of (sectionRows ?? []) as { id: string; institution_id: string | null }[]) {
      if (r.institution_id) instBySection.set(r.id, r.institution_id)
    }

    const rows = ids.map((sectionId) => ({
      kind: 'recompute-mastery',
      module_item_id: null,
      institution_id: instBySection.get(sectionId) ?? null,
      status: 'pending',
      payload: { sectionId },
    }))
    const { error } = await admin.from('extraction_jobs').insert(rows)
    if (error) {
      logger.error('enqueueMasteryRecomputeMany: insert failed', error, { count: ids.length })
      return { enqueued: 0 }
    }
    await kickWorker('mastery-nightly-sweep')
    return { enqueued: ids.length }
  } catch (err) {
    logger.warn('enqueueMasteryRecomputeMany: failed', {
      error: err instanceof Error ? err.message : String(err),
    })
    return { enqueued: 0 }
  }
}

export async function enqueueMasteryRecompute(sectionId: string): Promise<void> {
  if (!sectionId) return
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const admin = createAdminClient() as any
    // Supersede pending recompute jobs for this section (coalesce the burst).
    await admin
      .from('extraction_jobs')
      .update({ status: 'failed', error: 'superseded by newer recompute', completed_at: new Date().toISOString() })
      .eq('kind', 'recompute-mastery')
      .eq('status', 'pending')
      .eq('payload->>sectionId', sectionId)

    const { data: inserted, error } = await admin
      .from('extraction_jobs')
      .insert({
        kind: 'recompute-mastery',
        module_item_id: null,
        institution_id: await institutionForSection(admin, sectionId),
        status: 'pending',
        payload: { sectionId },
      })
      .select('id')
      .single()
    if (error || !inserted) {
      logger.error('enqueueMasteryRecompute: insert failed', error, { sectionId })
      return
    }
    await kickWorker((inserted as { id: string }).id)
  } catch (err) {
    logger.warn('enqueueMasteryRecompute: failed (sweep/nightly will catch up)', {
      sectionId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
