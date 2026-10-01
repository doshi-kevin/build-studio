// POST /api/live-classroom/reap-decks — the replacement for the pg_cron deck
// reaper that never once succeeded.
//
// This endpoint deletes files in bulk, so the failure that matters is not
// "deleted too few". It is "deleted the wrong ones", and every case below is one
// way that could happen silently:
//
//   - a failed candidate read being treated as "nothing to keep", which would
//     reap the whole bucket instead of nothing
//   - the auth check being satisfiable without the secret
//   - a dry run that deletes anyway
//
// Which paths are safe to delete is decided in SQL (lc_orphan_deck_paths), next
// to lc_rooms, because PostgREST does not expose the storage schema. That
// keep/drop predicate is verified against the real database, not mocked here.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

const SECRET = 'test-worker-secret'

let orphanPaths: unknown[] = []
let listFails = false
let removed: string[][] = []
let removeFails = false
let rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = []

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args })
      if (listFails) return { data: null, error: { message: 'boom' } }
      return { data: orphanPaths, error: null }
    },
    storage: {
      from: () => ({
        remove: async (paths: string[]) => {
          if (removeFails) return { error: { message: 'nope' } }
          removed.push(paths)
          return { error: null }
        },
      }),
    },
  }),
}))

const { POST } = await import('@/app/api/live-classroom/reap-decks/route')

function post(opts: { secret?: string | null; dryRun?: boolean } = {}) {
  const headers: Record<string, string> = {}
  const secret = opts.secret === undefined ? SECRET : opts.secret
  if (secret !== null) headers['x-extraction-worker-secret'] = secret
  const url = `https://x.test/api/live-classroom/reap-decks${opts.dryRun ? '?dryRun=1' : ''}`
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return POST(new Request(url, { method: 'POST', headers }) as any)
}

beforeEach(() => {
  process.env.EXTRACTION_WORKER_SECRET = SECRET
  orphanPaths = []
  listFails = false
  removeFails = false
  removed = []
  rpcCalls = []
})

describe('reap-decks — refusing to delete is always the safe failure', () => {
  it('deletes NOTHING when the candidate query fails', async () => {
    /* The query is what protects live sessions. Treating a failed read as an
       empty result would delete every deck in the bucket, which is the worst
       possible outcome for a bulk-delete endpoint. */
    listFails = true
    const res = await post()
    expect(res.status).toBe(500)
    expect(removed).toEqual([])
  })

  it('reports a storage failure rather than claiming success', async () => {
    orphanPaths = ['gone-room/deck.pdf']
    removeFails = true
    const res = await post()
    expect(res.status).toBe(500)
  })

  it('deletes nothing, and calls storage not at all, when there is nothing to reap', async () => {
    orphanPaths = []
    const res = await post()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ deleted: 0 })
    expect(removed).toEqual([])
  })
})

describe('reap-decks — what it asks for and what it deletes', () => {
  it('passes the keep window and the batch cap to SQL', async () => {
    // The window and cap belong in one place; drifting them apart is how a
    // "1 hour" grace quietly becomes no grace at all.
    orphanPaths = ['a/deck.pdf']
    await post()
    expect(rpcCalls[0].name).toBe('lc_orphan_deck_paths')
    expect(rpcCalls[0].args).toMatchObject({ p_keep_after: '1 hour', p_limit: 500 })
  })

  it('deletes exactly the paths SQL returned, in one call', async () => {
    orphanPaths = ['dead-a/deck.pdf', 'dead-b/deck.pdf']
    const res = await post()
    expect(res.status).toBe(200)
    expect(removed).toEqual([['dead-a/deck.pdf', 'dead-b/deck.pdf']])
  })

  it('accepts the row-object shape too, since setof text can arrive either way', async () => {
    orphanPaths = [{ lc_orphan_deck_paths: 'dead/deck.pdf' }]
    await post()
    expect(removed).toEqual([['dead/deck.pdf']])
  })

  it('drops empty or malformed entries rather than passing them to remove()', async () => {
    orphanPaths = ['real/deck.pdf', '', null, undefined]
    await post()
    expect(removed).toEqual([['real/deck.pdf']])
  })

  it('dry run reports the plan and deletes nothing', async () => {
    orphanPaths = ['a/deck.pdf', 'b/deck.pdf']
    const res = await post({ dryRun: true })
    expect(await res.json()).toMatchObject({ ok: true, dryRun: true, wouldDelete: 2 })
    expect(removed).toEqual([])
  })
})

describe('reap-decks — auth', () => {
  it('rejects a request with no secret', async () => {
    orphanPaths = ['x/deck.pdf']
    const res = await post({ secret: null })
    expect(res.status).toBe(401)
    expect(removed).toEqual([])
  })

  it('rejects a wrong secret of the same length', async () => {
    // Same length keeps it past the length gate and into timingSafeEqual.
    orphanPaths = ['x/deck.pdf']
    const res = await post({ secret: 'x'.repeat(SECRET.length) })
    expect(res.status).toBe(401)
    expect(removed).toEqual([])
  })

  it('rejects everything when no secret is configured at all', async () => {
    delete process.env.EXTRACTION_WORKER_SECRET
    const res = await post({ secret: 'anything' })
    expect(res.status).toBe(401)
  })
})
