// signOut() and recordSignOut() in src/app/(dashboard)/dashboard/actions.ts.
// Both are reachable by anyone who can POST a server action, and both feed the
// audit log, so the order of calls, the allowlist and the no-session branch are
// the things that would rot silently.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetUser = vi.fn()
const mockSupabaseSignOut = vi.fn()
const mockGetClaims = vi.fn()
const mockLogEvent = vi.fn()
const mockCookieSet = vi.fn()
const mockRedirect = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser, getClaims: mockGetClaims, signOut: mockSupabaseSignOut } })),
}))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: (...a: unknown[]) => mockLogEvent(...a) }))
vi.mock('next/headers', () => ({ cookies: async () => ({ set: mockCookieSet }) }))
vi.mock('next/navigation', () => ({ redirect: (...a: unknown[]) => mockRedirect(...a) }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }))

let signOut: typeof import('@/app/(dashboard)/dashboard/actions').signOut
let recordSignOut: typeof import('@/app/(dashboard)/dashboard/actions').recordSignOut

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset().mockResolvedValue({ data: { user: { id: 'u1' } }, error: null })
  mockSupabaseSignOut.mockReset().mockResolvedValue({ error: null })
  mockGetClaims.mockReset().mockResolvedValue({ data: { claims: { session_id: 's1' } } })
  mockLogEvent.mockReset().mockResolvedValue(undefined)
  mockCookieSet.mockReset()
  mockRedirect.mockReset()
  ;({ signOut, recordSignOut } = await import('@/app/(dashboard)/dashboard/actions'))
})

describe('signOut', () => {
  it('reads the user before ending the session, so the audit row has an actor', async () => {
    await signOut()
    expect(mockGetUser.mock.invocationCallOrder[0]).toBeLessThan(mockSupabaseSignOut.mock.invocationCallOrder[0])
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', eventType: 'auth.signed_out', metadata: { reason: 'manual' } }))
    expect(mockCookieSet).toHaveBeenCalledWith('scholera_last_active', 'signed_out.s1', expect.objectContaining({ httpOnly: false, path: '/' }))
    expect(mockRedirect).toHaveBeenCalledWith('/login')
  })

  it('still marks other tabs and redirects when there was no session', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null })
    mockGetClaims.mockResolvedValue({ data: null })
    await signOut()
    expect(mockLogEvent).not.toHaveBeenCalled()
    expect(mockCookieSet).toHaveBeenCalledWith('scholera_last_active', 'signed_out.', expect.anything())
    expect(mockRedirect).toHaveBeenCalledWith('/login')
  })
})

describe('recordSignOut', () => {
  it('logs the reason for a signed-in user and touches no cookies', async () => {
    expect(await recordSignOut('idle')).toEqual({ success: true })
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', metadata: { reason: 'idle' } }))
    expect(mockCookieSet).not.toHaveBeenCalled()
  })

  it('rejects a reason outside the allowlist without logging', async () => {
    expect(await recordSignOut('manual' as never)).toEqual({ error: 'Invalid sign-out reason' })
    expect(await recordSignOut({ x: 1 } as never)).toEqual({ error: 'Invalid sign-out reason' })
    expect(mockLogEvent).not.toHaveBeenCalled()
  })

  it('rejects a caller with no session without logging', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no session' } })
    expect(await recordSignOut('idle')).toEqual({ error: 'Not signed in' })
    expect(mockLogEvent).not.toHaveBeenCalled()
  })
})
