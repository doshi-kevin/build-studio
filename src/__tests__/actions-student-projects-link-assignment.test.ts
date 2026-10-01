// Tests for the "Link Assignment to project phase" server actions:
//   getLinkableAssignments  — enrollment gate + published-only read
//   createPhaseFromAssignment — the full guard chain (auth → enrollment →
//     team role → team/project integrity → assignment IDOR + published),
//     the TIMESTAMPTZ→DATE conversion, and the tri-state insert-mode mapping.
//
// The insert-mode mapping and due-date conversion are the load-bearing logic
// here: they live inline in the action (no pure helper to unit-test), so they
// are pinned via the args passed to the insert_project_phase RPC.

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
  chain.then = (onFulfilled: (v: unknown) => unknown) =>
    Promise.resolve(finalResult).then(onFulfilled)
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

// ── Action Handles ───────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
let getLinkableAssignments: any
let createPhaseFromAssignment: any
/* eslint-enable @typescript-eslint/no-explicit-any */

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockAdminClient.mockReset()

  const mod = await import(
    '@/app/(dashboard)/student/courses/[sectionId]/projects/actions'
  )
  getLinkableAssignments = mod.getLinkableAssignments
  createPhaseFromAssignment = mod.createPhaseFromAssignment
})

function mockUnauthenticated() {
  mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no user' } })
}

function mockAuthenticated(userId = 'user-1') {
  mockGetUser.mockResolvedValue({ data: { user: { id: userId } }, error: null })
}

// Standard fixtures for the happy path.
const SECTION = 'section-1'
const PROJECT = 'project-1'
const TEAM = 'team-1'
const ASSIGNMENT = 'assignment-1'

const publishedAssignment = {
  id: ASSIGNMENT,
  title: 'Build a REST API',
  description: '<p>Ship it</p>',
  due_at: '2026-08-15T23:59:00.000Z',
  status: 'published',
  section_id: SECTION,
}

// ── getLinkableAssignments ───────────────────────────────────

describe('getLinkableAssignments', () => {
  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const result = await getLinkableAssignments(SECTION)
    expect(result.error).toBe('Not authenticated')
  })

  it('rejects users not enrolled in the section', async () => {
    mockAuthenticated()
    const admin = { from: vi.fn(() => buildChain({ data: null, error: null })) } // no enrollment
    mockAdminClient.mockReturnValue(admin)
    const result = await getLinkableAssignments(SECTION)
    expect(result.error).toBe('Not enrolled in this course')
  })

  it('returns published assignments for an enrolled student', async () => {
    mockAuthenticated()
    const rows = [{ id: ASSIGNMENT, title: 'Build a REST API', due_at: null, points: 100 }]
    let call = 0
    const admin = {
      from: vi.fn(() => {
        call++
        if (call === 1) return buildChain({ data: { id: 'enr' }, error: null }) // enrollment
        return buildChain({ data: rows, error: null }) // assignments query (thenable)
      }),
    }
    mockAdminClient.mockReturnValue(admin)
    const result = await getLinkableAssignments(SECTION)
    expect(result.success).toBe(true)
    expect(result.data).toEqual(rows)
  })

  it('returns an error message when the assignments query fails', async () => {
    mockAuthenticated()
    let call = 0
    const admin = {
      from: vi.fn(() => {
        call++
        if (call === 1) return buildChain({ data: { id: 'enr' }, error: null })
        return buildChain({ data: null, error: { message: 'boom' } })
      }),
    }
    mockAdminClient.mockReturnValue(admin)
    const result = await getLinkableAssignments(SECTION)
    expect(result.error).toBe('Failed to load assignments')
  })
})

// ── createPhaseFromAssignment ────────────────────────────────

describe('createPhaseFromAssignment', () => {
  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const result = await createPhaseFromAssignment(TEAM, PROJECT, SECTION, ASSIGNMENT)
    expect(result.error).toBe('Not authenticated')
  })

  it('rejects users not enrolled in the section', async () => {
    mockAuthenticated()
    const admin = { from: vi.fn(() => buildChain({ data: null, error: null })) }
    mockAdminClient.mockReturnValue(admin)
    const result = await createPhaseFromAssignment(TEAM, PROJECT, SECTION, ASSIGNMENT)
    expect(result.error).toBe('Not enrolled in this course')
  })

  it('rejects viewers (non-editing team members)', async () => {
    mockAuthenticated()
    let call = 0
    const admin = {
      from: vi.fn(() => {
        call++
        if (call === 1) return buildChain({ data: { id: 'enr' }, error: null }) // enrollment
        return buildChain({ data: { id: 'm', role: 'viewer' }, error: null }) // project_members
      }),
    }
    mockAdminClient.mockReturnValue(admin)
    const result = await createPhaseFromAssignment(TEAM, PROJECT, SECTION, ASSIGNMENT)
    expect(result.error).toBe('Only team members can create phases')
  })

  it('rejects when the team does not belong to the named project (integrity guard)', async () => {
    mockAuthenticated()
    let call = 0
    const admin = {
      from: vi.fn(() => {
        call++
        if (call === 1) return buildChain({ data: { id: 'enr' }, error: null }) // enrollment
        if (call === 2) return buildChain({ data: { id: 'm', role: 'owner' }, error: null }) // members
        // project_teams → team belongs to a DIFFERENT project
        return buildChain({ data: { id: TEAM, project_id: 'other-project' }, error: null })
      }),
    }
    mockAdminClient.mockReturnValue(admin)
    const result = await createPhaseFromAssignment(TEAM, PROJECT, SECTION, ASSIGNMENT)
    expect(result.error).toBe('Team does not belong to this project')
  })

  it('rejects an assignment from a different section (IDOR guard)', async () => {
    mockAuthenticated()
    let call = 0
    const admin = {
      from: vi.fn(() => {
        call++
        if (call === 1) return buildChain({ data: { id: 'enr' }, error: null })
        if (call === 2) return buildChain({ data: { id: 'm', role: 'owner' }, error: null })
        if (call === 3) return buildChain({ data: { id: TEAM, project_id: PROJECT }, error: null })
        // assignments → belongs to another section
        return buildChain({
          data: { ...publishedAssignment, section_id: 'other-section' },
          error: null,
        })
      }),
    }
    mockAdminClient.mockReturnValue(admin)
    const result = await createPhaseFromAssignment(TEAM, PROJECT, SECTION, ASSIGNMENT)
    expect(result.error).toBe('Assignment not found')
  })

  it('rejects an unpublished assignment', async () => {
    mockAuthenticated()
    let call = 0
    const admin = {
      from: vi.fn(() => {
        call++
        if (call === 1) return buildChain({ data: { id: 'enr' }, error: null })
        if (call === 2) return buildChain({ data: { id: 'm', role: 'owner' }, error: null })
        if (call === 3) return buildChain({ data: { id: TEAM, project_id: PROJECT }, error: null })
        return buildChain({ data: { ...publishedAssignment, status: 'draft' }, error: null })
      }),
    }
    mockAdminClient.mockReturnValue(admin)
    const result = await createPhaseFromAssignment(TEAM, PROJECT, SECTION, ASSIGNMENT)
    expect(result.error).toBe('Only published assignments can be linked')
  })

  // Helper: wires the full happy path up to (and including) the RPC + link
  // update, capturing the RPC args so tests can assert on the mapped values.
  function buildHappyAdmin(
    assignment: Record<string, unknown> = publishedAssignment,
    rpcResult: { data: unknown; error: unknown } = { data: 'new-phase-1', error: null },
  ) {
    const rpc = vi.fn().mockResolvedValue(rpcResult)
    let call = 0
    const admin = {
      rpc,
      from: vi.fn(() => {
        call++
        if (call === 1) return buildChain({ data: { id: 'enr' }, error: null }) // enrollment
        if (call === 2) return buildChain({ data: { id: 'm', role: 'owner' }, error: null }) // members
        if (call === 3) return buildChain({ data: { id: TEAM, project_id: PROJECT }, error: null }) // teams
        if (call === 4) return buildChain({ data: assignment, error: null }) // assignments
        return buildChain({ data: null, error: null }) // link UPDATE (thenable)
      }),
    }
    return { admin, rpc }
  }

  it('creates the phase, converts due_at to a DATE, and links the assignment', async () => {
    mockAuthenticated()
    const { admin, rpc } = buildHappyAdmin()
    mockAdminClient.mockReturnValue(admin)

    const result = await createPhaseFromAssignment(TEAM, PROJECT, SECTION, ASSIGNMENT)
    expect(result.success).toBe(true)

    const rpcArgs = rpc.mock.calls[0]
    expect(rpcArgs[0]).toBe('insert_project_phase')
    // TIMESTAMPTZ 2026-08-15T23:59Z → DATE (yyyy-mm-dd)
    expect(rpcArgs[1].p_due_date).toBe('2026-08-15')
    expect(rpcArgs[1].p_title).toBe('Build a REST API')
    // undefined anchor → append at end, no anchor phase
    expect(rpcArgs[1].p_insert_mode).toBe('append')
    expect(rpcArgs[1].p_anchor_phase_id).toBeNull()
  })

  it('maps a null anchor to insert-at-top', async () => {
    mockAuthenticated()
    const { admin, rpc } = buildHappyAdmin()
    mockAdminClient.mockReturnValue(admin)

    await createPhaseFromAssignment(TEAM, PROJECT, SECTION, ASSIGNMENT, null)
    expect(rpc.mock.calls[0][1].p_insert_mode).toBe('top')
    expect(rpc.mock.calls[0][1].p_anchor_phase_id).toBeNull()
  })

  it('maps an anchor id to insert-after that phase', async () => {
    mockAuthenticated()
    const { admin, rpc } = buildHappyAdmin()
    mockAdminClient.mockReturnValue(admin)

    await createPhaseFromAssignment(TEAM, PROJECT, SECTION, ASSIGNMENT, 'phase-42')
    expect(rpc.mock.calls[0][1].p_insert_mode).toBe('after')
    expect(rpc.mock.calls[0][1].p_anchor_phase_id).toBe('phase-42')
  })

  it('passes a null due date through when the assignment has no due_at', async () => {
    mockAuthenticated()
    const { admin, rpc } = buildHappyAdmin({ ...publishedAssignment, due_at: null })
    mockAdminClient.mockReturnValue(admin)

    await createPhaseFromAssignment(TEAM, PROJECT, SECTION, ASSIGNMENT)
    expect(rpc.mock.calls[0][1].p_due_date).toBeNull()
  })

  it('returns an error and does not link when the RPC fails', async () => {
    mockAuthenticated()
    const { admin } = buildHappyAdmin(publishedAssignment, { data: null, error: { message: 'rpc boom' } })
    mockAdminClient.mockReturnValue(admin)

    const result = await createPhaseFromAssignment(TEAM, PROJECT, SECTION, ASSIGNMENT)
    expect(result.error).toBe('Failed to create phase')
  })
})
