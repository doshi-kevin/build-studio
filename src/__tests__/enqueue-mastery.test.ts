// Tests for the mastery-recompute enqueue coalescing
// (src/lib/extraction/enqueue.ts).
//
// The behaviours worth pinning are the queue-discipline ones a future change
// could silently break:
//   - enqueueMasteryRecompute supersedes pending recomputes for the SAME section
//     (coalesce a grade burst) BEFORE inserting a fresh pending job,
//   - it NEVER throws — a failed recompute enqueue must not break the grade write,
//   - enqueueMasteryRecomputeMany de-dups section ids and fires a single kick,
//     short-circuiting on an empty list.
//
// createAdminClient + fetch are mocked; we record the supersede update filters
// and the inserted job rows to assert the coalesce + tenant shape.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

const mockAdminClient = vi.fn()
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => mockAdminClient(),
}))

import { enqueueMasteryRecompute, enqueueMasteryRecomputeMany } from '@/lib/extraction/enqueue'

interface Recorder {
  supersedeFilters: Record<string, unknown>[]
  inserted: Array<Record<string, unknown>>
  insertCalls: number
}

/** Admin double recording supersede-update .eq() filters and inserted rows. */
function makeAdmin(opts: { insertError?: boolean } = {}): { admin: unknown; rec: Recorder } {
  const rec: Recorder = { supersedeFilters: [], inserted: [], insertCalls: 0 }
  const admin = {
    from(table: string) {
      /* enqueue now resolves the section's institution so the job row carries
         institution_id (migration 20260807153351 — it lets /admin/extraction-jobs be
         scoped in SQL instead of filtering in app code). Single lookup for one section,
         batched .in() for the Many variant. */
      if (table === 'course_sections') {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: { institution_id: 'inst-1' }, error: null }) }),
            in: async (_col: string, ids: string[]) => ({
              data: ids.map((id) => ({ id, institution_id: 'inst-1' })),
              error: null,
            }),
          }),
        }
      }
      return {
        // supersede path: update(...).eq().eq().eq()
        update() {
          const filter: Record<string, unknown> = {}
          const chain = {
            eq(col: string, val: unknown) {
              filter[col] = val
              return chain
            },
            then(resolve: (v: unknown) => unknown) {
              rec.supersedeFilters.push(filter)
              return resolve({ data: null, error: null })
            },
          }
          return chain
        },
        // insert path: insert(rows).select('id').single()  OR  await insert(rows)
        insert(rows: Record<string, unknown> | Array<Record<string, unknown>>) {
          rec.insertCalls += 1
          if (Array.isArray(rows)) rec.inserted.push(...rows)
          else rec.inserted.push(rows)
          const result = opts.insertError
            ? { data: null, error: { message: 'insert boom' } }
            : { data: { id: 'job-new' }, error: null }
          return {
            select: () => ({ single: async () => result }),
            then: (resolve: (v: unknown) => unknown) => resolve(result),
          }
        },
      }
    },
  }
  return { admin, rec }
}

beforeEach(() => {
  mockAdminClient.mockReset()
  process.env.EXTRACTION_WORKER_SECRET = 'test-secret'
  // kickWorker fetches the /kick route — keep it a no-op success.
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 202 })))
})

describe('enqueueMasteryRecompute', () => {
  it('supersedes pending recomputes for the section before inserting a fresh job', async () => {
    const { admin, rec } = makeAdmin()
    mockAdminClient.mockReturnValue(admin)

    await enqueueMasteryRecompute('sec-1')

    // One supersede filtered to kind + pending + this section.
    expect(rec.supersedeFilters).toHaveLength(1)
    expect(rec.supersedeFilters[0]).toMatchObject({
      kind: 'recompute-mastery',
      status: 'pending',
      'payload->>sectionId': 'sec-1',
    })
    // Then one fresh pending job for that section.
    expect(rec.insertCalls).toBe(1)
    expect(rec.inserted[0]).toMatchObject({
      kind: 'recompute-mastery',
      status: 'pending',
      payload: { sectionId: 'sec-1' },
    })
  })

  it('no-ops on an empty sectionId (never touches the admin client)', async () => {
    await enqueueMasteryRecompute('')
    expect(mockAdminClient).not.toHaveBeenCalled()
  })

  it('never throws even if the insert fails (grade write must not break)', async () => {
    const { admin, rec } = makeAdmin({ insertError: true })
    mockAdminClient.mockReturnValue(admin)
    await expect(enqueueMasteryRecompute('sec-1')).resolves.toBeUndefined()
    expect(rec.insertCalls).toBe(1)
  })

  it('never throws even if the admin client itself blows up', async () => {
    mockAdminClient.mockImplementation(() => {
      throw new Error('no admin')
    })
    await expect(enqueueMasteryRecompute('sec-1')).resolves.toBeUndefined()
  })
})

describe('enqueueMasteryRecomputeMany', () => {
  it('de-dups section ids and inserts one job each', async () => {
    const { admin, rec } = makeAdmin()
    mockAdminClient.mockReturnValue(admin)

    const res = await enqueueMasteryRecomputeMany(['a', 'b', 'a', '', 'b'])
    expect(res).toEqual({ enqueued: 2 })
    expect(rec.inserted.map((r) => (r.payload as { sectionId: string }).sectionId).sort()).toEqual(['a', 'b'])
    expect(rec.inserted.every((r) => r.kind === 'recompute-mastery' && r.status === 'pending')).toBe(true)
  })

  it('short-circuits on an empty list without touching the admin client', async () => {
    const res = await enqueueMasteryRecomputeMany(['', ''])
    expect(res).toEqual({ enqueued: 0 })
    expect(mockAdminClient).not.toHaveBeenCalled()
  })

  it('returns enqueued:0 (no throw) when the batch insert fails', async () => {
    const { admin } = makeAdmin({ insertError: true })
    mockAdminClient.mockReturnValue(admin)
    const res = await enqueueMasteryRecomputeMany(['a'])
    expect(res).toEqual({ enqueued: 0 })
  })
})
