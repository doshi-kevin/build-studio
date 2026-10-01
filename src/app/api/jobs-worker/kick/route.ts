// POST /api/jobs-worker/kick
//
// Drains the background_jobs queue. Called two ways (mirrors the extraction
// worker):
//   1. enqueueJob() fires a fetch here after inserting a pending row.
//   2. A scheduled sweep (GitHub Action / Cloud Scheduler) POSTs here
//      periodically as a safety net for jobs whose initial kick was lost.
//
// Auth: shared secret in the x-background-jobs-secret header (dedicated —
// NOT the extraction secret). Without it → 401.
//
// Behaviour: reaps abandoned jobs, then claims + runs jobs one at a time until
// the queue is empty OR we're within the safety cushion of maxDuration.

import 'server-only'
import { timingSafeEqual } from 'crypto'
import { NextResponse, type NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'

import { runUntilDrained } from '@/lib/jobs/worker'
import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 900

const SAFETY_CUSHION_MS = 60_000

function unauthorized() {
  return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
}

export function verifySecret(req: NextRequest): boolean {
  const expected = process.env.BACKGROUND_JOBS_SECRET
  if (!expected) return false
  const provided = req.headers.get('x-background-jobs-secret')
  if (!provided) return false
  if (provided.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
}

/**
 * Mark truly-dead jobs as failed: status='running', claim TTL lapsed, AND
 * retries exhausted (attempts >= max_attempts). Gentle — never steps on a
 * slow-but-alive worker (its claim_expires_at is still in the future).
 */
export async function reapAbandonedJobs(adminClient?: SupabaseClient): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = (adminClient ?? createAdminClient()) as any
  const { data: candidates, error: selectError } = await admin
    .from('background_jobs')
    .select('id, attempts, max_attempts')
    .eq('status', 'running')
    .lt('claim_expires_at', new Date().toISOString())
  if (selectError) {
    logger.warn('jobs-worker/kick: reap SELECT failed', { error: selectError.message })
    return 0
  }
  const abandoned = (candidates ?? []).filter(
    (j: { attempts: number; max_attempts: number }) => j.attempts >= j.max_attempts,
  )
  if (abandoned.length === 0) return 0

  const ids = abandoned.map((j: { id: string }) => j.id)
  const { error: updateError } = await admin
    .from('background_jobs')
    .update({
      status: 'failed',
      completed_at: new Date().toISOString(),
      error: '[abandoned — claim expired and attempts exhausted]',
    })
    .in('id', ids)
  if (updateError) {
    logger.warn('jobs-worker/kick: reap UPDATE failed', { error: updateError.message })
    return 0
  }
  return ids.length
}

export async function POST(req: NextRequest) {
  if (!verifySecret(req)) return unauthorized()

  const startedAt = Date.now()
  const deadline = startedAt + maxDuration * 1000 - SAFETY_CUSHION_MS

  try {
    const reaped = await reapAbandonedJobs()
    const { jobsRun, lastResult } = await runUntilDrained(deadline)
    return NextResponse.json(
      {
        jobsRun,
        reaped,
        lastJobId: lastResult?.jobId,
        lastStatus: lastResult?.finalStatus,
        elapsedMs: Date.now() - startedAt,
      },
      { status: 200 },
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error'
    logger.error('jobs-worker/kick: drain failed', err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// GET is a secret-gated liveness check.
export async function GET(req: NextRequest) {
  if (!verifySecret(req)) return unauthorized()
  return NextResponse.json({ ok: true, runtime: 'nodejs' }, { status: 200 })
}
