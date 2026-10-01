// Tests for the student office-hours booking action (createBooking).
//
// This is the function PR #437 hardens, so its guards are what these tests pin down:
//   • C2 cross-institution check (a student may only book a professor in their own institution)
//   • server-side slot validation against the office-hours template (day / time window)
//   • the meeting-mode match, the fast-path double-book check, and the 23505 atomic-guard branch
// The Zod schema and etWallClockToIso are deliberately left UNMOCKED so the real validation runs.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Chain Builder (mirrors actions-student-quiz.test.ts) ─────────

function buildChain(finalResult: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {}
  chain.select = vi.fn().mockReturnValue(chain)
  chain.eq = vi.fn().mockReturnValue(chain)
  chain.order = vi.fn().mockReturnValue(chain)
  chain.limit = vi.fn().mockReturnValue(chain)
  chain.lte = vi.fn().mockReturnValue(chain)
  chain.or = vi.fn().mockReturnValue(chain)
  chain.single = vi.fn().mockResolvedValue(finalResult)
  chain.maybeSingle = vi.fn().mockResolvedValue(finalResult)
  chain.insert = vi.fn().mockReturnValue(chain)
  chain.update = vi.fn().mockReturnValue(chain)
  chain.then = undefined
  return chain
}

// Awaitable variant: the double-book check ends on `.eq('status','booked')` and is awaited
// directly (not via .single()), so its chain must resolve when awaited.
function buildAwaitableChain(finalResult: { data: unknown; error: unknown }) {
  const chain = buildChain(finalResult) as Record<string, unknown>
  chain.then = (resolve: (v: unknown) => unknown) => resolve(finalResult)
  return chain
}

// ── Module-level mocks ───────────────────────────────────────────

const mockGetUser = vi.fn()
const mockAdminClient = vi.fn()
const mockSendBookingConfirmed = vi.fn()
const mockEmitEvent = vi.fn()

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
vi.mock('@/lib/email', () => ({ sendBookingConfirmed: (...a: unknown[]) => mockSendBookingConfirmed(...a) }))
vi.mock('@/lib/events/emit', () => ({ emitEvent: (...a: unknown[]) => mockEmitEvent(...a) }))
// @/lib/validations/calendar and @/lib/calendar/utils are intentionally NOT mocked.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createBooking: any

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockAdminClient.mockReset()
  mockSendBookingConfirmed.mockReset()
  mockEmitEvent.mockReset()
  const mod = await import('@/app/(dashboard)/student/office-hours/actions')
  createBooking = mod.createBooking
})

// ── Fixtures ─────────────────────────────────────────────────────

// A fixed FUTURE date so the "time has already passed" guard never rejects a valid booking.
// day_of_week is derived from the same date so the day-of-week guard passes for the happy path.
const FUTURE_DATE = '2099-06-01'
const DOW = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const MATCHING_DAY = DOW[new Date(`${FUTURE_DATE}T00:00:00`).getDay()]
const OTHER_DAY = DOW[(new Date(`${FUTURE_DATE}T00:00:00`).getDay() + 1) % 7]

function mockAuth(userId = 'student-123') {
  mockGetUser.mockResolvedValue({ data: { user: { id: userId } }, error: null })
}

const studentProfile = {
  data: { id: 'student-123', role: 'student', name: 'Stu Dent', email: 'stu@a.edu', institution_id: 'inst-A' },
  error: null,
}

function activeOH(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      id: 'oh-1',
      professor_id: 'prof-1',
      title: 'Weekly Office Hours',
      location: 'Room 101',
      zoom_link: '',
      meeting_type: 'in_person',
      is_active: true,
      day_of_week: MATCHING_DAY,
      start_time: '09:00:00',
      end_time: '12:00:00',
      slot_duration: 30,
      buffer_minutes: 0,
      effective_from: '2020-01-01',
      effective_until: null,
      ...overrides,
    },
    error: null,
  }
}

const sameInstProf = { data: { institution_id: 'inst-A' }, error: null }
const otherInstProf = { data: { institution_id: 'inst-B' }, error: null }

const insertedBooking = {
  data: {
    id: 'booking-1',
    date: FUTURE_DATE,
    start_time: '10:00:00',
    end_time: '10:30:00',
    title: 'Assignment help',
    location: 'Room 101',
    zoom_link: '',
  },
  error: null,
}

// Routes each adminDb.from(table) call by table and call order:
//   profiles → 1st = verifyStudent, 2nd = C2 professor-institution lookup
//   bookings → 1st = double-book existence check (awaited list), 2nd = INSERT (.single())
function routedAdmin(opts: {
  oh?: { data: unknown; error: unknown }
  prof?: { data: unknown; error: unknown }
  existing?: { data: unknown; error: unknown }
  insert?: { data: unknown; error: unknown }
  blocks?: { data: unknown; error: unknown }
} = {}) {
  const oh = opts.oh ?? activeOH()
  const prof = opts.prof ?? sameInstProf
  const existing = opts.existing ?? { data: [], error: null }
  const insert = opts.insert ?? insertedBooking
  const blocks = opts.blocks ?? { data: [], error: null }
  let profileCalls = 0
  let bookingCalls = 0
  return {
    from: vi.fn((table: string) => {
      if (table === 'profiles') {
        profileCalls += 1
        return buildChain(profileCalls === 1 ? studentProfile : prof)
      }
      if (table === 'office_hours') return buildChain(oh)
      // The server-side blocked-times overlap check (awaited list, ends on .or()).
      if (table === 'blocked_times') return buildAwaitableChain(blocks)
      if (table === 'bookings') {
        bookingCalls += 1
        return bookingCalls === 1 ? buildAwaitableChain(existing) : buildChain(insert)
      }
      return buildChain({ data: null, error: null })
    }),
  }
}

const validInput = {
  officeHoursId: 'oh-1',
  date: FUTURE_DATE,
  startTime: '10:00',
  endTime: '10:30',
  title: 'Assignment help',
  courseId: null as string | null,
  meetingType: 'in_person',
  purpose: 'general_question',
  studentNote: '',
}

// ── Tests ────────────────────────────────────────────────────────

describe('createBooking', () => {
  it('rejects unauthenticated users', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'No user' } })
    const result = await createBooking(validInput)
    expect(result.error).toBe('Not authenticated')
  })

  it('books successfully when the professor is in the student’s institution', async () => {
    mockAuth()
    mockAdminClient.mockReturnValue(routedAdmin())
    const result = await createBooking(validInput)
    expect(result.error).toBeUndefined()
    expect(result.data).toMatchObject({ id: 'booking-1', title: 'Assignment help' })
    // The professor is notified of the new booking.
    expect(mockEmitEvent).toHaveBeenCalledTimes(1)
  })

  it('rejects a booking when the professor is in a DIFFERENT institution (C2 cross-tenant guard)', async () => {
    mockAuth()
    mockAdminClient.mockReturnValue(routedAdmin({ prof: otherInstProf }))
    const result = await createBooking(validInput)
    expect(result.error).toBe('These office hours are not available to you.')
    // No booking row is written and the professor is not notified.
    expect(mockEmitEvent).not.toHaveBeenCalled()
  })

  it('rejects a time outside the office-hours window', async () => {
    mockAuth()
    mockAdminClient.mockReturnValue(routedAdmin())
    // 08:00 is before the 09:00 office-hours start.
    const result = await createBooking({ ...validInput, startTime: '08:00', endTime: '08:30' })
    expect(result.error).toBe('That time is outside these office hours.')
  })

  it('rejects a day the office hours are not offered', async () => {
    mockAuth()
    mockAdminClient.mockReturnValue(routedAdmin({ oh: activeOH({ day_of_week: OTHER_DAY }) }))
    const result = await createBooking(validInput)
    expect(result.error).toBe('That day is not offered for these office hours.')
  })

  it('rejects a meeting mode the office hour does not offer', async () => {
    mockAuth()
    // OH is in-person only; a zoom booking must be refused.
    mockAdminClient.mockReturnValue(routedAdmin())
    const result = await createBooking({ ...validInput, meetingType: 'zoom' })
    expect(result.error).toBe('That meeting type is not available for this slot.')
  })

  it('rejects when the slot is already booked (fast-path check)', async () => {
    mockAuth()
    mockAdminClient.mockReturnValue(routedAdmin({ existing: { data: [{ id: 'other' }], error: null } }))
    const result = await createBooking(validInput)
    expect(result.error).toBe('This time slot is already booked')
  })

  it('maps a 23505 unique-violation from the atomic guard to a friendly message', async () => {
    mockAuth()
    mockAdminClient.mockReturnValue(routedAdmin({ insert: { data: null, error: { code: '23505' } } }))
    const result = await createBooking(validInput)
    expect(result.error).toBe('This time slot was just booked by someone else.')
  })

  it('rejects a booking against inactive office hours', async () => {
    mockAuth()
    mockAdminClient.mockReturnValue(routedAdmin({ oh: activeOH({ is_active: false }) }))
    const result = await createBooking(validInput)
    expect(result.error).toBe('These office hours are no longer active')
  })

  it('rejects a start time not on the slot grid (BUG-5 — defeats the exact-start unique guard)', async () => {
    mockAuth()
    mockAdminClient.mockReturnValue(routedAdmin())
    // 10:15 isn't a 30-min boundary from the 09:00 template start.
    const result = await createBooking({ ...validInput, startTime: '10:15', endTime: '10:45' })
    expect(result.error).toBe('That is not a bookable slot.')
  })

  it('rejects a duration longer than one slot (BUG-5 — grabbing two slots)', async () => {
    mockAuth()
    mockAdminClient.mockReturnValue(routedAdmin())
    // Aligned start, but 60 min against a 30-min slot_duration.
    const result = await createBooking({ ...validInput, startTime: '10:00', endTime: '11:00' })
    expect(result.error).toBe('That is not a bookable slot.')
  })

  it('rejects a booking overlapping the professor’s blocked time (BUG-6 — server-side)', async () => {
    mockAuth()
    mockAdminClient.mockReturnValue(
      routedAdmin({
        blocks: {
          data: [
            { date: FUTURE_DATE, start_time: '10:00:00', end_time: '11:00:00', recurrence: 'none', recurrence_until: null },
          ],
          error: null,
        },
      }),
    )
    const result = await createBooking(validInput)
    expect(result.error).toBe('That time is no longer available.')
  })

  it('rejects a booking overlapping a WEEKLY recurring blocked time (BUG-6 — recurrence branch)', async () => {
    mockAuth()
    // A block first set two weeks earlier on the same weekday, recurring weekly with no end —
    // it must still apply to FUTURE_DATE via the weekday match, not just its original date.
    const earlierSameWeekday = new Date(`${FUTURE_DATE}T12:00:00`)
    earlierSameWeekday.setDate(earlierSameWeekday.getDate() - 14)
    const blockDate = earlierSameWeekday.toISOString().slice(0, 10)
    mockAdminClient.mockReturnValue(
      routedAdmin({
        blocks: {
          data: [
            { date: blockDate, start_time: '10:00:00', end_time: '11:00:00', recurrence: 'weekly', recurrence_until: null },
          ],
          error: null,
        },
      }),
    )
    const result = await createBooking(validInput)
    expect(result.error).toBe('That time is no longer available.')
  })

  it('fails closed when the blocked-times lookup errors (BUG-6 — no book-over on a failed read)', async () => {
    mockAuth()
    mockAdminClient.mockReturnValue(routedAdmin({ blocks: { data: null, error: { message: 'db down' } } }))
    const result = await createBooking(validInput)
    // We couldn't confirm the slot is free, so the booking is refused rather than let through.
    expect(result.error).toBe('Could not verify availability. Please try again.')
    expect(mockEmitEvent).not.toHaveBeenCalled()
  })
})
