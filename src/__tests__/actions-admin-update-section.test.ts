// Reassigning a section's professor was a silent no-op (#716).
//
// EditSectionDialog renders a professor picker and sends `professor_id`. But
// `updateCourseAssignmentSchema` had no such field, and Zod STRIPS unknown keys — so
// safeParse quietly dropped it and updateAssignment wrote every other column, then
// reported success. The admin picked a new professor, saw a success toast, and the
// section kept its old one.
//
// That makes "the field is never sent" the wrong diagnosis, and the distinction matters
// for the test: the field IS sent and DISCARDED BY VALIDATION. So the assertion has to be
// on what reaches the write, not on what the caller passed.
//
// The second half is the guard that had to come with it: professor_id is a client-supplied
// id, so accepting it without a tenant check would turn section reassignment into a way to
// attach a professor from another institution — and the section read-back joins straight
// through professor_id to render their name. assignCourse already guarded this on create;
// update simply had nothing to guard.
//
// Uses the REAL assertTenantOwns against a faked admin client, matching
// actions-admin-course-actions.test.ts, so the tenant check under test is the shipped one.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { updateCourseAssignmentSchema } from '@/lib/validations/course-assignment'

const mockVerifyAdmin = vi.fn()
const mockAssignmentUpdate = vi.fn()

const SECTION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PROF_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const PROF_OTHER_TENANT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const STUDENT_SAME_TENANT = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

// table -> row id -> { institution_id, role }. Consumed by the real assertTenantOwns
// chain AND by assertIsProfessor, which reads `role` from the same shape.
let tenantData: Record<string, Record<string, { institution_id: string; role?: string }>> = {}

function makeAdminDb() {
  return {
    from: (table: string) => ({
      select: () => ({
        eq: (_col: string, id: string) => ({
          maybeSingle: async () => {
            const row = tenantData[table]?.[id]
            return row ? { data: row, error: null } : { data: null, error: null }
          },
        }),
      }),
    }),
  }
}

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => makeAdminDb() }))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
vi.mock('@/lib/auth/admin-context', () => ({
  verifyInstitutionAdmin: (...a: unknown[]) => mockVerifyAdmin(...a),
}))
vi.mock('@/lib/supabase/queries', () => ({
  courseAssignmentQueries: { update: (...a: unknown[]) => mockAssignmentUpdate(...a) },
  courseAdminQueries: {},
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let updateAssignment: any

beforeEach(async () => {
  vi.resetModules()
  mockVerifyAdmin.mockReset().mockResolvedValue({ userId: 'admin-A', institutionId: 'inst-A' })
  mockAssignmentUpdate.mockReset().mockResolvedValue({ id: SECTION_A })
  tenantData = {
    course_sections: { [SECTION_A]: { institution_id: 'inst-A' } },
    profiles: {
      [PROF_A]: { institution_id: 'inst-A', role: 'professor' },
      [PROF_OTHER_TENANT]: { institution_id: 'inst-B', role: 'professor' },
      [STUDENT_SAME_TENANT]: { institution_id: 'inst-A', role: 'student' },
    },
  }
  const mod = await import('@/app/(dashboard)/admin/courses/actions')
  updateAssignment = mod.updateAssignment
})

describe('updateCourseAssignmentSchema — professor_id survives validation (#716)', () => {
  it('keeps professor_id instead of stripping it', () => {
    const parsed = updateCourseAssignmentSchema.safeParse({ professor_id: PROF_A })
    expect(parsed.success).toBe(true)
    /* The whole bug: this key used to be absent from the parsed output. */
    if (parsed.success) expect(parsed.data.professor_id).toBe(PROF_A)
  })

  it('still rejects a non-uuid, so the picker cannot send junk', () => {
    expect(updateCourseAssignmentSchema.safeParse({ professor_id: 'not-a-uuid' }).success).toBe(false)
  })
})

describe('updateAssignment — professor reassignment (#716)', () => {
  it('passes professor_id through to the write', async () => {
    const res = await updateAssignment(SECTION_A, { professor_id: PROF_A })

    expect(res.success).toBe(true)
    /* Asserting on what reached the QUERY, not on the return value — a success toast is
       exactly what the broken version produced. */
    expect(mockAssignmentUpdate).toHaveBeenCalledWith(
      expect.anything(),
      SECTION_A,
      expect.objectContaining({ professor_id: PROF_A }),
    )
  })

  it('refuses a professor from another institution and writes nothing', async () => {
    const res = await updateAssignment(SECTION_A, { professor_id: PROF_OTHER_TENANT })

    expect(res.success).toBeUndefined()
    expect(res.error).toBeTruthy()
    expect(mockAssignmentUpdate).not.toHaveBeenCalled()
  })

  it('still updates the other fields when no professor is supplied', async () => {
    const res = await updateAssignment(SECTION_A, { max_students: 40 })

    expect(res.success).toBe(true)
    expect(mockAssignmentUpdate).toHaveBeenCalledWith(
      expect.anything(),
      SECTION_A,
      expect.objectContaining({ max_students: 40 }),
    )
  })
})

/**
 * Tenancy is not role. `course_sections.professor_id` is the subject of a large number of
 * RLS policies and of verifySectionAccess, so naming a STUDENT of the same institution
 * would grant them professor-level reach into that section — the gradebook, every
 * submission, the roster. assertTenantOwns proves the id is ours; it says nothing about
 * what the person is.
 *
 * Raised in security review of #716.
 */
describe('updateAssignment — professor_id must be a professor', () => {
  it('refuses a same-institution student and writes nothing', async () => {
    const res = await updateAssignment(SECTION_A, { professor_id: STUDENT_SAME_TENANT })

    expect(res.success).toBeUndefined()
    expect(res.error).toMatch(/not a professor/i)
    expect(mockAssignmentUpdate).not.toHaveBeenCalled()
  })
})
