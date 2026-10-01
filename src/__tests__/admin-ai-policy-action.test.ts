/**
 * updateInstitutionAiPolicy — the institution admin's kill-switch write action.
 *
 * The load-bearing assertions:
 *  - a non-admin is rejected before any DB or RPC touch,
 *  - unknown feature keys / bad versions refuse as invalid input,
 *  - the write goes through the RLS-BOUND USER client's rpc (supabase.rpc),
 *    NEVER the service-role client — that is the security invariant the
 *    action's header claims, and exactly what a later refactor might
 *    "simplify" away by reusing the admin client already in scope,
 *  - version_conflict maps to the refresh-the-page copy, not a generic error.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const verifyInstitutionAdminMock = vi.fn()
vi.mock('@/lib/auth/admin-context', () => ({
  verifyInstitutionAdmin: (...args: unknown[]) => verifyInstitutionAdminMock(...(args as [])),
}))

const userRpcMock = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ rpc: userRpcMock }),
}))

// Admin client: used ONLY for the before-snapshot read and never for the write.
const adminRpcMock = vi.fn()
const adminFromMock = vi.fn(() => ({
  select: () => ({
    eq: () => ({
      maybeSingle: async () => ({ data: { settings: {} }, error: null }),
    }),
  }),
}))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ from: adminFromMock, rpc: adminRpcMock }),
}))

vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn(async () => undefined) }))
vi.mock('@/lib/notifications/ai-policy', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  notifyAiPolicyChange: vi.fn(async () => undefined),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }))

import { updateInstitutionAiPolicy } from '@/app/(dashboard)/admin/settings/actions'

const ADMIN = { userId: 'admin-1', institutionId: 'inst-1' }
const VALID = { allDisabled: false, disabledFeatures: ['quiz-ai'], expectedVersion: 1 }

beforeEach(() => {
  verifyInstitutionAdminMock.mockReset().mockResolvedValue(ADMIN)
  userRpcMock.mockReset().mockResolvedValue({ data: 2, error: null })
  adminRpcMock.mockClear()
})

describe('updateInstitutionAiPolicy', () => {
  it('rejects a non-admin before touching the DB', async () => {
    verifyInstitutionAdminMock.mockResolvedValue({ error: 'Not authorized' })
    const result = await updateInstitutionAiPolicy(VALID)
    expect(result).toEqual({ error: 'Not authorized' })
    expect(userRpcMock).not.toHaveBeenCalled()
    expect(adminFromMock).not.toHaveBeenCalled()
  })

  it('rejects unknown feature keys and bad versions as invalid input', async () => {
    expect(
      await updateInstitutionAiPolicy({ allDisabled: false, disabledFeatures: ['drop-table'], expectedVersion: 1 }),
    ).toEqual({ error: 'Invalid settings.' })
    expect(
      await updateInstitutionAiPolicy({ allDisabled: false, disabledFeatures: [], expectedVersion: 0 }),
    ).toEqual({ error: 'Invalid settings.' })
    expect(userRpcMock).not.toHaveBeenCalled()
  })

  it('writes via the USER client rpc with the verified institution — never the admin client', async () => {
    const result = await updateInstitutionAiPolicy(VALID)
    expect(result).toEqual({ success: true, version: 2 })
    expect(userRpcMock).toHaveBeenCalledWith('set_institution_ai_policy', {
      p_institution_id: 'inst-1', // from the VERIFIED context, not the client
      p_layer: 'institution', // this action can never reach platform/global
      p_policy: { allDisabled: false, disabledFeatures: ['quiz-ai'] },
      p_expected_version: 1,
    })
    expect(adminRpcMock).not.toHaveBeenCalled()
  })

  it('maps version_conflict to the refresh-the-page copy', async () => {
    userRpcMock.mockResolvedValue({ data: null, error: { message: 'version_conflict' } })
    const result = await updateInstitutionAiPolicy(VALID)
    expect(result).toEqual({
      error: 'These settings were changed by someone else — refresh the page and try again.',
    })
  })

  it('refuses when the RPC returns a non-numeric version (no guessed client state)', async () => {
    userRpcMock.mockResolvedValue({ data: null, error: null })
    const result = await updateInstitutionAiPolicy(VALID)
    expect(result).toEqual({ error: 'Could not save AI settings. Please try again.' })
  })
})
