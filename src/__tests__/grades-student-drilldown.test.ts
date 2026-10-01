/**
 * #622 — the per-student drill-down denied correctly (no data leaked) but rendered a bare
 * EmptyState with no exit, and used the SAME branch for "not your student" as for "the query
 * failed". Per .claude/rules/dead-ends.md those are different claims: a 404 asserts the thing
 * doesn't exist, a failed fetch means we don't know.
 *
 * The oracle is which OUTCOME the action reports, since that is what picks the page's branch.
 * A test that only checked "no data returned" would pass against the bug — the old code also
 * returned no data.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetUser = vi.fn()
const mockVerifySectionAccess = vi.fn()

vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }))
// getAuthUser is LOCAL to the actions file and goes through createClient — mocking a
// non-existent '@/lib/auth/get-auth-user' silently made every case fail on auth instead,
// so two of these tests passed for the wrong reason before this was corrected.
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: () => mockGetUser() } }),
}))
vi.mock('@/lib/auth/section-access', () => ({
  verifySectionAccess: (...a: unknown[]) => mockVerifySectionAccess(...a),
  canWriteAsStaff: () => true,
  canGrade: () => true,
}))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

/** adminDb whose enrollments lookup resolves to the given { data, error }. */
function adminWith(enrollment: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'order', 'gte', 'lte', 'not', 'is']) chain[m] = () => chain
  chain.single = async () => enrollment
  chain.maybeSingle = async () => enrollment
  chain.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r)
  return { from: () => chain, rpc: async () => ({ data: null, error: null }) }
}

async function load() {
  return import('@/app/(dashboard)/professor/courses/[sectionId]/grades/actions')
}

describe('getStudentAnalytics — denial vs failure', () => {
  beforeEach(() => {
    vi.resetModules()
    mockGetUser.mockReset().mockResolvedValue({ data: { user: { id: 'prof-1' } }, error: null })
    mockVerifySectionAccess.mockReset()
  })

  it('reports notFound for a student who is not in this section', async () => {
    // PGRST116 is .single()'s "no rows" — the genuine not-found
    mockVerifySectionAccess.mockResolvedValue({
      ok: true, adminDb: adminWith({ data: null, error: { code: 'PGRST116', message: 'no rows' } }),
    })
    const mod = await load()
    const res = await mod.getStudentAnalytics('sec-1', 'other-section-student')

    expect(res.notFound).toBe(true)
    // must NOT claim a failure — the page turns this into notFound()
    expect(res.error).toBeUndefined()
  })

  it('reports an error — NOT notFound — when the lookup itself breaks', async () => {
    mockVerifySectionAccess.mockResolvedValue({
      ok: true, adminDb: adminWith({ data: null, error: { code: '57014', message: 'statement timeout' } }),
    })
    const mod = await load()
    const res = await mod.getStudentAnalytics('sec-1', 'stu-1')

    /* The old code collapsed this into "Student not found in this section", telling the
       professor something false about their own roster. */
    expect(res.notFound).toBeUndefined()
    expect(res.error).toBeTruthy()
    expect(res.error).not.toMatch(/not found/i)
  })

  it('denies a section the professor cannot access as NOT-FOUND, not as a retryable error', async () => {
    mockVerifySectionAccess.mockResolvedValue({ ok: false })
    const mod = await load()
    const res = await mod.getStudentAnalytics('someone-elses-section', 'stu-1')

    expect(res.data).toBeUndefined()
    /* Fused with not-found on purpose: per dead-ends.md, distinguishing "not yours" from
       "doesn't exist" on a resource-keyed route is a cross-tenant existence oracle. And it must
       NOT come back as an error, or the page tells the professor to retry something no retry
       can fix. */
    expect(res.notFound).toBe(true)
    expect(res.error).toBeUndefined()
  })
})
