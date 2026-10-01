/**
 * `studentQueries.getEnrolledSectionsForStudent` must filter to `status = 'enrolled'`.
 *
 * This asserts on the query the builder issues rather than on returned rows, which
 * needs justifying — the repo does that exactly once elsewhere (see
 * `queries-student-enrollments-select.test.ts`). The justification here is that this
 * one `.eq()` is the ONLY thing enforcing a privacy rule, and nothing else in the
 * stack can observe it going missing:
 *
 *   - The caller cannot. `/professor/students/[studentId]` filters the returned rows
 *     on `section.professor_id` and `section.status === 'active'`. Neither of those
 *     is the ENROLLMENT status, so a dropped or completed enrollment in a still-active
 *     section passes the page's own check untouched.
 *   - TypeScript cannot. The builder is reached through an `any` cast, so no select
 *     list or filter change is a type error.
 *   - A row-level test cannot. Any fake client returns whatever rows the test hands
 *     it, which would prove the fake filtered them and nothing about the query.
 *
 * And the consequence is silent and one-directional: a professor keeps a live view of
 * a student's other courses and week-by-week calendar after that student has dropped
 * or completed the only course they shared. No error, no empty state — the page just
 * keeps working for someone who is no longer their student.
 *
 * The section-status and professor-id parts of the select are deliberately NOT pinned
 * here: dropping either makes the page's own comparison fail closed (`undefined` never
 * equals a uuid), so they cannot leak anything by going missing.
 */

import { describe, it, expect, vi } from 'vitest'
import { studentQueries } from '@/lib/supabase/queries'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

/** Captures the `.eq()` filters applied to each table. */
function fakeClient(filters: Record<string, [string, unknown][]>) {
  return {
    from: (table: string) => {
      filters[table] ??= []
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {}
      chain.select = () => chain
      chain.eq = (col: string, val: unknown) => {
        filters[table].push([col, val])
        return chain
      }
      // The function awaits the builder itself — no .single()/.order() terminator.
      chain.then = (resolve: (r: unknown) => unknown) => resolve({ data: [], error: null })
      return chain
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

describe('studentQueries.getEnrolledSectionsForStudent', () => {
  it("filters enrollments to the requested student AND status 'enrolled'", async () => {
    const filters: Record<string, [string, unknown][]> = {}

    await studentQueries.getEnrolledSectionsForStudent(fakeClient(filters), 'stu-1')

    expect(filters.enrollments).toEqual(
      expect.arrayContaining([
        ['student_id', 'stu-1'],
        ['status', 'enrolled'],
      ]),
    )
  })

  it('returns an empty list when the read fails, so the caller denies rather than opens', async () => {
    const erroring = {
      from: () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const chain: any = {}
        chain.select = () => chain
        chain.eq = () => chain
        chain.then = (resolve: (r: unknown) => unknown) =>
          resolve({ data: null, error: { message: 'boom' } })
        return chain
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any

    expect(await studentQueries.getEnrolledSectionsForStudent(erroring, 'stu-1')).toEqual([])
  })
})
