// Leaving a project team (#699).
//
// The decision lives in the `leave_project_team` RPC, under one row lock, because the count and
// the delete cannot be separate round trips: two members leaving at the same instant would each
// see the other still present and both decline to clean up, stranding an empty team.
//
// What this file pins is the ACTION's contract with that RPC — that each outcome is translated
// into the right thing for the student, and that the two refusals are refusals rather than
// silent successes. The stakes are why:
//
//   Deleting a project team cascades to FOURTEEN tables, including project_grades,
//   project_item_scores, project_docs, project_videos and project_showcase. When this was
//   written, production had 21 teams of which 18 were already single-member and 2 of those
//   carried a grade. "Last member leaves, delete the team" was one click from destroying a
//   graded submission.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetUser = vi.fn()
const mockAdminClient = vi.fn()
const mockLogEvent = vi.fn()

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => mockAdminClient() }))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: (...a: unknown[]) => mockLogEvent(...a) }))

const ME = 'stu-1'
const TEAM = 'team-1'
const SECTION = 'sec-1'

/* eslint-disable @typescript-eslint/no-explicit-any */
let leaveTeam: any
let rpcSpy: any
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Admin client whose rpc() returns a chosen outcome, and which satisfies the enrollment check.
 *  verifyEnrollment does .from().select().eq().eq().in().single(), so the chain returns itself
 *  until single() resolves. */
function dbReturning(outcome: string | null, rpcError: unknown = null, enrolled = true) {
  rpcSpy = vi.fn(async () => ({ data: outcome, error: rpcError }))
  const chain: Record<string, unknown> = {}
  const self = () => chain
  chain.select = self
  chain.eq = self
  chain.in = self
  chain.single = async () => ({ data: enrolled ? { id: 'enr-1' } : null, error: null })
  chain.maybeSingle = chain.single
  return { rpc: rpcSpy, from: () => chain }
}

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockAdminClient.mockReset()
  mockLogEvent.mockReset()
  mockGetUser.mockResolvedValue({ data: { user: { id: ME } }, error: null })
  const mod = await import('@/app/(dashboard)/student/courses/[sectionId]/projects/actions')
  leaveTeam = mod.leaveTeam
})

describe('leaveTeam: who may leave', () => {
  it('rejects an unauthenticated caller before touching the database', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no user' } })
    mockAdminClient.mockReturnValue(dbReturning('left'))
    const r = await leaveTeam(TEAM, SECTION)
    expect(r.error).toBe('Not authenticated')
    expect(rpcSpy).not.toHaveBeenCalled()
  })

  it('passes the AUTHENTICATED user id, never one from the caller', async () => {
    /* The RPC takes the actor as an argument because the service-role client has no auth.uid().
       If this action ever forwarded a client-supplied id, any student could remove anyone. */
    mockAdminClient.mockReturnValue(dbReturning('left'))
    await leaveTeam(TEAM, SECTION)
    expect(rpcSpy).toHaveBeenCalledWith('leave_project_team', { p_team_id: TEAM, p_user_id: ME })
  })
})

describe('leaveTeam: who may leave', () => {
  it('refuses someone not enrolled in the course, before calling the RPC', async () => {
    mockAdminClient.mockReturnValue(dbReturning('left', null, false))
    const r = await leaveTeam(TEAM, SECTION)
    expect(r.error).toBe('Not enrolled in this course')
    expect(rpcSpy).not.toHaveBeenCalled()
  })
})

describe('leaveTeam: the two refusals are refusals', () => {
  it('will not let the last member take a graded team down with them', async () => {
    /* The whole reason this is not a plain delete. A student-initiated action must never
       destroy an academic record. */
    mockAdminClient.mockReturnValue(dbReturning('has_academic_record'))
    const r = await leaveTeam(TEAM, SECTION)
    expect(r.success).toBeUndefined()
    expect(r.error).toMatch(/submitted work or a grade/i)
    // and it must say who can help, not just "no"
    expect(r.error).toMatch(/professor/i)
    expect(mockLogEvent).not.toHaveBeenCalled()
  })

  it('makes an owner hand over before leaving teammates behind', async () => {
    mockAdminClient.mockReturnValue(dbReturning('owner_must_transfer'))
    const r = await leaveTeam(TEAM, SECTION)
    expect(r.success).toBeUndefined()
    expect(r.error).toMatch(/owner/i)
    expect(mockLogEvent).not.toHaveBeenCalled()
  })

  it('does not distinguish "not your team" from "no such team"', async () => {
    /* Different copy would confirm whether an arbitrary team id is real to someone outside it. */
    mockAdminClient.mockReturnValue(dbReturning('not_member'))
    const notMine = await leaveTeam(TEAM, SECTION)
    mockAdminClient.mockReturnValue(dbReturning('team_not_found'))
    const missing = await leaveTeam(TEAM, SECTION)
    expect(notMine.error).toBe(missing.error)
  })
})

describe('leaveTeam: the successes are distinguishable in the audit log', () => {
  it('logs a plain leave', async () => {
    mockAdminClient.mockReturnValue(dbReturning('left'))
    const r = await leaveTeam(TEAM, SECTION)
    expect(r.success).toBe(true)
    expect(mockLogEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'project.member_left', userId: ME }),
    )
  })

  it('logs a dissolve differently, because a team ceased to exist', async () => {
    /* Same student action, materially different consequence. One event type for both would make
       "where did that team go?" unanswerable from the log. */
    mockAdminClient.mockReturnValue(dbReturning('left_and_team_deleted'))
    const r = await leaveTeam(TEAM, SECTION)
    expect(r.success).toBe(true)
    expect(mockLogEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'project.team_dissolved' }),
    )
  })
})

describe('leaveTeam: failure handling', () => {
  it('reports a failure rather than a false success when the RPC errors', async () => {
    mockAdminClient.mockReturnValue(dbReturning(null, { message: 'boom' }))
    const r = await leaveTeam(TEAM, SECTION)
    expect(r.error).toBe('Failed to leave the team')
    expect(mockLogEvent).not.toHaveBeenCalled()
  })

  it('treats an unknown outcome as a failure instead of assuming it worked', async () => {
    /* If the RPC gains a new return value, defaulting to success would silently report a leave
       that did not happen. */
    mockAdminClient.mockReturnValue(dbReturning('some_future_outcome'))
    const r = await leaveTeam(TEAM, SECTION)
    expect(r.error).toBe('Failed to leave the team')
    expect(mockLogEvent).not.toHaveBeenCalled()
  })
})
