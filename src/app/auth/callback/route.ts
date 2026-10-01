/**
 * Auth Callback Route — handles Supabase email invite and magic link redirects.
 *
 * When a user clicks an invite or magic link in their email, Supabase redirects
 * to this route with an auth code. This handler exchanges the code for a session
 * cookie, then redirects the user to the dashboard.
 *
 * If the user hasn't set a password yet (magic link / invite flow), the redirect
 * includes ?setup=password so the SetPasswordDialog appears on first login.
 *
 * Flow:
 * 1. Supabase sends email with link → /auth/callback?code=...
 * 2. This route exchanges the code for a session via supabase.auth.exchangeCodeForSession()
 * 3. Session is stored in cookies (handled by the Supabase SSR client)
 * 4. User is redirected to /dashboard (with ?setup=password if no password set)
 *
 * Type: Route Handler (GET)
 * Used by: Supabase inviteUserByEmail(), signInWithOtp(), resetPasswordForEmail() flows
 */

import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { NextResponse, type NextRequest } from 'next/server'
import { logger } from '@/lib/logger'
import { createAdminClient } from '@/lib/supabase/admin'
import { AUTH_COOKIE_OPTIONS } from '@/lib/supabase/cookie-options'

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl
  const code = searchParams.get('code')

  // `redirect_to` is attacker-controllable (it rides in on the emailed link) and
  // is concatenated onto `origin` below, so it must be a same-origin relative
  // path. Accept only "/path": reject "//host" and the "/\host" variant browsers
  // treat as protocol-relative, and reject anything not starting with "/" — a
  // bare ".evil.com" or "@evil.com" would otherwise glue onto the origin and
  // resolve to an attacker host. Same predicate as safeHref() in lib/dashboard/todos.
  const requestedRedirect = searchParams.get('redirect_to')
  const redirectTo =
    requestedRedirect
    && requestedRedirect.startsWith('/')
    && !requestedRedirect.startsWith('//')
    && !requestedRedirect.startsWith('/\\')
      ? requestedRedirect
      : '/dashboard'

  // Use the public site URL for redirects — request.nextUrl.origin returns
  // the internal container host (e.g. localhost:8080) on Railway/serverless.
  // SITE_URL is read at runtime; NEXT_PUBLIC_SITE_URL is inlined at build
  // time (empty in the prod image), kept only for local dev.
  const origin = process.env.SITE_URL
    || process.env.NEXT_PUBLIC_SITE_URL
    || request.headers.get('x-forwarded-host') && `https://${request.headers.get('x-forwarded-host')}`
    || request.nextUrl.origin

  if (code) {
    const cookieStore = await cookies()

    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookieOptions: AUTH_COOKIE_OPTIONS,
        cookies: {
          getAll() {
            return cookieStore.getAll()
          },
          setAll(cookiesToSet) {
            try {
              cookiesToSet.forEach(({ name, value, options }) =>
                cookieStore.set(name, value, options)
              )
            } catch {
              // Cookie setting may fail in certain contexts — session will
              // still be established on subsequent requests via middleware.
            }
          },
        },
      }
    )

    const { error } = await supabase.auth.exchangeCodeForSession(code)

    if (error) {
      logger.error('Auth callback: Failed to exchange code for session', { error })
      return NextResponse.redirect(`${origin}/login?error=auth_callback_failed`)
    }

    let finalRedirect = redirectTo

    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const adminDb = createAdminClient() as any

        // Stamp last sign-in — the dormancy signal for re-engagement nudges. Every
        // authenticated callback (OAuth / magic-link / invite) is a sign-in. Best-effort.
        await adminDb
          .from('profiles')
          .update({ last_login_at: new Date().toISOString() })
          .eq('id', user.id)

        // If invitee is accepting (professor, staff, etc.), mark as accepted
        const { data: profile } = await adminDb
          .from('profiles')
          .select('invite_status, role')
          .eq('id', user.id)
          .single()

        // An invite is being redeemed right now if the profile is still in
        // 'pending' state when the callback fires. Remember this before we
        // flip the flag so we can mark password setup as mandatory on the
        // redirect (first-time invite redemption = must set a password).
        const isRedeemingInvite = profile?.invite_status === 'pending'

        if (isRedeemingInvite) {
          await adminDb
            .from('profiles')
            .update({
              invite_status: 'accepted',
              invite_accepted_at: new Date().toISOString(),
            })
            .eq('id', user.id)
          logger.info('Auth callback: Invite accepted', { userId: user.id, role: profile.role })
        }

        // If user hasn't set a password yet, prompt them to set one.
        // Users who signed up with a password or already set one will have
        // password_set: true in their user_metadata.
        const passwordSet = user.user_metadata?.password_set === true
        const isPasswordReset = redirectTo.includes('reset-password')

        if (!passwordSet && !isPasswordReset) {
          // Append ?setup=password so SetPasswordDialog auto-opens on landing.
          // Dialog is dismissible — we nudge, we don't gate. The flag on
          // app_metadata stays so each subsequent login re-opens the dialog
          // until the user actually sets a password.
          const separator = finalRedirect.includes('?') ? '&' : '?'
          finalRedirect = `${finalRedirect}${separator}setup=password`
          if (isRedeemingInvite) {
            const { error: metaError } = await adminDb.auth.admin.updateUserById(user.id, {
              app_metadata: { ...user.app_metadata, requires_password_set: true },
            })
            if (metaError) {
              logger.error('Auth callback: Failed to set requires_password_set flag', metaError, { userId: user.id })
            }
          }
          logger.info('Auth callback: User needs password setup', { userId: user.id })
        }
      }
    } catch (err) {
      logger.warn('Auth callback: Failed to process post-login checks', { error: err })
    }

    logger.info('Auth callback: Session established, redirecting', { redirectTo: finalRedirect })
    return NextResponse.redirect(`${origin}${finalRedirect}`)
  }

  logger.warn('Auth callback: No code provided, redirecting to login')
  return NextResponse.redirect(`${origin}/login`)
}
