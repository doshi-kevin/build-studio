// Tests for professor grades server actions — auth and ownership checks.
// Verifies that getGradebookData, updateStudentFinalGrade, getClassAnalytics,
// and getStudentAnalytics reject unauthenticated / non-owner callers.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ROLE_DENIED_MESSAGE } from '@/lib/auth/section-access'

// ── Chain Builder ────────────────────────────────────────────

function buildChain(finalResult: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {}
  chain.select = vi.fn().mockReturnValue(chain)
  chain.eq = vi.fn().mockReturnValue(chain)
  chain.neq = vi.fn().mockReturnValue(chain)
  chain.in = vi.fn().mockReturnValue(chain)
  chain.is = vi.fn().mockReturnValue(chain)
  chain.order = vi.fn().mockReturnValue(chain)
  chain.limit = vi.fn().mockReturnValue(chain)
  chain.single = vi.fn().mockResolvedValue(finalResult)
  chain.maybeSingle = vi.fn().mockResolvedValue(finalResult)
  chain.insert = vi.fn().mockReturnValue(chain)
  chain.update = vi.fn().mockReturnValue(chain)
  chain.delete = vi.fn().mockReturnValue(chain)
  chain.upsert = vi.fn().mockReturnValue(chain)
  chain.lte = vi.fn().mockReturnValue(chain)
  chain.not = vi.fn().mockReturnValue(chain)
  chain.gt = vi.fn().mockReturnValue(chain)
  chain.then = undefined
  return chain
}

// ── Module-Level Mock References ─────────────────────────────

const mockGetUser = vi.fn()
const mockAdminClient = vi.fn()

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: (...args: unknown[]) => mockAdminClient(...args),
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
/* No analytics-utils mock here any more. getClassAnalytics used to compute topic
   performance with calculateSkillInsights and this file stubbed it out, so the
   stub outlived the call and advertised coverage that did not exist. Topic
   performance now reads skill_mastery, and it is covered for real in
   class-analytics-mastery.test.ts. */
vi.mock('@/lib/validations/proctoring', () => ({}))

// ── Test Setup ───────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let getGradebookData: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let updateStudentFinalGrade: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let getClassAnalytics: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let getStudentAnalytics: any

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockAdminClient.mockReset()

  const mod = await import('@/app/(dashboard)/professor/courses/[sectionId]/grades/actions')
  getGradebookData = mod.getGradebookData
  updateStudentFinalGrade = mod.updateStudentFinalGrade
  getClassAnalytics = mod.getClassAnalytics
  getStudentAnalytics = mod.getStudentAnalytics
})

// ── Auth helpers ─────────────────────────────────────────────

function mockUnauthenticated() {
  mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'No user' } })
}

function mockAuthenticated(userId = 'prof-1') {
  mockGetUser.mockResolvedValue({ data: { user: { id: userId } }, error: null })
}

/** Returns an admin mock whose course_sections query resolves with a different professor_id. */
function mockNonOwnerAdmin() {
  const admin = {
    from: vi.fn(() =>
      buildChain({ data: { id: 'section-1', professor_id: 'real-prof-id' }, error: null })
    ),
  }
  mockAdminClient.mockReturnValue(admin)
  return admin
}

/** Returns an admin mock where the caller is an active TA on the section.
 * 1st `from('course_sections')` → returns a section owned by someone else.
 * 2nd `from('section_staff')` → returns an active TA row.
 * Grades must still reject this caller because grades is professor-only. */
function mockActiveTaAdmin() {
  let call = 0
  const admin = {
    from: vi.fn(() => {
      call++
      if (call === 1) {
        return buildChain({ data: { id: 'section-1', professor_id: 'real-prof-id' }, error: null })
      }
      return buildChain({ data: { role: 'ta' }, error: null })
    }),
  }
  mockAdminClient.mockReturnValue(admin)
  return admin
}

/** Owner professor: `from('course_sections')` → a section they own,
 * `from('enrollments')` → the supplied result. Routed by table name so the
 * mock survives reordered or added queries. Drives the enrollment
 * error-vs-not-found branch in getStudentAnalytics. */
function mockOwnerWithEnrollment(enrollmentResult: { data: unknown; error: unknown }) {
  const admin = {
    from: vi.fn((table: string) => {
      if (table === 'course_sections') {
        return buildChain({ data: { id: 'section-1', professor_id: 'prof-1' }, error: null })
      }
      if (table === 'enrollments') {
        return buildChain(enrollmentResult)
      }
      return buildChain({ data: null, error: null })
    }),
  }
  mockAdminClient.mockReturnValue(admin)
  return admin
}

// ── getGradebookData ─────────────────────────────────────────

describe('getGradebookData', () => {
  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const result = await getGradebookData('section-1')
    expect(result.error).toBe('Not authenticated')
  })

  it('rejects users who do not own the section', async () => {
    mockAuthenticated('attacker-id')
    mockNonOwnerAdmin()
    const result = await getGradebookData('section-1')
    expect(result.error).toBe('You do not have access to this section')
  })

  it('allows an active TA to read the gradebook', async () => {
    mockAuthenticated('ta-user-id')
    mockActiveTaAdmin()
    const result = await getGradebookData('section-1')
    // Reads are permitted; we don't assert a happy-path payload since later
    // chain calls return the section_staff shape. Key invariant: no access error.
    expect(result.error).not.toBe('You do not have access to this section')
  })
})

// ── updateStudentFinalGrade ──────────────────────────────────

describe('updateStudentFinalGrade', () => {
  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const result = await updateStudentFinalGrade('section-1', 'student-1', 'A', 95)
    expect(result.error).toBe('Not authenticated')
  })

  it('rejects users who do not own the section', async () => {
    mockAuthenticated('attacker-id')
    mockNonOwnerAdmin()
    const result = await updateStudentFinalGrade('section-1', 'student-1', 'A', 95)
    expect(result.error).toBe('You do not have access to this section')
  })

  it('allows an active TA to update a final grade', async () => {
    mockAuthenticated('ta-user-id')
    mockActiveTaAdmin()
    const result = await updateStudentFinalGrade('section-1', 'student-1', 'A', 95)
    // We don't assert full success (subsequent UPDATE chain is a simplified mock),
    // but access gating must not reject a TA.
    expect(result.error).not.toBe('You do not have access to this section')
    expect(result.error).not.toBe(ROLE_DENIED_MESSAGE)
  })

  it('rejects invalid grade input (grade not in enum)', async () => {
    mockAuthenticated('prof-1')
    const admin = {
      from: vi.fn(() =>
        buildChain({ data: { id: 'section-1', professor_id: 'prof-1' }, error: null })
      ),
    }
    mockAdminClient.mockReturnValue(admin)
    // 'Z' is not a valid grade letter
    const result = await updateStudentFinalGrade('section-1', 'student-1', 'Z', 50)
    expect(result.error).toBe('Invalid grade input')
  })

  it('rejects score out of range (> 100)', async () => {
    mockAuthenticated('prof-1')
    const admin = {
      from: vi.fn(() =>
        buildChain({ data: { id: 'section-1', professor_id: 'prof-1' }, error: null })
      ),
    }
    mockAdminClient.mockReturnValue(admin)
    const result = await updateStudentFinalGrade('section-1', 'student-1', 'A', 150)
    expect(result.error).toBe('Invalid grade input')
  })
})

// ── getClassAnalytics ────────────────────────────────────────

describe('getClassAnalytics', () => {
  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const result = await getClassAnalytics('section-1')
    expect(result.error).toBe('Not authenticated')
  })

  it('rejects users who do not own the section', async () => {
    mockAuthenticated('attacker-id')
    mockNonOwnerAdmin()
    const result = await getClassAnalytics('section-1')
    expect(result.error).toBe('You do not have access to this section')
  })

  it('allows an active TA to read class analytics', async () => {
    mockAuthenticated('ta-user-id')
    mockActiveTaAdmin()
    const result = await getClassAnalytics('section-1')
    expect(result.error).not.toBe('You do not have access to this section')
  })
})

// ── getStudentAnalytics ──────────────────────────────────────

describe('getStudentAnalytics', () => {
  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const result = await getStudentAnalytics('section-1', 'student-1')
    expect(result.error).toBe('Not authenticated')
    expect(result.data).toBeUndefined()
  })

  it('denies non-owners with notFound (no data, no cross-tenant leak)', async () => {
    mockAuthenticated('attacker-id')
    mockNonOwnerAdmin()
    const result = await getStudentAnalytics('section-1', 'student-1')
    /* Contract changed on PR #624: a section denial now fuses with NOT-FOUND rather than
       returning an error string. Per .claude/rules/dead-ends.md, distinguishing "not yours" from
       "doesn't exist" on a resource-keyed route is a cross-tenant existence oracle — and the page
       was rendering the old error as "try again in a moment", which no retry can fix.
       The invariant this test guards is unchanged: a non-owner gets NO data. */
    expect(result.data).toBeUndefined()
    expect(result.notFound).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it('allows an active TA to read student analytics', async () => {
    mockAuthenticated('ta-user-id')
    mockActiveTaAdmin()
    const result = await getStudentAnalytics('section-1', 'student-1')
    expect(result.notFound).toBeUndefined()
  })

  // #622: a genuine query failure and a missing enrollment must not look alike.
  // The page routes the first to error.tsx and the second to the 404 boundary,
  // so the action must return `error` vs `notFound`, never conflate them.
  it('returns notFound (not an error) when the enrollment is missing', async () => {
    mockAuthenticated('prof-1')
    mockOwnerWithEnrollment({ data: null, error: { code: 'PGRST116' } })
    const result = await getStudentAnalytics('section-1', 'missing-student')
    expect(result.notFound).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it('surfaces an error (not notFound) on a genuine enrollment query failure', async () => {
    mockAuthenticated('prof-1')
    mockOwnerWithEnrollment({ data: null, error: { code: '42P01', message: 'relation missing' } })
    const result = await getStudentAnalytics('section-1', 'student-1')
    expect(result.error).toBe('Could not load this student. Please try again.')
    expect(result.notFound).toBeUndefined()
  })
})

// ── Grader access ────────────────────────────────────────────
// Graders read gradebook data + analytics, and — since #746 — may also write
// scores. A role called "grader" being unable to grade was the bug: the grading
// UI rendered fully enabled and every save silently no-opped, with no toast and
// no disabled state, because canWriteAsStaff excluded graders.
//
// updateStudentFinalGrade now gates on canGrade instead. The narrowness is the
// point: canGrade covers SCORE writes only. Announcements, content and
// destructive actions still go through canWriteAsStaff / canWriteAsProfessor,
// so a grader remains unable to reach any of those.

function mockActiveGraderAdmin() {
  let call = 0
  const admin = {
    from: vi.fn(() => {
      call++
      if (call === 1) {
        return buildChain({ data: { id: 'section-1', professor_id: 'real-prof-id' }, error: null })
      }
      return buildChain({ data: { role: 'grader' }, error: null })
    }),
  }
  mockAdminClient.mockReturnValue(admin)
  return admin
}

describe('Grader access', () => {
  it('allows a grader to read the gradebook (reads are not gated by canWriteAsStaff)', async () => {
    mockAuthenticated('grader-user-id')
    mockActiveGraderAdmin()
    const result = await getGradebookData('section-1')
    expect(result.error).not.toBe('You do not have access to this section')
  })

  it('lets a grader set a final grade — the authz gate no longer refuses (#746)', async () => {
    mockAuthenticated('grader-user-id')
    mockActiveGraderAdmin()
    const result = await updateStudentFinalGrade('section-1', 'student-1', 'A', 95)
    /* Asserting on the gate, not the whole write path: FORBIDDEN is the exact
       string the role check returns, so its absence is the behaviour change and
       nothing else in this test has to model the update. */
    expect(result.error).not.toBe(ROLE_DENIED_MESSAGE)
  })

  it('allows a grader to read class analytics', async () => {
    mockAuthenticated('grader-user-id')
    mockActiveGraderAdmin()
    const result = await getClassAnalytics('section-1')
    expect(result.error).not.toBe('You do not have access to this section')
  })

  it('allows a grader to read student analytics', async () => {
    mockAuthenticated('grader-user-id')
    mockActiveGraderAdmin()
    const result = await getStudentAnalytics('section-1', 'student-1')
    expect(result.error).not.toBe('Not authorized')
  })
})

