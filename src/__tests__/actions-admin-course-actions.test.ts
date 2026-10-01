// Tenant-isolation tests for admin course server actions (security review Vulns 6/7/8).
// These exercise the REAL assertTenantOwns helper against a faked admin client to
// prove that updateCourse / deleteCourse / getCourseCascadeCounts reject a course
// ID belonging to another institution before touching the DB.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DEFAULT_COURSE_CREDITS } from '@/lib/validations/course'

const mockVerifyAdmin = vi.fn()
const mockCreate = vi.fn()
const mockUpdate = vi.fn()
const mockRemove = vi.fn()
const mockGetByCode = vi.fn()
const mockGetCascadeCounts = vi.fn()

const DEPT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const DEPT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

// table -> row id -> institution_id, consumed by the real assertTenantOwns chain.
let tenantData: Record<string, Record<string, string>> = {}

function makeAdminDb() {
  return {
    from: (table: string) => ({
      select: () => ({
        eq: (_col: string, id: string) => ({
          maybeSingle: async () => {
            const inst = tenantData[table]?.[id]
            return inst ? { data: { institution_id: inst }, error: null } : { data: null, error: null }
          },
        }),
      }),
    }),
  }
}

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: vi.fn() } })),
}))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => makeAdminDb() }))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
vi.mock('@/lib/auth/admin-context', () => ({
  verifyInstitutionAdmin: (...a: unknown[]) => mockVerifyAdmin(...a),
}))
vi.mock('@/lib/supabase/queries', () => ({
  courseAdminQueries: {
    create: (...a: unknown[]) => mockCreate(...a),
    update: (...a: unknown[]) => mockUpdate(...a),
    remove: (...a: unknown[]) => mockRemove(...a),
    getByCode: (...a: unknown[]) => mockGetByCode(...a),
    getCascadeCounts: (...a: unknown[]) => mockGetCascadeCounts(...a),
  },
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createCourse: any, updateCourse: any, deleteCourse: any, getCourseCascadeCounts: any

beforeEach(async () => {
  vi.resetModules()
  mockVerifyAdmin.mockReset().mockResolvedValue({ userId: 'admin-A', institutionId: 'inst-A' })
  mockCreate.mockReset().mockResolvedValue({ id: 'course-new', code: 'CS-9' })
  /* courseAdminQueries.update returns a discriminated result now, so a stale write
     can be told apart from a failed one (#724, see .claude/rules/data-access.md). */
  mockUpdate.mockReset().mockResolvedValue({ ok: true, data: { id: 'course-A', code: 'CS-1' } })
  mockRemove.mockReset().mockResolvedValue(true)
  mockGetByCode.mockReset().mockResolvedValue(null)
  mockGetCascadeCounts.mockReset().mockResolvedValue({ sections: 3 })
  tenantData = {
    courses: { 'course-A': 'inst-A', 'course-B': 'inst-B' },
    departments: { [DEPT_A]: 'inst-A', [DEPT_B]: 'inst-B' },
  }

  const mod = await import('@/app/(dashboard)/admin/departments/course-actions')
  createCourse = mod.createCourse
  updateCourse = mod.updateCourse
  deleteCourse = mod.deleteCourse
  getCourseCascadeCounts = mod.getCourseCascadeCounts
})

describe('createCourse — tenant isolation', () => {
  it('rejects creating a course under another tenant department and never inserts', async () => {
    const res = await createCourse({ department_id: DEPT_B, code: 'CS-9', title: 'New Course', status: 'active' })
    expect(res).toEqual({ error: 'Not found' })
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('allows creating a course under a department in the caller institution', async () => {
    const res = await createCourse({ department_id: DEPT_A, code: 'CS-9', title: 'New Course', status: 'active' })
    expect(res.success).toBe(true)
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })

  it('defaults credits to 3 when the field is left blank (#138)', async () => {
    await createCourse({ department_id: DEPT_A, code: 'CS-9', title: 'New Course', status: 'active' })
    expect(mockCreate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ credits: 3 }))
  })

  it('preserves an explicit credits value rather than overwriting it with the default', async () => {
    await createCourse({ department_id: DEPT_A, code: 'CS-9', title: 'New Course', status: 'active', credits: 4 })
    expect(mockCreate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ credits: 4 }))
  })

  it('preserves an explicit 0 credits (guards ?? against a || regression)', async () => {
    // credits is valid at 0 (schema min is 0). `credits ?? 3` keeps 0; a
    // regression to `credits || 3` would silently turn 0 into 3.
    await createCourse({ department_id: DEPT_A, code: 'CS-9', title: 'New Course', status: 'active', credits: 0 })
    expect(mockCreate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ credits: 0 }))
  })
})

// Issue #138: the Credits field advertises "3" as a placeholder, but an omitted
// value used to insert NULL — the course then rendered its credits as "—". The
// fallback lives in the action (not just the form's default) so every caller that
// omits credits gets the advertised value, while an explicit 0 survives.
describe('createCourse — credits default', () => {
  it('stores the advertised default when credits is omitted', async () => {
    await createCourse({ department_id: DEPT_A, code: 'CS-9', title: 'New Course', status: 'active' })
    expect(mockCreate.mock.calls[0][1].credits).toBe(DEFAULT_COURSE_CREDITS)
  })

  it('never overrides a credits value the admin actually typed', async () => {
    await createCourse({ department_id: DEPT_A, code: 'CS-9', title: 'New Course', status: 'active', credits: 0 })
    expect(mockCreate.mock.calls[0][1].credits).toBe(0)
  })
})

describe('updateCourse — tenant isolation', () => {
  it('rejects a course owned by another institution and never writes', async () => {
    const res = await updateCourse('course-B', DEPT_B, { title: 'Hijacked Title' })
    expect(res).toEqual({ error: 'Not found' })
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('blocks re-parenting a course into another tenant department', async () => {
    // Caller owns course-A (inst-A) but tries to move it under inst-B's department.
    const res = await updateCourse('course-A', DEPT_A, { department_id: DEPT_B })
    expect(res).toEqual({ error: 'Not found' })
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('allows updating a course within the caller institution', async () => {
    const res = await updateCourse('course-A', DEPT_A, { title: 'Updated Course Title' })
    expect(res.success).toBe(true)
    expect(mockUpdate).toHaveBeenCalledTimes(1)
  })

  it('forwards expectedUpdatedAt to the query helper so the guard lands in the WHERE', async () => {
    await updateCourse('course-A', DEPT_A, { title: 'Updated Course Title' }, '2026-08-20T12:00:00.000Z')
    /* 4th arg, not 3rd: a guard passed in the wrong position silently disables
       itself — the update still succeeds, it just stops being concurrency-safe. */
    expect(mockUpdate.mock.calls[0][3]).toBe('2026-08-20T12:00:00.000Z')
  })

  it('turns a stale write into a conflict message, not a generic failure', async () => {
    mockUpdate.mockResolvedValueOnce({ ok: false, reason: 'conflict' })
    const res = await updateCourse('course-A', DEPT_A, { title: 'Updated Course Title' }, 'stale-timestamp')
    expect(res.success).toBeUndefined()
    /* The wording is the whole point of the discriminated result: "failed to
       update" tells the admin nothing, and they retry into the same race. */
    expect(res.error).toMatch(/someone else changed this/i)
    expect(res.error).toMatch(/reload/i)
  })

  it('still reports a real DB failure as a failure, not a conflict', async () => {
    mockUpdate.mockResolvedValueOnce({ ok: false, reason: 'error' })
    const res = await updateCourse('course-A', DEPT_A, { title: 'Updated Course Title' }, 'ts')
    expect(res.error).toBe('Failed to update course')
    expect(res.error).not.toMatch(/someone else/i)
  })
})

describe('deleteCourse — tenant isolation', () => {
  it('rejects deleting another institution course and never deletes', async () => {
    const res = await deleteCourse('course-B', DEPT_B)
    expect(res).toEqual({ error: 'Not found' })
    expect(mockRemove).not.toHaveBeenCalled()
  })

  it('allows deleting a course within the caller institution', async () => {
    const res = await deleteCourse('course-A', DEPT_A)
    expect(res).toEqual({ success: true })
    expect(mockRemove).toHaveBeenCalledTimes(1)
  })
})

describe('getCourseCascadeCounts — auth + tenant isolation', () => {
  /* null rather than zeros on every refusal (#715). A zeroed result renders in the delete
     dialog as the no-warning path, so a denied read used to look like an empty course. */
  it('returns null when unauthenticated', async () => {
    mockVerifyAdmin.mockResolvedValue({ error: 'Not authenticated' })
    const res = await getCourseCascadeCounts('course-A')
    expect(res).toBeNull()
    expect(mockGetCascadeCounts).not.toHaveBeenCalled()
  })

  it('returns null for a cross-tenant course', async () => {
    const res = await getCourseCascadeCounts('course-B')
    expect(res).toBeNull()
    expect(mockGetCascadeCounts).not.toHaveBeenCalled()
  })

  it('returns real counts for a course in the caller institution', async () => {
    const res = await getCourseCascadeCounts('course-A')
    expect(res).toEqual({ sections: 3 })
    expect(mockGetCascadeCounts).toHaveBeenCalledTimes(1)
  })
})
