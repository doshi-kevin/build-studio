/**
 * Student Grades Overview Page — all grades across all courses.
 *
 * Shows a table of all enrollments with grades, GPA calculation.
 *
 * Type: Server Component
 * Route: /student/grades
 */

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { studentCatalogQueries } from '@/lib/supabase/queries'
import { logger } from '@/lib/logger'
import { GradesTable } from '@/components/student/grades/GradesTable'

export default async function StudentGradesPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) return null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any
  const enrollments = await studentCatalogQueries.getStudentGrades(adminDb, user.id)

  logger.info('StudentGradesPage: Loaded', { studentId: user.id, enrollments: enrollments.length })

  return <GradesTable enrollments={enrollments} />
}
