// POST /api/live-classroom/reap-decks
//
// Deletes live-classroom deck files whose room is no longer live and ended more
// than an hour ago. Deck uploads are ephemeral by design: anything worth keeping
// is copied into the course-materials bucket by promote-deck-material.ts, so the
// live-classroom-decks copy is scratch space.
//
// This replaces the pg_cron job `lc_decks_orphan_reaper`, which ran nightly from
// 2026-04-29 and NEVER once succeeded — 134 consecutive failures. It called
// lc_reap_orphan_decks(), which did `DELETE FROM storage.objects` directly, and
// Supabase blocks that with a storage.protect_delete() trigger:
//
//   ERROR: Direct deletion from storage tables is not allowed.
//          Use the Storage API instead.
//
// It was born broken, which is why nobody noticed: there was never a "working"
// state to regress from. By the time it was found, 5,213 files and 662 MB had
// accumulated. Storage rows must be removed through the Storage API, which is
// what the rest of the codebase already does (six call sites use
// `adminDb.storage.from(bucket).remove([...])`).
//
// Auth: the same shared secret the other workers use. No NODE_ENV branch — that
// answers "is this an optimized build", not "which deployment is this", and an
// authorization check must rest on a credential.
//
// Trigger: Google Cloud Scheduler, daily, alongside the other two sweeps.
// Deliberately NOT a GitHub Actions cron: the repo moved the other sweeps off
// Actions after a billing lapse silently stopped the queues, and .github/README.md
// says not to reintroduce that dependency.

import 'server-only'
import { timingSafeEqual } from 'crypto'
import { NextResponse, type NextRequest } from 'next/server'

import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const BUCKET = 'live-classroom-decks'

/** Deletions per run. The Storage API takes bulk paths, but a bounded batch keeps
 *  one run inside maxDuration and means the first run against a long backlog
 *  drains over a few nights rather than issuing thousands of deletes at once. */
const MAX_DELETES_PER_RUN = 500

/** A room's deck is live scratch until an hour after the room ends, which covers
 *  a professor reopening the tab right after class. Passed to the SQL function
 *  so the window lives in one place. */
const KEEP_AFTER_INTERVAL = '1 hour'

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

  /* `?dryRun=1` reports what it would delete and deletes nothing. The first run
     against a backlog this old should be looked at before it is trusted. */
  const dryRun = new URL(req.url).searchParams.get('dryRun') === '1'

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const admin = createAdminClient() as any

    /* The candidate list comes from SQL, not from a client query: PostgREST only
       exposes `public` and `graphql_public`, so asking it for storage.objects
       returns PGRST106. lc_orphan_deck_paths() does the keep/drop logic next to
       lc_rooms and returns paths only.

       An error here returns 500 and deletes nothing. That direction matters more
       than it looks: the keep-set is what protects live sessions, so a failed
       read must never be read as "nothing is worth keeping". */
    const { data, error } = await admin.rpc('lc_orphan_deck_paths', {
      p_keep_after: KEEP_AFTER_INTERVAL,
      p_limit: MAX_DELETES_PER_RUN,
    })
    if (error) {
      logger.error('reap-decks: could not list orphan paths, refusing to delete', error)
      return NextResponse.json({ error: 'list failed' }, { status: 500 })
    }

    /* setof text arrives as either bare strings or { lc_orphan_deck_paths } rows
       depending on the client version; normalise and drop anything empty rather
       than passing a stray null into remove(). */
    const paths: string[] = ((data ?? []) as Array<unknown>)
      .map((row) => {
        if (typeof row === 'string') return row
        // Object.values(null) throws, and one malformed row must not turn a
        // routine sweep into a 500.
        if (row && typeof row === 'object') return Object.values(row)[0]
        return null
      })
      .filter((p): p is string => typeof p === 'string' && p.length > 0)

    if (dryRun) {
      return NextResponse.json({
        ok: true,
        dryRun: true,
        wouldDelete: paths.length,
        sample: paths.slice(0, 5),
      })
    }

    if (paths.length === 0) return NextResponse.json({ ok: true, deleted: 0 })

    // The supported path, and the only one storage.protect_delete() permits.
    const { error: removeError } = await admin.storage.from(BUCKET).remove(paths)
    if (removeError) {
      logger.error('reap-decks: storage remove failed', removeError, { count: paths.length })
      return NextResponse.json({ error: 'remove failed' }, { status: 500 })
    }

    logger.info('reap-decks: removed orphaned deck files', { deleted: paths.length })
    return NextResponse.json({ ok: true, deleted: paths.length })
  } catch (err) {
    logger.error('reap-decks: unexpected', err)
    return NextResponse.json({ error: 'unexpected' }, { status: 500 })
  }
}
