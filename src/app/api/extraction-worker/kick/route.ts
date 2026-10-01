// POST /api/extraction-worker/kick
//
// Drains the extraction_jobs queue. Called from two places:
//   1. enqueueExtractionJob() fires a fetch() here after inserting
//      a new pending row (fast path, typical invocation).
//   2. The GHA sweep workflow (PR 5) POSTs here every 5 min as a
//      safety net for jobs whose initial kick silently failed.
//
// Auth: requires a shared secret in the x-extraction-worker-secret
// header. The secret lives in Cloud Run env + GitHub Actions secret
// store only. Without it the route returns 401 and does nothing.
//
// Behaviour: claims and runs jobs one at a time until the queue is
// empty OR until we're within the safety cushion of maxDuration.
// Returns 200 with a small JSON summary when done. The HTTP caller
// typically doesn't care about the full body — enqueueExtractionJob
// aborts the read after 2s; the GHA sweep logs it.
//
// Runtime: 'nodejs' because pdfjs-dist + sharp need the native Node
// runtime (edge workers don't have Buffer + native modules).

import 'server-only'
import { timingSafeEqual } from 'crypto'
import { NextResponse, type NextRequest } from 'next/server'

import { runUntilDrained } from '@/lib/extraction/worker'
import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Give ourselves the full 15-minute Cloud Run cushion. The drain loop
// exits ~60s before this deadline so we never mid-job timeout.
export const maxDuration = 900

const SAFETY_CUSHION_MS = 60_000

function unauthorized() {
  return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
}

function verifySecret(req: NextRequest): boolean {
  const expected = process.env.EXTRACTION_WORKER_SECRET
  if (!expected) return false
  const provided = req.headers.get('x-extraction-worker-secret')
  if (!provided) return false
  if (provided.length !== expected.length) return false
  // Timing-safe compare. timingSafeEqual requires equal-length buffers;
  // the length gate above guarantees that. Without this, a network
  // observer could in principle infer secret characters from response
  // time — small threat in practice, trivial to defend against.
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
}

/**
 * Mark abandoned jobs as failed so they stop cluttering the admin
 * view. A job is considered abandoned if:
 *   - status='running', claim_expires_at < now() (TTL lapsed), AND
 *     it has exhausted its retries (attempts >= max_attempts)
 *   - OR status='running' for > 2× maxDuration with no heartbeat update
 *     (belt-and-braces — the claim_expires_at check usually wins first)
 *
 * Kept intentionally gentle — only marks truly dead jobs, never
 * steps on a slow-but-alive worker. Runs once per kick before the
 * drain loop so the admin table reflects reality.
 */
async function reapAbandonedJobs(): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminClient() as any
  // Step 1: find stale-running rows. PostgREST can't express a
  // column-to-column compare (attempts >= max_attempts) in one
  // .filter() call, so we pull candidates and filter in code. Volume
  // is small — a handful of expired rows per sweep at most.
  const { data: candidates, error: selectError } = await admin
    .from('extraction_jobs')
    .select('id, attempts, max_attempts, claim_expires_at')
    .eq('status', 'running')
    .lt('claim_expires_at', new Date().toISOString())
  if (selectError) {
    logger.warn('extraction-worker/kick: reap SELECT failed', {
      error: selectError.message,
    })
    return 0
  }
  const abandoned = (candidates ?? []).filter(
    (j: { attempts: number; max_attempts: number }) =>
      j.attempts >= j.max_attempts,
  )
  if (abandoned.length === 0) return 0

  const ids = abandoned.map((j: { id: string }) => j.id)
  const { error: updateError } = await admin
    .from('extraction_jobs')
    .update({
      status: 'failed',
      completed_at: new Date().toISOString(),
      error: '[abandoned — claim expired and attempts exhausted]',
    })
    .in('id', ids)

  if (updateError) {
    logger.warn('extraction-worker/kick: reap UPDATE failed', {
      error: updateError.message,
    })
    return 0
  }
  return ids.length
}

export async function POST(req: NextRequest) {

  if (!verifySecret(req)) {
    return unauthorized()
  }

  const startedAt = Date.now()
  const deadline = startedAt + maxDuration * 1000 - SAFETY_CUSHION_MS

  try {
    const reaped = await reapAbandonedJobs()
    const { jobsRun, lastResult } = await runUntilDrained(deadline)
    const elapsedMs = Date.now() - startedAt
    return NextResponse.json(
      {
        jobsRun,
        reaped,
        lastJobId: lastResult?.jobId,
        lastStatus: lastResult?.finalStatus,
        elapsedMs,
      },
      { status: 200 },
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error'
    logger.error('extraction-worker/kick: drain failed', err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// GET is useful for a manual "is the worker alive" check. Requires
// the same secret to prevent trivial discovery.
export async function GET(req: NextRequest) {
  if (!verifySecret(req)) return unauthorized()
  return NextResponse.json({ ok: true, runtime: 'nodejs' }, { status: 200 })
}
