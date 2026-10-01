/**
 * markAttendance — the refusal and failure paths.
 *
 * lc-join-code.test.ts already covers the projector-code gate in depth (asks / accepts /
 * refuses / rate-limits / never re-asks). It exercises the happy spine, so the branches left
 * uncovered were every REFUSAL and both error paths — measured at 89.47% lines before this file,
 * against a target CLAUDE.md states as 100%.
 *
 * Those branches are the ones worth pinning: each is a security boundary (is the caller signed
 * in, does this room exist, has the school paid for live classroom) or an honesty boundary
 * (a failed write must not report success to a student who then believes they were marked
 * present). A silent `{ success: true }` on a failed upsert is the specific bug this guards.
 *
 * Mocks are assigned INSIDE each test rather than reset in beforeEach: vitest 4 mis-attributes
 * errors thrown by a mock implementation when that mock is touched in beforeEach, even when the
 * code under test catches them — see the header of llm-quiz-dedup-types.test.ts. The last test
 * here deliberately throws from a mock, so the pattern matters.
 */

import { describe, it, expect, vi } from 'vitest'

const mockGetUser = vi.fn()
const mockAdminClient = vi.fn()
const mockCheckEntitlement = vi.fn()
const mockLoggerError = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => mockAdminClient() }))
vi.mock('@/lib/logger', () => ({
  logger: { error: mockLoggerError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('@/lib/entitlements/check', () => ({
  checkEntitlementBySection: (...args: unknown[]) => mockCheckEntitlement(...args),
}))

const ROOM = '11111111-1111-4111-8111-111111111111'
const ME = 'stu-1'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Opts = {
  room?: any
  enrolled?: boolean
  upsertError?: unknown
  joinCode?: string
  /** Return the limiter row bare instead of wrapped in an array — a real PostgREST shape. */
  bareLimitRow?: boolean
}

/** Minimal admin-client stub. No join code by default, so the code gate is skipped and the
 *  refusal under test is the only thing that can end the call. */
function db(opts: Opts = {}) {
  const upsert = vi.fn(async () => ({ error: opts.upsertError ?? null }))
  const client = {
    rpc: vi.fn(async (fn: string) => {
      if (fn !== 'increment_auth_rate_limit') return { data: null, error: null }
      const row = { accepted: true, resets_at: null }
      return { data: opts.bareLimitRow ? row : [row], error: null }
    }),
    from: (table: string) => {
      if (table === 'lc_rooms') {
        return { select: () => ({ eq: () => ({ single: async () => ({
          data: opts.room === undefined
            ? { id: ROOM, section_id: 'sec-1', prof_id: 'p', status: 'live', setup_completed: true }
            : opts.room,
          error: opts.room === null ? { message: 'not found' } : null,
        }) }) }) }
      }
      if (table === 'lc_room_codes') {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({
          data: opts.joinCode ? { code: opts.joinCode } : null,
        }) }) }) }
      }
      if (table === 'enrollments') {
        return { select: () => ({ eq: () => ({ eq: () => ({ in: () => ({
          maybeSingle: async () => ({ data: opts.enrolled === false ? null : { id: 'e1' } }),
        }) }) }) }) }
      }
      return {
        select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
        upsert,
      }
    },
  }
  return { client, upsert }
}

async function load() {
  vi.resetModules()
  const mod = await import('@/lib/live-classroom/attendance/actions')
  return mod.markAttendance
}
/* eslint-enable @typescript-eslint/no-explicit-any */

describe('markAttendance refuses before it records', () => {
  it('refuses an unauthenticated caller and never builds the admin client', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null })
    mockAdminClient.mockImplementation(() => {
      throw new Error('admin client must not be constructed for an anonymous caller')
    })
    const markAttendance = await load()

    expect(await markAttendance(ROOM)).toEqual({ error: 'Not authenticated' })
    // The service-role client bypasses row-level security, so "not reached" is the contract,
    // not just "returned an error".
    expect(mockAdminClient).not.toHaveBeenCalled()
  })

  it('rejects a room id that is not a UUID, before any query', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: ME } }, error: null })
    const { client } = db()
    const fromSpy = vi.spyOn(client, 'from')
    mockAdminClient.mockReturnValue(client)
    const markAttendance = await load()

    expect(await markAttendance('not-a-uuid')).toEqual({ error: 'Invalid room ID' })
    expect(fromSpy).not.toHaveBeenCalled()
  })

  it('reports a missing room rather than recording attendance against nothing', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: ME } }, error: null })
    const { client, upsert } = db({ room: null })
    mockAdminClient.mockReturnValue(client)
    const markAttendance = await load()

    expect(await markAttendance(ROOM)).toEqual({ error: 'Room not found' })
    expect(upsert).not.toHaveBeenCalled()
  })

  it('refuses a room that has already ended', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: ME } }, error: null })
    const { client, upsert } = db({
      room: { id: ROOM, section_id: 'sec-1', prof_id: 'p', status: 'ended', setup_completed: true },
    })
    mockAdminClient.mockReturnValue(client)
    const markAttendance = await load()

    expect(await markAttendance(ROOM)).toEqual({ error: 'Room has ended' })
    expect(upsert).not.toHaveBeenCalled()
  })

  it('refuses a student who is not enrolled in the room\'s section', async () => {
    /* The tenant boundary. The section comes from the admin-fetched room row, never from input,
       so this is the check that stops someone with a room URL from another institution being
       recorded in a class they are not in. */
    mockGetUser.mockResolvedValue({ data: { user: { id: ME } }, error: null })
    const { client, upsert } = db({ enrolled: false })
    mockAdminClient.mockReturnValue(client)
    const markAttendance = await load()

    expect(await markAttendance(ROOM)).toEqual({ error: 'You are not enrolled in this section' })
    expect(upsert).not.toHaveBeenCalled()
  })

  it('refuses when the school is not entitled to live classroom, and records nothing', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: ME } }, error: null })
    mockCheckEntitlement.mockResolvedValue({ allowed: false })
    const { client, upsert } = db()
    mockAdminClient.mockReturnValue(client)
    const markAttendance = await load()

    const res = await markAttendance(ROOM)
    expect(res.success).toBeUndefined()
    expect(res.error).toMatch(/live classroom/i)
    expect(upsert).not.toHaveBeenCalled()
  })
})

describe('markAttendance reads the limiter result in either shape', () => {
  it('accepts a limiter row returned bare instead of wrapped in an array', async () => {
    /* The RPC is read as `Array.isArray(limit) ? limit[0] : limit`. Both shapes occur in
       practice, and getting this wrong reads `accepted` off an array — undefined — which the
       code treats as "not accepted" and refuses a student holding the correct code. */
    mockGetUser.mockResolvedValue({ data: { user: { id: ME } }, error: null })
    mockCheckEntitlement.mockResolvedValue({ allowed: true })
    const { client, upsert } = db({ joinCode: '7K4M', bareLimitRow: true })
    mockAdminClient.mockReturnValue(client)
    const markAttendance = await load()

    expect(await markAttendance(ROOM, '7k4m')).toEqual({ success: true })
    expect(upsert).toHaveBeenCalledTimes(1)
  })
})

describe('markAttendance is honest when the write fails', () => {
  it('reports failure when the upsert errors, instead of claiming the student is present', async () => {
    /* The failure that matters: a student sees "you're marked present", the row was never
       written, and the professor's roster silently disagrees at the end of class. */
    mockGetUser.mockResolvedValue({ data: { user: { id: ME } }, error: null })
    mockCheckEntitlement.mockResolvedValue({ allowed: true })
    const { client } = db({ upsertError: { message: 'deadlock detected' } })
    mockAdminClient.mockReturnValue(client)
    mockLoggerError.mockClear()
    const markAttendance = await load()

    expect(await markAttendance(ROOM)).toEqual({ error: 'Failed to record attendance' })
    expect(mockLoggerError).toHaveBeenCalled()
  })

  it('turns an unexpected throw into a refusal rather than a 500', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: ME } }, error: null })
    mockCheckEntitlement.mockResolvedValue({ allowed: true })
    mockAdminClient.mockImplementation(() => {
      throw new Error('connection pool exhausted')
    })
    mockLoggerError.mockClear()
    const markAttendance = await load()

    // Server actions in this codebase return { error } and never throw — a throw here would
    // surface to the student as an unhandled server error on a 3-minute heartbeat.
    expect(await markAttendance(ROOM)).toEqual({ error: 'An unexpected error occurred' })
    expect(mockLoggerError).toHaveBeenCalled()
  })
})
