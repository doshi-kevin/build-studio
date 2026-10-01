/**
 * Admin Course Detail Page — shows course info and all its sections.
 *
 * Admin can view course metadata, add new sections (A/B/C),
 * and assign professors to each section from this page.
 *
 * Type: Server Component
 * Route: /admin/courses/[courseId]
 * Tables: courses, course_sections, profiles, departments
 */

import { notFound } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/admin'
import { courseAdminQueries, courseAssignmentQueries } from '@/lib/supabase/queries'
import { verifyInstitutionAdmin } from '@/lib/auth/admin-context'
import { CourseDetailView } from '@/components/admin/courses/CourseDetailView'
import { logger } from '@/lib/logger'

interface PageProps {
  params: Promise<{ courseId: string }>
}

export default async function CourseDetailPage({ params }: PageProps) {
  const { courseId } = await params

  const auth = await verifyInstitutionAdmin('CourseDetailPage')
  if ('error' in auth) {
    logger.warn('CourseDetailPage: Unauthorized', { courseId })
    notFound()
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any

  logger.debug('CourseDetailPage: Fetching course and sections', { courseId, institutionId: auth.institutionId })

  const [course, sections, { data: professorsData }] = await Promise.all([
    courseAdminQueries.getById(adminDb, courseId),
    courseAssignmentQueries.getByCourse(adminDb, courseId),
    adminDb
      .from('profiles')
      .select('id, name, email')
      .eq('role', 'professor')
      .eq('institution_id', auth.institutionId)
      .order('name'),
  ])

  if (!course) {
    logger.warn('CourseDetailPage: Course not found', { courseId })
    notFound()
  }

  /* Tenant ownership check — block cross-tenant access via guessable course IDs. */
  if (course.institution_id !== auth.institutionId) {
    logger.warn('CourseDetailPage: Cross-tenant course access blocked', {
      courseId,
      courseInstitution: course.institution_id,
      callerInstitution: auth.institutionId,
    })
    notFound()
  }

  // Fetch department name for breadcrumb
  let departmentName: string | null = null
  if (course.department_id) {
    const { data: dept } = await adminDb
      .from('departments')
      .select('name')
      .eq('id', course.department_id)
      .single()
    departmentName = dept?.name ?? null
  }

  logger.info('CourseDetailPage: Loaded', { courseId, sections: sections.length })

  return (
    <CourseDetailView
      course={course}
      sections={sections}
      professors={professorsData || []}
      departmentName={departmentName}
    />
  )
}
