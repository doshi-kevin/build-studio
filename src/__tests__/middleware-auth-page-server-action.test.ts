/**
 * RULE 2 must not redirect a server action's own POST (#731).
 *
 * A Next.js server action POSTs to the URL of the page that invoked it, so an
 * action called from the login form posts to /login. By the time it arrives,
 * signInWithPassword has already set the auth cookies — so RULE 2 ("an
 * authenticated visitor has no business on a login form") matched the action's
 * own POST and 307'd it to /dashboard. The action body never ran. Not
 * intermittently: on every single password login, deterministically.
 *
 * The visible symptom was profiles.last_login_at being NULL for all 46
 * production accounts, which is why the re-engagement sweep had never had a
 * candidate to send to. But recordSignIn was only the action that happened to
 * exist — the rule silently swallowed EVERY server action reachable from an auth
 * page, and would swallow the next one too.
 *
 * This is the cheapest possible regression to reintroduce: deleting four lines
 * from middleware.ts breaks a feature whose failure is invisible from the UI (the
 * login succeeds, the redirect looks right, only a column stays empty). Nothing
 * else in the suite touches middleware, so this file is the only thing standing
 * between that and production.
 *
 * The exemption is scoped two ways, and both are asserted, because "let the POST
 * through" is one edit away from "let anything with a header through":
 *   - it lives INSIDE `if (user && ...)`, so it can never satisfy RULE 1
 *   - it does not weaken the navigation redirect it sits next to
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockGetUser = vi.fn()

vi.mock('@supabase/ssr', () => ({
  /* The real client is irrelevant here — the unit under test is the rule chain
     that runs AFTER getUser() resolves. Cookie plumbing is Supabase's. */
  createServerClient: () => ({ auth: { getUser: mockGetUser } }),
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let middleware: any

const signedIn = () =>
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })

const signedOut = () =>
  mockGetUser.mockResolvedValue({
    data: { user: null },
    /* The shape a logged-out visitor actually produces, so the authError branch
       above RULE 0 is exercised rather than stepped over. */
    error: { name: 'AuthSessionMissingError', message: 'Auth session missing!' },
  })

/** A server action POST looks exactly like this: same URL as the page, plus the header. */
const actionPost = (path: string) =>
  new NextRequest(`http://localhost:3000${path}`, {
    method: 'POST',
    headers: { 'next-action': '7f9c1a2b3c4d5e6f' },
  })

const navigation = (path: string) => new NextRequest(`http://localhost:3000${path}`)

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  middleware = (await import('@/middleware')).middleware
})

describe('middleware RULE 2 — server action POSTs from auth pages (#731)', () => {
  it.each(['/login', '/forgot-password'])(
    'passes a signed-in server action POST from %s through to the action',
    async (path) => {
      signedIn()
      const res = await middleware(actionPost(path))

      /* A redirect is the bug. Asserting on Location rather than only on status
         because that is what the action's POST followed to /dashboard instead of
         reaching its own handler. */
      expect(res.headers.get('location')).toBeNull()
      expect(res.status).toBe(200)
    },
  )

  it('still redirects a signed-in NAVIGATION to /login — the exemption is not a hole in RULE 2', async () => {
    signedIn()
    const res = await middleware(navigation('/login'))

    expect(res.status).toBe(307)
    expect(new URL(res.headers.get('location')!).pathname).toBe('/dashboard')
  })

  it('does not let the header satisfy RULE 1 — a signed-OUT action POST to a protected route is still bounced', async () => {
    /* The exemption sits inside `if (user && ...)`, so it is unreachable without a
       session. If it were ever hoisted above RULE 1, `next-action` would become a
       one-header auth bypass for every /professor, /student and /admin route. */
    signedOut()
    const res = await middleware(actionPost('/professor/courses/abc/assignments'))

    expect(res.status).toBe(307)
    expect(new URL(res.headers.get('location')!).pathname).toBe('/login')
  })

  it('leaves RULE 0 in front of the exemption — /signup stays disabled even for an action POST', async () => {
    /* Documenting the real order, not the comment's. RULE 0 is unconditional and
       runs first, so a server action on /signup is still redirected — correct while
       signup is invite-only, and a deliberate difference from /login worth pinning
       so re-enabling signup doesn't silently inherit the #731 bug. */
    signedIn()
    const res = await middleware(actionPost('/signup'))

    expect(res.status).toBe(307)
    expect(new URL(res.headers.get('location')!).pathname).toBe('/login')
  })
})
