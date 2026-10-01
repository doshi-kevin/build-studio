// Tests for student team invitation server actions — sendTeamInvitation,
// getSentInvitations, getMyInvitations, respondToInvitation, withdrawInvitation.
// Covers auth guards, enrollment checks, ownership checks, team-full enforcement,
// re-invite handling, CAS accept flow, and decline-other-invitations side effects.

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
  chain.lte = vi.fn().mockReturnValue(chain)
  // Make chain thenable so `await chain` (without .single()) resolves to finalResult
  chain.then = (resolve: (v: unknown) => void) => Promise.resolve(finalResult).then(resolve)
  return chain
}

// ── Module-Level Mock References ─────────────────────────────

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

// Also mock the AI client since the module imports it at top level
vi.mock('@/lib/ai/llm-client', () => ({
  generateProjectPhases: vi.fn(),
}))

// ── Action References ───────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sendTeamInvitation: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let getSentInvitations: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let getMyInvitations: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let respondToInvitation: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let withdrawInvitation: any

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockAdminClient.mockReset()

  const mod = await import(
    '@/app/(dashboard)/student/courses/[sectionId]/projects/actions'
  )
  sendTeamInvitation = mod.sendTeamInvitation
  getSentInvitations = mod.getSentInvitations
  getMyInvitations = mod.getMyInvitations
  respondToInvitation = mod.respondToInvitation
  withdrawInvitation = mod.withdrawInvitation
})

// ── Helpers ──────────────────────────────────────────────────

function mockAuthenticated(userId = 'student-123') {
  mockGetUser.mockResolvedValue({ data: { user: { id: userId } }, error: null })
}

function mockUnauthenticated() {
  mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'No user' } })
}

/** Admin client that returns no enrollment (empty .single()) */
function mockNotEnrolled() {
  const admin = {
    from: vi.fn(() => buildChain({ data: null, error: null })),
  }
  mockAdminClient.mockReturnValue(admin)
  return admin
}

/**
 * Build an admin mock that routes table calls to different chain results.
 * Each entry in the sequence is consumed in order of `.from()` calls.
 */
/**
 * @param rpcResult What `join_project_team_atomic` returns. Team capacity is decided
 *   inside that locking RPC now, not by a read-then-insert here (#698) — a JS-side count
 *   could not be made atomic, so the sequence no longer contains the project /
 *   current-members reads that used to drive the decision.
 */
function mockAdminWithSequence(
  sequence: Array<{ data: unknown; error: unknown }>,
  rpcResult: unknown = { ok: true },
) {
  let callIdx = 0
  const admin = {
    from: vi.fn(() => {
      const result = sequence[callIdx] ?? { data: null, error: null }
      callIdx++
      return buildChain(result)
    }),
    rpc: vi.fn(async () => ({ data: rpcResult, error: null })),
  }
  mockAdminClient.mockReturnValue(admin)
  return admin
}

// ── sendTeamInvitation ──────────────────────────────────────

describe('sendTeamInvitation', () => {
  const teamId = 'team-1'
  const projectId = 'project-1'
  const sectionId = 'section-1'
  const invitedUserId = 'student-456'

  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const result = await sendTeamInvitation(teamId, projectId, sectionId, invitedUserId)
    expect(result.error).toBe('Not authenticated')
  })

  it('rejects non-enrolled students', async () => {
    mockAuthenticated()
    mockNotEnrolled()
    const result = await sendTeamInvitation(teamId, projectId, sectionId, invitedUserId)
    expect(result.error).toBe('Not enrolled in this course')
  })

  it('rejects non-owner callers', async () => {
    mockAuthenticated()
    // Sequence: 1) enrollment check passes, 2) verifyTeamAccess returns 'member' not 'owner'
    mockAdminWithSequence([
      { data: { id: 'enroll-1' }, error: null }, // enrollment
      { data: { id: 'pm-1', role: 'member' }, error: null }, // project_members (team access)
    ])
    const result = await sendTeamInvitation(teamId, projectId, sectionId, invitedUserId)
    expect(result.error).toBe('Only team owners can send invitations')
  })

  it('rejects when team is full', async () => {
    mockAuthenticated()
    mockAdminWithSequence([
      { data: { id: 'enroll-1' }, error: null }, // enrollment
      { data: { id: 'pm-1', role: 'owner' }, error: null }, // team access (owner)
      { data: { max_team_size: 2 }, error: null }, // projects (max size)
      { data: [{ id: 'mem-1' }, { id: 'mem-2' }], error: null }, // current members (full)
    ])
    const result = await sendTeamInvitation(teamId, projectId, sectionId, invitedUserId)
    expect(result.error).toBe('Team is full (max 2 members)')
  })

  it('rejects when target user is not enrolled', async () => {
    mockAuthenticated()
    mockAdminWithSequence([
      { data: { id: 'enroll-1' }, error: null }, // enrollment
      { data: { id: 'pm-1', role: 'owner' }, error: null }, // team access
      { data: { max_team_size: 5 }, error: null }, // projects
      { data: [{ id: 'mem-1' }], error: null }, // current members (1, not full)
      { data: null, error: null }, // target enrollment — not found
    ])
    const result = await sendTeamInvitation(teamId, projectId, sectionId, invitedUserId)
    expect(result.error).toBe('User is not enrolled in this course')
  })

  it('rejects when target is already in a team for the project', async () => {
    mockAuthenticated()
    mockAdminWithSequence([
      { data: { id: 'enroll-1' }, error: null }, // enrollment
      { data: { id: 'pm-1', role: 'owner' }, error: null }, // team access
      { data: { max_team_size: 5 }, error: null }, // projects
      { data: [{ id: 'mem-1' }], error: null }, // current members
      { data: { id: 'target-enroll' }, error: null }, // target enrollment (found)
      { data: [{ id: 'team-1' }], error: null }, // project_teams for this project
      { data: [{ user_id: invitedUserId }], error: null }, // existing members — target is in a team
    ])
    const result = await sendTeamInvitation(teamId, projectId, sectionId, invitedUserId)
    expect(result.error).toBe('This student is already in a team for this project')
  })

  it('rejects when a pending invitation already exists', async () => {
    mockAuthenticated()
    mockAdminWithSequence([
      { data: { id: 'enroll-1' }, error: null }, // enrollment
      { data: { id: 'pm-1', role: 'owner' }, error: null }, // team access
      { data: { max_team_size: 5 }, error: null }, // projects
      { data: [{ id: 'mem-1' }], error: null }, // current members
      { data: { id: 'target-enroll' }, error: null }, // target enrollment
      { data: [{ id: 'team-1' }], error: null }, // project_teams
      { data: [], error: null }, // existing members (target not in team)
      { data: { id: 'inv-1', status: 'pending' }, error: null }, // existing invitation — pending
    ])
    const result = await sendTeamInvitation(teamId, projectId, sectionId, invitedUserId)
    expect(result.error).toBe('An invitation has already been sent to this student')
  })

  it('re-invites when previous invitation was declined', async () => {
    mockAuthenticated()
    mockAdminWithSequence([
      { data: { id: 'enroll-1' }, error: null }, // enrollment
      { data: { id: 'pm-1', role: 'owner' }, error: null }, // team access
      { data: { max_team_size: 5 }, error: null }, // projects
      { data: [{ id: 'mem-1' }], error: null }, // current members
      { data: { id: 'target-enroll' }, error: null }, // target enrollment
      { data: [{ id: 'team-1' }], error: null }, // project_teams
      { data: [], error: null }, // existing members (target not in team)
      { data: { id: 'inv-1', status: 'declined' }, error: null }, // existing invitation — declined
      { data: null, error: null }, // update succeeds
    ])
    const result = await sendTeamInvitation(teamId, projectId, sectionId, invitedUserId, 'Join us!')
    expect(result.success).toBe(true)
  })

  it('sends a new invitation when no prior invitation exists', async () => {
    mockAuthenticated()
    mockAdminWithSequence([
      { data: { id: 'enroll-1' }, error: null }, // enrollment
      { data: { id: 'pm-1', role: 'owner' }, error: null }, // team access
      { data: { max_team_size: 5 }, error: null }, // projects
      { data: [{ id: 'mem-1' }], error: null }, // current members
      { data: { id: 'target-enroll' }, error: null }, // target enrollment
      { data: [{ id: 'team-1' }], error: null }, // project_teams
      { data: [], error: null }, // existing members (target not in team)
      { data: null, error: null }, // no existing invitation (single returns null)
      { data: null, error: null }, // insert succeeds
    ])
    const result = await sendTeamInvitation(teamId, projectId, sectionId, invitedUserId)
    expect(result.success).toBe(true)
  })
})

// ── getSentInvitations ──────────────────────────────────────

describe('getSentInvitations', () => {
  const teamId = 'team-1'
  const sectionId = 'section-1'

  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const result = await getSentInvitations(teamId, sectionId)
    expect(result.error).toBe('Not authenticated')
  })

  it('rejects non-enrolled students', async () => {
    mockAuthenticated()
    mockNotEnrolled()
    const result = await getSentInvitations(teamId, sectionId)
    expect(result.error).toBe('Not enrolled in this course')
  })

  it('returns invitations with profiles when enrolled', async () => {
    mockAuthenticated()
    const invitations = [
      {
        id: 'inv-1', team_id: teamId, project_id: 'p-1', section_id: sectionId,
        invited_by: 'student-123', invited_user_id: 'student-456',
        message: null, status: 'pending', created_at: '2026-01-01', responded_at: null,
      },
    ]
    const profiles = [{ id: 'student-456', name: 'Alice', email: 'alice@test.com', avatar_url: null }]

    mockAdminWithSequence([
      { data: { id: 'enroll-1' }, error: null }, // enrollment
      // verifyTeamAccess — enrollment alone is not authorization for a caller-supplied
      // teamId, so this step is new (#697).
      { data: { id: 'pm-1', role: 'member' }, error: null }, // project_members (team access)
      { data: invitations, error: null }, // team_invitations
      { data: profiles, error: null }, // profiles
    ])
    const result = await getSentInvitations(teamId, sectionId)
    expect(result.data).toHaveLength(1)
    expect(result.data![0].invited_profile).toEqual({
      name: 'Alice', email: 'alice@test.com', avatar_url: null,
    })
  })

  it('returns empty array when no invitations', async () => {
    mockAuthenticated()
    mockAdminWithSequence([
      { data: { id: 'enroll-1' }, error: null }, // enrollment
      { data: { id: 'pm-1', role: 'member' }, error: null }, // verifyTeamAccess (#697)
      { data: [], error: null }, // no invitations
    ])
    const result = await getSentInvitations(teamId, sectionId)
    expect(result.data).toEqual([])
  })
})

// ── getMyInvitations ────────────────────────────────────────

describe('getMyInvitations', () => {
  const projectId = 'project-1'
  const sectionId = 'section-1'

  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const result = await getMyInvitations(projectId, sectionId)
    expect(result.error).toBe('Not authenticated')
  })

  it('rejects non-enrolled students', async () => {
    mockAuthenticated()
    mockNotEnrolled()
    const result = await getMyInvitations(projectId, sectionId)
    expect(result.error).toBe('Not enrolled in this course')
  })

  it('returns invitations with inviter profiles and team names', async () => {
    mockAuthenticated()
    const invitations = [
      {
        id: 'inv-1', team_id: 'team-1', project_id: projectId, section_id: sectionId,
        invited_by: 'student-owner', invited_user_id: 'student-123',
        message: 'Join our team!', status: 'pending', created_at: '2026-01-01', responded_at: null,
      },
    ]
    const profiles = [{ id: 'student-owner', name: 'Bob', email: 'bob@test.com', avatar_url: 'avatar.png' }]
    const teams = [{ id: 'team-1', name: 'Alpha Team' }]

    mockAdminWithSequence([
      { data: { id: 'enroll-1' }, error: null }, // enrollment
      { data: invitations, error: null }, // team_invitations
      { data: profiles, error: null }, // profiles (inviters)
      { data: teams, error: null }, // project_teams
    ])
    const result = await getMyInvitations(projectId, sectionId)
    expect(result.data).toHaveLength(1)
    expect(result.data![0].inviter_profile).toEqual({
      name: 'Bob', email: 'bob@test.com', avatar_url: 'avatar.png',
    })
    expect(result.data![0].team_name).toBe('Alpha Team')
  })

  it('returns empty array when no invitations', async () => {
    mockAuthenticated()
    mockAdminWithSequence([
      { data: { id: 'enroll-1' }, error: null }, // enrollment
      { data: [], error: null }, // no invitations
    ])
    const result = await getMyInvitations(projectId, sectionId)
    expect(result.data).toEqual([])
  })
})

// ── respondToInvitation ─────────────────────────────────────

describe('respondToInvitation', () => {
  const invitationId = 'inv-1'
  const sectionId = 'section-1'

  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const result = await respondToInvitation(invitationId, sectionId, true)
    expect(result.error).toBe('Not authenticated')
  })

  it('rejects non-enrolled students', async () => {
    mockAuthenticated()
    mockNotEnrolled()
    const result = await respondToInvitation(invitationId, sectionId, true)
    expect(result.error).toBe('Not enrolled in this course')
  })

  it('returns error when invitation not found', async () => {
    mockAuthenticated()
    mockAdminWithSequence([
      { data: { id: 'enroll-1' }, error: null }, // enrollment
      { data: null, error: null }, // invitation not found
    ])
    const result = await respondToInvitation(invitationId, sectionId, true)
    expect(result.error).toBe('Invitation not found')
  })

  it('rejects when invitation already responded to', async () => {
    mockAuthenticated()
    mockAdminWithSequence([
      { data: { id: 'enroll-1' }, error: null }, // enrollment
      { data: { id: invitationId, team_id: 'team-1', project_id: 'project-1', invited_user_id: 'student-123', status: 'accepted' }, error: null },
    ])
    const result = await respondToInvitation(invitationId, sectionId, true)
    expect(result.error).toBe('Invitation has already been responded to')
  })

  it('rejects accept when team is full', async () => {
    mockAuthenticated()
    mockAdminWithSequence(
      [
        { data: { id: 'enroll-1' }, error: null }, // enrollment
        { data: { id: invitationId, team_id: 'team-1', project_id: 'project-1', invited_user_id: 'student-123', status: 'pending' }, error: null }, // invitation
      ],
      // The RPC refuses under the team row lock — two students taking the last slot
      // cannot both be told yes (#698).
      { ok: false, reason: 'full', count: 2, cap: 2 },
    )
    const result = await respondToInvitation(invitationId, sectionId, true)
    expect(result.error).toBe('Team is now full. Cannot accept this invitation.')
  })

  it('rejects accept when user is already in a team for the project', async () => {
    mockAuthenticated()
    mockAdminWithSequence(
      [
        { data: { id: 'enroll-1' }, error: null }, // enrollment
        { data: { id: invitationId, team_id: 'team-1', project_id: 'project-1', invited_user_id: 'student-123', status: 'pending' }, error: null }, // invitation
      ],
      /* The already-in-a-team check moved into the RPC too: it shares the UNIQUE
         (project_id, user_id) constraint's subject, and doing it there keeps it under the
         same lock instead of racing the insert (#698). */
      { ok: false, reason: 'already_member' },
    )
    const result = await respondToInvitation(invitationId, sectionId, true)
    expect(result.error).toBe('You are already in a team for this project')
  })

  it('successfully accepts invitation (adds to team, declines others)', async () => {
    mockAuthenticated()
    mockAdminWithSequence([
      { data: { id: 'enroll-1' }, error: null }, // enrollment
      { data: { id: invitationId, team_id: 'team-1', project_id: 'project-1', invited_user_id: 'student-123', status: 'pending' }, error: null }, // invitation
      // Capacity + membership + insert all happen in the RPC now (#698); the sequence
      // resumes at the invitation status update.
      { data: null, error: null }, // update invitation to accepted (CAS)
      { data: null, error: null }, // insert project_members
      { data: null, error: null }, // decline other pending invitations
      { data: null, error: null }, // decline pending join requests
    ])
    const result = await respondToInvitation(invitationId, sectionId, true)
    expect(result.success).toBe(true)
  })

  it('successfully declines invitation', async () => {
    mockAuthenticated()
    mockAdminWithSequence([
      { data: { id: 'enroll-1' }, error: null }, // enrollment
      { data: { id: invitationId, team_id: 'team-1', project_id: 'project-1', invited_user_id: 'student-123', status: 'pending' }, error: null }, // invitation
      { data: null, error: null }, // update invitation to declined (CAS)
    ])
    const result = await respondToInvitation(invitationId, sectionId, false)
    expect(result.success).toBe(true)
  })
})

// ── withdrawInvitation ──────────────────────────────────────

describe('withdrawInvitation', () => {
  const invitationId = 'inv-1'
  const teamId = 'team-1'
  const sectionId = 'section-1'

  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const result = await withdrawInvitation(invitationId, teamId, sectionId)
    expect(result.error).toBe('Not authenticated')
  })

  it('rejects non-enrolled students', async () => {
    mockAuthenticated()
    mockNotEnrolled()
    const result = await withdrawInvitation(invitationId, teamId, sectionId)
    expect(result.error).toBe('Not enrolled in this course')
  })

  it('rejects non-owner callers', async () => {
    mockAuthenticated()
    mockAdminWithSequence([
      { data: { id: 'enroll-1' }, error: null }, // enrollment
      { data: { id: 'pm-1', role: 'member' }, error: null }, // team access (member, not owner)
    ])
    const result = await withdrawInvitation(invitationId, teamId, sectionId)
    expect(result.error).toBe('Only team owners can withdraw invitations')
  })

  it('successfully withdraws a pending invitation', async () => {
    mockAuthenticated()
    mockAdminWithSequence([
      { data: { id: 'enroll-1' }, error: null }, // enrollment
      { data: { id: 'pm-1', role: 'owner' }, error: null }, // team access (owner)
      { data: null, error: null }, // delete succeeds
    ])
    const result = await withdrawInvitation(invitationId, teamId, sectionId)
    expect(result.success).toBe(true)
  })
})
