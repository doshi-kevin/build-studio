/**
 * #697 — two server actions checked course ENROLLMENT and then queried by a
 * caller-supplied id, with no team-membership check. Any enrolled student who passed
 * another team's id got that team's data: pending invitees' names and email addresses,
 * and the team's private phase feedback.
 *
 * #698 — both accept paths read the member count, decided in JS, then inserted. Two
 * students taking the last slot both passed the check; live-reproduced at 5 members
 * against a cap of 4, and one production team is over cap because of it.
 *
 * The oracles here are structural, because that is where these bugs live:
 *   • #697 — was verifyTeamAccess consulted BEFORE the data query, and is the refusal
 *     the same for "no such team" and "not your team" (so it cannot be used to probe
 *     which ids exist)?
 *   • #698 — is the capacity decision made by the locking RPC rather than by a
 *     read-then-insert in JS? Asserting "team not over cap" against a mock would pass
 *     against the old code too, since the mock never runs concurrently.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetUser = vi.fn()
const mockAdminClient = vi.fn()

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: (...a: unknown[]) => mockAdminClient(...a),
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
vi.mock('@/lib/events/emit', () => ({ emitEvent: vi.fn() }))
vi.mock('@/lib/ai/llm-client', () => ({ generateProjectPhases: vi.fn() }))
vi.mock('@/lib/chat/system-messages', () => ({ emitSystemMessage: vi.fn() }))

const CALLER = 'student-1'
const SECTION = 'sec-1'
const OTHER_TEAM = 'team-other'
const OTHER_PHASE = 'phase-other'

interface Recorder {
  tables: string[]
  rpcs: Array<{ name: string; args: Record<string, unknown> }>
}

/**
 * Admin double. `memberOf` decides what project_members returns for the caller — an
 * empty list is "not a member of the team you asked about".
 */
function makeAdmin(opts: { memberOf: string[]; rpcResult?: unknown }): { db: unknown; rec: Recorder } {
  const rec: Recorder = { tables: [], rpcs: [] }

  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {}
    const self = () => chain
    const rows =
      table === 'enrollments'
        ? [{ id: 'e1', status: 'enrolled' }]
        : table === 'team_invitations'
          // A real pending invitation addressed to the caller, so respondToInvitation
          // reaches the capacity decision rather than exiting at "not found".
          ? [{ id: 'inv-1', team_id: 'team-a', project_id: 'proj-1', invited_user_id: CALLER, status: 'pending' }]
        : table === 'project_members'
          ? opts.memberOf.map((t) => ({ id: 'm', team_id: t, user_id: CALLER, role: 'member' }))
          : table === 'project_phases'
            ? [{ team_id: OTHER_TEAM }]
            : []
    Object.assign(chain, {
      select: self, eq: self, neq: self, in: self, is: self, order: self, limit: self,
      insert: self, update: self, delete: self, upsert: self, gt: self,
      single: async () => ({ data: rows[0] ?? null, error: null }),
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      then: (res: (v: { data: unknown; error: null }) => unknown) => res({ data: rows, error: null }),
    })
    return chain
  }

  const db = {
    from(table: string) {
      rec.tables.push(table)
      return chainFor(table)
    },
    rpc(name: string, args: Record<string, unknown>) {
      rec.rpcs.push({ name, args })
      return Promise.resolve({ data: opts.rpcResult ?? { ok: true }, error: null })
    },
  }
  return { db, rec }
}

async function load() {
  return await import('@/app/(dashboard)/student/courses/[sectionId]/projects/actions')
}

describe('#697 — team-scoped reads must check membership, not just enrollment', () => {
  beforeEach(() => {
    vi.resetModules()
    mockGetUser.mockReset().mockResolvedValue({ data: { user: { id: CALLER } } })
    mockAdminClient.mockReset()
  })

  it('refuses getSentInvitations for a team the caller is not in', async () => {
    // Enrolled in the course, member of NO team — the exact attacker shape.
    const { db, rec } = makeAdmin({ memberOf: [] })
    mockAdminClient.mockReturnValue(db)

    const mod = await load()
    const res = await mod.getSentInvitations(OTHER_TEAM, SECTION)

    expect(res.error).toBeTruthy()
    expect(res.data).toBeUndefined()
    // The invitee profiles must never have been fetched.
    expect(rec.tables).not.toContain('team_invitations')
    expect(rec.tables).not.toContain('profiles')
  })

  it('refuses getPhaseCommentsForStudent for another team\'s phase', async () => {
    const { db, rec } = makeAdmin({ memberOf: [] })
    mockAdminClient.mockReturnValue(db)

    const mod = await load()
    const res = await mod.getPhaseCommentsForStudent(OTHER_PHASE, SECTION)

    expect(res.error).toBeTruthy()
    expect(res.data).toBeUndefined()
    expect(rec.tables).not.toContain('phase_comments')
  })

  it('gives the same refusal for a nonexistent phase as for a foreign one', async () => {
    /* Distinguishable messages would make this an existence oracle — a student could
       enumerate which phase ids are real. */
    const { db } = makeAdmin({ memberOf: [] })
    mockAdminClient.mockReturnValue(db)
    const mod = await load()

    const foreign = await mod.getPhaseCommentsForStudent(OTHER_PHASE, SECTION)
    const missing = await mod.getPhaseCommentsForStudent('phase-does-not-exist', SECTION)
    expect(foreign.error).toBe(missing.error)
  })
})

describe('#698 — team capacity is decided under a lock, not in JS', () => {
  beforeEach(() => {
    vi.resetModules()
    mockGetUser.mockReset().mockResolvedValue({ data: { user: { id: CALLER } } })
    mockAdminClient.mockReset()
  })

  it('accepts an invitation through the atomic RPC', async () => {
    const { db, rec } = makeAdmin({ memberOf: ['team-a'], rpcResult: { ok: true, count: 3, cap: 4 } })
    mockAdminClient.mockReturnValue(db)

    const mod = await load()
    await mod.respondToInvitation('inv-1', SECTION, true)

    // The whole point: the decision is the RPC's, and it is given the team + project it
    // must lock rather than a count computed here.
    const call = rec.rpcs.find((r) => r.name === 'join_project_team_atomic')
    expect(call).toBeDefined()
    expect(call!.args).toHaveProperty('p_team_id')
    expect(call!.args).toHaveProperty('p_project_id')
    expect(call!.args).toHaveProperty('p_user_id', CALLER)
  })

  it('reports a full team instead of silently over-filling it', async () => {
    const { db } = makeAdmin({ memberOf: ['team-a'], rpcResult: { ok: false, reason: 'full', count: 4, cap: 4 } })
    mockAdminClient.mockReturnValue(db)

    const mod = await load()
    const res = await mod.respondToInvitation('inv-1', SECTION, true)

    expect(res.error).toMatch(/full/i)
  })

  it('distinguishes already-in-a-team from full', async () => {
    // Different causes need different words, or the student cannot act on either.
    const { db } = makeAdmin({ memberOf: ['team-a'], rpcResult: { ok: false, reason: 'already_member' } })
    mockAdminClient.mockReturnValue(db)

    const mod = await load()
    const res = await mod.respondToInvitation('inv-1', SECTION, true)

    expect(res.error).toMatch(/already in a team/i)
  })
})
