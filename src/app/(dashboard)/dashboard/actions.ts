/**
 * Dashboard Server Actions — secure server-side operations called from client components.
 *
 * Server Actions run on the server even when invoked from client components.
 * They are the secure way to perform mutations (auth, database writes) without
 * exposing server-side logic to the browser.
 *
 * Exports:
 * - signOut(): Ends the user's session and redirects to /login
 * - recordSignOut(): Audit-logs a sign-out the browser is about to do on the
 *   user's behalf (idle timeout, newer sign-in elsewhere)
 */
'use server'

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { logEvent } from '@/lib/supabase/event-logger'
import { logger } from '@/lib/logger'
import {
  LAST_ACTIVE_COOKIE,
  SIGN_OUT_REASONS,
  signedOutCookieValue,
  type SignOutReason,
} from '@/lib/auth/idle-timeout'

/* Replaces the activity stamp so the session's other open tabs follow to /login
 * on their next tick. IdleTimeout writes the same value from the browser for its
 * own sign-outs; see signedOutCookieValue() for why it names the session. */
async function markSignedOut(sessionId: string) {
  const cookieStore = await cookies()
  cookieStore.set(LAST_ACTIVE_COOKIE, signedOutCookieValue('signed_out', sessionId), {
    path: '/',
    maxAge: 86400,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    httpOnly: false,
  })
}

/**
 * Sign out the current user and redirect to the login page.
 * Called by DashboardHeader's logout button.
 * The redirect() call at the end always runs, even if signOut fails,
 * to ensure the user is sent to /login regardless.
 */
export async function signOut() {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    const { data: claims } = await supabase.auth.getClaims()
    const { error } = await supabase.auth.signOut()
    if (error) {
      logger.error('signOut', error)
    }
    if (user) {
      await logEvent({
        userId: user.id,
        eventType: 'auth.signed_out',
        eventCategory: 'auth',
        metadata: { reason: 'manual' },
      })
    }
    await markSignedOut(claims?.claims.session_id ?? '')
  } catch (error) {
    logger.error('signOut', error)
  }
  redirect('/login')
}

/**
 * Audit-log a sign-out that IdleTimeout is about to perform (idle timeout, or the
 * account signed in on another device). Called while the session still exists,
 * so the event has an actor.
 *
 * Deliberately touches no cookies. Any cookie write in a server action makes Next
 * re-render the current page on the server, and that render would run after the
 * session is gone and log auth errors from the layout. So the browser ends its
 * own session afterwards (scope 'local', leaving other devices alone; for
 * 'signed_in_elsewhere' the other device is the one the user moved to).
 */
export async function recordSignOut(
  reason: SignOutReason
): Promise<{ success: true } | { error: string }> {
  if (!SIGN_OUT_REASONS.includes(reason)) {
    return { error: 'Invalid sign-out reason' }
  }
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in' }
  await logEvent({
    userId: user.id,
    eventType: 'auth.signed_out',
    eventCategory: 'auth',
    metadata: { reason },
  })
  return { success: true }
}
