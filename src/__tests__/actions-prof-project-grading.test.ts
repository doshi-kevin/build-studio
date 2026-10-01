// Tests for the project GRADING-ENGINE server actions — the write-authorization
// boundary for the phase-weighted rubric. These tables are SELECT-only under RLS,
// so the server action is the ONLY thing standing between a caller and a
// cross-section write: a broken role gate or IDOR bind is a data-integrity /
// tenant-isolation hole. Mirrors the pattern in actions-prof-projects.test.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { gradeItemScoreSchema } from '@/lib/validations/project'

// ── Chain builder ────────────────────────────────────────────

function buildChain(finalResult: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {}
  chain.select = vi.fn().mockReturnValue(chain)
  chain.eq = vi.fn().mockReturnValue(chain)
  chain.in = vi.fn().mockReturnValue(chain)
  chain.gt = vi.fn().mockReturnValue(chain) // verifySectionAccess filters section_staff by ends_at
  chain.order = vi.fn().mockReturnValue(chain)
  chain.limit = vi.fn().mockReturnValue(chain)
  chain.single = vi.fn().mockResolvedValue(finalResult)
  chain.maybeSingle = vi.fn().mockResolvedValue(finalResult)
  chain.insert = vi.fn().mockReturnValue(chain)
  chain.update = vi.fn().mockReturnValue(chain)
  chain.delete = vi.fn().mockReturnValue(chain)
  chain.upsert = vi.fn().mockReturnValue(chain)
  // Plain `await chain` (count/error reads) resolves to the result too.
  chain.then = (onFulfilled: (v: unknown) => unknown) => Promise.resolve(finalResult).then(onFulfilled)
  return chain
}

// ── Module mocks ─────────────────────────────────────────────

const mockGetUser = vi.fn()
const mockAdminClient = vi.fn()

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: (...args: unknown[]) => mockAdminClient(...args),
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))

/* eslint-disable @typescript-eslint/no-explicit-any */
let updatePhaseItemGrading: any
let addManualPhaseItem: any
let gradeItemScore: any
let setProjectGradesReleased: any

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockAdminClient.mockReset()
  const mod = await import('@/app/(dashboard)/professor/courses/[sectionId]/projects/actions')
  updatePhaseItemGrading = mod.updatePhaseItemGrading
  addManualPhaseItem = mod.addManualPhaseItem
  gradeItemScore = mod.gradeItemScore
  setProjectGradesReleased = mod.setProjectGradesReleased
})

// ── Helpers ──────────────────────────────────────────────────

const CALLER = 'prof-1'
// gradeItemScoreSchema requires uuid student_id/team_id, and parse runs before the
// access check — so these must be valid UUIDs for the role/bind paths to be reached.
const STU = '11111111-1111-4111-8111-111111111111'
const TEAM = '22222222-2222-4222-8222-222222222222'
const auth = (id = CALLER) => mockGetUser.mockResolvedValue({ data: { user: { id } }, error: null })

// Per-table admin dispatcher. `tables` maps table name → its result; course_sections
// defaults to a professor-owned section (with institution_id for getSectionInstitutionId).
// Returns { admin, chains } where chains reuses one chain per table so writes are assertable.
function mockAdmin(
  role: 'professor' | 'ta' | 'grader' | 'none',
  tables: Record<string, { data: unknown; error: unknown }> = {},
) {
  const chains: Record<string, ReturnType<typeof buildChain>> = {}
  const sectionRow = {
    data: { id: 'section-1', professor_id: role === 'professor' ? CALLER : 'real-prof', institution_id: 'inst-1' },
    error: null,
  }
  const staffRow = {
    data: role === 'ta' ? { role: 'ta' } : role === 'grader' ? { role: 'grader' } : null,
    error: null,
  }
  const get = (t: string, result: { data: unknown; error: unknown }) => (chains[t] ??= buildChain(result))
  const admin = {
    from: vi.fn((t: string) => {
      if (t === 'course_sections') return get(t, sectionRow)
      if (t === 'section_staff') return get(t, staffRow)
      return get(t, tables[t] ?? { data: null, error: null })
    }),
  }
  mockAdminClient.mockReturnValue(admin)
  return { admin, chains }
}

const validGrading = { weight: 20, grain: 'individual', scoring_mode: 'numeric', levels: [] }

// ── Role / auth matrix (all four actions) ────────────────────

describe('grading actions — auth & role gate', () => {
  it('reject unauthenticated callers', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no user' } })
    expect((await updatePhaseItemGrading('i', 'p', 's', validGrading)).error).toBe('Not authenticated')
    expect((await gradeItemScore('i', 'p', 's', { student_id: STU, earned: 5 })).error).toBe('Not authenticated')
    expect((await setProjectGradesReleased('p', 's', true)).error).toBe('Not authenticated')
  })

  it('reject a caller with no section access', async () => {
    auth()
    mockAdmin('none')
    expect((await gradeItemScore('i', 'p', 's', { student_id: STU, earned: 5 })).error).toBe(
      'You do not have access to this section',
    )
  })

  it('reject a grader (read-only in v1) from grading writes', async () => {
    auth()
    mockAdmin('grader')
    const perm = 'You do not have permission to perform this action'
    expect((await updatePhaseItemGrading('i', 'p', 's', validGrading)).error).toBe(perm)
    expect((await gradeItemScore('i', 'p', 's', { student_id: STU, earned: 5 })).error).toBe(perm)
    expect((await setProjectGradesReleased('p', 's', true)).error).toBe(perm)
  })
})

// ── gradeItemScore — the IDOR binds ──────────────────────────

describe('gradeItemScore — cross-section / cross-project binds', () => {
  it('rejects an item whose project is in another section, and never writes a score', async () => {
    auth()
    const { admin } = mockAdmin('professor', { project_phase_items: { data: null, error: null } })
    const res = await gradeItemScore('item-foreign', 'proj-1', 'section-1', { student_id: STU, earned: 5 })
    expect(res.error).toBe('Item not found')
    expect(admin.from).not.toHaveBeenCalledWith('project_item_scores')
  })

  it('rejects a student who is not a member of this project, and never writes a score', async () => {
    auth()
    const { admin } = mockAdmin('professor', {
      project_phase_items: { data: { id: 'item-1' }, error: null },
      project_members: { data: null, error: null }, // not on any team here
    })
    const res = await gradeItemScore('item-1', 'proj-1', 'section-1', { student_id: STU, earned: 5 })
    expect(res.error).toBe('That student is not on a team in this project')
    expect(admin.from).not.toHaveBeenCalledWith('project_item_scores')
  })

  it('rejects a team that is not in this project, and never writes a score', async () => {
    auth()
    const { admin } = mockAdmin('professor', {
      project_phase_items: { data: { id: 'item-1' }, error: null },
      project_teams: { data: null, error: null },
    })
    const res = await gradeItemScore('item-1', 'proj-1', 'section-1', { team_id: TEAM, earned: 5 })
    expect(res.error).toBe('Team not found')
    expect(admin.from).not.toHaveBeenCalledWith('project_item_scores')
  })

  it('writes an individual score with the verified institution + graded_by, and the exact upsert conflict target', async () => {
    auth()
    const { chains } = mockAdmin('professor', {
      project_phase_items: { data: { id: 'item-1' }, error: null },
      project_members: { data: { team_id: 'team-1' }, error: null },
    })
    const res = await gradeItemScore('item-1', 'proj-1', 'section-1', { student_id: STU, earned: 9 })
    expect(res).toEqual({ success: true })
    expect(chains.project_item_scores.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        phase_item_id: 'item-1',
        project_id: 'proj-1',
        institution_id: 'inst-1', // from the verified section, not the client
        student_id: STU,
        team_id: null,
        earned: 9,
        graded_by: CALLER,
      }),
      // Must match uq_project_item_score UNIQUE NULLS NOT DISTINCT (phase_item_id, team_id, student_id);
      // a mismatch would insert duplicate scores instead of updating.
      { onConflict: 'phase_item_id,team_id,student_id' },
    )
  })

  it('writes a team score with team_id set and student_id null', async () => {
    auth()
    const { chains } = mockAdmin('professor', {
      project_phase_items: { data: { id: 'item-1' }, error: null },
      project_teams: { data: { id: 'team-1' }, error: null },
    })
    const res = await gradeItemScore('item-1', 'proj-1', 'section-1', { team_id: TEAM, earned: 26 })
    expect(res).toEqual({ success: true })
    expect(chains.project_item_scores.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ team_id: TEAM, student_id: null, earned: 26 }),
      { onConflict: 'phase_item_id,team_id,student_id' },
    )
  })
})

// ── updatePhaseItemGrading / addManualPhaseItem / release binds ──

describe('other grading actions — binds & stamps', () => {
  it('updatePhaseItemGrading rejects a foreign item and never updates', async () => {
    auth()
    const { admin } = mockAdmin('professor', { project_phase_items: { data: null, error: null } })
    const res = await updatePhaseItemGrading('item-foreign', 'proj-1', 'section-1', validGrading)
    expect(res.error).toBe('Item not found')
    const updated = admin.from.mock.results.some(
      (r: any) => r.value?.update?.mock?.calls?.length > 0,
    )
    expect(updated).toBe(false)
  })

  it('addManualPhaseItem rejects a foreign phase and never inserts', async () => {
    auth()
    const { admin } = mockAdmin('professor', { project_master_phases: { data: null, error: null } })
    const res = await addManualPhaseItem('phase-foreign', 'proj-1', 'section-1', {
      item_type: 'manual',
      manual_title: 'Deliverable',
      weight: 30,
      grain: 'team',
    })
    expect(res.error).toBe('Phase not found')
    expect(admin.from).not.toHaveBeenCalledWith('project_phase_items')
  })

  it('addManualPhaseItem stamps institution + defaults manual_max to 100 for a manual item', async () => {
    auth()
    const { chains } = mockAdmin('professor', {
      // verifyMasterPhase does a bound select; a non-null row = phase belongs here.
      project_master_phases: { data: { id: 'phase-1' }, error: null },
      project_phase_items: { data: { id: 'new-item' }, error: null },
    })
    const res = await addManualPhaseItem('phase-1', 'proj-1', 'section-1', {
      item_type: 'manual',
      manual_title: 'Final deliverable',
      weight: 30,
      grain: 'team',
    })
    expect(res.success).toBe(true)
    expect(chains.project_phase_items.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        item_type: 'manual',
        institution_id: 'inst-1',
        manual_max: 100,
        weight: 30,
        grain: 'team',
      }),
    )
  })

  it('setProjectGradesReleased rejects a foreign project', async () => {
    auth()
    const { admin } = mockAdmin('professor', { projects: { data: null, error: null } })
    const res = await setProjectGradesReleased('proj-foreign', 'section-1', true)
    expect(res.error).toBe('Project not found')
    expect(admin.from).not.toHaveBeenCalledWith('project_grade_releases')
  })

  it('setProjectGradesReleased(true) upserts a release row; (false) deletes it', async () => {
    auth()
    const on = mockAdmin('professor', { projects: { data: { id: 'proj-1' }, error: null } })
    await setProjectGradesReleased('proj-1', 'section-1', true)
    expect(on.chains.project_grade_releases.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: 'proj-1', institution_id: 'inst-1', released_by: CALLER }),
      { onConflict: 'project_id' },
    )

    auth()
    const off = mockAdmin('professor', { projects: { data: { id: 'proj-1' }, error: null } })
    await setProjectGradesReleased('proj-1', 'section-1', false)
    expect(off.chains.project_grade_releases.delete).toHaveBeenCalled()
  })
})

// ── gradeItemScoreSchema — the team/student XOR refinement ────

describe('gradeItemScoreSchema — exactly one target', () => {
  it('accepts a team-only target', () => {
    expect(gradeItemScoreSchema.safeParse({ team_id: crypto.randomUUID(), earned: 5 }).success).toBe(true)
  })
  it('accepts a student-only target', () => {
    expect(gradeItemScoreSchema.safeParse({ student_id: crypto.randomUUID(), earned: 5 }).success).toBe(true)
  })
  it('rejects both targets set', () => {
    expect(
      gradeItemScoreSchema.safeParse({ team_id: crypto.randomUUID(), student_id: crypto.randomUUID(), earned: 5 }).success,
    ).toBe(false)
  })
  it('rejects neither target set', () => {
    expect(gradeItemScoreSchema.safeParse({ earned: 5 }).success).toBe(false)
  })
})
