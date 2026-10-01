/**
 * Dashboard Server Actions — secure server-side operations called from client components.
 *
 * Server Actions run on the server even when invoked from client components.
 * They are the secure way to perform mutations (auth, database writes) without
 * exposing server-side logic to the browser.
 *
 * Exports:
 * - signOut(): Ends the user's session and redirects to /login
 */
'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'

/**
 * Sign out the current user and redirect to the login page.
 * Called by DashboardHeader's logout button.
 * The redirect() call at the end always runs, even if signOut fails,
 * to ensure the user is sent to /login regardless.
 */
export async function signOut() {
  try {
    const supabase = await createClient()
    const { error } = await supabase.auth.signOut()
    if (error) {
      logger.error('signOut', error)
    }
  } catch (error) {
    logger.error('signOut', error)
  }
  redirect('/login')
}
