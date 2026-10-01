/**
 * Cascade-count honesty for the department and course delete dialogs (#715).
 *
 * Two properties, and both failed silently before this fix:
 *
 *   1. The count must reach every table the delete actually removes.
 *      `departmentQueries.getCascadeCounts` counted programs, courses and faculty, and
 *      stopped there — while the delete cascaded on down through course_sections into
 *      enrollments. A department holding one live section and one enrolled student
 *      reported "1 program, 1 course", and the admin confirmed it not knowing a student
 *      was attached. `courseAdminQueries` had the same shape: its own docstring said
 *      "cascades to course_sections, which cascade to enrollments" while counting only
 *      sections.
 *
 *   2. A failed read must return null, never zeros. This is the sharper half. Both
 *      helpers coalesced every error to 0 (`count || 0`, and a catch returning an
 *      all-zero object), and the dialog renders a zeroed result as its reassuring line:
 *      "No associated programs, courses, or faculty will be affected." So a timeout, a
 *      blip or a denied read told the admin a populated department was empty, in the one
 *      moment where being wrong is unrecoverable. `getSectionCascadeCounts` was fixed
 *      this way first and its two siblings were left behind.
 *
 * Driving the real helpers against a fake client, because the action layer above them
 * only forwards the result: an action test can prove null passes through but says nothing
 * about whether the helper ever looked at enrollments.
 */

import { describe, it, expect, vi } from 'vitest'
import { departmentQueries, courseAdminQueries } from '@/lib/supabase/queries'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

/** Per-table canned responses, plus a record of which tables were actually queried. */
interface Plan {
  [table: string]: { data?: unknown; count?: number | null; error?: { message: string } | null }
}

function fakeClient(plan: Plan, touched: string[]) {
  return {
    from: (table: string) => {
      touched.push(table)
      const res = plan[table] ?? { data: [], count: 0, error: null }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {}
      /* head:true count reads resolve on .eq()/.in(); id-list reads resolve on the same
         call and return .data. One awaitable object serves both. */
      const settle = () => Promise.resolve({ data: res.data ?? [], count: res.count ?? null, error: res.error ?? null })
      chain.select = () => chain
      chain.eq = () => ({ ...chain, then: (f: (v: unknown) => unknown) => settle().then(f) })
      chain.in = () => ({ ...chain, then: (f: (v: unknown) => unknown) => settle().then(f) })
      chain.then = (f: (v: unknown) => unknown) => settle().then(f)
      return chain
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

describe('departmentQueries.getCascadeCounts (#715)', () => {
  it('counts the sections and enrollments the delete will actually destroy', async () => {
    const touched: string[] = []
    const client = fakeClient(
      {
        programs: { count: 1 },
        department_faculty: { count: 0 },
        courses: { data: [{ id: 'course-1' }] },
        course_sections: { data: [{ id: 'section-1' }] },
        enrollments: { count: 1 },
      },
      touched,
    )

    const res = await departmentQueries.getCascadeCounts(client, 'dept-1')

    /* The exact live repro from the issue: 1 program, 1 course, 1 active section, 1
       enrolled student. The dialog previously stopped at the first two. */
    expect(res).toEqual({ programs: 1, courses: 1, faculty: 0, sections: 1, enrollments: 1 })
    expect(touched).toContain('course_sections')
    expect(touched).toContain('enrollments')
  })

  it('returns null when a count read fails, rather than a zero that reads as empty', async () => {
    const touched: string[] = []
    const client = fakeClient({ programs: { count: null, error: { message: 'timeout' } } }, touched)

    expect(await departmentQueries.getCascadeCounts(client, 'dept-1')).toBeNull()
  })

  it('returns null when the mid-cascade section lookup fails', async () => {
    const touched: string[] = []
    const client = fakeClient(
      {
        programs: { count: 2 },
        department_faculty: { count: 1 },
        courses: { data: [{ id: 'course-1' }] },
        course_sections: { data: null, error: { message: 'denied' } },
      },
      touched,
    )

    /* Without the throw this returned programs:2, courses:1, sections:0, enrollments:0 —
       a partial result that looks authoritative and hides everything below the break. */
    expect(await departmentQueries.getCascadeCounts(client, 'dept-1')).toBeNull()
  })

  it('reports a genuinely empty department as zeros, not null', async () => {
    const touched: string[] = []
    const client = fakeClient(
      { programs: { count: 0 }, department_faculty: { count: 0 }, courses: { data: [] } },
      touched,
    )

    /* The reassuring line must still be reachable, or the fix just moves the lie. */
    expect(await departmentQueries.getCascadeCounts(client, 'dept-1')).toEqual({
      programs: 0, courses: 0, faculty: 0, sections: 0, enrollments: 0,
    })
    /* No courses means no sections to look for — the hop is skipped, not queried with an
       empty id list, which PostgREST would answer with everything. */
    expect(touched).not.toContain('course_sections')
  })
})

describe('courseAdminQueries.getCascadeCounts (#715)', () => {
  it('counts enrollments, which its own docstring promised and the code never did', async () => {
    const touched: string[] = []
    const client = fakeClient(
      { course_sections: { data: [{ id: 's-1' }, { id: 's-2' }] }, enrollments: { count: 7 } },
      touched,
    )

    expect(await courseAdminQueries.getCascadeCounts(client, 'course-1')).toEqual({
      sections: 2,
      enrollments: 7,
    })
    expect(touched).toContain('enrollments')
  })

  it('returns null when the enrollment count fails', async () => {
    const touched: string[] = []
    const client = fakeClient(
      {
        course_sections: { data: [{ id: 's-1' }] },
        enrollments: { count: null, error: { message: 'timeout' } },
      },
      touched,
    )

    expect(await courseAdminQueries.getCascadeCounts(client, 'course-1')).toBeNull()
  })

  it('reports a course with no sections as zeros', async () => {
    const touched: string[] = []
    const client = fakeClient({ course_sections: { data: [] } }, touched)

    expect(await courseAdminQueries.getCascadeCounts(client, 'course-1')).toEqual({
      sections: 0,
      enrollments: 0,
    })
    expect(touched).not.toContain('enrollments')
  })
})
