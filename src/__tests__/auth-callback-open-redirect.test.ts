// Pins the `redirect_to` guard in src/app/auth/callback/route.ts.
//
// Incident: `redirect_to` arrives on the emailed magic-link/invite URL, so it is fully
// attacker-controllable, and the route concatenates it onto `origin` — `${origin}${redirectTo}`.
// Unguarded, that is an open redirect on the ONE route that has just established a
// session: a victim who clicks a crafted reset link lands on an attacker page carrying
// the auth fragment / referrer. Costly and completely silent — the redirect works, the
// user just ends up somewhere else.
//
// This exercises the REAL route handler rather than a re-implemented copy of the
// predicate. A test that reimplements the check would pass forever regardless of what
// the route does, which is exactly the failure mode worth avoiding here.
//
// The `${origin}${redirectTo}` concatenation is why the non-obvious payloads matter:
//   ".evil.com"  → "https://app.scholera.com.evil.com"  (a different registrable domain)
//   "@evil.com"  → "https://app.scholera.com@evil.com"  (userinfo — browsers go to evil.com)
//   "//evil.com" → protocol-relative, resolves to https://evil.com
//   "/\evil.com" → browsers normalise the backslash and treat it as "//"

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import type { NextRequest } from 'next/server'

const mockExchangeCodeForSession = vi.fn()
const mockGetUser = vi.fn()
const mockAdminClient = vi.fn()

vi.mock('next/headers', () => ({
  cookies: async () => ({ getAll: () => [], set: () => {} }),
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: {
      exchangeCodeForSession: mockExchangeCodeForSession,
      getUser: mockGetUser,
    },
  }),
}))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: (...args: unknown[]) => mockAdminClient(...args),
}))

const ORIGIN = 'https://app.scholera.test'
const originalSiteUrl = process.env.SITE_URL

/** Admin double: the post-login profile bookkeeping must not interfere with the redirect. */
function passiveAdmin() {
  const chain = {
    update: () => ({ eq: async () => ({ error: null }) }),
    select: () => ({ eq: () => ({ single: async () => ({ data: { invite_status: 'accepted', role: 'student' }, error: null }) }) }),
  }
  return {
    from: () => chain,
    auth: { admin: { updateUserById: async () => ({ error: null }) } },
  }
}

function req(redirectTo: string | null, code: string | null = 'valid-code'): NextRequest {
  const url = new URL(`${ORIGIN}/auth/callback`)
  if (code !== null) url.searchParams.set('code', code)
  if (redirectTo !== null) url.searchParams.set('redirect_to', redirectTo)
  return {
    nextUrl: url,
    headers: new Headers(),
  } as unknown as NextRequest
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let GET: any

beforeEach(async () => {
  vi.resetModules()
  process.env.SITE_URL = ORIGIN
  mockExchangeCodeForSession.mockReset().mockResolvedValue({ error: null })
  // `password_set: true` keeps the handler off the ?setup=password branch so these
  // assertions are about the redirect target alone.
  mockGetUser.mockReset().mockResolvedValue({
    data: { user: { id: 'u1', user_metadata: { password_set: true }, app_metadata: {} } },
  })
  mockAdminClient.mockReset().mockReturnValue(passiveAdmin())
  GET = (await import('@/app/auth/callback/route')).GET
})

afterAll(() => {
  if (originalSiteUrl === undefined) delete process.env.SITE_URL
  else process.env.SITE_URL = originalSiteUrl
})

const location = async (redirectTo: string | null) =>
  (await GET(req(redirectTo))).headers.get('location')

describe('auth callback — rejects off-origin redirect_to', () => {
  // Each of these must land on the safe default, not on the attacker's host.
  const HOSTILE = [
    ['bare domain suffix', '.evil.com'],
    ['userinfo separator', '@evil.com'],
    ['protocol-relative', '//evil.com'],
    ['protocol-relative with path', '//evil.com/steal'],
    ['backslash protocol-relative', '/\\evil.com'],
    ['absolute https URL', 'https://evil.com'],
    ['absolute http URL', 'http://evil.com/phish'],
    ['scheme-less host', 'evil.com'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['data scheme', 'data:text/html,<script>alert(1)</script>'],
    ['empty string', ''],
  ] as const

  for (const [label, payload] of HOSTILE) {
    it(`falls back to /dashboard for ${label}: ${JSON.stringify(payload)}`, async () => {
      const dest = await location(payload)
      expect(dest).toBe(`${ORIGIN}/dashboard`)
      // Belt-and-braces: whatever the string is, the browser must resolve it to us.
      expect(new URL(dest!).host).toBe(new URL(ORIGIN).host)
      expect(dest).not.toContain('evil.com')
    })
  }

  it('sends an absent redirect_to to /dashboard', async () => {
    expect(await location(null)).toBe(`${ORIGIN}/dashboard`)
  })
})

describe('auth callback — accepts same-origin relative paths', () => {
  // The guard must not be so tight that it breaks the flows that depend on it —
  // /reset-password in particular is how every password reset lands.
  const ALLOWED = [
    '/dashboard',
    '/reset-password',
    '/professor/courses/abc/quizzes',
    '/dashboard?tab=grades',
    '/student/courses/123#section',
  ]

  for (const path of ALLOWED) {
    it(`preserves ${path}`, async () => {
      expect(await location(path)).toBe(`${ORIGIN}${path}`)
    })
  }

  it('still resolves to our own host for a path that merely mentions another domain', async () => {
    const dest = await location('/redirect/notes-about-evil.com')
    expect(new URL(dest!).host).toBe(new URL(ORIGIN).host)
  })
})

describe('auth callback — the guard also covers the surrounding flow', () => {
  it('redirects to /login on a failed code exchange, never to the requested target', async () => {
    mockExchangeCodeForSession.mockResolvedValue({ error: { message: 'expired' } })
    const dest = await location('//evil.com')
    expect(dest).toBe(`${ORIGIN}/login?error=auth_callback_failed`)
  })

  it('redirects to /login when no code is present', async () => {
    const res = await GET(req('//evil.com', null))
    expect(res.headers.get('location')).toBe(`${ORIGIN}/login`)
  })

  it('appends ?setup=password to the SAFE target, not to a hostile one', async () => {
    // The password-setup branch string-concatenates onto finalRedirect. If a hostile
    // redirect_to ever survived the guard, this is where it would be handed the session.
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'u1', user_metadata: {}, app_metadata: {} } },
    })
    expect(await location('//evil.com')).toBe(`${ORIGIN}/dashboard?setup=password`)
    expect(await location('/dashboard')).toBe(`${ORIGIN}/dashboard?setup=password`)
  })

  it('does not force password setup on the reset-password path', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'u1', user_metadata: {}, app_metadata: {} } },
    })
    expect(await location('/reset-password')).toBe(`${ORIGIN}/reset-password`)
  })
})
