// Tests for super_admin institution server actions.
// createInstitution: auth gate, validation, optional admin invite, slug
// uniqueness via catch-23505, partial-failure rollbacks (auth user orphan).
// setInstitutionStatus: suspension fan-out signOut, super_admin exemption,
// failure tolerance, reactivation skip.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock references ──────────────────────────────────────────

const mockGetUser = vi.fn()
const mockAdminClient = vi.fn()
const mockGetProfileById = vi.fn()
const mockSendInstitutionAdminWelcome = vi.fn().mockResolvedValue(true)

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
  sendInstitutionAdminWelcome: (...args: unknown[]) => mockSendInstitutionAdminWelcome(...args),
}))
vi.mock('@/lib/validations/student', () => ({
  generateSecurePassword: vi.fn(() => 'TestTempPassw0rd!'),
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createInstitution: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let setInstitutionStatus: any

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockAdminClient.mockReset()
  mockGetProfileById.mockReset()
  mockSendInstitutionAdminWelcome.mockClear()

  const mod = await import('@/app/(dashboard)/super-admin/institutions/actions')
  createInstitution = mod.createInstitution
  setInstitutionStatus = mod.setInstitutionStatus
})

// ── Helpers ──────────────────────────────────────────────────

function mockSuperAdmin(userId = 'super-1') {
  mockGetUser.mockResolvedValue({ data: { user: { id: userId } }, error: null })
  mockGetProfileById.mockResolvedValue({ id: userId, role: 'super_admin' })
}

function mockNonSuperAdmin() {
  mockGetUser.mockResolvedValue({ data: { user: { id: 'admin-1' } }, error: null })
  mockGetProfileById.mockResolvedValue({ id: 'admin-1', role: 'institution_admin' })
}

interface InsertResult {
  data?: unknown
  error?: { code?: string; message?: string } | null
}

/**
 * Build a minimal admin DB mock that handles the calls createInstitution makes.
 * Tests can override individual return values via the opts object.
 */
function buildAdminDb(opts: {
  insertInstitution?: InsertResult
  emailLookup?: InsertResult
  createUserResult?: { data?: { user?: { id: string } }; error?: { message?: string } | null }
  upsertProfile?: { error?: { message?: string } | null }
  deleteUser?: { error?: { message?: string } | null }
  deleteInstitutionTracker?: ReturnType<typeof vi.fn>
}) {
  const deleteInstitution = opts.deleteInstitutionTracker || vi.fn().mockResolvedValue({ error: null })
  const deleteUser = vi.fn().mockResolvedValue(opts.deleteUser ?? { error: null })

  return {
    from: vi.fn((table: string) => {
      if (table === 'institutions') {
        return {
          insert: vi.fn(() => ({
            select: vi.fn(() => ({
              single: vi.fn(() =>
                Promise.resolve(
                  opts.insertInstitution ?? {
                    data: { id: 'inst-1', name: 'Acme U', slug: 'acme', status: 'active' },
                    error: null,
                  },
                ),
              ),
            })),
          })),
          delete: vi.fn(() => ({
            eq: deleteInstitution,
          })),
        }
      }
      if (table === 'profiles') {
        return {
          select: vi.fn(() => ({
            ilike: vi.fn(() => ({
              maybeSingle: vi.fn(() =>
                Promise.resolve(opts.emailLookup ?? { data: null, error: null }),
              ),
            })),
          })),
          upsert: vi.fn(() => Promise.resolve(opts.upsertProfile ?? { error: null })),
        }
      }
      throw new Error(`Unexpected table: ${table}`)
    }),
    auth: {
      admin: {
        createUser: vi.fn(() =>
          Promise.resolve(
            opts.createUserResult ?? {
              data: { user: { id: 'user-new-1' } },
              error: null,
            },
          ),
        ),
        deleteUser,
      },
    },
    __deleteUser: deleteUser,
    __deleteInstitution: deleteInstitution,
  }
}

const baseInput = {
  name: 'Acme University',
  slug: 'acme',
}

const inputWithAdmin = {
  ...baseInput,
  primaryAdminEmail: 'admin@acme.edu',
  primaryAdminName: 'Acme Admin',
}

// ── Tests ────────────────────────────────────────────────────

describe('createInstitution — auth gate', () => {
  it('rejects unauthenticated callers', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null })
    const result = await createInstitution(baseInput)
    expect(result.error).toMatch(/Unauthorized/)
  })

  it('rejects non-super_admin callers', async () => {
    mockNonSuperAdmin()
    const result = await createInstitution(baseInput)
    expect(result.error).toMatch(/super_admin access required/)
  })
})

describe('createInstitution — validation', () => {
  it('rejects invalid slug format', async () => {
    mockSuperAdmin()
    const result = await createInstitution({ ...baseInput, slug: 'BadSlug!' })
    expect(result.error).toBeDefined()
    expect(result.error).toMatch(/Slug/)
  })

  it('rejects admin name provided without email (asymmetric)', async () => {
    mockSuperAdmin()
    const result = await createInstitution({
      ...baseInput,
      primaryAdminName: 'Solo Name',
      primaryAdminEmail: '',
    })
    expect(result.error).toBeDefined()
    expect(result.error).toMatch(/admin email and name/)
  })

  it('rejects admin email provided without name (asymmetric)', async () => {
    mockSuperAdmin()
    const result = await createInstitution({
      ...baseInput,
      primaryAdminEmail: 'admin@acme.edu',
      primaryAdminName: '',
    })
    expect(result.error).toBeDefined()
    expect(result.error).toMatch(/admin email and name/)
  })
})

describe('createInstitution — happy path without admin', () => {
  it('creates an institution with no admin and skips invite flow', async () => {
    mockSuperAdmin()
    const adminDb = buildAdminDb({})
    mockAdminClient.mockReturnValue(adminDb)

    const result = await createInstitution(baseInput)

    expect(result.success).toBe(true)
    expect(result.data?.institutionId).toBe('inst-1')
    expect(result.data?.primaryAdminId).toBeNull()
    expect(adminDb.auth.admin.createUser).not.toHaveBeenCalled()
    expect(mockSendInstitutionAdminWelcome).not.toHaveBeenCalled()
  })
})

describe('createInstitution — happy path with admin invite', () => {
  it('inserts institution + creates auth user + upserts profile + sends email', async () => {
    mockSuperAdmin()
    const adminDb = buildAdminDb({})
    mockAdminClient.mockReturnValue(adminDb)

    const result = await createInstitution(inputWithAdmin)

    expect(result.success).toBe(true)
    expect(result.data?.institutionId).toBe('inst-1')
    expect(result.data?.primaryAdminId).toBe('user-new-1')
    expect(adminDb.auth.admin.createUser).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'admin@acme.edu',
        password: 'TestTempPassw0rd!',
        email_confirm: true,
      }),
    )
    expect(mockSendInstitutionAdminWelcome).toHaveBeenCalledWith(
      'admin@acme.edu',
      'Acme Admin',
      expect.objectContaining({ institutionName: 'Acme University', tempPassword: 'TestTempPassw0rd!' }),
    )
  })
})

describe('createInstitution — slug uniqueness via 23505', () => {
  it('returns clean error when Postgres unique violation fires', async () => {
    mockSuperAdmin()
    const adminDb = buildAdminDb({
      insertInstitution: { data: null, error: { code: '23505', message: 'duplicate key' } },
    })
    mockAdminClient.mockReturnValue(adminDb)

    const result = await createInstitution(baseInput)

    expect(result.error).toMatch(/already exists/)
    /* createUser must not be called once the institution insert fails. */
    expect(adminDb.auth.admin.createUser).not.toHaveBeenCalled()
  })
})

describe('createInstitution — partial-failure rollbacks', () => {
  it('deletes the institution when the email is already taken', async () => {
    mockSuperAdmin()
    const deleteTracker = vi.fn().mockResolvedValue({ error: null })
    const adminDb = buildAdminDb({
      emailLookup: { data: { id: 'existing-user', email: 'admin@acme.edu' }, error: null },
      deleteInstitutionTracker: deleteTracker,
    })
    mockAdminClient.mockReturnValue(adminDb)

    const result = await createInstitution(inputWithAdmin)

    expect(result.error).toMatch(/already exists/)
    expect(deleteTracker).toHaveBeenCalledWith('id', 'inst-1')
    expect(adminDb.auth.admin.createUser).not.toHaveBeenCalled()
  })

  it('deletes the institution when auth.admin.createUser fails', async () => {
    mockSuperAdmin()
    const deleteTracker = vi.fn().mockResolvedValue({ error: null })
    const adminDb = buildAdminDb({
      createUserResult: { data: undefined, error: { message: 'auth error' } },
      deleteInstitutionTracker: deleteTracker,
    })
    mockAdminClient.mockReturnValue(adminDb)

    const result = await createInstitution(inputWithAdmin)

    expect(result.error).toMatch(/Failed to create admin account/)
    expect(deleteTracker).toHaveBeenCalledWith('id', 'inst-1')
  })

  it('deletes the orphan auth user when profile upsert fails', async () => {
    mockSuperAdmin()
    const adminDb = buildAdminDb({
      upsertProfile: { error: { message: 'profile insert failed' } },
    })
    mockAdminClient.mockReturnValue(adminDb)

    const result = await createInstitution(inputWithAdmin)

    expect(result.error).toMatch(/admin invite failed/)
    /* Critical rollback: the orphan auth.users row must be deleted so the
     * email is reusable on retry. */
    expect(adminDb.__deleteUser).toHaveBeenCalledWith('user-new-1')
  })
})

// ── setInstitutionStatus ─────────────────────────────────────

/* Builds an admin-client mock for setInstitutionStatus.
 *   - .from('institutions').update().eq().select().single() → updateResult
 *   - .from('profiles').select().eq() → members
 *   - auth.admin.signOut tracks calls; signOutImpl can simulate per-user failures.
 */
function buildSetStatusAdminDb(opts: {
  updateResult: { data: unknown; error: unknown }
  members?: { data: unknown; error: unknown }
  signOutImpl?: (userId: string) => Promise<{ error: unknown }>
}) {
  const signOut = vi.fn().mockImplementation(async (userId: string) => {
    if (opts.signOutImpl) return opts.signOutImpl(userId)
    return { error: null }
  })

  const institutionsChain = {
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue(opts.updateResult),
  }
  const profilesChain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockResolvedValue(opts.members ?? { data: [], error: null }),
  }

  return {
    from: vi.fn((table: string) => {
      if (table === 'institutions') return institutionsChain
      if (table === 'profiles') return profilesChain
      throw new Error(`Unexpected table: ${table}`)
    }),
    auth: { admin: { signOut } },
    __signOut: signOut,
  }
}

describe('setInstitutionStatus — auth + validation', () => {
  it('rejects non-super_admin caller', async () => {
    mockNonSuperAdmin()
    const result = await setInstitutionStatus('inst-1', 'suspended')
    expect(result.error).toMatch(/super_admin/)
    expect(mockAdminClient).not.toHaveBeenCalled()
  })

  it('rejects invalid status value', async () => {
    mockSuperAdmin()
    const result = await setInstitutionStatus('inst-1', 'archived' as 'active' | 'suspended')
    expect(result).toEqual({ error: 'Invalid status' })
  })

  it('returns error when update fails', async () => {
    mockSuperAdmin()
    const adminDb = buildSetStatusAdminDb({
      updateResult: { data: null, error: { message: 'not found' } },
    })
    mockAdminClient.mockReturnValue(adminDb)

    const result = await setInstitutionStatus('inst-1', 'suspended')

    expect(result.error).toMatch(/Failed to update institution/)
    expect(adminDb.__signOut).not.toHaveBeenCalled()
  })
})

describe('setInstitutionStatus — suspend flow', () => {
  const updatedRow = { id: 'inst-1', slug: 'stevens', status: 'suspended' }

  it('signs out every member of the tenant on suspend', async () => {
    mockSuperAdmin()
    const adminDb = buildSetStatusAdminDb({
      updateResult: { data: updatedRow, error: null },
      members: {
        data: [
          { id: 'user-a', role: 'institution_admin' },
          { id: 'user-b', role: 'professor' },
          { id: 'user-c', role: 'student' },
        ],
        error: null,
      },
    })
    mockAdminClient.mockReturnValue(adminDb)

    const result = await setInstitutionStatus('inst-1', 'suspended')

    expect(result.success).toBe(true)
    expect(adminDb.__signOut).toHaveBeenCalledTimes(3)
    expect(adminDb.__signOut).toHaveBeenCalledWith('user-a', 'global')
    expect(adminDb.__signOut).toHaveBeenCalledWith('user-b', 'global')
    expect(adminDb.__signOut).toHaveBeenCalledWith('user-c', 'global')
  })

  it('skips super_admin members from the global sign-out', async () => {
    mockSuperAdmin()
    const adminDb = buildSetStatusAdminDb({
      updateResult: { data: updatedRow, error: null },
      members: {
        data: [
          { id: 'user-a', role: 'institution_admin' },
          { id: 'user-platform', role: 'super_admin' },
        ],
        error: null,
      },
    })
    mockAdminClient.mockReturnValue(adminDb)

    await setInstitutionStatus('inst-1', 'suspended')

    expect(adminDb.__signOut).toHaveBeenCalledTimes(1)
    expect(adminDb.__signOut).toHaveBeenCalledWith('user-a', 'global')
  })

  it('continues on individual signOut failure (does not abort)', async () => {
    mockSuperAdmin()
    const adminDb = buildSetStatusAdminDb({
      updateResult: { data: updatedRow, error: null },
      members: {
        data: [
          { id: 'user-a', role: 'institution_admin' },
          { id: 'user-b', role: 'professor' },
        ],
        error: null,
      },
      signOutImpl: async (userId) =>
        userId === 'user-a' ? { error: { message: 'auth issue' } } : { error: null },
    })
    mockAdminClient.mockReturnValue(adminDb)

    const result = await setInstitutionStatus('inst-1', 'suspended')

    expect(result.success).toBe(true)
    expect(adminDb.__signOut).toHaveBeenCalledTimes(2)
  })

  it('completes the update even if member fetch fails', async () => {
    mockSuperAdmin()
    const adminDb = buildSetStatusAdminDb({
      updateResult: { data: updatedRow, error: null },
      members: { data: null, error: { message: 'fetch failed' } },
    })
    mockAdminClient.mockReturnValue(adminDb)

    const result = await setInstitutionStatus('inst-1', 'suspended')

    expect(result.success).toBe(true)
    expect(adminDb.__signOut).not.toHaveBeenCalled()
  })
})

describe('setInstitutionStatus — reactivate flow', () => {
  it('does NOT sign anyone out on reactivate', async () => {
    mockSuperAdmin()
    const adminDb = buildSetStatusAdminDb({
      updateResult: { data: { id: 'inst-1', slug: 'stevens', status: 'active' }, error: null },
      members: {
        data: [{ id: 'user-a', role: 'institution_admin' }],
        error: null,
      },
    })
    mockAdminClient.mockReturnValue(adminDb)

    const result = await setInstitutionStatus('inst-1', 'active')

    expect(result.success).toBe(true)
    expect(adminDb.__signOut).not.toHaveBeenCalled()
  })
})
