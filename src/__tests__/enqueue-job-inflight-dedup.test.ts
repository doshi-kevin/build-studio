/**
 * #630 — asking for the same background job again WHILE the first is in flight
 * started a second concurrent job. An ABET alignment run maps every course
 * artifact through an LLM, so an accidental double-ask doubled the cost of the
 * most expensive operation in the product, silently.
 *
 * Dedup is enforced by a partial unique index, whose predicate was
 * `status = 'pending'`. The moment the worker claims a job it becomes 'running',
 * leaves the index, and the next insert conflicts with nothing. The migration
 * widens the predicate to pending OR running; this file pins the APPLICATION half:
 * on the resulting 23505 the lookup must find the RUNNING job and report
 * alreadyActive, rather than searching 'pending' only, finding nothing, and
 * throwing.
 *
 * The oracle is `alreadyActive: true` plus the id of the in-flight job. Asserting
 * "does not throw" would pass against a version that silently enqueued a second
 * job, which is the actual bug.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

const mockAdminClient = vi.fn()
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => mockAdminClient(),
}))

import { enqueueJob } from '@/lib/jobs/enqueue'

const INSTITUTION = '00000000-0000-0000-0000-000000000002'
const SECTION = 'ff3f7c25-9223-412a-a850-ea919e4a5f84'
const RUNNING_JOB_ID = 'c0ffee00-0000-4000-8000-000000000001'

interface Recorder {
  /** Status values the recovery lookup filtered on, via .eq or .in. */
  statusFilter: string[] | null
  insertAttempts: number
}

/**
 * Admin double whose insert always raises 23505 (the widened index rejecting a
 * second in-flight job) and whose lookup returns a job only when the query asked
 * for 'running' — mirroring a DB where the sole in-flight row is running, not
 * pending. That is what makes the old 'pending'-only lookup observably fail.
 */
function makeAdmin(): { admin: unknown; rec: Recorder } {
  const rec: Recorder = { statusFilter: null, insertAttempts: 0 }

  const lookup = () => {
    const chain: Record<string, unknown> = {}
    const self = () => chain
    Object.assign(chain, {
      select: self,
      eq: (col: string, val: string) => {
        if (col === 'status') rec.statusFilter = [val]
        return chain
      },
      in: (col: string, vals: string[]) => {
        if (col === 'status') rec.statusFilter = vals
        return chain
      },
      is: self,
      order: self,
      limit: self,
      maybeSingle: async () => {
        const asked = rec.statusFilter ?? []
        return asked.includes('running')
          ? { data: { id: RUNNING_JOB_ID }, error: null }
          : { data: null, error: null }
      },
    })
    return chain
  }

  const admin = {
    from(table: string) {
      if (table !== 'background_jobs') throw new Error(`unexpected table ${table}`)
      return {
        insert: () => ({
          select: () => ({
            single: async () => {
              rec.insertAttempts++
              return { data: null, error: { code: '23505', message: 'duplicate key value' } }
            },
          }),
        }),
        ...lookup(),
      }
    },
  }
  return { admin, rec }
}

describe('enqueueJob — in-flight dedup (#630)', () => {
  beforeEach(() => {
    mockAdminClient.mockReset()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }))
    process.env.BACKGROUND_JOBS_SECRET = 'test-secret'
  })

  it('reports the RUNNING job as already active instead of starting a second one', async () => {
    const { admin, rec } = makeAdmin()
    mockAdminClient.mockReturnValue(admin)

    const result = await enqueueJob({
      type: 'outcome_alignment',
      params: { standardId: 'std-1' },
      institutionId: INSTITUTION,
      sectionId: SECTION,
      createdBy: 'prof-1',
    })

    expect(result.alreadyActive).toBe(true)
    expect(result.jobId).toBe(RUNNING_JOB_ID)
    // The lookup must consider 'running', not 'pending' alone — the whole defect.
    expect(rec.statusFilter).toEqual(['pending', 'running'])
    // Exactly one insert was attempted, and it was rejected by the index.
    expect(rec.insertAttempts).toBe(1)
  })
})
