// Tests for admin staff-request server actions — auth guards, state-machine
// guards, identity-conflict guards, and schema validation for approve/reject/
// revoke flows. Happy-path inserts are out of scope.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Chain Builder ────────────────────────────────────────────

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
const mockSendStaffWelcome = vi.fn().mockResolvedValue(true)
const mockSendStaffRequestRejected = vi.fn().mockResolvedValue(true)
const mockSendStaffInviteLink = vi.fn().mockResolvedValue(true)
const mockEmitEvent = vi.fn()

vi.mock('@/lib/events/emit', () => ({ emitEvent: (...args: unknown[]) => mockEmitEvent(...args) }))
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
vi.mock('@/lib/email', () => ({
  sendStaffWelcome: (...args: unknown[]) => mockSendStaffWelcome(...args),
  sendStaffRequestRejected: (...args: unknown[]) => mockSendStaffRequestRejected(...args),
  sendStaffInviteLink: (...args: unknown[]) => mockSendStaffInviteLink(...args),
}))
vi.mock('@/lib/validations/student', () => ({
  generateSecurePassword: vi.fn(() => 'TestTempPassw0rd!'),
}))

// ── Test Setup ───────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let approveStaffRequest: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let rejectStaffRequest: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let revokeStaffAssignment: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let resendStaffInvite: any

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockAdminClient.mockReset()
  mockGetProfileById.mockReset()
  mockSendStaffWelcome.mockClear()
  mockSendStaffRequestRejected.mockClear()
  mockSendStaffInviteLink.mockClear()
  mockSendStaffWelcome.mockResolvedValue(true)
  mockSendStaffInviteLink.mockResolvedValue(true)
  mockEmitEvent.mockReset()

  const mod = await import('@/app/(dashboard)/admin/staff-requests/actions')
  approveStaffRequest = mod.approveStaffRequest
  rejectStaffRequest = mod.rejectStaffRequest
  revokeStaffAssignment = mod.revokeStaffAssignment
  resendStaffInvite = mod.resendStaffInvite
})

// ── Auth helpers ─────────────────────────────────────────────

function mockUnauthenticated() {
  mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'No user' } })
}

function mockAdminAuth(userId = 'admin-1') {
  mockGetUser.mockResolvedValue({
    data: { user: { id: userId, app_metadata: { institution_status: 'active' } } },
    error: null,
  })
  mockGetProfileById.mockResolvedValue({ id: userId, role: 'institution_admin', institution_id: 'inst-test-1' })
}

function mockProfessorAuth(userId = 'prof-1') {
  mockGetUser.mockResolvedValue({ data: { user: { id: userId } }, error: null })
  mockGetProfileById.mockResolvedValue({ id: userId, role: 'professor' })
}

// ── Fixtures ─────────────────────────────────────────────────

const requestUUID = '550e8400-e29b-41d4-a716-446655440001'
const staffUUID = '550e8400-e29b-41d4-a716-446655440002'

const baseRequestRow = {
  id: requestUUID,
  section_id: 'sec-1',
  requested_by: 'prof-1',
  candidate_email: 'ta@uni.edu',
  candidate_first_name: 'Alex',
  candidate_last_name: 'Nguyen',
  requested_role: 'ta',
  status: 'pending',
  starts_at: '2026-01-01T00:00:00Z',
  ends_at: '2026-05-01T00:00:00Z',
  /* institution_id for the tenant-guard lookup (assertTenantOwnsVia
   * resolves through course_sections; the section_id field is also used). */
  institution_id: 'inst-test-1',
  section: {
    id: 'sec-1',
    end_date: '2026-05-01',
    professor_id: 'prof-1',
    section_code: 'CS101-01',
    course: { code: 'CS101', title: 'Intro' },
  },
}

/**
 * Builds an admin client where table queries route by name. Tests override
 * individual tables via the `overrides` map.
 */
function buildAdminDb(overrides: Record<string, unknown> = {}) {
  return {
    auth: {
      admin: {
        createUser: vi.fn().mockResolvedValue({
          data: { user: { id: 'new-staff-1' } },
          error: null,
        }),
        inviteUserByEmail: vi.fn().mockResolvedValue({
          data: { user: { id: 'new-staff-1' } },
          error: null,
        }),
        listUsers: vi.fn().mockResolvedValue({
          data: { users: [] },
          error: null,
        }),
        generateLink: vi.fn().mockResolvedValue({
          data: { properties: { action_link: 'https://example.com/invite?token=fresh' } },
          error: null,
        }),
        getUserById: vi.fn().mockResolvedValue({
          data: { user: { id: 'new-staff-1', app_metadata: {} } },
          error: null,
        }),
        updateUserById: vi.fn().mockResolvedValue({
          data: { user: { id: 'new-staff-1' } },
          error: null,
        }),
      },
    },
    from: vi.fn((table: string) => {
      if (overrides[table]) {
        // Caller can pass either a chain factory fn or a chain directly.
        const v = overrides[table]
        return typeof v === 'function' ? (v as () => unknown)() : v
      }
      /* Default chains for tenant-guard lookups (assertTenantOwns + Via).
       * Tests can override these by passing their own chain in overrides. */
      if (table === 'course_sections') {
        return buildChain({ data: { institution_id: 'inst-test-1' }, error: null })
      }
      if (table === 'profiles') {
        return buildChain({ data: { institution_id: 'inst-test-1' }, error: null })
      }
      return buildChain({ data: null, error: null })
    }),
  }
}

// ═════════════════════════════════════════════════════════════
// approveStaffRequest
// ═════════════════════════════════════════════════════════════

describe('approveStaffRequest', () => {
  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const result = await approveStaffRequest({ request_id: requestUUID })
    expect(result.error).toBe('Not authenticated')
  })

  it('rejects non-admin roles (professor)', async () => {
    mockProfessorAuth()
    const result = await approveStaffRequest({ request_id: requestUUID })
    expect(result.error).toBe('Unauthorized — admin access required')
  })

  it('rejects invalid input (non-UUID request_id)', async () => {
    mockAdminAuth()
    const result = await approveStaffRequest({ request_id: 'not-a-uuid' })
    expect(result.error).toBe('Invalid input')
  })

  it('blocks when request not found (tenant guard hits missing-row branch)', async () => {
    mockAdminAuth()
    mockAdminClient.mockReturnValue(
      buildAdminDb({
        section_staff_requests: () => buildChain({ data: null, error: { message: 'nope' } }),
      })
    )
    const result = await approveStaffRequest({ request_id: requestUUID })
    expect(result.error).toMatch(/Not found/)
  })

  it.each(['approved', 'rejected'] as const)(
    'rejects approval when request status is "%s" (only pending allowed)',
    async (status) => {
      mockAdminAuth()
      mockAdminClient.mockReturnValue(
        buildAdminDb({
          section_staff_requests: () =>
            buildChain({ data: { ...baseRequestRow, status }, error: null }),
        })
      )
      const result = await approveStaffRequest({ request_id: requestUUID })
      expect(result.error).toBe('Only pending requests can be approved')
    }
  )

  it('blocks approval when candidate is already an institution_admin', async () => {
    mockAdminAuth()
    mockAdminClient.mockReturnValue(
      buildAdminDb({
        section_staff_requests: () => buildChain({ data: baseRequestRow, error: null }),
        profiles: () =>
          buildChain({
            data: {
              id: 'existing-1',
              email: 'ta@uni.edu',
              role: 'institution_admin',
              name: 'Admin',
              /* #745: the candidate lookup is unscoped and compares institution_id,
                 so a fixture without one is now (correctly) refused as foreign. */
              institution_id: 'inst-test-1',
            },
            error: null,
          }),
      })
    )
    const result = await approveStaffRequest({ request_id: requestUUID })
    expect(result.error).toMatch(/registered as a institution_admin/)
  })

  it('blocks approval when candidate is already a professor', async () => {
    mockAdminAuth()
    mockAdminClient.mockReturnValue(
      buildAdminDb({
        section_staff_requests: () => buildChain({ data: baseRequestRow, error: null }),
        profiles: () =>
          buildChain({
            data: {
              id: 'existing-1',
              email: 'ta@uni.edu',
              role: 'professor',
              name: 'Prof',
              institution_id: 'inst-test-1',
            },
            error: null,
          }),
      })
    )
    const result = await approveStaffRequest({ request_id: requestUUID })
    expect(result.error).toMatch(/registered as a professor/)
  })

  it('signals requires_student_promotion when candidate is an existing student (no auto-promote)', async () => {
    mockAdminAuth()
    mockAdminClient.mockReturnValue(
      buildAdminDb({
        section_staff_requests: () => buildChain({ data: baseRequestRow, error: null }),
        profiles: () =>
          buildChain({
            data: {
              id: 'existing-1',
              email: 'ta@uni.edu',
              role: 'student',
              name: 'Stu',
              institution_id: 'inst-test-1',
            },
            error: null,
          }),
      })
    )
    const result = await approveStaffRequest({ request_id: requestUUID })
    expect(result.error).toBeUndefined()
    expect(result.requires_student_promotion).toBe(true)
    expect(result.candidate?.email).toBe('ta@uni.edu')
    expect(result.candidate?.name).toBe('Stu')
  })

  it('surfaces createUser failure as a user-facing error', async () => {
    mockAdminAuth()
    const adminDb = buildAdminDb({
      section_staff_requests: () => buildChain({ data: baseRequestRow, error: null }),
      // No existing profile → invite flow
      profiles: () => buildChain({ data: null, error: null }),
    })
    // Override createUser to fail (non-email_exists error)
    adminDb.auth.admin.createUser = vi.fn().mockResolvedValue({
      data: { user: null },
      error: { message: 'SMTP down' },
    })
    mockAdminClient.mockReturnValue(adminDb)

    const result = await approveStaffRequest({ request_id: requestUUID })
    expect(result.error).toMatch(/Failed to create user/)
    expect(result.error).toMatch(/SMTP down/)
  })

  it('surfaces section_staff insert failure as a user-facing error', async () => {
    mockAdminAuth()

    // Build a stateful profiles chain: first call (lookup) returns null, later
    // calls (upsert + professor-name lookup) return a successful chain.
    let profilesCallCount = 0
    const adminDb = buildAdminDb({
      section_staff_requests: () => buildChain({ data: baseRequestRow, error: null }),
      profiles: () => {
        profilesCallCount++
        if (profilesCallCount === 1) {
          // Initial candidate lookup: no existing profile → invite flow
          return buildChain({ data: null, error: null })
        }
        // Subsequent calls (upsert, professor name lookup)
        return buildChain({ data: { name: 'Prof Owner' }, error: null })
      },
      section_staff: () =>
        buildChain({ data: null, error: { message: 'unique violation' } }),
    })
    mockAdminClient.mockReturnValue(adminDb)

    const result = await approveStaffRequest({ request_id: requestUUID })
    expect(result.error).toMatch(/Failed to activate staff assignment/)
    // Welcome email must NOT fire on failure
    expect(mockSendStaffWelcome).not.toHaveBeenCalled()
  })

  /* ── Cross-tenant candidate resolution (#745) ──────────────────
   * The candidate lookup used to run across the whole profiles table on the admin
   * client with no institution predicate, so approving could resolve — and then
   * PROMOTE — a student belonging to a different institution, flipping their role and
   * breaking their real account in their own tenant.
   *
   * These pin the two halves that are easy to regress:
   *  - the refusal happens at all, and
   *  - a foreign candidate never reaches the invite branch. That second one matters
   *    more than it looks: the naive fix (scoping the lookup) makes a foreign email
   *    look brand-new, and the invite branch then hits email_exists, "recovers" the
   *    victim's auth user by id, and upserts a profile carrying OUR institution_id.
   *    That is cross-tenant account takeover, strictly worse than the bug it replaced.
   */
  const foreignProfile = (role: string) => ({
    id: 'foreign-1',
    email: 'ta@uni.edu',
    role,
    name: 'Someone Elsewhere',
    institution_id: 'inst-OTHER-999',
  })

  it.each(['student', 'professor', 'institution_admin', 'course_assistant'] as const)(
    'refuses a candidate belonging to another institution (%s) and never invites them',
    async (role) => {
      mockAdminAuth()
      const adminDb = buildAdminDb({
        section_staff_requests: () => buildChain({ data: baseRequestRow, error: null }),
        profiles: () => buildChain({ data: foreignProfile(role), error: null }),
      })
      mockAdminClient.mockReturnValue(adminDb)

      const result = await approveStaffRequest({ request_id: requestUUID })

      expect(result.success).toBeUndefined()
      expect(result.requires_student_promotion).toBeUndefined()
      /* The invite branch is where the takeover lived — it must not be reached. */
      expect(adminDb.auth.admin.createUser).not.toHaveBeenCalled()
      expect(adminDb.auth.admin.updateUserById).not.toHaveBeenCalled()
    },
  )

  it('gives the SAME refusal for every foreign role, so it is not an existence oracle', async () => {
    const messages: string[] = []
    for (const role of ['student', 'professor', 'institution_admin'] as const) {
      mockAdminAuth()
      mockAdminClient.mockReturnValue(
        buildAdminDb({
          section_staff_requests: () => buildChain({ data: baseRequestRow, error: null }),
          profiles: () => buildChain({ data: foreignProfile(role), error: null }),
        })
      )
      const result = await approveStaffRequest({ request_id: requestUUID })
      messages.push(result.error ?? '')
    }
    /* One distinct message. A role-specific one would tell any admin what any email
       on the platform is registered as — which is what the old copy did. */
    expect(new Set(messages).size).toBe(1)
    expect(messages[0]).not.toMatch(/student|professor|institution_admin/i)
    expect(messages[0]).toBeTruthy()
  })

  it('refuses an orphan auth user whose provenance is not ours, and rotates nothing', async () => {
    mockAdminAuth()
    const adminDb = buildAdminDb({
      section_staff_requests: () => buildChain({ data: baseRequestRow, error: null }),
      /* No local profile → invite branch → email already taken → orphan recovery. */
      profiles: () => buildChain({ data: null, error: null }),
    })
    adminDb.auth.admin.createUser = vi.fn().mockResolvedValue({
      data: { user: null },
      error: { status: 422, code: 'email_exists', message: 'Email already been registered' },
    })
    adminDb.auth.admin.listUsers = vi.fn().mockResolvedValue({
      data: { users: [{ id: 'someone-elses-user', email: 'ta@uni.edu' }] },
      error: null,
    })
    /* Belongs to another institution — or, as here, predates the stamp entirely.
       Unknown provenance fails CLOSED: an ambiguous account needs a human. */
    adminDb.auth.admin.getUserById = vi.fn().mockResolvedValue({
      data: { user: { id: 'someone-elses-user', app_metadata: {} } },
      error: null,
    })
    mockAdminClient.mockReturnValue(adminDb)

    const result = await approveStaffRequest({ request_id: requestUUID })

    expect(result.success).toBeUndefined()
    expect(result.error).toBeTruthy()
    /* The takeover was: rotate their password, then upsert their profile into our
       tenant. Neither may happen. */
    expect(adminDb.auth.admin.updateUserById).not.toHaveBeenCalled()
  })

  it('recovers orphan auth user when createUser reports email_exists (idempotent re-approve)', async () => {
    mockAdminAuth()

    // Emulate: profiles lookup returns null (no Scholera profile) → invite path.
    // createUser fails with 422/email_exists → action should call listUsers, find
    // the orphan auth row, reuse its ID, upsert profile, and succeed.
    let profilesCallCount = 0
    const adminDb = buildAdminDb({
      section_staff_requests: () => buildChain({ data: baseRequestRow, error: null }),
      profiles: () => {
        profilesCallCount++
        if (profilesCallCount === 1) {
          return buildChain({ data: null, error: null })
        }
        return buildChain({ data: { name: 'Prof Owner' }, error: null })
      },
      section_staff: () =>
        buildChain({ data: { id: 'staff-row-1' }, error: null }),
    })
    adminDb.auth.admin.createUser = vi.fn().mockResolvedValue({
      data: { user: null },
      error: { status: 422, code: 'email_exists', message: 'Email already been registered' },
    })
    adminDb.auth.admin.listUsers = vi.fn().mockResolvedValue({
      data: {
        users: [
          { id: 'orphan-auth-id', email: 'someone-else@uni.edu' },
          { id: 'orphan-recovered-id', email: 'TA@uni.edu' }, // case-insensitive match
        ],
      },
      error: null,
    })
    /* #745: recovery now requires proof the orphan is OURS — an auth user with no
       profile row is equally another tenant's half-finished invite. createUser stamps
       institution_id into app_metadata for exactly this comparison. */
    adminDb.auth.admin.getUserById = vi.fn().mockResolvedValue({
      data: { user: { id: 'orphan-recovered-id', app_metadata: { institution_id: 'inst-test-1' } } },
      error: null,
    })
    mockAdminClient.mockReturnValue(adminDb)

    const result = await approveStaffRequest({ request_id: requestUUID })
    expect(result.error).toBeUndefined()
    expect(result.success).toBe(true)
    // listUsers was consulted exactly once with page=1
    expect(adminDb.auth.admin.listUsers).toHaveBeenCalledWith({ page: 1, perPage: 1000 })
    // Orphan path must rotate the temp password + re-stamp the gate + confirm email
    expect(adminDb.auth.admin.updateUserById).toHaveBeenCalledWith(
      'orphan-recovered-id',
      expect.objectContaining({
        password: 'TestTempPassw0rd!',
        email_confirm: true,
        app_metadata: expect.objectContaining({ requires_password_set: true }),
      })
    )
  })

  it('returns clear error when email_exists but orphan auth user cannot be located', async () => {
    mockAdminAuth()

    const adminDb = buildAdminDb({
      section_staff_requests: () => buildChain({ data: baseRequestRow, error: null }),
      profiles: () => buildChain({ data: null, error: null }),
    })
    adminDb.auth.admin.createUser = vi.fn().mockResolvedValue({
      data: { user: null },
      error: { status: 422, code: 'email_exists', message: 'already registered' },
    })
    // listUsers returns fewer than 1000 (stop condition) with no match
    adminDb.auth.admin.listUsers = vi.fn().mockResolvedValue({
      data: { users: [{ id: 'someone', email: 'not-the-one@uni.edu' }] },
      error: null,
    })
    mockAdminClient.mockReturnValue(adminDb)

    const result = await approveStaffRequest({ request_id: requestUUID })
    expect(result.error).toMatch(/already registered in auth/i)
  })

  it('promotes existing student to course_assistant when promote_existing_student=true, then proceeds', async () => {
    mockAdminAuth()

    // Track whether the profiles.update({role:'course_assistant'}) was issued.
    const promoteUpdate = vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ error: null }),
    })

    let profilesCallCount = 0
    const adminDb = buildAdminDb({
      section_staff_requests: () => buildChain({ data: baseRequestRow, error: null }),
      profiles: () => {
        profilesCallCount++
        if (profilesCallCount === 1) {
          // Initial candidate lookup — returns the student row.
          const chain = buildChain({
            data: {
              id: 'existing-student-1',
              email: 'ta@uni.edu',
              role: 'student',
              name: 'Stu',
              institution_id: 'inst-test-1',
            },
            error: null,
          })
          return chain
        }
        if (profilesCallCount === 2) {
          // Second profiles call is the promotion update({role:'course_assistant'}).
          // Return a chain whose .update() is the tracker above.
          return { update: promoteUpdate }
        }
        // Subsequent calls (professor name lookup for welcome email).
        return buildChain({ data: { name: 'Prof Owner' }, error: null })
      },
      section_staff: () => buildChain({ data: { id: 'staff-row-1' }, error: null }),
    })
    mockAdminClient.mockReturnValue(adminDb)

    const result = await approveStaffRequest({
      request_id: requestUUID,
      promote_existing_student: true,
    })
    expect(result.error).toBeUndefined()
    expect(result.requires_student_promotion).toBeUndefined()
    expect(result.success).toBe(true)
    // Profile role flipped to 'course_assistant'
    expect(promoteUpdate).toHaveBeenCalledWith({ role: 'course_assistant' })
    // Welcome email fires on successful promotion
    expect(mockSendStaffWelcome).toHaveBeenCalled()
    // Invite path must NOT fire — we reused the existing profile.
    expect(adminDb.auth.admin.createUser).not.toHaveBeenCalled()
  })

  it('aborts promotion with a clear error if the role-flip update fails', async () => {
    mockAdminAuth()

    const failingPromoteUpdate = vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ error: { message: 'row-level security' } }),
    })

    let profilesCallCount = 0
    const adminDb = buildAdminDb({
      section_staff_requests: () => buildChain({ data: baseRequestRow, error: null }),
      profiles: () => {
        profilesCallCount++
        if (profilesCallCount === 1) {
          return buildChain({
            data: {
              id: 'existing-student-1',
              email: 'ta@uni.edu',
              role: 'student',
              name: 'Stu',
              institution_id: 'inst-test-1',
            },
            error: null,
          })
        }
        return { update: failingPromoteUpdate }
      },
    })
    mockAdminClient.mockReturnValue(adminDb)

    const result = await approveStaffRequest({
      request_id: requestUUID,
      promote_existing_student: true,
    })
    expect(result.error).toMatch(/Failed to promote student to course assistant/)
    // section_staff.insert must NOT happen when the promotion fails.
    expect(mockSendStaffWelcome).not.toHaveBeenCalled()
  })

  it('returns emailWarning when sendStaffWelcome fails (invite still succeeded)', async () => {
    mockAdminAuth()
    mockSendStaffWelcome.mockResolvedValueOnce(false)

    let profilesCallCount = 0
    const adminDb = buildAdminDb({
      section_staff_requests: () => buildChain({ data: baseRequestRow, error: null }),
      profiles: () => {
        profilesCallCount++
        if (profilesCallCount === 1) return buildChain({ data: null, error: null })
        return buildChain({ data: { name: 'Prof Owner' }, error: null })
      },
      section_staff: () => buildChain({ data: { id: 'staff-row-1' }, error: null }),
    })
    mockAdminClient.mockReturnValue(adminDb)

    const result = await approveStaffRequest({ request_id: requestUUID })
    expect(result.success).toBe(true)
    expect(result.emailWarning).toMatch(/Welcome email could not be sent/)
  })

  /* Security invariant: every fresh invite MUST create the auth user with
   * a known temp password + requires_password_set:true + email_confirm:true,
   * AND must NOT use Supabase's magic-link invite flow. The flag is what
   * middleware Rule 1.5 reads to force staff into SetPasswordDialog on first
   * login. If this stamp is dropped, staff can bypass password setup entirely. */
  it('creates auth user with temp password, email_confirm:true, and requires_password_set:true', async () => {
    mockAdminAuth()

    let profilesCallCount = 0
    const adminDb = buildAdminDb({
      section_staff_requests: () => buildChain({ data: baseRequestRow, error: null }),
      profiles: () => {
        profilesCallCount++
        if (profilesCallCount === 1) return buildChain({ data: null, error: null })
        return buildChain({ data: { name: 'Prof Owner' }, error: null })
      },
      section_staff: () => buildChain({ data: { id: 'staff-row-1' }, error: null }),
    })
    mockAdminClient.mockReturnValue(adminDb)

    const result = await approveStaffRequest({ request_id: requestUUID })
    expect(result.success).toBe(true)
    // createUser must include the temp password + email_confirm + the gate flag
    expect(adminDb.auth.admin.createUser).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'ta@uni.edu',
        password: 'TestTempPassw0rd!',
        email_confirm: true,
        app_metadata: expect.objectContaining({ requires_password_set: true }),
      })
    )
    // Magic-link invite flow must NOT fire — temp passwords replaced it.
    expect(adminDb.auth.admin.generateLink).not.toHaveBeenCalled()
    expect(adminDb.auth.admin.inviteUserByEmail).not.toHaveBeenCalled()
    // For fresh createUser, no separate updateUserById is needed.
    expect(adminDb.auth.admin.updateUserById).not.toHaveBeenCalled()
    // Welcome email receives the temp password (not an actionLink).
    expect(mockSendStaffWelcome).toHaveBeenCalledWith(
      'ta@uni.edu',
      expect.anything(),
      expect.objectContaining({ tempPassword: 'TestTempPassw0rd!' })
    )
  })

  /* Professor-notification wiring: on a successful approval the professor who SUBMITTED
   * the request (requested_by) gets an in-app notice — previously only the candidate was
   * emailed. */
  it('notifies the requesting professor in-app when the request is approved', async () => {
    mockAdminAuth()
    let profilesCallCount = 0
    const adminDb = buildAdminDb({
      section_staff_requests: () => buildChain({ data: baseRequestRow, error: null }),
      profiles: () => {
        profilesCallCount++
        if (profilesCallCount === 1) return buildChain({ data: null, error: null })
        return buildChain({ data: { name: 'Prof Owner' }, error: null })
      },
      section_staff: () => buildChain({ data: { id: 'staff-row-1' }, error: null }),
    })
    mockAdminClient.mockReturnValue(adminDb)

    const result = await approveStaffRequest({ request_id: requestUUID })
    expect(result.success).toBe(true)
    expect(mockEmitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'staff_request_approved', audience: ['prof-1'] }),
    )
  })
})

// ═════════════════════════════════════════════════════════════
// rejectStaffRequest
// ═════════════════════════════════════════════════════════════

describe('rejectStaffRequest', () => {
  const validInput = { request_id: requestUUID, note: 'Not the right fit' }

  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const result = await rejectStaffRequest(validInput)
    expect(result.error).toBe('Not authenticated')
  })

  it('rejects non-admin roles', async () => {
    mockProfessorAuth()
    const result = await rejectStaffRequest(validInput)
    expect(result.error).toBe('Unauthorized — admin access required')
  })

  it('requires a non-empty rejection note', async () => {
    mockAdminAuth()
    const result = await rejectStaffRequest({ request_id: requestUUID, note: '' })
    expect(result.error).toBe('Rejection reason is required')
  })

  it('blocks when request not found (tenant guard hits missing-row branch)', async () => {
    mockAdminAuth()
    mockAdminClient.mockReturnValue(
      buildAdminDb({
        section_staff_requests: () =>
          buildChain({ data: null, error: { message: 'missing' } }),
      })
    )
    const result = await rejectStaffRequest(validInput)
    expect(result.error).toMatch(/Not found/)
  })

  it.each(['approved', 'rejected'] as const)(
    'rejects when request status is "%s" (only pending allowed)',
    async (status) => {
      mockAdminAuth()
      mockAdminClient.mockReturnValue(
        buildAdminDb({
          section_staff_requests: () =>
            buildChain({
              data: {
                ...baseRequestRow,
                status,
                requester: { id: 'prof-1', name: 'Prof', email: 'prof@uni.edu' },
              },
              error: null,
            }),
        })
      )
      const result = await rejectStaffRequest(validInput)
      expect(result.error).toBe('Only pending requests can be rejected')
      // Email should not fire on state-machine rejection
      expect(mockSendStaffRequestRejected).not.toHaveBeenCalled()
    }
  )

  it('surfaces update failure cleanly', async () => {
    mockAdminAuth()

    /* The tenant guard succeeds via the default course_sections chain, then
     * the action's select returns a valid request, then the update fails. */
    const requestChain = buildChain({
      data: {
        ...baseRequestRow,
        requester: { id: 'prof-1', name: 'Prof', email: 'prof@uni.edu' },
      },
      error: null,
    })
    requestChain.update = vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ error: { message: 'DB down' } }),
    })

    mockAdminClient.mockReturnValue(
      buildAdminDb({
        section_staff_requests: () => requestChain,
      })
    )

    const result = await rejectStaffRequest(validInput)
    expect(result.error).toBe('Failed to reject request')
  })

  /* Professor-notification wiring: rejection already emailed the professor; now it also
   * lands an in-app notice for the requester (requested_by / the joined requester). */
  it('notifies the requesting professor in-app when the request is rejected', async () => {
    mockAdminAuth()
    mockAdminClient.mockReturnValue(
      buildAdminDb({
        section_staff_requests: () =>
          buildChain({
            data: {
              ...baseRequestRow,
              requester: { id: 'prof-1', name: 'Prof', email: 'prof@uni.edu' },
            },
            error: null,
          }),
      })
    )
    const result = await rejectStaffRequest(validInput)
    expect(result.success).toBe(true)
    expect(mockEmitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'staff_request_rejected', audience: ['prof-1'] }),
    )
  })
})

// ═════════════════════════════════════════════════════════════
// revokeStaffAssignment
// ═════════════════════════════════════════════════════════════

describe('revokeStaffAssignment', () => {
  const validInput = { staff_id: staffUUID }

  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const result = await revokeStaffAssignment(validInput)
    expect(result.error).toBe('Not authenticated')
  })

  it('rejects non-admin roles', async () => {
    mockProfessorAuth()
    const result = await revokeStaffAssignment(validInput)
    expect(result.error).toBe('Unauthorized — admin access required')
  })

  it('rejects invalid input (non-UUID staff_id)', async () => {
    mockAdminAuth()
    const result = await revokeStaffAssignment({ staff_id: 'not-a-uuid' })
    expect(result.error).toBe('Invalid input')
  })

  it('blocks when staff assignment not found (tenant guard hits missing-row branch)', async () => {
    mockAdminAuth()
    mockAdminClient.mockReturnValue(
      buildAdminDb({
        section_staff: () => buildChain({ data: null, error: null }),
      })
    )
    const result = await revokeStaffAssignment(validInput)
    expect(result.error).toMatch(/Not found/)
  })

  it.each(['ended', 'removed'] as const)(
    'rejects revoke when staff status is "%s" (only active allowed)',
    async (status) => {
      mockAdminAuth()
      mockAdminClient.mockReturnValue(
        buildAdminDb({
          section_staff: () =>
            buildChain({
              data: {
                id: staffUUID,
                section_id: 'sec-1',
                staff_id: 'user-1',
                status,
              },
              error: null,
            }),
        })
      )
      const result = await revokeStaffAssignment(validInput)
      expect(result.error).toBe('Only active assignments can be revoked')
    }
  )

  /**
   * The revoke now goes through an RPC, so the payload assertions that used to live here are gone.
   *
   * That is a deliberate trade and worth naming rather than quietly losing coverage. The old tests
   * asserted the UPDATE payload: past date omitted, null and future dates stamped. Those decisions
   * moved into SQL (`case when ends_at <= now() then ends_at else now() end`) precisely because
   * deciding them in JS split the clock between the Node process and the database, and a consultant
   * review showed that corrupts a real past end date whenever the app clock lags.
   *
   * So the conditional is no longer observable from here, and faking it in a mock would assert my
   * own mock rather than Postgres. What IS still worth pinning from a unit test is the wiring and
   * the two failure branches. The SQL expression itself is verified against the database.
   */
  function buildRpcDb(
    staffRow: Record<string, unknown>,
    opts: { closed?: unknown; rpcError?: unknown } = {},
  ) {
    const rpcCalls: Array<{ name: string; args: unknown }> = []
    const chain = buildChain({ data: staffRow, error: null })
    return {
      db: {
        ...buildAdminDb({ section_staff: () => chain }),
        rpc: (name: string, args: unknown) => {
          rpcCalls.push({ name, args })
          return {
            maybeSingle: () =>
              Promise.resolve({
                data: 'closed' in opts ? opts.closed : { id: staffRow.id },
                error: opts.rpcError ?? null,
              }),
          }
        },
      },
      rpcCalls,
    }
  }

  const activeRow = (ends_at: string | null) => ({
    id: staffUUID,
    section_id: 'sec-1',
    staff_id: 'user-1',
    status: 'active',
    ends_at,
  })

  it('closes the assignment through the guarded RPC, not a direct update', async () => {
    /* The wiring, and the reason it matters: a direct `.update()` here would reintroduce both the
       clock split and the read-then-write race the RPC exists to remove. */
    mockAdminAuth()
    const { db, rpcCalls } = buildRpcDb(activeRow('2026-01-03T00:00:00.000Z'))
    mockAdminClient.mockReturnValue(db)

    const result = await revokeStaffAssignment(validInput)

    expect(result.success).toBe(true)
    expect(rpcCalls).toHaveLength(1)
    expect(rpcCalls[0].name).toBe('revoke_staff_assignment')
    expect(rpcCalls[0].args).toEqual({ p_staff_id: staffUUID })
  })

  it('reports a conflict when the RPC matches no row', async () => {
    /* The RPC is guarded on `status = 'active'`, so zero rows means someone else closed it first.
       Reporting success there would tell the second admin their reason was recorded when it was
       not. */
    mockAdminAuth()
    const { db } = buildRpcDb(activeRow(null), { closed: null })
    mockAdminClient.mockReturnValue(db)

    const result = await revokeStaffAssignment(validInput)

    expect(result.success).toBeUndefined()
    expect(result.error).toMatch(/Someone else closed this assignment/)
  })

  it('surfaces an RPC failure cleanly', async () => {
    mockAdminAuth()
    const { db } = buildRpcDb(activeRow(null), { rpcError: { message: 'DB down' } })
    mockAdminClient.mockReturnValue(db)

    const result = await revokeStaffAssignment(validInput)
    expect(result.error).toBe('Failed to revoke assignment')
  })

})

// ═════════════════════════════════════════════════════════════
// resendStaffInvite
// ═════════════════════════════════════════════════════════════

describe('resendStaffInvite', () => {
  const profileUUID = '550e8400-e29b-41d4-a716-446655440003'
  const validInput = { profile_id: profileUUID }

  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const result = await resendStaffInvite(validInput)
    expect(result.error).toBe('Not authenticated')
  })

  it('rejects non-admin roles', async () => {
    mockProfessorAuth()
    const result = await resendStaffInvite(validInput)
    expect(result.error).toBe('Unauthorized — admin access required')
  })

  it('rejects invalid input (non-UUID profile_id)', async () => {
    mockAdminAuth()
    const result = await resendStaffInvite({ profile_id: 'not-a-uuid' })
    expect(result.error).toBe('Invalid input')
  })

  it('returns generic "Not found" when profile lookup returns null (tenant guard)', async () => {
    mockAdminAuth()
    mockAdminClient.mockReturnValue(
      buildAdminDb({
        profiles: () => buildChain({ data: null, error: null }),
      })
    )
    const result = await resendStaffInvite(validInput)
    expect(result.error).toMatch(/Not found/)
  })

  it.each(['student', 'professor', 'institution_admin'] as const)(
    'rejects resend when target profile.role is "%s" (staff-only action)',
    async (role) => {
      mockAdminAuth()
      mockAdminClient.mockReturnValue(
        buildAdminDb({
          profiles: () =>
            buildChain({
              data: {
                id: profileUUID,
                email: 'ta@uni.edu',
                name: 'Alex',
                role,
                invite_status: 'pending',
                institution_id: 'inst-test-1',
              },
              error: null,
            }),
        })
      )
      const result = await resendStaffInvite(validInput)
      expect(result.error).toMatch(/Only course-assistant profiles can be re-invited/)
    }
  )

  it.each(['accepted', 'expired'] as const)(
    'rejects resend when invite_status is already "%s"',
    async (inviteStatus) => {
      mockAdminAuth()
      mockAdminClient.mockReturnValue(
        buildAdminDb({
          profiles: () =>
            buildChain({
              data: {
                id: profileUUID,
                email: 'ta@uni.edu',
                name: 'Alex',
                role: 'course_assistant',
                invite_status: inviteStatus,
                institution_id: 'inst-test-1',
              },
              error: null,
            }),
        })
      )
      const result = await resendStaffInvite(validInput)
      expect(result.error).toMatch(new RegExp(`already ${inviteStatus}`))
    }
  )

  it('surfaces password-rotation failure as a recoverable error', async () => {
    mockAdminAuth()
    const adminDb = buildAdminDb({
      profiles: () =>
        buildChain({
          data: {
            id: profileUUID,
            email: 'ta@uni.edu',
            name: 'Alex',
            role: 'course_assistant',
            invite_status: 'pending',
            institution_id: 'inst-test-1',
          },
          error: null,
        }),
    })
    adminDb.auth.admin.updateUserById = vi.fn().mockResolvedValue({
      data: null,
      error: { message: 'auth update failed' },
    })
    mockAdminClient.mockReturnValue(adminDb)

    const result = await resendStaffInvite(validInput)
    expect(result.error).toMatch(/Could not reset the password/)
    expect(mockSendStaffInviteLink).not.toHaveBeenCalled()
  })

  it('rotates the temp password and emails the fresh credentials on success', async () => {
    mockAdminAuth()
    let profilesCallCount = 0
    const adminDb = buildAdminDb({
      profiles: () => {
        profilesCallCount++
        /* Call 1: assertTenantOwns lookup. Call 2: action's profile lookup.
         * Call 3+: the invited_at update. The first two return the same row. */
        if (profilesCallCount <= 2) {
          return buildChain({
            data: {
              id: profileUUID,
              email: 'ta@uni.edu',
              name: 'Alex',
              role: 'course_assistant',
              invite_status: 'pending',
              institution_id: 'inst-test-1',
            },
            error: null,
          })
        }
        return buildChain({ data: null, error: null })
      },
      section_staff: () =>
        buildChain({
          data: {
            role: 'ta',
            section: { section_code: 'CS101-01', course: { code: 'CS101', title: 'Intro' } },
          },
          error: null,
        }),
    })
    mockAdminClient.mockReturnValue(adminDb)

    const result = await resendStaffInvite(validInput)
    expect(result.error).toBeUndefined()
    expect(result.success).toBe(true)
    // Magic-link flow must NOT fire — password rotation replaced it.
    expect(adminDb.auth.admin.generateLink).not.toHaveBeenCalled()
    // Email receives the fresh temp password (not an actionLink).
    expect(mockSendStaffInviteLink).toHaveBeenCalledWith(
      'ta@uni.edu',
      'Alex',
      expect.objectContaining({ tempPassword: 'TestTempPassw0rd!' })
    )
  })

  it('returns emailWarning when sendStaffInviteLink fails (password still rotated)', async () => {
    mockAdminAuth()
    mockSendStaffInviteLink.mockResolvedValueOnce(false)

    let profilesCallCount = 0
    const adminDb = buildAdminDb({
      profiles: () => {
        profilesCallCount++
        if (profilesCallCount <= 2) {
          return buildChain({
            data: {
              id: profileUUID,
              email: 'ta@uni.edu',
              name: 'Alex',
              role: 'course_assistant',
              invite_status: 'pending',
              institution_id: 'inst-test-1',
            },
            error: null,
          })
        }
        return buildChain({ data: null, error: null })
      },
    })
    mockAdminClient.mockReturnValue(adminDb)

    const result = await resendStaffInvite(validInput)
    expect(result.success).toBe(true)
    expect(result.emailWarning).toMatch(/credentials email could not be sent/i)
  })

  /* Security invariant: resend must rotate the password AND re-stamp
   * requires_password_set on app_metadata. Without re-stamping, middleware
   * can't bounce the user into SetPasswordDialog after they log in with the
   * fresh temp password. */
  it('rotates the password AND re-stamps requires_password_set:true on resend', async () => {
    mockAdminAuth()

    let profilesCallCount = 0
    const adminDb = buildAdminDb({
      profiles: () => {
        profilesCallCount++
        /* Calls 1 and 2: the tenant-guard lookup + the action's profile
         * lookup. Call 3+: the invited_at update. */
        if (profilesCallCount <= 2) {
          return buildChain({
            data: {
              id: profileUUID,
              email: 'ta@uni.edu',
              name: 'Alex',
              role: 'course_assistant',
              invite_status: 'pending',
              institution_id: 'inst-test-1',
            },
            error: null,
          })
        }
        return buildChain({ data: null, error: null })
      },
      section_staff: () =>
        buildChain({
          data: {
            role: 'ta',
            section: { section_code: 'CS101-01', course: { code: 'CS101', title: 'Intro' } },
          },
          error: null,
        }),
    })
    adminDb.auth.admin.getUserById = vi.fn().mockResolvedValue({
      data: { user: { id: profileUUID, app_metadata: { provider: 'email' } } },
      error: null,
    })
    mockAdminClient.mockReturnValue(adminDb)

    const result = await resendStaffInvite(validInput)
    expect(result.success).toBe(true)
    // Single updateUserById call carries the new password + email_confirm + the gate flag,
    // preserving existing app_metadata.
    expect(adminDb.auth.admin.updateUserById).toHaveBeenCalledWith(
      profileUUID,
      {
        password: 'TestTempPassw0rd!',
        email_confirm: true,
        app_metadata: expect.objectContaining({
          provider: 'email',
          requires_password_set: true,
        }),
      }
    )
  })
})
