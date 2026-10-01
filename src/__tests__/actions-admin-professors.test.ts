// Tests for admin professor server actions — business logic guards.
// Auth gate tests removed (tautological). Kept: error fallback, duplicate email guard,
// and cascade check for deletion (real business logic).

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Module-Level Mock References ─────────────────────────────

const mockGetUser = vi.fn()
const mockAdminClient = vi.fn()
const mockGetProfileById = vi.fn()

// professorQueries mock functions — available for all tests
const mockGetByEmail = vi.fn()
const mockUpsertProfile = vi.fn()
const mockCreateDepartmentFaculty = vi.fn()
const mockGetCascadeCounts = vi.fn()
const mockRemove = vi.fn()
const mockGetById = vi.fn()
const mockSendProfessorWelcome = vi.fn()

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
  professorQueries: {
    getByEmail: (...args: unknown[]) => mockGetByEmail(...args),
    upsertProfile: (...args: unknown[]) => mockUpsertProfile(...args),
    createDepartmentFaculty: (...args: unknown[]) => mockCreateDepartmentFaculty(...args),
    getCascadeCounts: (...args: unknown[]) => mockGetCascadeCounts(...args),
    remove: (...args: unknown[]) => mockRemove(...args),
    getById: (...args: unknown[]) => mockGetById(...args),
    getByIdWithDetails: vi.fn(),
    getAllWithDepartments: vi.fn(),
    updateProfile: vi.fn(),
    updateDepartmentFaculty: vi.fn(),
    removeDepartmentFaculty: vi.fn(),
  },
}))
vi.mock('@/lib/email', () => ({
  sendProfessorWelcome: (...args: unknown[]) => mockSendProfessorWelcome(...args),
}))
vi.mock('@/lib/validations/student', () => ({
  generateSecurePassword: vi.fn(() => 'TestTempPassw0rd!'),
}))

// ── Lazily-imported action references ────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createProfessor: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let deleteProfessor: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let getProfessorCascadeCounts: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let resendProfessorInvite: any

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockAdminClient.mockReset()
  mockGetProfileById.mockReset()
  mockGetByEmail.mockReset()
  mockUpsertProfile.mockReset()
  mockCreateDepartmentFaculty.mockReset()
  mockGetCascadeCounts.mockReset()
  mockRemove.mockReset()
  mockGetById.mockReset()
  mockSendProfessorWelcome.mockReset().mockResolvedValue(true)

  const mod = await import('@/app/(dashboard)/admin/professors/actions')
  createProfessor = mod.createProfessor
  deleteProfessor = mod.deleteProfessor
  getProfessorCascadeCounts = mod.getProfessorCascadeCounts
  resendProfessorInvite = mod.resendProfessorInvite
})

// ── Shared chain/admin-db builders for the email-contract tests ──────
// Serves both the assertTenantOwns lookup (select/eq/maybeSingle returning a
// row whose institution_id matches the admin's) and the profiles update used
// by resendProfessorInvite (update/eq, awaited as a non-thenable chain).
function makeTenantChain(institutionId = 'inst-test-1') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {}
  chain.select = vi.fn(() => chain)
  chain.eq = vi.fn(() => chain)
  chain.update = vi.fn(() => chain)
  chain.maybeSingle = vi.fn().mockResolvedValue({ data: { institution_id: institutionId }, error: null })
  chain.single = vi.fn().mockResolvedValue({ data: { institution_id: institutionId }, error: null })
  chain.then = undefined
  return chain
}

// ── Auth Helper ─────────────────────────────────────────────

function mockAdminRole(userId = 'admin-1') {
  mockGetUser.mockResolvedValue({
    data: { user: { id: userId, app_metadata: { institution_status: 'active' } } },
    error: null,
  })
  mockGetProfileById.mockResolvedValue({ id: userId, role: 'institution_admin', institution_id: 'inst-test-1' })
}

// ── getProfessorCascadeCounts ─────────────────────────────────
// This action does NOT call verifyAdmin — it uses the admin client directly.
// We verify it handles unexpected errors gracefully (no auth wall to test here).

describe('getProfessorCascadeCounts', () => {
  it('returns zeroed counts when admin client throws', async () => {
    mockAdminClient.mockImplementation(() => {
      throw new Error('client error')
    })
    const result = await getProfessorCascadeCounts('prof-1')
    expect(result).toEqual({ departments: 0, sections: 0 })
  })
})

// ── createProfessor — duplicate email guard ─────────────────────

describe('createProfessor — duplicate email guard', () => {
  const validInput = {
    email: 'prof@example.com',
    first_name: 'Jane',
    last_name: 'Smith',
    department_id: '550e8400-e29b-41d4-a716-446655440000',
    position: 'professor' as const,
    employment_type: 'full_time' as const,
  }

  it('rejects when email already exists', async () => {
    mockAdminRole()

    // Existing user found for this email
    mockGetByEmail.mockResolvedValue({ id: 'existing-user', email: validInput.email })

    /* The action calls assertTenantOwns(adminDb, 'departments', ...) before
     * the email lookup — so the mock must service that .from(...).select(...)
     * chain returning a row with the matching institution_id. */
    const tenantOwnsChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { institution_id: 'inst-test-1' }, error: null }),
    }
    const fakeAdminDb = {
      from: vi.fn(() => tenantOwnsChain),
      auth: { admin: { createUser: vi.fn() } },
    }
    mockAdminClient.mockReturnValue(fakeAdminDb)

    const result = await createProfessor(validInput)

    expect(result.error).toMatch(/already exists/)
    // createUser should not have been called when email is already in use
    expect(fakeAdminDb.auth.admin.createUser).not.toHaveBeenCalled()
  })
})

// ── deleteProfessor — cascade check ─────────────────────────────

describe('deleteProfessor — cascade check', () => {
  it('blocks deletion when professor has active course sections', async () => {
    mockAdminRole()

    // getCascadeCounts: 2 sections — delete must be blocked
    mockGetCascadeCounts.mockResolvedValue({ departments: 1, sections: 2 })

    /* The action calls assertTenantOwns(adminDb, 'profiles', ...) first — the
     * mock must serve that lookup with a matching institution_id. */
    const tenantOwnsChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { institution_id: 'inst-test-1' }, error: null }),
    }
    const fakeAdminDb = {
      from: vi.fn(() => tenantOwnsChain),
      auth: { admin: { deleteUser: vi.fn() } },
    }
    mockAdminClient.mockReturnValue(fakeAdminDb)

    const result = await deleteProfessor('prof-with-sections')

    expect(result.error).toMatch(/2 course section/)
    // deleteUser should not have been called
    expect(fakeAdminDb.auth.admin.deleteUser).not.toHaveBeenCalled()
  })
})

// ── createProfessor — onboarding email contract ─────────────────────
// The whole flow hinges on the welcome email landing. A send failure must
// surface to the admin via emailWarning, not be swallowed into a clean success.

describe('createProfessor — onboarding email contract', () => {
  const validInput = {
    email: 'newprof@example.com',
    first_name: 'New',
    last_name: 'Prof',
    department_id: '550e8400-e29b-41d4-a716-446655440000',
    position: 'professor' as const,
    employment_type: 'full_time' as const,
  }

  function setupHappyPath() {
    mockAdminRole()
    mockGetByEmail.mockResolvedValue(null)
    mockUpsertProfile.mockResolvedValue({ id: 'prof-1', email: validInput.email })
    mockCreateDepartmentFaculty.mockResolvedValue({ id: 'fac-1' })
    const fakeAdminDb = {
      from: vi.fn(() => makeTenantChain()),
      auth: { admin: { createUser: vi.fn().mockResolvedValue({ data: { user: { id: 'prof-1' } }, error: null }) } },
    }
    mockAdminClient.mockReturnValue(fakeAdminDb)
    return fakeAdminDb
  }

  it('succeeds with no emailWarning when the welcome email sends', async () => {
    setupHappyPath()
    const result = await createProfessor(validInput)
    expect(result.success).toBe(true)
    expect(result.emailWarning).toBeUndefined()
    expect(mockSendProfessorWelcome).toHaveBeenCalledTimes(1)
  })

  it('still creates the account but returns emailWarning when the email fails', async () => {
    const fakeAdminDb = setupHappyPath()
    mockSendProfessorWelcome.mockResolvedValue(false)
    const result = await createProfessor(validInput)
    // Account was created — we do NOT roll back on email failure...
    expect(fakeAdminDb.auth.admin.createUser).toHaveBeenCalledTimes(1)
    expect(result.success).toBe(true)
    // ...but the admin is warned instead of seeing a clean success.
    expect(result.emailWarning).toMatch(/invite email could not be sent/i)
  })
})

// ── resendProfessorInvite ───────────────────────────────────────────

describe('resendProfessorInvite', () => {
  function setupResend(inviteStatus = 'pending') {
    mockAdminRole()
    mockGetById.mockResolvedValue({
      id: 'prof-1',
      email: 'newprof@example.com',
      name: 'New Prof',
      invite_status: inviteStatus,
    })
    const fakeAdminDb = {
      from: vi.fn(() => makeTenantChain()),
      auth: {
        admin: {
          getUserById: vi.fn().mockResolvedValue({ data: { user: { app_metadata: {} } } }),
          updateUserById: vi.fn().mockResolvedValue({ error: null }),
        },
      },
    }
    mockAdminClient.mockReturnValue(fakeAdminDb)
    return fakeAdminDb
  }

  it('rejects when the invite is not pending', async () => {
    const fakeAdminDb = setupResend('active')
    const result = await resendProfessorInvite('prof-1')
    expect(result.error).toMatch(/already active/i)
    expect(fakeAdminDb.auth.admin.updateUserById).not.toHaveBeenCalled()
  })

  it('blocks cross-tenant resend and never rotates the password', async () => {
    // Tenant guard fails: the target row belongs to a different institution.
    mockAdminRole()
    mockGetById.mockResolvedValue({ id: 'prof-1', email: 'x@example.com', name: 'X', invite_status: 'pending' })
    const fakeAdminDb = {
      from: vi.fn(() => makeTenantChain('other-institution')),
      auth: {
        admin: {
          getUserById: vi.fn(),
          updateUserById: vi.fn(),
        },
      },
    }
    mockAdminClient.mockReturnValue(fakeAdminDb)

    const result = await resendProfessorInvite('prof-1')
    expect(result.error).toMatch(/not found/i)
    expect(fakeAdminDb.auth.admin.updateUserById).not.toHaveBeenCalled()
    expect(mockSendProfessorWelcome).not.toHaveBeenCalled()
  })

  it('returns the rotate error and does NOT email when password rotation fails', async () => {
    const fakeAdminDb = setupResend('pending')
    fakeAdminDb.auth.admin.updateUserById.mockResolvedValue({ error: new Error('auth down') })
    const result = await resendProfessorInvite('prof-1')
    expect(result.error).toMatch(/could not reset the password/i)
    expect(result.success).toBeUndefined()
    expect(mockSendProfessorWelcome).not.toHaveBeenCalled()
  })

  it('returns "Professor not found" when the professor does not exist', async () => {
    const fakeAdminDb = setupResend('pending')
    mockGetById.mockResolvedValue(null)
    const result = await resendProfessorInvite('prof-1')
    expect(result.error).toMatch(/not found/i)
    expect(fakeAdminDb.auth.admin.updateUserById).not.toHaveBeenCalled()
  })

  it('rotates the password and returns emailWarning when the resend email fails', async () => {
    const fakeAdminDb = setupResend('pending')
    mockSendProfessorWelcome.mockResolvedValue(false)
    const result = await resendProfessorInvite('prof-1')
    expect(fakeAdminDb.auth.admin.updateUserById).toHaveBeenCalledTimes(1)
    expect(result.success).toBe(true)
    expect(result.emailWarning).toMatch(/invite email could not be sent/i)
  })

  it('succeeds cleanly (no warning) and re-arms the password-set gate', async () => {
    const fakeAdminDb = setupResend('pending')
    const result = await resendProfessorInvite('prof-1')
    expect(result.success).toBe(true)
    expect(result.emailWarning).toBeUndefined()
    const updateArgs = fakeAdminDb.auth.admin.updateUserById.mock.calls[0][1]
    expect(updateArgs.app_metadata.requires_password_set).toBe(true)
  })
})
