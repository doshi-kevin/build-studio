// Tests for super_admin team management: cap, owner-protection on revoke,
// transfer-ownership flow including failure rollback.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetUser = vi.fn()
const mockGetProfileById = vi.fn()
const mockAdminClient = vi.fn()
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
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
vi.mock('@/lib/email', () => ({
  sendSuperAdminWelcome: (...args: unknown[]) => mockSendWelcome(...args),
}))
vi.mock('@/lib/validations/student', () => ({
  generateSecurePassword: vi.fn(() => 'TempPass1!'),
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let inviteSuperAdmin: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let resendSuperAdminInvite: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let revokeSuperAdmin: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let transferPlatformOwnership: any

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockGetProfileById.mockReset()
  mockAdminClient.mockReset()
  mockSendWelcome.mockClear()
  mockSendWelcome.mockResolvedValue({ success: true })

  const mod = await import('@/app/(dashboard)/super-admin/team/actions')
  inviteSuperAdmin = mod.inviteSuperAdmin
  resendSuperAdminInvite = mod.resendSuperAdminInvite
  revokeSuperAdmin = mod.revokeSuperAdmin
  transferPlatformOwnership = mod.transferPlatformOwnership
})

function mockSuperAdminAuth(opts: { userId?: string; isPlatformOwner?: boolean } = {}) {
  const userId = opts.userId ?? 'super-1'
  mockGetUser.mockResolvedValue({
    data: { user: { id: userId } },
    error: null,
  })
  mockGetProfileById.mockResolvedValue({
    id: userId,
    role: 'super_admin',
    is_platform_owner: opts.isPlatformOwner ?? false,
  })
}

/* Mock admin DB for INVITE: count → email lookup → upsert */
function buildInviteAdminDb(opts: {
  count?: number
  emailHit?: { id: string; email: string; role: string } | null
  createUserResult?: { data?: { user?: { id: string } }; error?: { message?: string } | null }
}) {
  const deleteUser = vi.fn().mockResolvedValue({ error: null })
  const updateUserById = vi.fn().mockResolvedValue({ error: null })
  const createUser = vi.fn().mockResolvedValue(
    opts.createUserResult ?? { data: { user: { id: 'new-super-1' } }, error: null },
  )
  const upsert = vi.fn().mockResolvedValue({ error: null })

  let callIndex = 0
  const adminDb = {
    from: vi.fn().mockImplementation((table: string) => {
      if (table !== 'profiles') throw new Error(`Unexpected table ${table}`)
      callIndex += 1
      if (callIndex === 1) {
        /* Count: .select(..., {count:exact, head:true}).eq() awaits */
        const countResult = { count: opts.count ?? 0, error: null }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockResolvedValue(countResult),
        }
      }
      if (callIndex === 2) {
        /* Email lookup */
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: opts.emailHit ?? null, error: null }),
        }
      }
      /* upsert */
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

/* Mock admin DB for RESEND/REVOKE: target lookup → update or delete */
function buildTargetAdminDb(opts: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  target?: any
  deleteUserResult?: { error?: { message?: string } | null }
  updateUserResult?: { error?: { message?: string } | null }
}) {
  const deleteUser = vi.fn().mockResolvedValue(opts.deleteUserResult ?? { error: null })
  const updateUserById = vi.fn().mockResolvedValue(opts.updateUserResult ?? { error: null })
  const createUser = vi.fn()

  let callIndex = 0
  const adminDb = {
    from: vi.fn().mockImplementation((table: string) => {
      if (table !== 'profiles') throw new Error(`Unexpected table ${table}`)
      callIndex += 1
      if (callIndex === 1) {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: opts.target ?? null, error: null }),
        }
      }
      return {
        update: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: null }) })),
        delete: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: null }) })),
      }
    }),
    auth: { admin: { createUser, deleteUser, updateUserById } },
    __deleteUser: deleteUser,
    __updateUserById: updateUserById,
  }
  return adminDb
}

/* Mock admin DB for TRANSFER OWNERSHIP: target lookup → demote → promote */
function buildTransferAdminDb(opts: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  target?: any
  demoteFails?: boolean
  promoteFails?: boolean
  rollbackFails?: boolean
}) {
  let updateCallIndex = 0
  const updateCalls: Array<{ id: string; payload: { is_platform_owner: boolean } }> = []
  const adminDb = {
    from: vi.fn().mockImplementation((table: string) => {
      if (table !== 'profiles') throw new Error(`Unexpected table ${table}`)
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: opts.target ?? null, error: null }),
        update: vi.fn((payload: { is_platform_owner: boolean }) => ({
          eq: vi.fn().mockImplementation((_col: string, id: string) => {
            updateCallIndex += 1
            updateCalls.push({ id, payload })
            if (updateCallIndex === 1 && opts.demoteFails) {
              return Promise.resolve({ error: { message: 'demote failed' } })
            }
            if (updateCallIndex === 2 && opts.promoteFails) {
              return Promise.resolve({ error: { message: 'promote failed' } })
            }
            if (updateCallIndex === 3 && opts.rollbackFails) {
              return Promise.resolve({ error: { message: 'rollback failed' } })
            }
            return Promise.resolve({ error: null })
          }),
        })),
      }
    }),
    auth: { admin: {} },
    __updateCalls: updateCalls,
  }
  return adminDb
}

describe('inviteSuperAdmin — auth + cap', () => {
  it('rejects unauthenticated callers', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no user' } })
    const result = await inviteSuperAdmin({ name: 'X', email: 'x@example.com' })
    expect(result.error).toMatch(/not signed in/i)
  })

  it('rejects when caller is not super_admin', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'u' } }, error: null })
    mockGetProfileById.mockResolvedValue({ id: 'u', role: 'institution_admin', is_platform_owner: false })

    const result = await inviteSuperAdmin({ name: 'X', email: 'x@example.com' })
    expect(result.error).toMatch(/super_admin access required/i)
  })

  it('blocks invite at 5-cap', async () => {
    mockSuperAdminAuth({ isPlatformOwner: true })
    const db = buildInviteAdminDb({ count: 5 })
    mockAdminClient.mockReturnValue(db)

    const result = await inviteSuperAdmin({ name: 'X', email: 'x@example.com' })
    expect(result.error).toMatch(/maximum of 5/)
    expect(db.__createUser).not.toHaveBeenCalled()
  })

  it('blocks duplicate email', async () => {
    mockSuperAdminAuth()
    const db = buildInviteAdminDb({
      count: 1,
      emailHit: { id: 'existing', email: 'x@example.com', role: 'professor' },
    })
    mockAdminClient.mockReturnValue(db)

    const result = await inviteSuperAdmin({ name: 'X', email: 'x@example.com' })
    expect(result.error).toMatch(/already exists/)
  })

  it('happy path: creates user, upserts profile, sends welcome', async () => {
    mockSuperAdminAuth()
    const db = buildInviteAdminDb({ count: 1 })
    mockAdminClient.mockReturnValue(db)

    const result = await inviteSuperAdmin({ name: 'Jane', email: 'jane@scholera-inc.com' })
    expect(result.success).toBe(true)
    expect(db.__createUser).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'jane@scholera-inc.com',
        password: 'TempPass1!',
        user_metadata: expect.objectContaining({ role: 'super_admin' }),
      }),
    )
    expect(mockSendWelcome).toHaveBeenCalledWith(
      'jane@scholera-inc.com',
      'Jane',
      expect.objectContaining({ tempPassword: 'TempPass1!', isPlatformOwner: false }),
    )
  })
})

describe('revokeSuperAdmin — owner protection', () => {
  it('refuses to revoke the platform owner', async () => {
    mockSuperAdminAuth({ userId: 'super-1', isPlatformOwner: true })
    const db = buildTargetAdminDb({
      target: {
        id: 'super-2',
        email: 'owner@scholera-inc.com',
        role: 'super_admin',
        is_platform_owner: true,
        invite_status: 'accepted',
      },
    })
    mockAdminClient.mockReturnValue(db)

    const result = await revokeSuperAdmin('super-2')
    expect(result.error).toMatch(/Cannot revoke the platform owner/)
    expect(db.__deleteUser).not.toHaveBeenCalled()
  })

  it('refuses self-revoke', async () => {
    mockSuperAdminAuth({ userId: 'super-1', isPlatformOwner: false })
    /* Even if we somehow matched, action exits before DB lookup. */
    const db = buildTargetAdminDb({ target: null })
    mockAdminClient.mockReturnValue(db)

    const result = await revokeSuperAdmin('super-1')
    expect(result.error).toMatch(/cannot revoke your own/i)
  })

  it('happy path: deletes auth user + profile for non-owner', async () => {
    mockSuperAdminAuth({ userId: 'super-1', isPlatformOwner: false })
    const db = buildTargetAdminDb({
      target: {
        id: 'super-2',
        email: 'pending@scholera-inc.com',
        role: 'super_admin',
        is_platform_owner: false,
        invite_status: 'pending',
      },
    })
    mockAdminClient.mockReturnValue(db)

    const result = await revokeSuperAdmin('super-2')
    expect(result.success).toBe(true)
    expect(db.__deleteUser).toHaveBeenCalledWith('super-2')
  })
})

describe('transferPlatformOwnership', () => {
  it('only the current owner can transfer', async () => {
    mockSuperAdminAuth({ userId: 'super-1', isPlatformOwner: false })
    const db = buildTransferAdminDb({})
    mockAdminClient.mockReturnValue(db)

    const result = await transferPlatformOwnership('super-2')
    expect(result.error).toMatch(/Only the platform owner/)
    expect(db.__updateCalls).toHaveLength(0)
  })

  it('refuses transfer to self', async () => {
    mockSuperAdminAuth({ userId: 'super-1', isPlatformOwner: true })
    const db = buildTransferAdminDb({})
    mockAdminClient.mockReturnValue(db)

    const result = await transferPlatformOwnership('super-1')
    expect(result.error).toMatch(/already the platform owner/)
  })

  it('refuses transfer to non-super_admin target', async () => {
    mockSuperAdminAuth({ userId: 'super-1', isPlatformOwner: true })
    const db = buildTransferAdminDb({
      target: { id: 'x', email: 'x@y', role: 'professor', invite_status: 'accepted', is_platform_owner: false },
    })
    mockAdminClient.mockReturnValue(db)

    const result = await transferPlatformOwnership('x')
    expect(result.error).toMatch(/must be a super_admin/)
  })

  it('refuses transfer to a still-pending super_admin', async () => {
    mockSuperAdminAuth({ userId: 'super-1', isPlatformOwner: true })
    const db = buildTransferAdminDb({
      target: { id: 'super-2', email: 'p@y', role: 'super_admin', invite_status: 'pending', is_platform_owner: false },
    })
    mockAdminClient.mockReturnValue(db)

    const result = await transferPlatformOwnership('super-2')
    expect(result.error).toMatch(/must have accepted/)
  })

  it('happy path: demotes self, promotes target', async () => {
    mockSuperAdminAuth({ userId: 'super-1', isPlatformOwner: true })
    const db = buildTransferAdminDb({
      target: { id: 'super-2', email: 'new@y', role: 'super_admin', invite_status: 'accepted', is_platform_owner: false },
    })
    mockAdminClient.mockReturnValue(db)

    const result = await transferPlatformOwnership('super-2')
    expect(result.success).toBe(true)
    expect(db.__updateCalls).toEqual([
      { id: 'super-1', payload: { is_platform_owner: false } },
      { id: 'super-2', payload: { is_platform_owner: true } },
    ])
  })

  it('rolls back if promote fails after demote succeeds', async () => {
    mockSuperAdminAuth({ userId: 'super-1', isPlatformOwner: true })
    const db = buildTransferAdminDb({
      target: { id: 'super-2', email: 'new@y', role: 'super_admin', invite_status: 'accepted', is_platform_owner: false },
      promoteFails: true,
    })
    mockAdminClient.mockReturnValue(db)

    const result = await transferPlatformOwnership('super-2')
    expect(result.error).toMatch(/rolled back/)
    /* Three writes: demote self, fail to promote, restore self. */
    expect(db.__updateCalls).toEqual([
      { id: 'super-1', payload: { is_platform_owner: false } },
      { id: 'super-2', payload: { is_platform_owner: true } },
      { id: 'super-1', payload: { is_platform_owner: true } },
    ])
  })

  it('reports loud error if rollback also fails', async () => {
    mockSuperAdminAuth({ userId: 'super-1', isPlatformOwner: true })
    const db = buildTransferAdminDb({
      target: { id: 'super-2', email: 'new@y', role: 'super_admin', invite_status: 'accepted', is_platform_owner: false },
      promoteFails: true,
      rollbackFails: true,
    })
    mockAdminClient.mockReturnValue(db)

    const result = await transferPlatformOwnership('super-2')
    expect(result.error).toMatch(/rollback failed.*support/i)
  })
})

describe('resendSuperAdminInvite', () => {
  it('refuses resend on accepted invites', async () => {
    mockSuperAdminAuth()
    const db = buildTargetAdminDb({
      target: {
        id: 'super-2',
        email: 'a@y',
        name: 'A',
        role: 'super_admin',
        invite_status: 'accepted',
        is_platform_owner: false,
      },
    })
    mockAdminClient.mockReturnValue(db)

    const result = await resendSuperAdminInvite('super-2')
    expect(result.error).toMatch(/already been accepted/)
    expect(db.__updateUserById).not.toHaveBeenCalled()
  })

  it('happy path: rotates password and resends welcome', async () => {
    mockSuperAdminAuth()
    const db = buildTargetAdminDb({
      target: {
        id: 'super-2',
        email: 'a@y',
        name: 'A',
        role: 'super_admin',
        invite_status: 'pending',
        is_platform_owner: false,
      },
    })
    mockAdminClient.mockReturnValue(db)

    const result = await resendSuperAdminInvite('super-2')
    expect(result.success).toBe(true)
    expect(db.__updateUserById).toHaveBeenCalledWith(
      'super-2',
      expect.objectContaining({ password: 'TempPass1!' }),
    )
    expect(mockSendWelcome).toHaveBeenCalledWith(
      'a@y',
      'A',
      expect.objectContaining({ tempPassword: 'TempPass1!', isPlatformOwner: false }),
    )
  })
})
