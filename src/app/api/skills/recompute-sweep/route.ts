// POST /api/skills/recompute-sweep
//
// Nightly COVERAGE backstop for Topic-Mastery recompute. The fast path is
// event-triggered (a graded quiz/assignment/live-quiz or a topic config/exclude/
// mapping change enqueues a 'recompute-mastery' job, drained by the worker +
// 5-min sweep). This endpoint catches anything the event triggers don't cover —
// AI-tutor engagement, or any code path not wired — by enqueueing a recompute
// for every section that has any mastery evidence. The worker then drains them.
// Note "has evidence", not "has skills": a section with content but no skills yet
// is exactly the one that needs the sweep, and keying off `skills` meant it could
// never get one. The section list comes from the sections_with_mastery_evidence()
// RPC; that migration carries the reasoning.
//
// Auth: same shared secret as the extraction worker (x-extraction-worker-secret),
// set in Cloud Run env + the GitHub Actions secret store. 401 without it.
//
// Trigger: a scheduled GitHub Actions cron (mastery-recompute-nightly.yml).
// Equivalently, point a GCP Cloud Scheduler HTTP job at this URL with the same
// header — the endpoint doesn't care who calls it as long as the secret matches.

import 'server-only'
import { timingSafeEqual } from 'crypto'
import { NextResponse, type NextRequest } from 'next/server'

import { createAdminClient } from '@/lib/supabase/admin'
import { enqueueMasteryRecomputeMany } from '@/lib/extraction/enqueue'
import { logger } from '@/lib/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

function unauthorized() {
  return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
}

function verifySecret(req: NextRequest): boolean {
  const expected = process.env.EXTRACTION_WORKER_SECRET
  if (!expected) return false
  const provided = req.headers.get('x-extraction-worker-secret')
  if (!provided) return false
  if (provided.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
}

export async function POST(req: NextRequest) {
  if (!verifySecret(req)) return unauthorized()

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const admin = createAdminClient() as any
    /* Every section with any mastery EVIDENCE, not every section that already has
       skills. Listing `skills` alone could never bootstrap a section: skills are
       created by reconcileSectionSkills, which only runs inside the recompute this
       sweep enqueues, which only ran for sections that already had skills. A
       section that missed its initial seeding stayed empty forever — which is the
       live state of both Stevens sections (tagged questions and extracted
       modules, zero skills).

       The union runs in Postgres because PostgREST cannot do DISTINCT, and doing
       it here meant reading every row of four tables and de-duplicating in JS.
       That needed a page ceiling to stay inside this route's 60s limit, and any
       ceiling truncates by sort order — so past it the SAME sections drop out
       every night, which is the silent coverage loss this route was just fixed
       for. See the migration for the full reasoning. */
    const { data, error } = await admin.rpc('sections_with_mastery_evidence')
    if (error) {
      /* A coverage backstop that under-covers must fail loudly. Returning a
         partial list with a 200 would leave the cron green while sections quietly
         stopped being swept. */
      logger.error('recompute-sweep: list sections failed', error)
      return NextResponse.json({ error: 'list failed' }, { status: 500 })
    }
    const sectionIds = (data ?? []) as Array<{ section_id: string }>
    const { enqueued } = await enqueueMasteryRecomputeMany(sectionIds.map((r) => r.section_id))
    logger.info('recompute-sweep: enqueued nightly recompute', { sections: enqueued })
    return NextResponse.json({ ok: true, enqueued })
  } catch (err) {
    logger.error('recompute-sweep: unexpected', err)
    return NextResponse.json({ error: 'unexpected' }, { status: 500 })
  }
}
