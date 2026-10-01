// getProfessorTodoSources — the `failed` flag, and the section query that
// derives everything else.
//
// Why this specific pair of branches is worth pinning: the payload for "this
// professor has no work" and "we could not find out whether this professor has
// work" is byte-for-byte identical — seven empty collections. `failed` is the
// ONLY thing that distinguishes them, and the dashboard uses it to decide
// between an honest error state and "you're all caught up". Collapse the two
// (return `failed: false` on a query error, or drop the flag) and the
// regression is invisible in every other assertion you could write: the
// to-do list renders, it just confidently tells a professor with 40 ungraded
// submissions that there is nothing to do.
//
// The section query is also the tenancy boundary. This function reads with the
// service-role client (RLS bypassed), and it derives sectionIds from
// professorId itself rather than trusting a caller-supplied list — so the
// `professor_id` filter is what makes every downstream read unforgeable.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

import { professorDashboardQueries } from '@/lib/supabase/queries'

const PROFESSOR = 'prof-1'

/**
 * A thenable query builder that records which tables were opened and which
 * equality filters were applied. Both cases under test short-circuit on the
 * FIRST query, so one canned result covers every call.
 */
function makeSupabase(sectionResult: { data: unknown; error: unknown }) {
  const tables: string[] = []
  const filters: Array<[string, unknown]> = []

  function builder(table: string) {
    tables.push(table)
    const b: Record<string, unknown> = {}
    const self = () => b
    Object.assign(b, {
      select: self,
      in: self,
      gte: self,
      neq: self,
      order: self,
      eq: (col: string, val: unknown) => {
        filters.push([col, val])
        return b
      },
      then: (onOk: (v: unknown) => unknown) => Promise.resolve(sectionResult).then(onOk),
    })
    return b
  }

  return { supabase: { from: builder }, tables, filters }
}

/** The payload both branches must produce — they differ ONLY in `failed`. */
const EMPTY = {
  assessments: [],
  ungraded: [],
  turnedInByAssessment: {},
  enrolledBySection: {},
  failedSlideRooms: [],
  recentReportsBySection: {},
}

const run = (result: { data: unknown; error: unknown }) => {
  const { supabase, tables, filters } = makeSupabase(result)
  return professorDashboardQueries
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .getProfessorTodoSources(supabase as any, PROFESSOR)
    .then((out) => ({ out, tables, filters }))
}

describe('getProfessorTodoSources — failed vs empty', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reports failed:true when the section query errors, and failed:false when the professor simply has no sections — with an OTHERWISE IDENTICAL payload', async () => {
    const broken = await run({ data: null, error: { message: 'connection reset' } })
    const noSections = await run({ data: [], error: null })

    // Whole-object equality on purpose: it pins the flag, proves the two
    // payloads are otherwise indistinguishable, AND proves a broken fetch never
    // smuggles partial data into the list alongside failed:true.
    expect(broken.out).toEqual({ ...EMPTY, failed: true })
    expect(noSections.out).toEqual({ ...EMPTY, failed: false })
  })

  it('scopes the section query to the caller and short-circuits before any downstream read when there are no sections', async () => {
    const { out, tables, filters } = await run({ data: [], error: null })

    // Tenancy: sectionIds are derived from professor_id here, never accepted
    // from the caller. Losing this filter would fan every downstream `.in(
    // 'section_id', …)` out across other professors' — and other
    // institutions' — sections, with RLS already bypassed.
    expect(tables).toEqual(['course_sections'])
    expect(filters).toContainEqual(['professor_id', PROFESSOR])
    expect(filters).toContainEqual(['status', 'active'])

    // Zero sections must not fall through to 12 `.in('section_id', [])` reads.
    expect(out.failed).toBe(false)
  })

  it('still reports failed:true when the section query returns an error alongside rows', async () => {
    // Supabase can hand back both; the error is authoritative. Reading the rows
    // anyway would produce a to-do list built from a partial result set and
    // present it as complete.
    const { out, tables } = await run({ data: [{ id: 'sec-1' }], error: { message: 'statement timeout' } })
    expect(out.failed).toBe(true)
    expect(out.assessments).toEqual([])
    expect(tables).toEqual(['course_sections'])
  })
})
