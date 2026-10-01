// Tests for professor staff (TA/grader) server actions — auth, ownership, and
// state-machine guards for submitStaffRequest and withdrawStaffRequest.
// Happy-path inserts are NOT exhaustively tested — we focus on guards and
// branching logic per the pre-commit test policy.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Chain Builder ────────────────────────────────────────────
// Matches the Supabase chain shape used across actions-prof-*.test.ts files.

function buildChain(finalResult: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {}
  chain.select = vi.fn().mockReturnValue(chain)
  chain.eq = vi.fn().mockReturnValue(chain)
  chain.ilike = vi.fn().mockReturnValue(chain)
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
  chain.then = undefined
  return chain
}

// ── Module-Level Mock References ─────────────────────────────

const mockGetUser = vi.fn()
const mockAdminClient = vi.fn()
const mockGetProfileById = vi.fn()
const mockSendStaffRequestSubmitted = vi.fn()

// NOT reset in beforeEach: one test below gives this mock a rejecting
// implementation, and vitest 4 mis-attributes errors from a mock that was
// touched in beforeEach as test failures (see CLAUDE.md → Learned Mistakes).
vi.mock('@/lib/email', () => ({
  sendStaffRequestSubmitted: (...args: unknown[]) =>
    mockSendStaffRequestSubmitted(...args),
}))

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
vi.mock('@/lib/supabase/queries', () => ({
  profileQueries: {
    getProfileById: (...args: unknown[]) => mockGetProfileById(...args),
  },
}))

// ── Test Setup ───────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let submitStaffRequest: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let withdrawStaffRequest: any

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockAdminClient.mockReset()
  mockGetProfileById.mockReset()

  const mod = await import(
    '@/app/(dashboard)/professor/courses/[sectionId]/staff/actions'
  )
  submitStaffRequest = mod.submitStaffRequest
  withdrawStaffRequest = mod.withdrawStaffRequest
})

// ── Auth helpers ─────────────────────────────────────────────

function mockUnauthenticated() {
  mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'No user' } })
}

function mockStudentRole() {
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
  mockGetProfileById.mockResolvedValue({ id: 'user-1', role: 'student' })
}

function mockProfessorAuth(userId = 'prof-1', email = 'prof@uni.edu') {
  mockGetUser.mockResolvedValue({
    data: { user: { id: userId, email } },
    error: null,
  })
  mockGetProfileById.mockResolvedValue({ id: userId, role: 'professor' })
}

// ── Fixtures ─────────────────────────────────────────────────

const validUUID = '550e8400-e29b-41d4-a716-446655440000'
const requestUUID = '550e8400-e29b-41d4-a716-446655440001'

const validSubmitInput = {
  section_id: validUUID,
  candidate_email: 'ta@uni.edu',
  candidate_first_name: 'Alex',
  candidate_last_name: 'Nguyen',
  requested_role: 'ta' as const,
}

// ── submitStaffRequest ───────────────────────────────────────

describe('submitStaffRequest', () => {
  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const result = await submitStaffRequest(validSubmitInput)
    expect(result.error).toBe('Not authenticated')
  })

  it('rejects non-professor roles', async () => {
    mockStudentRole()
    const result = await submitStaffRequest(validSubmitInput)
    expect(result.error).toBe('Unauthorized — professor access required')
  })

  it('rejects professors who do not own the section', async () => {
    mockProfessorAuth('attacker-prof', 'attacker@uni.edu')
    mockAdminClient.mockReturnValue({
      from: vi.fn(() =>
        buildChain({
          data: { id: validUUID, professor_id: 'real-owner', end_date: null, course: null },
          error: null,
        })
      ),
    })
    const result = await submitStaffRequest(validSubmitInput)
    expect(result.error).toBe('You do not own this section')
  })

  it('returns "Section not found" when section lookup fails', async () => {
    mockProfessorAuth('prof-1', 'prof@uni.edu')
    mockAdminClient.mockReturnValue({
      from: vi.fn(() =>
        buildChain({ data: null, error: { message: 'not found' } })
      ),
    })
    const result = await submitStaffRequest(validSubmitInput)
    expect(result.error).toBe('Section not found')
  })

  it('rejects nominating your own email as staff', async () => {
    mockProfessorAuth('prof-1', 'ta@uni.edu') // same email as candidate
    mockAdminClient.mockReturnValue({
      from: vi.fn(() =>
        buildChain({
          data: { id: validUUID, professor_id: 'prof-1', end_date: null, course: null },
          error: null,
        })
      ),
    })
    const result = await submitStaffRequest(validSubmitInput)
    expect(result.error).toBe('You cannot nominate yourself as a course assistant')
  })

  it('blocks duplicate pending request for same email on same section', async () => {
    mockProfessorAuth('prof-1', 'prof@uni.edu')

    // The action calls from('course_sections'), then from('section_staff_requests')
    // for the duplicate-pending check. Route by table name so the first call returns
    // a valid section and the second returns an existing pending row.
    mockAdminClient.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === 'course_sections') {
          return buildChain({
            data: { id: validUUID, professor_id: 'prof-1', end_date: null, course: null },
            error: null,
          })
        }
        if (table === 'section_staff_requests') {
          return buildChain({ data: { id: 'existing-pending' }, error: null })
        }
        return buildChain({ data: null, error: null })
      }),
    })

    const result = await submitStaffRequest(validSubmitInput)
    expect(result.error).toBe(
      'A pending request already exists for this email on this section'
    )
  })

  it('blocks when candidate is already active staff on the section', async () => {
    mockProfessorAuth('prof-1', 'prof@uni.edu')

    mockAdminClient.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === 'course_sections') {
          return buildChain({
            data: { id: validUUID, professor_id: 'prof-1', end_date: null, course: null },
            error: null,
          })
        }
        if (table === 'section_staff_requests') {
          // No pending duplicate
          return buildChain({ data: null, error: null })
        }
        if (table === 'section_staff') {
          return buildChain({
            data: {
              id: 'active-staff-1',
              role: 'ta',
              staff: { email: 'ta@uni.edu' },
            },
            error: null,
          })
        }
        return buildChain({ data: null, error: null })
      }),
    })

    const result = await submitStaffRequest(validSubmitInput)
    expect(result.error).toBe('This person is already active staff on this section')
  })

  it('rejects invalid input (bad email) before hitting the DB', async () => {
    mockProfessorAuth('prof-1', 'prof@uni.edu')
    const result = await submitStaffRequest({
      ...validSubmitInput,
      candidate_email: 'not-an-email',
    })
    expect(result.error).toBe('Must be a valid email address')
    expect(result.success).toBeUndefined()
    // Admin client should not be constructed at all for schema failures
    expect(mockAdminClient).not.toHaveBeenCalled()
  })

  it('rejects invalid input (non-UUID section_id)', async () => {
    mockProfessorAuth('prof-1', 'prof@uni.edu')
    const result = await submitStaffRequest({
      ...validSubmitInput,
      section_id: 'not-a-uuid',
    })
    expect(result.error).toBe('Invalid section ID')
  })

  // ── Candidate notification (issue #83) ─────────────────────
  //
  // Every clean-path DB call resolves to { data: null, error: null }, which
  // makes the duplicate/active-staff guards pass and the insert succeed.

  function mockCleanInsertDb() {
    mockAdminClient.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === 'course_sections') {
          return buildChain({
            data: {
              id: validUUID,
              professor_id: 'prof-1',
              end_date: null,
              course: { id: 'course-1', code: 'CS 546', title: 'Web Programming' },
            },
            error: null,
          })
        }
        return buildChain({ data: null, error: null })
      }),
    })
  }

  it('emails the candidate that their application is pending review', async () => {
    mockProfessorAuth('prof-1', 'prof@uni.edu')
    mockGetProfileById.mockResolvedValue({
      id: 'prof-1',
      role: 'professor',
      name: 'Dr. Ada Byron',
    })
    mockCleanInsertDb()
    mockSendStaffRequestSubmitted.mockResolvedValue(true)

    const result = await submitStaffRequest(validSubmitInput)

    expect(result.success).toBe(true)
    expect(mockSendStaffRequestSubmitted).toHaveBeenCalledWith(
      'ta@uni.edu',
      'Alex Nguyen',
      {
        role: 'ta',
        courseLabel: 'CS 546 · Web Programming',
        professorName: 'Dr. Ada Byron',
      }
    )
  })

  it('still returns success when the candidate email throws', async () => {
    mockProfessorAuth('prof-1', 'prof@uni.edu')
    mockCleanInsertDb()
    mockSendStaffRequestSubmitted.mockRejectedValue(new Error('Resend is down'))

    const result = await submitStaffRequest(validSubmitInput)

    // The row is already committed — a mail outage must not report failure
    // back to the professor or they will re-submit and hit the dup guard.
    expect(result.success).toBe(true)
    expect(result.error).toBeUndefined()
  })
})

// ── withdrawStaffRequest ─────────────────────────────────────

describe('withdrawStaffRequest', () => {
  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const result = await withdrawStaffRequest(requestUUID, validUUID)
    expect(result.error).toBe('Not authenticated')
  })

  it('rejects non-professor roles', async () => {
    mockStudentRole()
    const result = await withdrawStaffRequest(requestUUID, validUUID)
    expect(result.error).toBe('Unauthorized — professor access required')
  })

  it('rejects professors who do not own the section', async () => {
    mockProfessorAuth('attacker', 'attacker@uni.edu')
    mockAdminClient.mockReturnValue({
      from: vi.fn(() =>
        buildChain({
          data: { id: validUUID, professor_id: 'real-owner', end_date: null, course: null },
          error: null,
        })
      ),
    })
    const result = await withdrawStaffRequest(requestUUID, validUUID)
    expect(result.error).toBe('You do not own this section')
  })

  it('rejects withdrawal by someone other than the original requester', async () => {
    mockProfessorAuth('prof-1', 'prof@uni.edu')

    mockAdminClient.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === 'course_sections') {
          return buildChain({
            data: { id: validUUID, professor_id: 'prof-1', end_date: null, course: null },
            error: null,
          })
        }
        if (table === 'section_staff_requests') {
          return buildChain({
            data: {
              id: requestUUID,
              requested_by: 'a-different-prof', // NOT prof-1
              status: 'pending',
            },
            error: null,
          })
        }
        return buildChain({ data: null, error: null })
      }),
    })

    const result = await withdrawStaffRequest(requestUUID, validUUID)
    expect(result.error).toBe('You did not submit this request')
  })

  it.each(['approved', 'rejected'] as const)(
    'rejects withdrawal when request status is "%s" (only pending allowed)',
    async (status) => {
      mockProfessorAuth('prof-1', 'prof@uni.edu')

      mockAdminClient.mockReturnValue({
        from: vi.fn((table: string) => {
          if (table === 'course_sections') {
            return buildChain({
              data: { id: validUUID, professor_id: 'prof-1', end_date: null, course: null },
              error: null,
            })
          }
          if (table === 'section_staff_requests') {
            return buildChain({
              data: { id: requestUUID, requested_by: 'prof-1', status },
              error: null,
            })
          }
          return buildChain({ data: null, error: null })
        }),
      })

      const result = await withdrawStaffRequest(requestUUID, validUUID)
      expect(result.error).toBe('Only pending requests can be withdrawn')
    }
  )

  it('returns "Request not found" when lookup fails', async () => {
    mockProfessorAuth('prof-1', 'prof@uni.edu')

    mockAdminClient.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === 'course_sections') {
          return buildChain({
            data: { id: validUUID, professor_id: 'prof-1', end_date: null, course: null },
            error: null,
          })
        }
        if (table === 'section_staff_requests') {
          return buildChain({ data: null, error: { message: 'not found' } })
        }
        return buildChain({ data: null, error: null })
      }),
    })

    const result = await withdrawStaffRequest(requestUUID, validUUID)
    expect(result.error).toBe('Request not found')
  })
})
