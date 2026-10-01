/**
 * Admin Layout — role guard for all pages under /admin/*.
 *
 * Verifies the authenticated user has the institution_admin role before rendering
 * any admin page content. If not admin, renders a no-access DeadEnd.
 *
 * IMPORTANT: Does NOT redirect — only middleware redirects for auth.
 * This layout handles authorization (role check), not authentication.
 *
 * Security layers:
 * 1. Middleware blocks unauthenticated users (redirects to /login)
 * 2. This layout blocks non-admin users (renders Access Denied)
 * 3. Server actions independently verify admin role per mutation
 *
 * Type: Server Component (fetches profile for role check)
 * Tables: profiles (read)
 */

import { createClient } from '@/lib/supabase/server'
import { profileQueries } from '@/lib/supabase/queries'
import { logger } from '@/lib/logger'
import { DeadEnd } from '@/components/ui/dead-end'

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    logger.warn('AdminLayout: No user session')
    return null
  }

  const profile = await profileQueries.getProfileById(supabase, user.id)

  if (!profile || profile.role !== 'institution_admin') {
    logger.warn('AdminLayout: Access denied', { userId: user.id, role: profile?.role })
    // Role-AREA denial: naming the area is safe (its existence is public), so
    // this may say "no access" — unlike resource-ID dead ends, which must 404.
    return <DeadEnd variant="no-access" action={{ label: 'Back to dashboard', href: '/dashboard' }} />
  }

  return <>{children}</>
}
