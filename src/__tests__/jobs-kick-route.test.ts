import { describe, it, expect, afterEach } from 'vitest'
import type { NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'

import { verifySecret, reapAbandonedJobs } from '@/app/api/jobs-worker/kick/route'

// The kick route drains the whole queue under the admin client, gated ONLY by
// verifySecret — so its branches matter. And reapAbandonedJobs' correctness is
// one JS filter that must never fail a slow-but-alive worker. Both are
// hand-written TS (not DB-level), so they're worth locking in here.

const HEADER = 'x-background-jobs-secret'

function fakeReq(headerVal: string | null): NextRequest {
  return {
    headers: { get: (h: string) => (h === HEADER ? headerVal : null) },
  } as unknown as NextRequest
}

describe('kick route — verifySecret', () => {
  const original = process.env.BACKGROUND_JOBS_SECRET
  afterEach(() => {
    if (original === undefined) delete process.env.BACKGROUND_JOBS_SECRET
    else process.env.BACKGROUND_JOBS_SECRET = original
  })

  it('fails closed when the env secret is unset', () => {
    delete process.env.BACKGROUND_JOBS_SECRET
    expect(verifySecret(fakeReq('anything'))).toBe(false)
  })

  it('rejects a request with no secret header', () => {
    process.env.BACKGROUND_JOBS_SECRET = 'super-secret-value'
    expect(verifySecret(fakeReq(null))).toBe(false)
  })

  it('rejects a length-mismatched secret (guards timingSafeEqual)', () => {
    process.env.BACKGROUND_JOBS_SECRET = 'super-secret-value'
    expect(verifySecret(fakeReq('short'))).toBe(false)
  })

  it('rejects a wrong secret of the same length', () => {
    process.env.BACKGROUND_JOBS_SECRET = 'super-secret-value'
    expect(verifySecret(fakeReq('wrong-secret-value'.padEnd('super-secret-value'.length, 'x').slice(0, 'super-secret-value'.length)))).toBe(false)
  })

  it('accepts the correct secret', () => {
    process.env.BACKGROUND_JOBS_SECRET = 'super-secret-value'
    expect(verifySecret(fakeReq('super-secret-value'))).toBe(true)
  })
})

describe('kick route — reapAbandonedJobs', () => {
  // Fake admin: select().eq().lt() → candidates; update().in() records the ids.
  function makeFakeAdmin(candidates: { id: string; attempts: number; max_attempts: number }[]) {
    const updated: { ids: string[] } = { ids: [] }
    const admin = {
      from: () => ({
        select: () => ({ eq: () => ({ lt: async () => ({ data: candidates, error: null }) }) }),
        update: () => ({
          in: async (_col: string, ids: string[]) => {
            updated.ids = ids
            return { error: null }
          },
        }),
      }),
    } as unknown as SupabaseClient
    return { admin, updated }
  }

  it('reaps only expired jobs that have exhausted their retries', async () => {
    const { admin, updated } = makeFakeAdmin([
      { id: 'exhausted-1', attempts: 3, max_attempts: 3 }, // reap
      { id: 'has-retries', attempts: 1, max_attempts: 3 }, // keep (slow-but-alive path)
      { id: 'exhausted-2', attempts: 4, max_attempts: 3 }, // reap
    ])
    const reaped = await reapAbandonedJobs(admin)

    expect(reaped).toBe(2)
    expect(updated.ids).toEqual(['exhausted-1', 'exhausted-2'])
  })

  it('reaps nothing (and does not update) when no expired job has exhausted retries', async () => {
    const { admin, updated } = makeFakeAdmin([{ id: 'has-retries', attempts: 1, max_attempts: 3 }])
    const reaped = await reapAbandonedJobs(admin)

    expect(reaped).toBe(0)
    expect(updated.ids).toEqual([])
  })
})
