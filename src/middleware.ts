/**
 * Middleware — the SOLE handler for authentication redirects in the entire app.
 *
 * Runs on every request (except static assets) and enforces two rules:
 * 1. /dashboard/* is protected — unauthenticated users are redirected to /login
 * 2. /login and /signup are auth-only — authenticated users are redirected to /dashboard
 *
 * IMPORTANT: No page or layout component should ever redirect for auth.
 * All auth redirects happen here to prevent infinite redirect loops.
 *
 * Uses its own Supabase client (not the shared server.ts) because middleware
 * has a different cookie API (NextRequest/NextResponse vs Next.js cookies()).
 */

import { createServerClient } from '@supabase/ssr'
import { AUTH_COOKIE_OPTIONS } from '@/lib/supabase/cookie-options'
import { NextResponse, type NextRequest } from 'next/server'
import { logger } from '@/lib/logger'

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname

  // Default response — continue to the requested page (no redirect)
  let supabaseResponse = NextResponse.next({
    request,
  })

  /**
   * Create a Supabase client with cookie access for auth session management.
   *
   * Cookie handling works in two steps:
   * - getAll(): reads existing auth cookies from the incoming request
   * - setAll(): writes refreshed auth cookies to both the request (for downstream
   *   server components) and the response (sent back to the browser)
   */
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookieOptions: AUTH_COOKIE_OPTIONS,
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          // Forward updated cookies to the request (for server components downstream)
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          )
          // Recreate the response with updated request cookies
          supabaseResponse = NextResponse.next({
            request,
          })
          // Set cookies on the response (sent back to the browser)
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  /**
   * Verify the user's session by validating the JWT token server-side.
   * getUser() is more secure than getSession() because it contacts the Supabase
   * auth server rather than just decoding the local JWT.
   */
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()

  if (authError) {
    // getUser() reports AuthSessionMissingError for any logged-out visitor, and an
    // "Invalid Refresh Token" error once a session has expired or its cookies were
    // cleared. Both are the routine "no valid session" state that RULE 1 already
    // handles by redirecting to /login — not a failure. Logging them at error level
    // fires on every logged-out page view and lights up the Next dev error overlay,
    // so demote those to debug and reserve error for genuine auth failures.
    const isNoSession =
      authError.name === 'AuthSessionMissingError' ||
      /refresh token not found/i.test(authError.message)
    if (isNoSession) {
      logger.debug('Middleware.authCheck: no active session', { pathname })
    } else {
      logger.error('Middleware.authCheck', authError, { pathname })
    }
  }

  // RULE 0: /signup is disabled — Scholera is invite-only. Users only enter the
  // system via institution_admin / super_admin invites that ship a temp password.
  // This is a soft hide: the route still exists, but visitors are bounced to /login.
  if (pathname === '/signup' || pathname.startsWith('/signup/')) {
    logger.debug('Middleware: /signup is disabled, redirecting to /login', { pathname })
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }

  // RULE 1: Protected routes — send unauthenticated users to login
  // Covers /dashboard/* and /admin/* (admin pages live inside the (dashboard) route group
  // but resolve to /admin/* URLs since route groups are invisible in the URL).
  // /super-admin is the platform-vendor admin tier (Phase 1 super_admin feature).
  if (!user && (pathname.startsWith('/dashboard') || pathname.startsWith('/admin') || pathname.startsWith('/super-admin') || pathname.startsWith('/professor') || pathname.startsWith('/student') || pathname.startsWith('/staff') || pathname.startsWith('/dms') || pathname.startsWith('/projector'))) {
    logger.warn('Middleware: Unauthenticated access to protected route, redirecting to /login', { pathname })
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }

  // RULE 2: Auth pages — send authenticated users to dashboard (no need to see login/signup)
  // Note: /reset-password is excluded because users arrive with a recovery session (authenticated)
  // Allow /login through when invite tokens are present — the client-side processInvite()
  // useEffect needs to run to mark invite_status as accepted.
  // NOTE: Hash fragments (#access_token=...) are NOT visible to the server, so we also
  // check for ?invite=true (set in the invite redirectTo) and ?code= (PKCE flow).
  if (user && (pathname === '/login' || pathname === '/signup' || pathname === '/forgot-password')) {
    const hasInviteParam = request.nextUrl.searchParams.has('invite')
    const hasPkceCode = request.nextUrl.searchParams.has('code')

    if (hasInviteParam || hasPkceCode) {
      logger.debug('Middleware: Allowing auth page with invite tokens', { pathname, userId: user.id })
      return supabaseResponse
    }

    /* A Next.js server action POSTs to the URL of the page that INVOKED it — so an
     * action called from the login page posts to /login. signInWithPassword has
     * already set the auth cookies by then, so this rule matched the action's own
     * POST and 307'd it to /dashboard: the action body never ran, deterministically,
     * on every single password login.
     *
     * That is why profiles.last_login_at was NULL for all 46 accounts in production
     * and the re-engagement sweep has never had a candidate to send to (#731). It is
     * not specific to recordSignIn — it silently broke EVERY server action reachable
     * from /login and /forgot-password. (Not /signup: RULE 0 above runs first and is
     * deliberately not exempted, so actions there are still bounced. Harmless, since
     * signup is disabled.)
     *
     * Redirecting an action POST was never the intent of this rule, which exists so a
     * signed-in person doesn't sit on a login form. That is about navigation, and an
     * action POST is not a navigation. RULE 1 above is the actual auth boundary and is
     * untouched.
     *
     * This grants nothing, for a reason worth writing down: Next routes server actions
     * by the action ID in the `next-action` header, NOT by URL — so every action
     * reachable from these pages was already invocable by POSTing it to any
     * non-redirecting page. RULE 2 never gated actions; it gated one URL. Spoofing the
     * header buys an authenticated caller "render the login page".
     *
     * Scoped to POST because that is the only method an action uses; a GET carrying the
     * header has no business skipping the redirect. */
    if (request.method === 'POST' && request.headers.has('next-action')) {
      logger.debug('Middleware: Allowing server action POST from an auth page', { pathname, userId: user.id })
      return supabaseResponse
    }

    logger.debug('Middleware: Authenticated user on auth page, redirecting to /dashboard', { pathname, userId: user.id })
    const url = request.nextUrl.clone()
    url.pathname = '/dashboard'
    return NextResponse.redirect(url)
  }

  // No redirect needed — pass the request through to the page
  logger.debug('Middleware: Passthrough', { pathname, authenticated: !!user })

  return supabaseResponse
}

/**
 * Route matcher — tells Next.js which routes to run this middleware on.
 * Excludes static assets (_next/static, _next/image, favicon, images)
 * to avoid unnecessary auth checks on non-page requests.
 */
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
