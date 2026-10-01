// Tests for the professor calendar actions that PR #530 hardens:
//   • updateOfficeHours (BUG-12) — the merged schedule is validated against the SAME schema
//     createOfficeHours uses, so the update path can't drift from create. The load-bearing case
//     is the buffer lockout: a row legally created with buffer_minutes:7 must stay editable.
//   • deleteOfficeHours (BUG-13) — the cascade guard is atomic via delete_office_hours_if_unbooked;
//     delete-allowed / delete-blocked / RPC-error must each behave correctly (no fail-open).
// The Zod schema in @/lib/validations/calendar is deliberately left UNMOCKED so real validation runs.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Chain builder (mirrors actions-student-booking.test.ts) ──────────
function buildChain(finalResult: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {}
  chain.select = vi.fn().mockReturnValue(chain)
  chain.eq = vi.fn().mockReturnValue(chain)
  chain.update = vi.fn().mockReturnValue(chain)
  chain.single = vi.fn().mockResolvedValue(finalResult)
  chain.maybeSingle = vi.fn().mockResolvedValue(finalResult)
  chain.then = undefined
  return chain
}

// ── Module-level mocks ───────────────────────────────────────────────
const mockGetUser = vi.fn()
const mockAdminClient = vi.fn()
const mockLogEvent = vi.fn()

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
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: (...a: unknown[]) => mockLogEvent(...a) }))
vi.mock('@/lib/email', () => ({ sendBookingCancelled: vi.fn() }))
vi.mock('@/lib/events/emit', () => ({ emitEvent: vi.fn() }))
// @/lib/validations/calendar is intentionally NOT mocked.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let updateOfficeHours: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let deleteOfficeHours: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let importCalendarEvents: any

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockAdminClient.mockReset()
  mockLogEvent.mockReset()
  const mod = await import('@/app/(dashboard)/professor/calendar/actions')
  updateOfficeHours = mod.updateOfficeHours
  deleteOfficeHours = mod.deleteOfficeHours
  importCalendarEvents = mod.importCalendarEvents
})

// ── Fixtures ─────────────────────────────────────────────────────────
function mockAuth(userId = 'prof-1') {
  mockGetUser.mockResolvedValue({ data: { user: { id: userId } }, error: null })
}

const professorProfile = { data: { id: 'prof-1', role: 'professor' }, error: null }

// start_time/end_time are HH:MM:SS (columns are TEXT) to exercise the HH:MM normalization.
function existingOH(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      id: 'oh-1',
      professor_id: 'prof-1',
      title: 'Weekly Office Hours',
      course_id: null,
      day_of_week: 'monday',
      start_time: '09:00:00',
      end_time: '12:00:00',
      slot_duration: 30,
      buffer_minutes: 0,
      meeting_type: 'in_person',
      location: 'Room 101',
      zoom_link: '',
      effective_from: '2020-01-01',
      effective_until: null,
      ...overrides,
    },
    error: null,
  }
}

// Routes adminDb.from()/rpc():
//   profiles → verifyProfessor role check
//   office_hours → 1st = existing fetch, 2nd = the update .select('*')
//   rpc(delete_office_hours_if_unbooked) → the atomic guarded delete
function routedAdmin(opts: {
  profile?: { data: unknown; error: unknown }
  existing?: { data: unknown; error: unknown }
  updated?: { data: unknown; error: unknown }
  rpc?: { data: unknown; error: unknown }
} = {}) {
  const profile = opts.profile ?? professorProfile
  const existing = opts.existing ?? existingOH()
  const updated = opts.updated ?? { data: { id: 'oh-1', title: 'Updated' }, error: null }
  const rpc = opts.rpc ?? { data: true, error: null }
  const captured: { updatePayload?: Record<string, unknown> } = {}
  let ohCalls = 0
  return {
    _captured: captured,
    from: vi.fn((table: string) => {
      if (table === 'profiles') return buildChain(profile)
      if (table === 'office_hours') {
        ohCalls += 1
        if (ohCalls === 1) return buildChain(existing)
        // 2nd office_hours touch is the update — capture the payload it writes.
        const chain = buildChain(updated)
        chain.update = vi.fn((payload: Record<string, unknown>) => {
          captured.updatePayload = payload
          return chain
        })
        return chain
      }
      return buildChain({ data: null, error: null })
    }),
    rpc: vi.fn(async () => rpc),
  }
}

// ── updateOfficeHours (BUG-12) ───────────────────────────────────────
describe('updateOfficeHours', () => {
  it('updates a valid edit and logs the event', async () => {
    mockAuth()
    mockAdminClient.mockReturnValue(routedAdmin())
    const result = await updateOfficeHours('oh-1', { title: 'New Title' })
    expect(result.error).toBeUndefined()
    expect(result.data).toMatchObject({ id: 'oh-1' })
    expect(mockLogEvent).toHaveBeenCalledTimes(1)
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'office_hours.updated' }))
  })

  it('does NOT lock out a row created with a non-multiple-of-5 buffer (BUG-12 — no create/update drift)', async () => {
    mockAuth()
    // buffer_minutes:7 is legal per createOfficeHoursFormSchema (0-15) and the DB check constraint.
    // The old hand-rolled {0,5,10,15} enum rejected EVERY subsequent edit of such a row — even a
    // title-only change that never touches the buffer. Validating via the schema fixes that.
    mockAdminClient.mockReturnValue(routedAdmin({ existing: existingOH({ buffer_minutes: 7 }) }))
    const result = await updateOfficeHours('oh-1', { title: 'New Title' })
    expect(result.error).toBeUndefined()
    expect(result.data).toMatchObject({ id: 'oh-1' })
  })

  it('persists the NORMALIZED time, not the raw input (validate == write)', async () => {
    mockAuth()
    const admin = routedAdmin()
    mockAdminClient.mockReturnValue(admin)
    // A trailing-seconds value only passes the HH:MM regex after truncation — the column must
    // receive the truncated 'HH:MM', never the raw string, or timeToMinutes yields NaN downstream.
    const result = await updateOfficeHours('oh-1', { startTime: '09:00:59' })
    expect(result.error).toBeUndefined()
    expect(admin._captured.updatePayload?.start_time).toBe('09:00')
  })

  it('rejects a malformed time instead of writing NaN-guarded garbage', async () => {
    mockAuth()
    mockAdminClient.mockReturnValue(routedAdmin())
    const result = await updateOfficeHours('oh-1', { startTime: '9am' })
    expect(result.error).toMatch(/Invalid input/)
    expect(mockLogEvent).not.toHaveBeenCalled()
  })

  it('rejects a window too short to fit a single slot', async () => {
    mockAuth()
    mockAdminClient.mockReturnValue(routedAdmin())
    // 09:00 → 09:15 is 15 min against a 30-min slot_duration → zero bookable slots.
    const result = await updateOfficeHours('oh-1', { endTime: '09:15' })
    expect(result.error).toMatch(/Invalid input/)
    expect(mockLogEvent).not.toHaveBeenCalled()
  })

  it('rejects an edit to office hours owned by another professor', async () => {
    mockAuth('prof-1')
    mockAdminClient.mockReturnValue(routedAdmin({ existing: existingOH({ professor_id: 'prof-2' }) }))
    const result = await updateOfficeHours('oh-1', { title: 'Hijack' })
    expect(result.error).toBe('Not authorized')
  })
})

// ── deleteOfficeHours (BUG-13) ───────────────────────────────────────
describe('deleteOfficeHours', () => {
  it('deletes when the atomic guard reports no active bookings', async () => {
    mockAuth()
    mockAdminClient.mockReturnValue(routedAdmin({ rpc: { data: true, error: null } }))
    const result = await deleteOfficeHours('oh-1')
    expect(result.success).toBe(true)
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'office_hours.deleted' }))
  })

  it('refuses to delete when the guard reports active bookings (no cascade wipe)', async () => {
    mockAuth()
    mockAdminClient.mockReturnValue(routedAdmin({ rpc: { data: false, error: null } }))
    const result = await deleteOfficeHours('oh-1')
    expect(result.error).toMatch(/deactivate/)
    expect(mockLogEvent).not.toHaveBeenCalled()
  })

  it('fails CLOSED when the delete RPC errors (never fail-open)', async () => {
    mockAuth()
    mockAdminClient.mockReturnValue(routedAdmin({ rpc: { data: null, error: { message: 'db down' } } }))
    const result = await deleteOfficeHours('oh-1')
    expect(result.error).toBe('Failed to delete office hours')
    expect(mockLogEvent).not.toHaveBeenCalled()
  })
})

// ── importCalendarEvents: the bound this path never had (#713 part 7) ──
//
// The student's .ics import has capped at 500 since it shipped. THIS path had no cap at
// all: the entire client-supplied array was mapped to rows and bulk-inserted, so a
// decade-long calendar export was an unbounded write originating in the browser. The
// shared import dialog knew about neither limit, which is what produced the reported
// symptom — a clickable "Import 501 Events" that then failed on one path and silently
// succeeded on the other.
//
// The refusal must land BEFORE the insert, so the assertion is that no write is attempted
// rather than merely that an error comes back.
describe('importCalendarEvents payload bound', () => {
  function event(i: number) {
    return {
      summary: `Event ${i}`,
      description: '',
      location: '',
      dtstart: `2026-09-01T09:00:00.000Z`,
      dtend: `2026-09-01T10:00:00.000Z`,
    }
  }

  /** Records every table touched, so we can prove the DB was never written. */
  function dbSpy() {
    const touched: string[] = []
    const admin = {
      from: vi.fn((table: string) => {
        touched.push(table)
        if (table === 'profiles') {
          return buildChain({ data: { id: 'prof-1', role: 'professor' }, error: null })
        }
        const chain = buildChain({ data: [{ id: 'row-1' }], error: null })
        chain.insert = vi.fn().mockReturnValue(chain)
        chain.select = vi.fn().mockResolvedValue({ data: [{ id: 'row-1' }], error: null })
        return chain
      }),
    }
    return { admin, touched }
  }

  it('refuses one event over the cap without writing anything', async () => {
    mockAuth('prof-1')
    const { admin, touched } = dbSpy()
    mockAdminClient.mockReturnValue(admin)

    const r = await importCalendarEvents(Array.from({ length: 501 }, (_, i) => event(i)))

    expect(r.error).toMatch(/at most 500/)
    expect(r.count).toBe(0)
    // profiles is the authorization read; blocked_times would be the write.
    expect(touched).not.toContain('blocked_times')
  })

  it('accepts a payload exactly at the cap', async () => {
    // Guards against an off-by-one turning the fix into a 499-event limit.
    mockAuth('prof-1')
    const { admin, touched } = dbSpy()
    mockAdminClient.mockReturnValue(admin)

    const r = await importCalendarEvents(Array.from({ length: 500 }, (_, i) => event(i)))

    expect(r.error).toBeUndefined()
    expect(touched).toContain('blocked_times')
  })

  it('checks authorization before the payload size, so the cap is not an unauthenticated oracle', async () => {
    mockAuth('not-a-prof')
    const admin = {
      from: vi.fn(() => buildChain({ data: { id: 'not-a-prof', role: 'student' }, error: null })),
    }
    mockAdminClient.mockReturnValue(admin)

    const r = await importCalendarEvents(Array.from({ length: 501 }, (_, i) => event(i)))

    expect(r.error).toBe('Not authorized')
  })
})
