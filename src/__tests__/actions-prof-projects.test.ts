// Tests for professor/TA project workspace server actions — authorization
// gating for the TA access model. Graders must stay read-only; deleteProject
// must remain professor-only (nuclear: destroys teams/phases/videos/grades).
// These tests are load-bearing because silently loosening project permissions
// would let TAs delete sprint-end artifacts or let graders edit assignment specs.

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
  chain.single = vi.fn().mockResolvedValue(finalResult)
  chain.maybeSingle = vi.fn().mockResolvedValue(finalResult)
  chain.insert = vi.fn().mockReturnValue(chain)
  chain.update = vi.fn().mockReturnValue(chain)
  chain.delete = vi.fn().mockReturnValue(chain)
  chain.upsert = vi.fn().mockReturnValue(chain)
  chain.gt = vi.fn().mockReturnValue(chain)
  chain.then = undefined
  return chain
}

// ── Module-Level Mocks ───────────────────────────────────────

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

// ── Test Setup ───────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createProject: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let updateProject: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let deleteProject: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let getPhaseComments: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let addPhaseComment: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let deletePhaseComment: any

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockAdminClient.mockReset()

  const mod = await import(
    '@/app/(dashboard)/professor/courses/[sectionId]/projects/actions'
  )
  createProject = mod.createProject
  updateProject = mod.updateProject
  deleteProject = mod.deleteProject
  getPhaseComments = mod.getPhaseComments
  addPhaseComment = mod.addPhaseComment
  deletePhaseComment = mod.deletePhaseComment
})

// ── Auth + Role helpers ──────────────────────────────────────

function mockUnauthenticated() {
  mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'No user' } })
}

function mockAuthenticated(userId = 'prof-1') {
  mockGetUser.mockResolvedValue({ data: { user: { id: userId } }, error: null })
}

/** Stranger — section exists but caller is neither professor nor active staff. */
function mockNonAccessAdmin() {
  const admin = {
    from: vi.fn(() =>
      buildChain({ data: { id: 'section-1', professor_id: 'real-prof-id' }, error: null }),
    ),
  }
  mockAdminClient.mockReturnValue(admin)
  return admin
}

/** Caller is the section's professor — full privileges. */
function mockOwnerAdmin(userId: string) {
  const admin = {
    from: vi.fn(() =>
      buildChain({ data: { id: 'section-1', professor_id: userId }, error: null }),
    ),
  }
  mockAdminClient.mockReturnValue(admin)
  return admin
}

// ── Phase comments cross-section isolation (Vulns 14/15) ─────
// The caller is the professor of section-1, but the phase belongs to a
// project in another section (project_phases -> projects!inner(section_id)
// yields no row), so reads/writes must be rejected.

describe('phase comments — cross-section isolation', () => {
  function mockProfessorWithForeignPhase(userId: string) {
    const admin = {
      from: vi.fn((table: string) =>
        table === 'project_phases'
          ? buildChain({ data: null, error: null })
          : buildChain({ data: { id: 'section-1', professor_id: userId }, error: null }),
      ),
    }
    mockAdminClient.mockReturnValue(admin)
    return admin
  }

  it('getPhaseComments rejects a phase from another section', async () => {
    mockAuthenticated('prof-1')
    mockProfessorWithForeignPhase('prof-1')
    const res = await getPhaseComments('phase-other', 'section-1')
    expect(res.error).toBe('Phase not found')
  })

  it('addPhaseComment rejects a phase from another section', async () => {
    mockAuthenticated('prof-1')
    mockProfessorWithForeignPhase('prof-1')
    const res = await addPhaseComment('phase-other', 'section-1', 'injected comment')
    expect(res.error).toBe('Phase not found')
  })

  // deletePhaseComment binds comment -> phase -> project -> section before
  // deleting, so a staff user of section-1 can't delete a comment whose
  // project lives in another section by guessing its id (IDOR).
  function mockProfessorWithForeignComment(userId: string) {
    const admin = {
      from: vi.fn((table: string) =>
        table === 'phase_comments'
          ? buildChain({ data: null, error: null })
          : buildChain({ data: { id: 'section-1', professor_id: userId }, error: null }),
      ),
    }
    mockAdminClient.mockReturnValue(admin)
    return admin
  }

  it('deletePhaseComment rejects a comment from another section', async () => {
    mockAuthenticated('prof-1')
    const admin = mockProfessorWithForeignComment('prof-1')
    const res = await deletePhaseComment('comment-other', 'section-1')
    expect(res.error).toBe('Comment not found')
    // The section-binding guard must run BEFORE any delete is issued.
    const deleteCalled = admin.from.mock.results.some(
      (r) => (r.value as { delete: { mock: { calls: unknown[] } } }).delete.mock.calls.length > 0,
    )
    expect(deleteCalled).toBe(false)
  })
})

/** Caller is an active TA — can write most things, blocked only from nuclear ops. */
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

/** Caller is an active grader — read-only for v1. */
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

// ── Valid fixtures ───────────────────────────────────────────

const validProjectInput = {
  title: 'Capstone Project',
  description: 'Build something impressive.',
  guidelines: '',
  max_team_size: 4,
}

// ── createProject ────────────────────────────────────────────

describe('createProject', () => {
  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const result = await createProject('section-1', validProjectInput)
    expect(result.error).toBe('Not authenticated')
  })

  it('rejects invalid input (empty title) before hitting auth check', async () => {
    mockAuthenticated('prof-1')
    const result = await createProject('section-1', { ...validProjectInput, title: '' })
    expect(result.error).toMatch(/Invalid input/)
  })

  it('rejects users who do not have access to the section', async () => {
    mockAuthenticated('attacker-id')
    mockNonAccessAdmin()
    const result = await createProject('section-1', validProjectInput)
    expect(result.error).toBe('You do not have access to this section')
  })

  it('allows an active TA to create a project', async () => {
    mockAuthenticated('ta-user-id')
    mockActiveTaAdmin()
    const result = await createProject('section-1', validProjectInput)
    // TA should pass every gate; we only assert no denial.
    expect(result.error).not.toBe('You do not have access to this section')
    expect(result.error).not.toBe('You do not have permission to perform this action')
  })

  it('blocks a grader from creating a project', async () => {
    mockAuthenticated('grader-user-id')
    mockActiveGraderAdmin()
    const result = await createProject('section-1', validProjectInput)
    expect(result.error).toBe('You do not have permission to perform this action')
  })
})

// ── updateProject ────────────────────────────────────────────

describe('updateProject', () => {
  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const result = await updateProject('proj-1', 'section-1', { title: 'Renamed' })
    expect(result.error).toBe('Not authenticated')
  })

  it('rejects users who do not have access to the section', async () => {
    mockAuthenticated('attacker-id')
    mockNonAccessAdmin()
    const result = await updateProject('proj-1', 'section-1', { title: 'Hijacked' })
    expect(result.error).toBe('You do not have access to this section')
  })

  it('allows an active TA to update a project', async () => {
    mockAuthenticated('ta-user-id')
    mockActiveTaAdmin()
    const result = await updateProject('proj-1', 'section-1', { title: 'TA Edit' })
    expect(result.error).not.toBe('You do not have access to this section')
    expect(result.error).not.toBe('You do not have permission to perform this action')
  })

  it('blocks a grader from updating a project', async () => {
    mockAuthenticated('grader-user-id')
    mockActiveGraderAdmin()
    const result = await updateProject('proj-1', 'section-1', { title: 'Grader Edit' })
    expect(result.error).toBe('You do not have permission to perform this action')
  })
})

// ── deleteProject (nuclear — professor only) ─────────────────

describe('deleteProject', () => {
  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const result = await deleteProject('proj-1', 'section-1')
    expect(result.error).toBe('Not authenticated')
  })

  it('rejects users who do not have access to the section', async () => {
    mockAuthenticated('attacker-id')
    mockNonAccessAdmin()
    const result = await deleteProject('proj-1', 'section-1')
    expect(result.error).toBe('You do not have access to this section')
  })

  it('blocks TAs (deleteProject is nuclear — destroys teams, phases, videos, grades)', async () => {
    mockAuthenticated('ta-user-id')
    mockActiveTaAdmin()
    const result = await deleteProject('proj-1', 'section-1')
    expect(result.error).toBe('Only the professor can delete a project')
  })

  it('blocks graders', async () => {
    mockAuthenticated('grader-user-id')
    mockActiveGraderAdmin()
    const result = await deleteProject('proj-1', 'section-1')
    expect(result.error).toBe('Only the professor can delete a project')
  })

  it('allows the section professor to delete', async () => {
    mockAuthenticated('prof-1')
    mockOwnerAdmin('prof-1')
    const result = await deleteProject('proj-1', 'section-1')
    // Happy path may still bottom out on a subsequent mock chain — we only
    // assert that neither authorization gate blocked the call.
    expect(result.error).not.toBe('Only the professor can delete a project')
    expect(result.error).not.toBe('You do not have access to this section')
  })
})

