/**
 * `studentQueries.getByIdWithDetails` must SELECT the scalar `enrollments.section_id` (#725).
 *
 * This is the one test in the #720–#727 batch that asserts on a query string rather
 * than on behaviour, so the reason has to carry it: nothing else in the stack can
 * observe this column going missing.
 *
 *   - TypeScript cannot. The builder is reached through an `any` cast, so the rows
 *     are typed as `Enrollment` (where `section_id` is required) no matter what the
 *     select list actually asks for.
 *   - The runtime cannot. PostgREST returns the columns it was asked for and no
 *     error for the ones it wasn't, so the field is simply `undefined`.
 *   - A behavioural test cannot, at this layer. Any fake client returns whatever
 *     rows the test hands it, which would prove the fake carries `section_id` and
 *     nothing about the query.
 *
 * And the consequence was silent: the admin enrollment dialog builds its exclusion
 * list as `enrollments.map(e => e.section_id)`, so every entry was `undefined`, the
 * filter matched nothing, and the enroll dropdown cheerfully offered sections the
 * student was already enrolled in. No error, no empty state — just a wrong list.
 *
 * The assertion is scoped to the scalar head of the select (everything before the
 * first nested relation) so it stays indifferent to column order, whitespace, and
 * any change inside `section:course_sections(...)`.
 */

import { describe, it, expect, vi } from 'vitest'
import { studentQueries } from '@/lib/supabase/queries'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

/** Captures the select list issued against each table. */
function fakeClient(selects: Record<string, string>) {
  return {
    from: (table: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {}
      chain.select = (cols: string) => {
        selects[table] = cols
        return chain
      }
      chain.eq = () => chain
      chain.order = async () => ({ data: [], error: null })
      chain.single = async () => ({ data: { id: 'stu-1' }, error: null })
      return chain
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

/** The scalar columns — everything before the first nested relation opens. */
const scalarHead = (select: string) => select.split('(')[0]

describe('studentQueries.getByIdWithDetails — enrollment select list (#725)', () => {
  it('selects the scalar section_id alongside the nested section relation', async () => {
    const selects: Record<string, string> = {}

    await studentQueries.getByIdWithDetails(fakeClient(selects), 'stu-1')

    /* The nested `section:course_sections(id, …)` is NOT a substitute: it lands
       under `row.section`, while every consumer reads `row.section_id`. */
    expect(scalarHead(selects.enrollments)).toMatch(/\bsection_id\b/)
    expect(selects.enrollments).toMatch(/section:course_sections/)
  })
})
