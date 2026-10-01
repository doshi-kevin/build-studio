// Tests for getStudentProjectGrades — specifically the enrollment gate added so a
// stale project_members row (a since-unenrolled student) can no longer read this
// section's project grades. The gate is the security-load-bearing behavior here:
// it must run BEFORE any project/grade read, so an unenrolled caller gets nothing.

import { describe, it, expect, vi, beforeEach } from 'vitest'

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
  chain.range = vi.fn().mockReturnValue(chain)
  chain.single = vi.fn().mockResolvedValue(finalResult)
  chain.maybeSingle = vi.fn().mockResolvedValue(finalResult)
  chain.insert = vi.fn().mockReturnValue(chain)
  chain.update = vi.fn().mockReturnValue(chain)
  chain.delete = vi.fn().mockReturnValue(chain)
  chain.upsert = vi.fn().mockReturnValue(chain)
  chain.then = (onFulfilled: (v: unknown) => unknown) =>
    Promise.resolve(finalResult).then(onFulfilled)
  return chain
}

// ── Module-Level Mocks ───────────────────────────────────────

const mockGetUser = vi.fn()
const mockAdminClient = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: (...args: unknown[]) => mockAdminClient(...args),
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// ── Action Handle ────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let getStudentProjectGrades: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let getStudentAssignmentGrades: any

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockAdminClient.mockReset()
  const mod = await import('@/app/(dashboard)/student/courses/[sectionId]/grades/actions')
  getStudentProjectGrades = mod.getStudentProjectGrades
  getStudentAssignmentGrades = mod.getStudentAssignmentGrades
})

const SECTION = 'section-1'

// Build an admin client whose from(table) dispatches to a per-table chain. Any
// table not listed resolves to an empty result, so tests only wire the tables the
// path under test actually reads — an unenrolled caller should never reach `projects`.
function buildAdmin(tables: Record<string, { data: unknown; error: unknown }>) {
  const chains: Record<string, ReturnType<typeof buildChain>> = {}
  for (const [t, result] of Object.entries(tables)) chains[t] = buildChain(result)
  const from = vi.fn((t: string) => chains[t] ?? buildChain({ data: [], error: null }))
  return { from, _chains: chains }
}

describe('getStudentProjectGrades — enrollment gate', () => {
  it('rejects an unauthenticated caller', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no user' } })
    const res = await getStudentProjectGrades(SECTION)
    expect(res).toEqual({ error: 'Not authenticated' })
  })

  it('rejects a since-unenrolled caller and never reads project grades', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
    // No enrollment row for this section → the gate must fire.
    const admin = buildAdmin({ enrollments: { data: null, error: null } })
    mockAdminClient.mockReturnValue(admin)

    const res = await getStudentProjectGrades(SECTION)

    expect(res).toEqual({ error: 'Not enrolled in this section' })
    // The gate short-circuits before any project/grade read.
    expect(admin.from).not.toHaveBeenCalledWith('projects')
    expect(admin.from).not.toHaveBeenCalledWith('project_members')
  })

  // Wiring for an enrolled member on a team, with a one-item rubric (a manual
  // item worth 100, the student scored 90 → 90%). `release` toggles whether the
  // project_grade_releases row exists.
  function enrolledMemberAdmin(release: boolean) {
    return buildAdmin({
      enrollments: { data: { id: 'enr-1' }, error: null },
      projects: { data: [{ id: 'proj-1', title: 'Capstone', due_date: '2026-08-01' }], error: null },
      project_members: { data: [{ team_id: 'team-1' }], error: null },
      project_teams: { data: [{ id: 'team-1', name: 'Team Alpha', project_id: 'proj-1' }], error: null },
      project_grade_releases: {
        data: release ? [{ project_id: 'proj-1', released_at: '2026-08-05' }] : [],
        error: null,
      },
      project_phase_items: {
        data: [
          {
            id: 'pi-1',
            item_type: 'manual',
            assignment_id: null,
            quiz_id: null,
            weight: 100,
            grain: 'individual',
            scoring_mode: 'numeric',
            levels: [],
            manual_title: 'Deliverable',
            manual_max: 100,
            position: 0,
            phase: null,
          },
        ],
        error: null,
      },
      project_item_scores: {
        data: [{ phase_item_id: 'pi-1', team_id: null, student_id: 'user-1', earned: 90, level_id: null }],
        error: null,
      },
    })
  }

  it('returns nothing until the project grades are released (in-progress stays hidden)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
    mockAdminClient.mockReturnValue(enrolledMemberAdmin(false))

    const res = await getStudentProjectGrades(SECTION)
    expect(res).toEqual({ data: [] })
  })

  it('returns the computed grade once released (own grade, from the weighted rubric)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
    mockAdminClient.mockReturnValue(enrolledMemberAdmin(true))

    const res = await getStudentProjectGrades(SECTION)
    expect(res).toEqual({
      data: [
        {
          projectId: 'proj-1',
          projectTitle: 'Capstone',
          teamName: 'Team Alpha',
          score: 90, // 90/100 × weight 100 = 90, out of total 100 → 90%
          feedback: null,
          gradedAt: '2026-08-05',
          dueDate: '2026-08-01',
        },
      ],
    })
  })

  it('does not leak an UNPUBLISHED assignment grade into a released project total', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
    // Released project, rubric = one assignment worth 100, the student is graded 80 —
    // but the assignment's grades are NOT published, so it must count as ungraded and
    // the project (nothing else graded) drops out entirely.
    mockAdminClient.mockReturnValue(
      buildAdmin({
        enrollments: { data: { id: 'enr-1' }, error: null },
        projects: { data: [{ id: 'proj-1', title: 'Capstone', due_date: '2026-08-01' }], error: null },
        project_members: { data: [{ team_id: 'team-1' }], error: null },
        project_teams: { data: [{ id: 'team-1', name: 'Team Alpha', project_id: 'proj-1' }], error: null },
        project_grade_releases: { data: [{ project_id: 'proj-1', released_at: '2026-08-05' }], error: null },
        project_phase_items: {
          data: [
            { id: 'pi-1', item_type: 'assignment', assignment_id: 'a1', quiz_id: null, weight: 100, grain: 'individual', scoring_mode: 'numeric', levels: [], manual_title: null, manual_max: null, position: 0, phase: null },
          ],
          error: null,
        },
        assignments: { data: [{ id: 'a1', title: 'HW', points: 100, settings: {} }], error: null }, // gradesPublished not set
        assignment_submissions: { data: [{ id: 's1', assignment_id: 'a1', student_id: 'user-1', status: 'graded', score: 80 }], error: null },
      }),
    )

    const res = await getStudentProjectGrades(SECTION)
    expect(res).toEqual({ data: [] })
  })
})

describe('getStudentAssignmentGrades — grade-leak guard', () => {
  const GRADED_SUB = {
    assignment_id: 'a1',
    status: 'graded',
    score: 88,
    feedback: 'good',
    graded_at: '2026-07-01',
  }
  const publishedAssignment = (settings: Record<string, unknown>) => ({
    assignments: {
      data: [{ id: 'a1', title: 'HW1', points: 100, due_at: null, settings }],
      error: null,
    },
  })

  it('rejects an unauthenticated caller', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no user' } })
    const res = await getStudentAssignmentGrades(SECTION)
    expect(res).toEqual({ error: 'Not authenticated' })
  })

  it('rejects a since-unenrolled caller and never reads assignments', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
    const admin = buildAdmin({ enrollments: { data: null, error: null } })
    mockAdminClient.mockReturnValue(admin)

    const res = await getStudentAssignmentGrades(SECTION)

    expect(res).toEqual({ error: 'Not enrolled in this section' })
    expect(admin.from).not.toHaveBeenCalledWith('assignments')
  })

  it('reveals score/feedback when grades are published AND the submission is graded', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
    mockAdminClient.mockReturnValue(buildAdmin({
      enrollments: { data: { id: 'enr-1' }, error: null },
      ...publishedAssignment({ gradesPublished: true }),
      assignment_submissions: { data: [GRADED_SUB], error: null },
    }))

    const res = await getStudentAssignmentGrades(SECTION)

    expect(res.data[0]).toMatchObject({
      assignmentId: 'a1',
      status: 'graded',
      released: true,
      score: 88,
      feedback: 'good',
      gradedAt: '2026-07-01',
    })
  })

  it('STRIPS score/feedback when a graded submission is NOT yet published', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
    mockAdminClient.mockReturnValue(buildAdmin({
      enrollments: { data: { id: 'enr-1' }, error: null },
      ...publishedAssignment({}), // gradesPublished absent → not published
      assignment_submissions: { data: [GRADED_SUB], error: null },
    }))

    const res = await getStudentAssignmentGrades(SECTION)

    // The load-bearing assertion: a graded-but-unpublished score must never leave the server.
    expect(res.data[0]).toMatchObject({
      status: 'graded',
      released: false,
      score: null,
      feedback: null,
      gradedAt: null,
    })
  })

  it('STRIPS score when published but the submission is not yet graded', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
    mockAdminClient.mockReturnValue(buildAdmin({
      enrollments: { data: { id: 'enr-1' }, error: null },
      ...publishedAssignment({ gradesPublished: true }),
      assignment_submissions: {
        data: [{ assignment_id: 'a1', status: 'submitted', score: null, feedback: null, graded_at: null }],
        error: null,
      },
    }))

    const res = await getStudentAssignmentGrades(SECTION)

    expect(res.data[0]).toMatchObject({ status: 'submitted', score: null, feedback: null })
  })

  it('reports not_started when the student has no submission', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
    mockAdminClient.mockReturnValue(buildAdmin({
      enrollments: { data: { id: 'enr-1' }, error: null },
      ...publishedAssignment({ gradesPublished: true }),
      assignment_submissions: { data: [], error: null },
    }))

    const res = await getStudentAssignmentGrades(SECTION)

    expect(res.data[0]).toMatchObject({ status: 'not_started', score: null })
  })
})
