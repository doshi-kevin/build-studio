/**
 * Student Layout — role guard for all pages under /student/*.
 *
 * Verifies the authenticated user has the student (or institution_admin) role
 * before rendering any student page content. Renders a no-access DeadEnd otherwise.
 *
 * Side effect: advances the invite-status lifecycle from `accepted` → `active`
 * on the student's first visit to /student/*. This gives Admin > Students the
 * same 3-state progression Professors have (pending → accepted → active)
 * without requiring a student-side onboarding wizard.
 *
 * Security layers:
 * 1. Middleware blocks unauthenticated users (redirects to /login)
 * 2. This layout blocks non-student users (renders Access Denied)
 *
 * Type: Server Component (fetches profile for role check)
 */

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { profileQueries } from '@/lib/supabase/queries'
import { logger } from '@/lib/logger'
import { DeadEnd } from '@/components/ui/dead-end'
import { AthenaShell } from '@/components/student/athena/AthenaShell'

export default async function StudentLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    logger.warn('StudentLayout: No user session')
    return null
  }

  const profile = await profileQueries.getProfileById(supabase, user.id)

  if (!profile || (profile.role !== 'student' && profile.role !== 'institution_admin')) {
    logger.warn('StudentLayout: Access denied', { userId: user.id, role: profile?.role })
    // Role-AREA denial: naming the area is safe (its existence is public), so
    // this may say "no access" — unlike resource-ID dead ends, which must 404.
    return <DeadEnd variant="no-access" action={{ label: 'Back to dashboard', href: '/dashboard' }} />
  }

  /* Bump invite_status from 'accepted' to 'active' the first time a student
     lands on a /student/* route after setting their password. Fire-and-forget
     so a transient failure doesn't break the page load — the next visit will
     retry. The .eq('invite_status', 'accepted') guard makes this idempotent. */
  if (profile.role === 'student' && profile.invite_status === 'accepted') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    adminDb
      .from('profiles')
      .update({ invite_status: 'active', updated_at: new Date().toISOString() })
      .eq('id', user.id)
      .eq('invite_status', 'accepted')
      .then(({ error }: { error: { message: string } | null }) => {
        if (error) {
          logger.warn('StudentLayout: Failed to advance invite_status to active', { userId: user.id, error: error.message })
        }
      })
  }

  /* Athena wraps every student page, not just course pages (design doc §14.7
     D1). She is only VISIBLE once a course has announced itself — the shell
     renders nothing but its children until then — but mounting her here is what
     lets her survive driving a student to `/student/office-hours` or any other
     surface outside the course segment, which is the whole of C10.

     The name is the one prop she still needs from the server here; the course,
     its code and the professor's toggle arrive from `AthenaCourseBeacon`. */
  const greetingName = ((profile.name as string) || user.email || 'there').split(' ')[0]

  return <AthenaShell greetingName={greetingName}>{children}</AthenaShell>
}
