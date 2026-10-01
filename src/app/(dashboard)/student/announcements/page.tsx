/**
 * Student Announcements Page — cross-course announcement history.
 *
 * Lists every visible announcement across the student's enrolled sections,
 * grouped by course, with read/unread state. Complements the dashboard's
 * "Recent Announcements" panel (which shows only unread + important ones).
 *
 * Type: Server Component
 * Route: /student/announcements
 */

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { studentCatalogQueries } from '@/lib/supabase/queries'
import { logger } from '@/lib/logger'
import { AllStudentAnnouncements } from '@/components/student/announcements/AllStudentAnnouncements'

export default async function StudentAnnouncementsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) return null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any
  const announcements = await studentCatalogQueries.getAllStudentAnnouncements(adminDb, user.id)

  logger.info('StudentAnnouncementsPage: Loaded', {
    studentId: user.id,
    announcements: announcements.length,
  })

  return <AllStudentAnnouncements announcements={announcements} />
}
