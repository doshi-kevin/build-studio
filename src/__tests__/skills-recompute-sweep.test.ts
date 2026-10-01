// POST /api/skills/recompute-sweep — which sections the nightly backstop visits.
//
// The sweep used to list sections from `skills`, which meant it could never
// bootstrap one: skills are created by reconcileSectionSkills, which only runs
// inside the recompute the sweep enqueues, which only ran for sections that
// already had skills. Sections whose content predates concept seeding were stuck
// empty permanently. It now lists sections with any evidence instead.
//
// The first test is the regression: a section with evidence and zero skills must
// be swept. It fails against the old `skills`-only query.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

const enqueueMany = vi.fn(async (ids: string[]) => ({ enqueued: ids.length }))
vi.mock('@/lib/extraction/enqueue', () => ({
  enqueueMasteryRecomputeMany: (ids: string[]) => enqueueMany(ids),
}))

/* What sections_with_mastery_evidence() returns. The union itself is Postgres's
   job and is asserted against the real database in the migration verification,
   not re-implemented here — mocking the four tables would only test a JS union
   the route no longer contains. */
let evidenceRows: Array<{ section_id: string }> = []
let rpcFails = false
const rpcCalls: string[] = []

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    rpc: async (name: string) => {
      rpcCalls.push(name)
      if (rpcFails) return { data: null, error: { message: 'boom' } }
      return { data: evidenceRows, error: null }
    },
  }),
}))

import { POST } from '@/app/api/skills/recompute-sweep/route'

const SECRET = 'test-secret'

function post(): Request {
  return new Request('https://example.test/api/skills/recompute-sweep', {
    method: 'POST',
    headers: { 'x-extraction-worker-secret': SECRET, 'content-type': 'application/json' },
    body: '{}',
  })
}

/** Runs the sweep and returns [status, enqueued ids sorted]. Both come back so a
 *  non-200 fails in the test body, not inside a helper named for its ids. */
async function sweep(): Promise<[number, string[]]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await POST(post() as any)
  return [res.status, [...(enqueueMany.mock.calls.at(-1)?.[0] ?? [])].sort()]
}

beforeEach(() => {
  process.env.EXTRACTION_WORKER_SECRET = SECRET
  enqueueMany.mockClear()
  evidenceRows = []
  rpcFails = false
  rpcCalls.length = 0
})

describe('recompute-sweep section selection', () => {
  it('asks for sections by evidence, not by whether they already have skills', async () => {
    /* The regression. The old route listed `select section_id from skills`, so a
       section with content and no skills was invisible to the sweep forever —
       and skills are only created inside the recompute the sweep enqueues. */
    evidenceRows = [{ section_id: 'sec-stuck' }]
    expect(await sweep()).toEqual([200, ['sec-stuck']])
    expect(rpcCalls).toEqual(['sections_with_mastery_evidence'])
  })

  it('enqueues every section the evidence query returns, once each', async () => {
    evidenceRows = [{ section_id: 'sec-a' }, { section_id: 'sec-b' }, { section_id: 'sec-c' }]
    expect(await sweep()).toEqual([200, ['sec-a', 'sec-b', 'sec-c']])
  })

  it('enqueues nothing when there is no evidence anywhere', async () => {
    expect(await sweep()).toEqual([200, []])
  })

  it('fails loudly when the evidence query errors, rather than sweeping a short list', async () => {
    /* The whole job of this endpoint is coverage. A failed read must not produce
       a smaller section set, a 200, and a green cron run — that is sections
       silently dropping out of coverage, which is the bug this route was fixed
       for. Enqueue nothing and return 500. */
    rpcFails = true

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(post() as any)
    expect(res.status).toBe(500)
    expect(enqueueMany).not.toHaveBeenCalled()
  })

  it('rejects a request without the shared secret', async () => {
    const res = await POST(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new Request('https://example.test/api/skills/recompute-sweep', { method: 'POST' }) as any,
    )
    expect(res.status).toBe(401)
    expect(enqueueMany).not.toHaveBeenCalled()
  })

  it('rejects a wrong secret of the same length', async () => {
    /* The no-header case above returns 401 before the comparison runs, so it
       would pass even if the comparison were replaced with something trivial.
       Same length keeps it past the length guard and into timingSafeEqual. */
    const wrong = 'x'.repeat(SECRET.length)
    expect(wrong).toHaveLength(SECRET.length)
    const res = await POST(
      new Request('https://example.test/api/skills/recompute-sweep', {
        method: 'POST',
        headers: { 'x-extraction-worker-secret': wrong },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
    )
    expect(res.status).toBe(401)
    expect(enqueueMany).not.toHaveBeenCalled()
  })
})
