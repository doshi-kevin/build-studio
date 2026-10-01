// Tests for verifyInstitutionAdmin — the shared gate behind every
// institution_admin server action. Covers the new Phase 2 hardening branches:
// JWT-first suspension check, DB fallback when JWT lacks status, and the
// existing role / institution_id validation paths.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetUser = vi.fn()
const mockGetProfileById = vi.fn()
const mockAdminClient = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: (...args: unknown[]) => mockAdminClient(...args),
}))
vi.mock('@/lib/supabase/queries', () => ({
  profileQueries: {
    getProfileById: (...args: unknown[]) => mockGetProfileById(...args),
  },
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let verifyInstitutionAdmin: any

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockGetProfileById.mockReset()
  mockAdminClient.mockReset()

  const mod = await import('@/lib/auth/admin-context')
  verifyInstitutionAdmin = mod.verifyInstitutionAdmin
})

/* Helper: build a mock supabase admin client whose .from('institutions')
 * chain returns the given status (or error). */
function mockInstitutionsLookup(result: { data: { status: string } | null; error: unknown }) {
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue(result),
  }
  mockAdminClient.mockReturnValue({
    from: vi.fn().mockReturnValue(chain),
  })
  return chain
}

function user(overrides: Record<string, unknown> = {}) {
  return { id: 'admin-1', app_metadata: {}, ...overrides }
}

describe('verifyInstitutionAdmin — auth gates', () => {
  it('rejects unauthenticated callers', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no user' } })

    const result = await verifyInstitutionAdmin('test')

    expect(result).toEqual({ error: 'Not authenticated' })
    expect(mockAdminClient).not.toHaveBeenCalled()
  })

  it('rejects non-admin roles', async () => {
    mockGetUser.mockResolvedValue({ data: { user: user() }, error: null })
    mockGetProfileById.mockResolvedValue({ id: 'admin-1', role: 'student', institution_id: 'inst-1' })

    const result = await verifyInstitutionAdmin('test')

    expect(result).toEqual({ error: 'Unauthorized — admin access required' })
    expect(mockAdminClient).not.toHaveBeenCalled()
  })

  it('rejects when profile is missing', async () => {
    mockGetUser.mockResolvedValue({ data: { user: user() }, error: null })
    mockGetProfileById.mockResolvedValue(null)

    const result = await verifyInstitutionAdmin('test')

    expect(result).toEqual({ error: 'Unauthorized — admin access required' })
  })

  it('rejects admin without institution_id', async () => {
    mockGetUser.mockResolvedValue({ data: { user: user() }, error: null })
    mockGetProfileById.mockResolvedValue({ id: 'admin-1', role: 'institution_admin', institution_id: null })

    const result = await verifyInstitutionAdmin('test')

    expect(result.error).toMatch(/not linked to an institution/)
  })
})

describe('verifyInstitutionAdmin — JWT-first suspension check', () => {
  it('returns success on active JWT status without hitting DB', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: user({ app_metadata: { institution_status: 'active' } }) },
      error: null,
    })
    mockGetProfileById.mockResolvedValue({ id: 'admin-1', role: 'institution_admin', institution_id: 'inst-1' })

    const result = await verifyInstitutionAdmin('test')

    expect(result).toEqual({ userId: 'admin-1', institutionId: 'inst-1' })
    expect(mockAdminClient).not.toHaveBeenCalled()
  })

  it('blocks when JWT status is suspended (no DB call)', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: user({ app_metadata: { institution_status: 'suspended' } }) },
      error: null,
    })
    mockGetProfileById.mockResolvedValue({ id: 'admin-1', role: 'institution_admin', institution_id: 'inst-1' })

    const result = await verifyInstitutionAdmin('test')

    expect(result.error).toMatch(/suspended/)
    expect(mockAdminClient).not.toHaveBeenCalled()
  })
})

describe('verifyInstitutionAdmin — DB fallback (no JWT status)', () => {
  it('returns success when DB shows active', async () => {
    mockGetUser.mockResolvedValue({ data: { user: user() }, error: null })
    mockGetProfileById.mockResolvedValue({ id: 'admin-1', role: 'institution_admin', institution_id: 'inst-1' })
    mockInstitutionsLookup({ data: { status: 'active' }, error: null })

    const result = await verifyInstitutionAdmin('test')

    expect(result).toEqual({ userId: 'admin-1', institutionId: 'inst-1' })
    expect(mockAdminClient).toHaveBeenCalledTimes(1)
  })

  it('blocks when DB shows suspended', async () => {
    mockGetUser.mockResolvedValue({ data: { user: user() }, error: null })
    mockGetProfileById.mockResolvedValue({ id: 'admin-1', role: 'institution_admin', institution_id: 'inst-1' })
    mockInstitutionsLookup({ data: { status: 'suspended' }, error: null })

    const result = await verifyInstitutionAdmin('test')

    expect(result.error).toMatch(/suspended/)
  })

  it('returns missing-institution error when DB has no row', async () => {
    mockGetUser.mockResolvedValue({ data: { user: user() }, error: null })
    mockGetProfileById.mockResolvedValue({ id: 'admin-1', role: 'institution_admin', institution_id: 'inst-1' })
    mockInstitutionsLookup({ data: null, error: null })

    const result = await verifyInstitutionAdmin('test')

    expect(result.error).toMatch(/institution record is missing/)
  })

  it('returns generic error when DB query fails', async () => {
    mockGetUser.mockResolvedValue({ data: { user: user() }, error: null })
    mockGetProfileById.mockResolvedValue({ id: 'admin-1', role: 'institution_admin', institution_id: 'inst-1' })
    mockInstitutionsLookup({ data: null, error: { message: 'connection lost' } })

    const result = await verifyInstitutionAdmin('test')

    expect(result.error).toMatch(/Could not verify institution status/)
  })
})
