/**
 * Who may open `/professor/students/[studentId]`, and what they get to see.
 *
 * Tested at the page rather than through a helper because the page IS the guard: the
 * check is inline, and `(dashboard)/professor/layout.tsx` admits institution admins and
 * course assistants too, so the route is reachable by more people than may read it.
 * Same approach as `dm-resolver-page.test.tsx`, for the same reason — the judgement is
 * the product, and there is no server action here to test instead.
 *
 * The page hands a client component a student's phone number, their other courses, and
 * a two-week reconstruction of their week. Four denial paths and one whitelist decide
 * whether that is the right student:
 *
 *   1. Not signed in.
 *   2. No section shared with the caller as its professor.
 *   3. A shared section, but the enrollment is not live (dropped/completed), or the
 *      section is a draft. Finishing a course must not keep granting a live view.
 *   4. A shared section in ANOTHER institution's tenant.
 *
 * And the whitelist: enrollment rows arrive carrying `final_grade`/`final_score` for
 * EVERY section the student is in, including other professors' — the page must null
 * those out. That is a leak a type cannot catch, because the whole row lands in the
 * RSC payload regardless of how it is typed.
 *
 * Every denial must be `notFound()`, never a distinguishable error: telling "no such
 * student" apart from "not your student" turns the URL into a probe for which student
 * ids exist in other people's courses.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

/* notFound() throws to unwind, and it is asserted on by the message rather than by a
   spy. CLAUDE.md's vitest-4 note: a mock whose implementation throws must not be
   touched in beforeEach, or vitest mis-attributes the throw as a test failure — so
   this is a plain function, never reset. */
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND')
  },
}))

const mockGetUser = vi.fn()
const mockGetEnrolledSections = vi.fn()
const mockGetStudentById = vi.fn()
const mockGetProfileById = vi.fn()
const mockGetBusyTimes = vi.fn()
const mockStudentEvents = vi.fn()
const mockProfessorEvents = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/supabase/queries', () => ({
  studentQueries: {
    getEnrolledSectionsForStudent: (...a: unknown[]) => mockGetEnrolledSections(...a),
    getById: (...a: unknown[]) => mockGetStudentById(...a),
  },
  profileQueries: { getProfileById: (...a: unknown[]) => mockGetProfileById(...a) },
  calendarQueries: { getProfessorBusyTimes: (...a: unknown[]) => mockGetBusyTimes(...a) },
}))
vi.mock('@/lib/calendar/student-events', () => ({
  getStudentCalendarEvents: (...a: unknown[]) => mockStudentEvents(...a),
}))
vi.mock('@/lib/calendar/professor-events', () => ({
  getProfessorCalendarEvents: (...a: unknown[]) => mockProfessorEvents(...a),
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

const PROF = 'prof-1'
const INST = 'inst-1'

/** An enrollment row in the shape `getEnrolledSectionsForStudent` selects. */
function row(overrides: {
  sectionId?: string
  professorId?: string | null
  sectionStatus?: string
  code?: string
  finalGrade?: string | null
  finalScore?: number | null
} = {}) {
  return {
    final_grade: overrides.finalGrade ?? 'A',
    final_score: overrides.finalScore ?? 95,
    section: {
      id: overrides.sectionId ?? 'sec-mine',
      section_code: '01',
      semester: 'fall',
      year: 2026,
      status: overrides.sectionStatus ?? 'active',
      professor_id: overrides.professorId === undefined ? PROF : overrides.professorId,
      course: { id: 'c1', code: overrides.code ?? '506-NLP', title: 'NLP' },
    },
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let page: (props: any) => Promise<unknown>

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockGetEnrolledSections.mockReset()
  mockGetStudentById.mockReset()
  mockGetProfileById.mockReset()
  mockGetBusyTimes.mockReset()
  mockStudentEvents.mockReset()
  mockProfessorEvents.mockReset()

  // Defaults: signed-in professor, a student in the same tenant, empty calendars.
  mockGetUser.mockResolvedValue({ data: { user: { id: PROF } } })
  mockGetStudentById.mockResolvedValue({
    id: 'stu-1', name: 'Ada Lovelace', email: 'ada@x.edu',
    first_name: 'Ada', last_name: 'Lovelace', cwid: '123', phone: null,
    status: 'active', institution_id: INST, settings: {},
  })
  mockGetProfileById.mockResolvedValue({ institution_id: INST })
  mockGetBusyTimes.mockResolvedValue([])
  mockStudentEvents.mockResolvedValue({ events: [], error: false })
  mockProfessorEvents.mockResolvedValue({ events: [], error: false })

  const mod = await import('@/app/(dashboard)/professor/students/[studentId]/page')
  page = mod.default
})

const render = (studentId = 'stu-1') => page({ params: Promise.resolve({ studentId }) })

/**
 * The props the page hands StudentProfileView. Read off the returned element rather
 * than through a mocked component: a server component RETURNS an element, it never
 * invokes its child, so a spy on the child is never called.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const propsFrom = async (studentId = 'stu-1'): Promise<any> => (await render(studentId) as any).props

describe('the access check', () => {
  it('refuses an unauthenticated caller before reading anything', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })

    await expect(render()).rejects.toThrow('NEXT_NOT_FOUND')
    // The point of checking before the first read, not just before the render.
    expect(mockGetEnrolledSections).not.toHaveBeenCalled()
  })

  it("refuses a professor who shares no section with the student", async () => {
    mockGetEnrolledSections.mockResolvedValue([row({ professorId: 'prof-other' })])

    await expect(render()).rejects.toThrow('NEXT_NOT_FOUND')
    // Never reaches either calendar, so nothing about the student's week is read.
    expect(mockStudentEvents).not.toHaveBeenCalled()
  })

  it('refuses when the only shared section is still a draft', async () => {
    mockGetEnrolledSections.mockResolvedValue([row({ sectionStatus: 'draft' })])

    await expect(render()).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('refuses a student in another institution even with a section match', async () => {
    /* Belt and braces over the enrollment join, and the failure mode it guards is the
       one from PR #555: another tenant's roster rendered into the response. */
    mockGetEnrolledSections.mockResolvedValue([row()])
    mockGetStudentById.mockResolvedValue({
      id: 'stu-1', name: 'Ada', email: 'a@y.edu', first_name: 'A', last_name: 'B',
      status: 'active', institution_id: 'inst-OTHER', settings: {},
    })

    await expect(render()).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('gives the same refusal for a missing student as for a forbidden one', async () => {
    /* Identical failures on purpose. A different error for "no such id" would let any
       professor enumerate student ids in courses they do not teach. */
    mockGetEnrolledSections.mockResolvedValue([row()])
    mockGetStudentById.mockResolvedValue(null)
    const missing = await render().catch((e: Error) => e.message)

    mockGetEnrolledSections.mockResolvedValue([row({ professorId: 'prof-other' })])
    const forbidden = await render().catch((e: Error) => e.message)

    expect(missing).toBe(forbidden)
  })

  it('admits a professor who teaches the student in a live section', async () => {
    mockGetEnrolledSections.mockResolvedValue([row()])

    const props = await propsFrom()

    expect(props.student).toMatchObject({ id: 'stu-1', email: 'ada@x.edu' })
    expect(props.classes).toHaveLength(1)
  })
})

describe("another professor's grades never reach the client", () => {
  it('nulls the grade on a section the caller does not teach', async () => {
    mockGetEnrolledSections.mockResolvedValue([
      row({ sectionId: 'sec-mine', code: '506-NLP', finalGrade: 'B', finalScore: 85 }),
      row({
        sectionId: 'sec-theirs', professorId: 'prof-other',
        code: '101-CPE', finalGrade: 'D', finalScore: 61,
      }),
    ])

    const { classes } = await propsFrom()
    const mine = classes.find((c: { courseCode: string }) => c.courseCode === '506-NLP')
    const theirs = classes.find((c: { courseCode: string }) => c.courseCode === '101-CPE')

    // Own section: the professor's own grade, which is theirs to see.
    expect(mine).toMatchObject({ isMine: true, finalGrade: 'B', finalScore: 85 })
    /* Other section: it must still be LISTED — "what else are they taking" is the
       point of the page — but carry no grade. The row arrived with 'D'/61 on it. */
    expect(theirs).toMatchObject({ isMine: false, finalGrade: null, finalScore: null })
    expect(JSON.stringify(classes)).not.toContain('61')
  })

  it("lists the caller's own course first", async () => {
    mockGetEnrolledSections.mockResolvedValue([
      row({ sectionId: 'sec-theirs', professorId: 'prof-other', code: '101-CPE' }),
      row({ sectionId: 'sec-mine', code: '506-NLP' }),
    ])

    const { classes } = await propsFrom()
    expect(classes.map((c: { courseCode: string }) => c.courseCode)).toEqual(['506-NLP', '101-CPE'])
  })
})

describe('an empty calendar is not the same claim as a free one', () => {
  it('reports no calendar data rather than a week of free time', async () => {
    mockGetEnrolledSections.mockResolvedValue([row()])

    const { availability } = await propsFrom()

    expect(availability.hasCalendarData).toBe(false)
  })

  it('reports a failed calendar read as its own state', async () => {
    mockGetEnrolledSections.mockResolvedValue([row()])
    mockStudentEvents.mockResolvedValue({ events: [], error: true })

    const { availability } = await propsFrom()

    expect(availability.loadError).toBe(true)
  })
})
