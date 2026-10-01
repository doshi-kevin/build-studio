// requestLateSubmission guards + idempotency + concurrency-stamp race.
// Pattern 2: module-level mock vars + vi.mock + vi.resetModules() + dynamic import.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetUser = vi.fn()
const mockAdmin = vi.fn()
const mockLogEvent = vi.fn()
const mockEmitEvent = vi.fn()
const mockResolveStaffAudience = vi.fn()

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => mockAdmin() }))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: (...args: unknown[]) => mockLogEvent(...args) }))
vi.mock('@/lib/events/emit', () => ({
  markFeedItemDone: vi.fn(),
  emitEvent: (...args: unknown[]) => mockEmitEvent(...args),
}))
vi.mock('@/lib/events/audience', () => ({
  resolveStaffAudience: (...args: unknown[]) => mockResolveStaffAudience(...args),
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

const PAST_DUE = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() // 2h ago
const FUTURE = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()   // 2h from now

/** Build a minimal admin client with configurable per-table responses. */
function makeAdmin({
  assignment = {
    id: 'asg-1',
    section_id: 'sec-1',
    status: 'published',
    institution_id: 'inst-1',
    due_at: PAST_DUE,
    title: 'HW 1',
  } as unknown,
  enrollment = { id: 'enr-1' } as unknown,
  existing = null as null | Record<string, unknown>,
  upsertError = null as { message: string } | null,
  stampRows = [{ id: 'sub-1' }] as unknown[],
} = {}) {
  const upsert = vi.fn().mockResolvedValue({ error: upsertError })
  const stampSelect = vi.fn().mockResolvedValue({ data: stampRows, error: null })

  // The stamp update chain: .update().eq().eq().is().select()
  const stampChain: Record<string, unknown> = {}
  stampChain.eq = vi.fn().mockReturnValue(stampChain)
  stampChain.is = vi.fn().mockReturnValue(stampChain)
  stampChain.select = stampSelect

  const updateFn = vi.fn().mockReturnValue(stampChain)

  const chainFor = (data: unknown) => {
    const c: Record<string, unknown> = {}
    c.select = () => c
    c.eq = () => c
    c.in = () => c
    c.is = () => c
    c.maybeSingle = () => Promise.resolve({ data, error: null })
    c.upsert = upsert
    c.update = updateFn
    return c
  }

  const client = {
    from: (t: string) => {
      if (t === 'assignments') return chainFor(assignment)
      if (t === 'enrollments') return chainFor(enrollment)
      if (t === 'assignment_submissions') return chainFor(existing)
      return chainFor(null)
    },
  }

  return { client, upsert, updateFn, stampChain, stampSelect }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mod: any

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset().mockResolvedValue({ data: { user: { id: 'stu-1' } }, error: null })
  mockAdmin.mockReset()
  mockLogEvent.mockReset()
  mockEmitEvent.mockReset()
  mockResolveStaffAudience.mockReset().mockResolvedValue(['staff-1'])
  mod = await import('@/app/(dashboard)/student/courses/[sectionId]/assignments/actions')
})

describe('requestLateSubmission', () => {
  it('1. unauthenticated: returns auth error', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null })
    const { client } = makeAdmin()
    mockAdmin.mockReturnValue(client)
    const res = await mod.requestLateSubmission('sec-1', 'asg-1')
    expect(res).toEqual({ error: 'You need to sign in again.' })
  })

  it('2. not enrolled: returns enrollment error', async () => {
    const { client } = makeAdmin({ enrollment: null })
    mockAdmin.mockReturnValue(client)
    const res = await mod.requestLateSubmission('sec-1', 'asg-1')
    expect(res).toEqual({ error: "You're not enrolled in this course." })
  })

  it('3. assignment not past due: returns not-past-due error', async () => {
    const { client } = makeAdmin({
      assignment: {
        id: 'asg-1',
        section_id: 'sec-1',
        status: 'published',
        institution_id: 'inst-1',
        due_at: FUTURE,
        title: 'HW 1',
      },
    })
    mockAdmin.mockReturnValue(client)
    const res = await mod.requestLateSubmission('sec-1', 'asg-1')
    expect(res).toEqual({ error: "The assignment isn't past due yet. You can still submit on time." })
  })

  it('4. active reopen window already open: returns already-open error', async () => {
    const { client } = makeAdmin({
      existing: {
        id: 'sub-1',
        status: 'draft',
        resubmit_until: FUTURE,
        late_request_at: null,
      },
    })
    mockAdmin.mockReturnValue(client)
    const res = await mod.requestLateSubmission('sec-1', 'asg-1')
    expect(res).toEqual({ error: 'Your submission window is already open.' })
  })

  it('5a. already submitted (status=submitted): returns already-submitted error', async () => {
    const { client } = makeAdmin({
      existing: {
        id: 'sub-1',
        status: 'submitted',
        resubmit_until: null,
        late_request_at: null,
      },
    })
    mockAdmin.mockReturnValue(client)
    const res = await mod.requestLateSubmission('sec-1', 'asg-1')
    expect(res).toEqual({ error: 'You have already submitted.' })
  })

  it('5b. already graded (status=graded): returns already-submitted error', async () => {
    const { client } = makeAdmin({
      existing: {
        id: 'sub-1',
        status: 'graded',
        resubmit_until: null,
        late_request_at: null,
      },
    })
    mockAdmin.mockReturnValue(client)
    const res = await mod.requestLateSubmission('sec-1', 'asg-1')
    expect(res).toEqual({ error: 'You have already submitted.' })
  })

  it('6. idempotent double-request: already has late_request_at → success, no stamp/log/emit', async () => {
    const EXISTING_TS = new Date(Date.now() - 60_000).toISOString()
    const { client, upsert, stampSelect } = makeAdmin({
      existing: {
        id: 'sub-1',
        status: 'draft',
        resubmit_until: null,
        late_request_at: EXISTING_TS,
      },
    })
    mockAdmin.mockReturnValue(client)
    const res = await mod.requestLateSubmission('sec-1', 'asg-1')
    expect(res).toEqual({ success: true })
    // No stub upsert, no stamp update, no logEvent, no emitEvent
    expect(upsert).not.toHaveBeenCalled()
    expect(stampSelect).not.toHaveBeenCalled()
    expect(mockLogEvent).not.toHaveBeenCalled()
    expect(mockEmitEvent).not.toHaveBeenCalled()
  })

  it('7. concurrent-stamp race: stamp returns 0 rows → success, no logEvent/emitEvent', async () => {
    const { client, stampSelect } = makeAdmin({
      existing: { id: 'sub-1', status: 'draft', resubmit_until: null, late_request_at: null },
      stampRows: [], // 0 rows affected
    })
    mockAdmin.mockReturnValue(client)
    const res = await mod.requestLateSubmission('sec-1', 'asg-1')
    expect(res).toEqual({ success: true })
    expect(stampSelect).toHaveBeenCalledTimes(1)
    expect(mockLogEvent).not.toHaveBeenCalled()
    expect(mockEmitEvent).not.toHaveBeenCalled()
  })

  it('8. happy path: success, stub upsert happens, stamp happens, logEvent + emitEvent fire once', async () => {
    const { client, upsert, updateFn } = makeAdmin({
      existing: null, // no prior row
      stampRows: [{ id: 'sub-new' }],
    })
    mockAdmin.mockReturnValue(client)
    const res = await mod.requestLateSubmission('sec-1', 'asg-1')
    expect(res).toEqual({ success: true })
    expect(upsert).toHaveBeenCalledTimes(1)
    expect(updateFn).toHaveBeenCalledTimes(1)
    expect(mockLogEvent).toHaveBeenCalledTimes(1)
    expect(mockLogEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'assignment.late_submission_requested' }),
    )
    // emitEvent is fire-and-forget (void), called once
    expect(mockEmitEvent).toHaveBeenCalledTimes(1)
  })
})
