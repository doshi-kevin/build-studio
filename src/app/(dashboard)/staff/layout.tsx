/**
 * Course Assistant Layout — role guard for all /staff/* pages.
 *
 * Only users with profile.role === 'course_assistant' reach this area. A
 * course assistant's actual per-section permissions (TA vs grader, which
 * sections) are enforced by `section_staff` RLS rules at query time.
 *
 * Note: the URL path remains /staff/* for stability (renaming the route
 * would break bookmarks and external links). The internal role value is
 * 'course_assistant'; the route segment is unrelated to that string.
 *
 * Security layers:
 * 1. Middleware blocks unauthenticated users (redirects to /login)
 * 2. This layout blocks non-course-assistant users (renders Access Denied)
 * 3. Individual pages verify active section_staff membership for the
 *    specific section being accessed.
 */

import { createClient } from '@/lib/supabase/server'
import { profileQueries } from '@/lib/supabase/queries'
import { logger } from '@/lib/logger'
import { DeadEnd } from '@/components/ui/dead-end'

export default async function StaffLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    logger.warn('StaffLayout: No user session')
    return null
  }

  const profile = await profileQueries.getProfileById(supabase, user.id)

  if (!profile || profile.role !== 'course_assistant') {
    logger.warn('StaffLayout: Access denied', { userId: user.id, role: profile?.role })
    // Role-AREA denial with a self-service next step: a just-approved TA's JWT
    // still carries the old role, so the fix is re-login — worth keeping in copy.
    return (
      <DeadEnd
        variant="no-access"
        title="You don't have access to the course assistant workspace yet"
        description="If you were just approved as a TA or grader, sign out and back in to refresh your role. Still stuck? Ask the professor who requested you — they can ping the institution admin."
        action={{ label: 'Back to dashboard', href: '/dashboard' }}
      />
    )
  }

  return <>{children}</>
}
