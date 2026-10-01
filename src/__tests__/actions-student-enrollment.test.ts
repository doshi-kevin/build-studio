// Tests for the student self-unenroll action (dropSection) — the only student-side
// enrollment mutation left after enrollment became admin-driven. The interesting
// behavior is the policy gate: institutions.settings.selfUnenroll must be enabled
// AND the call must land inside the per-enrollment window, else the action refuses.
// Uses vi.resetModules() + dynamic import pattern for clean state per test.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Chain Builder ────────────────────────────────────────────

function buildChain(finalResult: { data: unknown; error: unknown; count?: number }) {
  const chain: Record<string, unknown> = {}
  chain.select = vi.fn().mockReturnValue(chain)
  chain.eq = vi.fn().mockReturnValue(chain)
  chain.in = vi.fn().mockReturnValue(chain)
  chain.single = vi.fn().mockResolvedValue(finalResult)
  chain.maybeSingle = vi.fn().mockResolvedValue(finalResult)
  chain.insert = vi.fn().mockReturnValue(chain)
  chain.update = vi.fn().mockReturnValue(chain)
  chain.then = undefined
  return chain
}

/** Chain for the guarded UPDATE path: .update().eq().eq().select('id') resolves rows. */
function buildUpdateChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {}
  chain.update = vi.fn().mockReturnValue(chain)
  chain.eq = vi.fn().mockReturnValue(chain)
  chain.select = vi.fn().mockResolvedValue({ data: rows, error: null })
  return chain
}

// ── Module-Level Mock References ─────────────────────────────

const mockGetUser = vi.fn()
const mockAdminClient = vi.fn()
const mockGetProfileById = vi.fn()

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
  })),
}))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: (...args: unknown[]) => mockAdminClient(...args),
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

vi.mock('@/lib/supabase/event-logger', () => ({
  logEvent: vi.fn(),
}))

vi.mock('@/lib/supabase/queries', () => ({
  profileQueries: {
    getProfileById: (...args: unknown[]) => mockGetProfileById(...args),
  },
}))

// ── Test Setup ───────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let dropSection: any

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockAdminClient.mockReset()
  mockGetProfileById.mockReset()

  const mod = await import('@/app/(dashboard)/student/courses/actions')
  dropSection = mod.dropSection
})

// ── Helpers ──────────────────────────────────────────────────

function mockAuthenticated(userId = 'student-123') {
  mockGetUser.mockResolvedValue({ data: { user: { id: userId } }, error: null })
}

function mockUnauthenticated() {
  mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'No user' } })
}

function mockStudentProfile(userId = 'student-123', institutionId = 'inst-test-1') {
  mockGetProfileById.mockResolvedValue({ id: userId, role: 'student', institution_id: institutionId })
}

function mockProfessorProfile(userId = 'user-1') {
  mockGetProfileById.mockResolvedValue({ id: userId, role: 'professor', institution_id: 'inst-test-1' })
}

/** adminDb whose from() routes by table: enrollments find → enrollment row,
 *  institutions → settings + deadline policy, course_sections → start date,
 *  second enrollments call → the guarded update. */
let lastUpdateChain: Record<string, unknown> | null = null
/* Read through a function so TS does not narrow the module-level binding to `never` from
   the `= null` in the test body — it cannot see the assignment inside mockAdminFor. */
const takeUpdateChain = () => lastUpdateChain

function mockAdminFor({
  enrollment,
  settings,
  addDropDeadlineDays = 14,
  sectionStartDate = daysFromNow(-1),
  updatedRows = [{ id: 'enroll-1' }],
}: {
  enrollment: unknown
  settings: unknown
  /** Institution policy: days after the SECTION's start that self-drop stays open (#744). */
  addDropDeadlineDays?: number | null
  sectionStartDate?: string | null
  updatedRows?: unknown[]
}) {
  let enrollmentsCalls = 0
  const admin = {
    from: vi.fn((table: string) => {
      if (table === 'institutions') {
        return buildChain({ data: { settings, add_drop_deadline_days: addDropDeadlineDays }, error: null })
      }
      if (table === 'course_sections') {
        return buildChain({ data: { start_date: sectionStartDate }, error: null })
      }
      enrollmentsCalls += 1
      if (enrollmentsCalls === 1) return buildChain({ data: enrollment, error: null })
      lastUpdateChain = buildUpdateChain(updatedRows)
      return lastUpdateChain
    }),
  }
  mockAdminClient.mockReturnValue(admin)
  return admin
}

const HOURS = 60 * 60 * 1000
const enrolledAgo = (ms: number) => new Date(Date.now() - ms).toISOString()
/** yyyy-MM-dd, n days from today. Negative is in the past. */
function daysFromNow(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}

// ── dropSection ──────────────────────────────────────────────

describe('dropSection', () => {
  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const result = await dropSection('section-1')
    expect(result.error).toBe('Not authenticated')
  })

  it('rejects non-student roles', async () => {
    mockAuthenticated('user-1')
    mockProfessorProfile('user-1')
    const result = await dropSection('section-1')
    expect(result.error).toBe('Unauthorized — student access required')
  })

  it('returns error when no active enrollment found', async () => {
    mockAuthenticated()
    mockStudentProfile()
    mockAdminFor({ enrollment: null, settings: { selfUnenroll: { enabled: true, days: 14 } } })

    const result = await dropSection('section-1')
    expect(result.error).toBe('No active enrollment found for this section')
  })

  it('refuses when the self-unenroll policy is disabled', async () => {
    mockAuthenticated()
    mockStudentProfile()
    mockAdminFor({
      enrollment: { id: 'enroll-1', status: 'enrolled', enrolled_at: enrolledAgo(1 * HOURS) },
      settings: { selfUnenroll: { enabled: false, days: 14 } },
    })

    const result = await dropSection('section-1')
    expect(result.error?.toLowerCase()).toContain('contact your administrator')
  })

  it('refuses when institution settings are missing (fails closed)', async () => {
    mockAuthenticated()
    mockStudentProfile()
    mockAdminFor({
      enrollment: { id: 'enroll-1', status: 'enrolled', enrolled_at: enrolledAgo(1 * HOURS) },
      settings: null,
    })

    const result = await dropSection('section-1')
    expect(result.error?.toLowerCase()).toContain('contact your administrator')
  })

  /* The window is anchored to the SECTION's start date now, not to this student's own
     enrolled_at (#744). Two students enrolling a week apart used to get two different
     deadlines for the same course, which is not what an add/drop period means. */
  it('refuses once the add/drop period after the section start has passed', async () => {
    mockAuthenticated()
    mockStudentProfile()
    mockAdminFor({
      // Enrolled an hour ago, but the section started 30 days back and the window is 2 days.
      enrollment: { id: 'enroll-1', status: 'enrolled', enrolled_at: enrolledAgo(1 * HOURS) },
      settings: { selfUnenroll: { enabled: true, days: 365 } },
      addDropDeadlineDays: 2,
      sectionStartDate: daysFromNow(-30),
    })

    const result = await dropSection('section-1')
    expect(result.error).toContain('add/drop period')
  })

  it('gives every student in a section the same deadline, whenever they enrolled', async () => {
    mockAuthenticated()
    mockStudentProfile()
    /* A late enroller. Under the old per-student anchor this was inside their personal
       window and allowed; under a section-anchored deadline the period has closed for
       everyone, which is the point. */
    mockAdminFor({
      enrollment: { id: 'enroll-1', status: 'enrolled', enrolled_at: enrolledAgo(1 * HOURS) },
      settings: { selfUnenroll: { enabled: true, days: 14 } },
      addDropDeadlineDays: 7,
      sectionStartDate: daysFromNow(-20),
    })

    const result = await dropSection('section-1')
    expect(result.error).toContain('add/drop period')
  })

  it('stays open all term when no add/drop deadline is configured', async () => {
    mockAuthenticated()
    mockStudentProfile()
    /* parseAddDropPolicy documents a null day count as "no deadline, self-drop allowed for
       the whole term" — the behaviour that shipped before any policy existed. My first
       version failed closed here, which would have silently removed self-drop from every
       institution, since none has a day count set. allowStudentDrop is the switch for
       turning it off; the absence of a deadline is not. */
    mockAdminFor({
      enrollment: { id: 'enroll-1', status: 'enrolled', enrolled_at: enrolledAgo(1 * HOURS) },
      settings: { selfUnenroll: { enabled: true, days: 14 } },
      addDropDeadlineDays: null,
    })

    const result = await dropSection('section-1')
    expect(result.success).toBe(true)
  })

  it('fails closed when the section has no start date to anchor the deadline to', async () => {
    mockAuthenticated()
    mockStudentProfile()
    mockAdminFor({
      enrollment: { id: 'enroll-1', status: 'enrolled', enrolled_at: enrolledAgo(1 * HOURS) },
      settings: { selfUnenroll: { enabled: true, days: 14 } },
      sectionStartDate: null,
    })

    const result = await dropSection('section-1')
    expect(result.error).toContain('Contact your administrator')
  })

  it('drops the enrollment inside an open window', async () => {
    mockAuthenticated()
    mockStudentProfile()
    const admin = mockAdminFor({
      enrollment: { id: 'enroll-1', status: 'enrolled', enrolled_at: enrolledAgo(1 * HOURS) },
      settings: { selfUnenroll: { enabled: true, days: 14 } },
    })

    const result = await dropSection('section-1')
    expect(result.success).toBe(true)
    expect(admin.from).toHaveBeenCalledWith('enrollments')
    expect(admin.from).toHaveBeenCalledWith('institutions')
    // The deadline is anchored to the section, so its start date has to be read (#744).
    expect(admin.from).toHaveBeenCalledWith('course_sections')
  })

  it('stamps dropped_at in the SAME statement as the status flip', async () => {
    mockAuthenticated()
    mockStudentProfile()
    lastUpdateChain = null
    mockAdminFor({
      enrollment: { id: 'enroll-1', status: 'enrolled', enrolled_at: enrolledAgo(1 * HOURS) },
      settings: { selfUnenroll: { enabled: true, days: 14 } },
    })

    await dropSection('section-1')

    /* One statement, not two. A second write could fail and leave a dropped row with no
       departure date, which the future retention sweep reads as "unknown" and skips
       forever — so the row would never be cleared and nothing would say why (#744). */
    const update = takeUpdateChain()?.update as ReturnType<typeof vi.fn>
    expect(update).toHaveBeenCalledTimes(1)
    const payload = update.mock.calls[0][0] as Record<string, unknown>
    expect(payload.status).toBe('dropped')
    expect(typeof payload.dropped_at).toBe('string')
    expect(Number.isNaN(Date.parse(payload.dropped_at as string))).toBe(false)
  })

  it('reports failure when the guarded update matches no row (concurrent change)', async () => {
    mockAuthenticated()
    mockStudentProfile()
    mockAdminFor({
      enrollment: { id: 'enroll-1', status: 'enrolled', enrolled_at: enrolledAgo(1 * HOURS) },
      settings: { selfUnenroll: { enabled: true, days: 14 } },
      updatedRows: [],
    })

    const result = await dropSection('section-1')
    expect(result.error).toBe('Failed to unenroll. Please try again.')
  })
})
