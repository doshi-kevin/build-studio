/**
 * Cascade counts for the challenge and badge delete confirmations (#702).
 *
 * Both deletes used to fire on ONE click with no confirmation at all. `challenge_claims`
 * cascades on `challenge_id`, so deleting a scored challenge removed students' earned
 * points, and deleting a badge stripped the credential from everyone holding it. Neither
 * could be undone through the product: `reviewClaim` only accepts claims in `submitted`
 * state, so nothing destroyed here can be re-granted.
 *
 * The property under test is the one that made #715 critical on the admin side: a FAILED
 * count must return null, never zeros. The dialog renders zeros as "no student has claimed
 * this yet", so zeros-on-failure actively reassures a professor immediately before an
 * unrecoverable delete. Fail toward "I don't know".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetAuthUser = vi.fn()
const mockVerifyOwnership = vi.fn()

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
vi.mock('@/lib/events/emit', () => ({ emitEvent: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: mockGetAuthUser } }),
}))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => mockVerifyOwnership() }))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let getChallengeCascadeCounts: any, getBadgeCascadeCounts: any

const SECTION = '8a2ac745-bbd2-4848-a4b6-aeac1e69bb4b'

/**
 * Fake admin client. `plan` maps a table name to the response its query resolves with, so
 * a test can make exactly one read fail.
 */
function fakeDb(plan: Record<string, { data?: unknown; count?: number | null; error?: unknown }>) {
  const build = (table: string) => {
    const res = plan[table] ?? { data: [], count: 0, error: null }
    const settle = () =>
      Promise.resolve({ data: res.data ?? [], count: res.count ?? null, error: res.error ?? null })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      /* Both are needed: verifyOwnership uses .single() for the section lookup while the
         count actions use .maybeSingle(). Omitting .single() made every call throw into the
         catch and return null — which is exactly the value the fail-closed tests assert, so
         all five passed while proving nothing. */
      single: () => Promise.resolve({ data: res.data ?? null, error: res.error ?? null }),
      maybeSingle: () => Promise.resolve({ data: res.data ?? null, error: res.error ?? null }),
      then: (f: (v: unknown) => unknown) => settle().then(f),
    }
    return chain
  }
  // The section-ownership lookup runs through the same client.
  return { from: (t: string) => build(t) }
}

beforeEach(async () => {
  vi.resetModules()
  mockGetAuthUser.mockResolvedValue({ data: { user: { id: 'prof-1' } }, error: null })
  const mod = await import('@/app/(dashboard)/professor/courses/[sectionId]/challenges/actions')
  getChallengeCascadeCounts = mod.getChallengeCascadeCounts
  getBadgeCascadeCounts = mod.getBadgeCascadeCounts
})

describe('getChallengeCascadeCounts (#702)', () => {
  it('reports the points a delete would destroy', async () => {
    mockVerifyOwnership.mockReturnValue(
      fakeDb({
        course_sections: { data: { id: SECTION, professor_id: 'prof-1' } },
        enrollments: { data: null },
        challenges: { data: { points: 10, bonus_points: 5 } },
        challenge_claims: {
          data: [{ status: 'approved' }, { status: 'approved' }, { status: 'submitted' }],
        },
      }),
    )

    const res = await getChallengeCascadeCounts('ch-1', SECTION)

    /* Only APPROVED claims carry awarded points; a submitted-but-unscored claim loses
       nothing, and telling a professor otherwise would make them keep a challenge they
       could safely delete. */
    expect(res).toEqual({ claims: 3, approved: 2, points: 30 })
  })

  it('returns null when the claims read fails, never a reassuring zero', async () => {
    mockVerifyOwnership.mockReturnValue(
      fakeDb({
        course_sections: { data: { id: SECTION, professor_id: 'prof-1' } },
        challenges: { data: { points: 10, bonus_points: 0 } },
        challenge_claims: { data: null, error: { message: 'timeout' } },
      }),
    )

    expect(await getChallengeCascadeCounts('ch-1', SECTION)).toBeNull()
  })

  it('returns null when the caller is not signed in', async () => {
    mockGetAuthUser.mockResolvedValue({ data: { user: null }, error: null })
    mockVerifyOwnership.mockReturnValue(fakeDb({}))

    expect(await getChallengeCascadeCounts('ch-1', SECTION)).toBeNull()
  })
})

describe('getBadgeCascadeCounts (#702)', () => {
  it('returns null when the holder count fails', async () => {
    mockVerifyOwnership.mockReturnValue(
      fakeDb({
        course_sections: { data: { id: SECTION, professor_id: 'prof-1' } },
        user_badges: { count: null, error: { message: 'denied' } },
      }),
    )

    expect(await getBadgeCascadeCounts('badge-1', SECTION)).toBeNull()
  })

  it('returns null when the caller is not signed in', async () => {
    mockGetAuthUser.mockResolvedValue({ data: { user: null }, error: null })
    mockVerifyOwnership.mockReturnValue(fakeDb({}))

    expect(await getBadgeCascadeCounts('badge-1', SECTION)).toBeNull()
  })
})
