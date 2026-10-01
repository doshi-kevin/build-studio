/**
 * Super Admin Layout — role guard for all pages under /super-admin/*.
 *
 * Verifies the authenticated user has the super_admin role before rendering
 * any super-admin page content. If not, renders a no-access DeadEnd.
 *
 * IMPORTANT: Does NOT redirect — only middleware redirects for auth.
 *
 * Security layers:
 * 1. Middleware blocks unauthenticated users (redirects to /login)
 * 2. This layout blocks non-super_admin users (renders Access Denied)
 * 3. Server actions independently verify super_admin role per mutation
 *
 * Type: Server Component (fetches profile for role check)
 * Tables: profiles (read)
 */

import { createClient } from '@/lib/supabase/server'
import { profileQueries } from '@/lib/supabase/queries'
import { logger } from '@/lib/logger'
import { DeadEnd } from '@/components/ui/dead-end'

export default async function SuperAdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    logger.warn('SuperAdminLayout: No user session')
    return null
  }

  const profile = await profileQueries.getProfileById(supabase, user.id)

  if (!profile || profile.role !== 'super_admin') {
    logger.warn('SuperAdminLayout: Access denied', { userId: user.id, role: profile?.role })
    // Role-AREA denial: naming the area is safe (its existence is public), so
    // this may say "no access" — unlike resource-ID dead ends, which must 404.
    return (
      <DeadEnd
        variant="no-access"
        description="The super-admin area is reserved for the Scholera platform team. Contact us if you believe you should have access."
        action={{ label: 'Back to dashboard', href: '/dashboard' }}
      />
    )
  }

  return <>{children}</>
}
