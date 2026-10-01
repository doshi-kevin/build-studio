/**
 * Student Courses Page — card grid of enrolled course sections.
 *
 * Shows all enrolled/completed courses with grade info.
 * Clicking a card enters the student course container.
 *
 * Type: Server Component
 * Route: /student/courses
 */

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { courseQueries, profileQueries } from '@/lib/supabase/queries'
import { logger } from '@/lib/logger'
import { StudentCourseGrid } from '@/components/student/courses/StudentCourseGrid'

export default async function StudentCoursesPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) return null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any

  const [profile, enrollments] = await Promise.all([
    profileQueries.getProfileById(adminDb, user.id),
    courseQueries.getStudentEnrollments(adminDb, user.id),
  ])

  const studentName = profile?.name || profile?.first_name || 'Student'

  logger.info('StudentCoursesPage: Loaded', {
    studentId: user.id,
    enrollments: (enrollments || []).length,
  })

  return (
    <StudentCourseGrid
      studentName={studentName}
      enrollments={enrollments || []}
    />
  )
}
