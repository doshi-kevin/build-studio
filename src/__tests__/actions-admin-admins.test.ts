// Tests for institution_admin co-admin invite actions: cap enforcement,
// tenant scoping, resend gates, revoke flow.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetUser = vi.fn()
const mockGetProfileById = vi.fn()
const mockAdminClient = vi.fn()
const mockGetById = vi.fn()
const mockSendWelcome = vi.fn().mockResolvedValue({ success: true })

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: (...args: unknown[]) => mockAdminClient(...args),
}))
vi.mock('@/lib/supabase/queries', () => ({
  profileQueries: { getProfileById: (...args: unknown[]) => mockGetProfileById(...args) },
  institutionQueries: { getById: (...args: unknown[]) => mockGetById(...args) },
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
vi.mock('@/lib/email', () => ({
  sendInstitutionAdminWelcome: (...args: unknown[]) => mockSendWelcome(...args),
}))
vi.mock('@/lib/validations/student', () => ({
  generateSecurePassword: vi.fn(() => 'TempPass1!'),
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let inviteInstitutionAdmin: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let resendCoAdminInvite: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let revokeCoAdminInvite: any

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockGetProfileById.mockReset()
  mockAdminClient.mockReset()
  mockGetById.mockReset()
  mockSendWelcome.mockClear()
  mockSendWelcome.mockResolvedValue({ success: true })

  const mod = await import('@/app/(dashboard)/admin/admins/actions')
  inviteInstitutionAdmin = mod.inviteInstitutionAdmin
  resendCoAdminInvite = mod.resendCoAdminInvite
  revokeCoAdminInvite = mod.revokeCoAdminInvite
})

function mockAdminAuth(userId = 'admin-1') {
  mockGetUser.mockResolvedValue({
    data: { user: { id: userId, app_metadata: { institution_status: 'active' } } },
    error: null,
  })
  mockGetProfileById.mockResolvedValue({ id: userId, role: 'institution_admin', institution_id: 'inst-1' })
}

/* Build a mock admin DB for the INVITE path: count → email lookup → upsert */
function buildInviteAdminDb(opts: {
  adminCount?: number
  emailHit?: { id: string; email: string; role: string } | null
  createUserResult?: { data?: { user?: { id: string } }; error?: { message?: string } | null }
  upsertResult?: { error?: { message?: string } | null }
}) {
  const deleteUser = vi.fn().mockResolvedValue({ error: null })
  const updateUserById = vi.fn().mockResolvedValue({ error: null })
  const createUser = vi.fn().mockResolvedValue(
    opts.createUserResult ?? { data: { user: { id: 'new-admin-1' } }, error: null },
  )
  const upsert = vi.fn().mockResolvedValue(opts.upsertResult ?? { error: null })

  let callIndex = 0
  const adminDb = {
    from: vi.fn().mockImplementation((table: string) => {
      if (table !== 'profiles') throw new Error(`Unexpected table ${table}`)
      callIndex += 1
      if (callIndex === 1) {
        /* Count query: .select().eq().eq() awaits to {count, error} */
        const countResult = { count: opts.adminCount ?? 0, error: null }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockImplementation(function (this: unknown) {
            return {
              eq: vi.fn().mockResolvedValue(countResult),
              then: (resolve: (v: unknown) => void) => resolve(countResult),
            }
          }),
        }
      }
      if (callIndex === 2) {
        /* Email lookup: .select().eq().eq().maybeSingle() */
        const chain = {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: opts.emailHit ?? null, error: null }),
        }
        return chain
      }
      /* 3rd+ call: upsert */
      return { upsert }
    }),
    auth: { admin: { createUser, deleteUser, updateUserById } },
    __createUser: createUser,
    __deleteUser: deleteUser,
    __updateUserById: updateUserById,
    __upsert: upsert,
  }
  return adminDb
}

/* Build a mock admin DB for RESEND/REVOKE: target lookup → update (resend) or delete (revoke) */
function buildTargetAdminDb(opts: {
  targetProfile?: { id: string; email: string; name: string | null; role: string; invite_status: string | null; institution_id: string } | null
  updateUserResult?: { error?: { message?: string } | null }
  deleteUserResult?: { error?: { message?: string } | null }
}) {
  const deleteUser = vi.fn().mockResolvedValue(opts.deleteUserResult ?? { error: null })
  const updateUserById = vi.fn().mockResolvedValue(opts.updateUserResult ?? { error: null })
  const createUser = vi.fn().mockResolvedValue({ data: { user: { id: 'unused' } }, error: null })

  let callIndex = 0
  const adminDb = {
    from: vi.fn().mockImplementation((table: string) => {
      if (table !== 'profiles') throw new Error(`Unexpected table ${table}`)
      callIndex += 1
      if (callIndex === 1) {
        /* Target lookup: .select().eq().maybeSingle() */
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: opts.targetProfile ?? null, error: null }),
        }
      }
      /* 2nd+ call: update or delete */
      const eqResult = { error: null }
      return {
        update: vi.fn(() => ({ eq: vi.fn().mockResolvedValue(eqResult) })),
        delete: vi.fn(() => ({ eq: vi.fn().mockResolvedValue(eqResult) })),
      }
    }),
    auth: { admin: { createUser, deleteUser, updateUserById } },
    __createUser: createUser,
    __deleteUser: deleteUser,
    __updateUserById: updateUserById,
  }
  return adminDb
}

describe('inviteInstitutionAdmin — auth + cap', () => {
  it('rejects unauthenticated callers', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no user' } })
    const result = await inviteInstitutionAdmin({ name: 'X', email: 'x@example.com' })
    expect(result.error).toBe('Not authenticated')
  })

  it('rejects when caller is not institution_admin', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'u', app_metadata: { institution_status: 'active' } } },
      error: null,
    })
    mockGetProfileById.mockResolvedValue({ id: 'u', role: 'professor', institution_id: 'inst-1' })

    const result = await inviteInstitutionAdmin({ name: 'X', email: 'x@example.com' })

    expect(result.error).toMatch(/admin access required/)
  })

  it('rejects invalid email', async () => {
    mockAdminAuth()
    mockAdminClient.mockReturnValue(buildInviteAdminDb({}))
    const result = await inviteInstitutionAdmin({ name: 'X', email: 'not-email' })
    expect(result.error).toMatch(/Invalid email/)
  })

  it('blocks invite when at the 5-admin cap', async () => {
    mockAdminAuth()
    const adminDb = buildInviteAdminDb({ adminCount: 5 })
    mockAdminClient.mockReturnValue(adminDb)

    const result = await inviteInstitutionAdmin({ name: 'X', email: 'x@example.com' })

    expect(result.error).toMatch(/maximum of 5 admins/)
    expect(adminDb.__createUser).not.toHaveBeenCalled()
  })

  it('blocks invite when over the cap (defensive)', async () => {
    mockAdminAuth()
    const adminDb = buildInviteAdminDb({ adminCount: 7 })
    mockAdminClient.mockReturnValue(adminDb)

    const result = await inviteInstitutionAdmin({ name: 'X', email: 'x@example.com' })

    expect(result.error).toMatch(/maximum of 5 admins/)
  })

  it('blocks invite when email already in tenant', async () => {
    mockAdminAuth()
    const adminDb = buildInviteAdminDb({
      adminCount: 1,
      emailHit: { id: 'existing', email: 'x@example.com', role: 'professor' },
    })
    mockAdminClient.mockReturnValue(adminDb)

    const result = await inviteInstitutionAdmin({ name: 'X', email: 'x@example.com' })

    expect(result.error).toMatch(/already exists in your institution/)
    expect(adminDb.__createUser).not.toHaveBeenCalled()
  })

  it('happy path: under cap → createUser + upsert + sendWelcome', async () => {
    mockAdminAuth()
    mockGetById.mockResolvedValue({ id: 'inst-1', name: 'Acme University', slug: 'acme' })
    const adminDb = buildInviteAdminDb({ adminCount: 2 })
    mockAdminClient.mockReturnValue(adminDb)

    const result = await inviteInstitutionAdmin({ name: 'Jane Doe', email: 'jane@example.com' })

    expect(result.success).toBe(true)
    expect(adminDb.__createUser).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'jane@example.com',
        password: 'TempPass1!',
        email_confirm: true,
      }),
    )
    expect(mockSendWelcome).toHaveBeenCalledWith(
      'jane@example.com',
      'Jane Doe',
      expect.objectContaining({ institutionName: 'Acme University', tempPassword: 'TempPass1!' }),
    )
  })
})

describe('resendCoAdminInvite — tenant + state guards', () => {
  it('blocks cross-tenant resend (target in different institution)', async () => {
    mockAdminAuth()
    const adminDb = buildTargetAdminDb({
      targetProfile: {
        id: 'admin-other',
        email: 'other@example.com',
        name: 'Other',
        role: 'institution_admin',
        invite_status: 'pending',
        institution_id: 'inst-OTHER',
      },
    })
    mockAdminClient.mockReturnValue(adminDb)

    const result = await resendCoAdminInvite('admin-other')

    expect(result.error).toMatch(/Admin not found/)
    expect(adminDb.__updateUserById).not.toHaveBeenCalled()
  })

  it('blocks resend when invite is already accepted', async () => {
    mockAdminAuth()
    const adminDb = buildTargetAdminDb({
      targetProfile: {
        id: 'admin-2',
        email: 'a@example.com',
        name: 'A',
        role: 'institution_admin',
        invite_status: 'accepted',
        institution_id: 'inst-1',
      },
    })
    mockAdminClient.mockReturnValue(adminDb)

    const result = await resendCoAdminInvite('admin-2')

    expect(result.error).toMatch(/already been accepted/)
  })
})

describe('revokeCoAdminInvite — guards', () => {
  it('blocks self-revoke', async () => {
    mockAdminAuth('admin-1')
    const result = await revokeCoAdminInvite('admin-1')
    expect(result.error).toMatch(/cannot revoke your own/)
  })

  it('blocks revoke when invite already accepted', async () => {
    mockAdminAuth()
    const adminDb = buildTargetAdminDb({
      targetProfile: {
        id: 'admin-2',
        email: 'a@example.com',
        name: 'A',
        role: 'institution_admin',
        invite_status: 'accepted',
        institution_id: 'inst-1',
      },
    })
    mockAdminClient.mockReturnValue(adminDb)

    const result = await revokeCoAdminInvite('admin-2')

    expect(result.error).toMatch(/cannot revoke/)
    expect(adminDb.__deleteUser).not.toHaveBeenCalled()
  })

  it('blocks cross-tenant revoke', async () => {
    mockAdminAuth()
    const adminDb = buildTargetAdminDb({
      targetProfile: {
        id: 'admin-other',
        email: 'other@example.com',
        name: 'Other',
        role: 'institution_admin',
        invite_status: 'pending',
        institution_id: 'inst-OTHER',
      },
    })
    mockAdminClient.mockReturnValue(adminDb)

    const result = await revokeCoAdminInvite('admin-other')

    expect(result.error).toMatch(/Admin not found/)
  })
})
