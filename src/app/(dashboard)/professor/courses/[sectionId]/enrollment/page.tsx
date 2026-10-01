/**
 * Roster Page — read-only enrolled-student list for the professor.
 *
 * Enrollment is admin-driven; the professor consults the roster here.
 * (The route stays /enrollment so existing links keep working; the feature
 * registry labels it "Roster".)
 *
 * Type: Server Component
 * Route: /professor/courses/[sectionId]/enrollment
 */

import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { enrollmentQueries } from '@/lib/supabase/queries'
import { logger } from '@/lib/logger'
import { RosterPage } from '@/components/professor/enrollment/RosterPage'

interface EnrollmentPageProps {
  params: Promise<{ sectionId: string }>
}

export default async function EnrollmentPage({ params }: EnrollmentPageProps) {
  const { sectionId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) return null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any

  // Verify professor owns section
  const { data: section, error: sectionError } = await adminDb
    .from('course_sections')
    .select('id, professor_id')
    .eq('id', sectionId)
    .single()

  if (sectionError || !section) {
    logger.warn('EnrollmentPage: Section not found', { sectionId })
    notFound()
  }

  if (section.professor_id !== user.id) {
    logger.warn('EnrollmentPage: Ownership mismatch', { sectionId, userId: user.id })
    notFound()
  }

  const enrolledStudents = await enrollmentQueries.getSectionEnrollments(adminDb, sectionId)

  /* Departures, which every professor-facing query filters out (#744). A student who
     unenrols simply vanished from the roster and the gradebook with no signal at all — a
     row the professor may have been part-way through grading, gone on the next refresh,
     with nothing saying why. Their submissions and grades are untouched in the database, so
     this is the cheap half of the fix: make the departure discoverable where the professor
     already looks, rather than behind a page they would have to go find.

     dropped_at can be NULL on rows dropped before that column existed, so the list is
     ordered with a NULL-last fallback rather than assuming a date is there. */
  const { data: departedRows, error: departedError } = await adminDb
    .from('enrollments')
    .select('student_id, dropped_at, student:profiles!enrollments_student_id_fkey(name, email)')
    .eq('section_id', sectionId)
    .eq('status', 'dropped')
    .order('dropped_at', { ascending: false, nullsFirst: false })
  if (departedError) {
    logger.warn('EnrollmentPage: departed lookup failed', { sectionId, error: departedError.message })
  }

  const departed = ((departedRows ?? []) as Array<{
    student_id: string
    dropped_at: string | null
    student: { name: string | null; email: string } | { name: string | null; email: string }[] | null
  }>).map((r) => {
    // Supabase returns a single relation as either an object or a one-element array.
    const s = Array.isArray(r.student) ? r.student[0] : r.student
    return { id: r.student_id, name: s?.name ?? s?.email ?? 'A student', droppedAt: r.dropped_at }
  })

  logger.info('EnrollmentPage: Loaded', {
    sectionId,
    enrolledCount: enrolledStudents.length,
    departedCount: departed.length,
  })

  return <RosterPage enrolledStudents={enrolledStudents} departed={departed} />
}
