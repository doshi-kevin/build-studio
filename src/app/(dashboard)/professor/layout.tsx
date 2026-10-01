/**
 * Professor Layout — role guard for all pages under /professor/*.
 *
 * Verifies the authenticated user has the professor, institution_admin, or
 * course_assistant (TA/grader) role before rendering any professor page
 * content. Course assistants are permitted because the professor UI tree is
 * reused for TAs — per-section access is verified inside the section
 * container layout, which rejects course assistants who aren't assigned to
 * the specific section they're viewing.
 *
 * Security layers:
 * 1. Middleware blocks unauthenticated users (redirects to /login)
 * 2. This layout blocks roles that can never access professor views
 * 3. Course container layout verifies section-level access (professor OR active staff)
 * 4. Individual server actions gate write operations by role
 *
 * Type: Server Component (fetches profile for role check)
 */

import { createClient } from '@/lib/supabase/server'
import { profileQueries } from '@/lib/supabase/queries'
import { logger } from '@/lib/logger'
import { DeadEnd } from '@/components/ui/dead-end'
import { OnboardingGate } from '@/components/professor/onboarding/OnboardingGate'

export default async function ProfessorLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    logger.warn('ProfessorLayout: No user session')
    return null
  }

  const profile = await profileQueries.getProfileById(supabase, user.id)

  const allowedRoles = ['professor', 'institution_admin', 'course_assistant']
  if (!profile || !allowedRoles.includes(profile.role)) {
    logger.warn('ProfessorLayout: Access denied', { userId: user.id, role: profile?.role })
    // Role-AREA denial: naming the area is safe (its existence is public), so
    // this may say "no access" — unlike resource-ID dead ends, which must 404.
    return <DeadEnd variant="no-access" action={{ label: 'Back to dashboard', href: '/dashboard' }} />
  }

  /* OnboardingGate redirects unfinished professors into the professor onboarding
   * wizard. Course assistants (TAs/graders) don't have a professor onboarding
   * flow — their own onboarding (set password) is handled elsewhere, and their
   * onboarding_completed flag is flipped in completeOnboarding() once the
   * password is set. Skip the gate for course assistants so they aren't pushed
   * into a wizard that doesn't apply to them. */
  if (profile.role === 'course_assistant') {
    return <>{children}</>
  }

  const onboardingCompleted = profile.onboarding_completed ?? true

  return (
    <OnboardingGate onboardingCompleted={onboardingCompleted}>
      {children}
    </OnboardingGate>
  )
}
