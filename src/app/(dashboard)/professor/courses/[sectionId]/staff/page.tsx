// Professor staff page — shows active TAs/graders, pending requests, and a
// "Request New TA/Grader" button. Approval requires an institution admin.
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { sectionStaffQueries } from '@/lib/supabase/queries'
import { logger } from '@/lib/logger'
import { StaffFeaturePage } from '@/components/professor/staff/StaffFeaturePage'

interface StaffPageProps {
  params: Promise<{ sectionId: string }>
}

export default async function ProfessorStaffPage({ params }: StaffPageProps) {
  const { sectionId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any

  const { data: section, error } = await adminDb
    .from('course_sections')
    .select('id, professor_id, section_code, semester, year, end_date, course:courses(id, code, title)')
    .eq('id', sectionId)
    .single()

  if (error || !section) {
    logger.warn('ProfessorStaffPage: Section not found', { sectionId })
    notFound()
  }
  if (section.professor_id !== user.id) {
    logger.warn('ProfessorStaffPage: Ownership mismatch', { sectionId, userId: user.id })
    notFound()
  }

  const [activeStaff, requests] = await Promise.all([
    sectionStaffQueries.listActiveForSection(adminDb, sectionId),
    sectionStaffQueries.listRequestsForSection(adminDb, sectionId),
  ])

  const course = Array.isArray(section.course) ? section.course[0] : section.course

  return (
    <StaffFeaturePage
      sectionId={sectionId}
      sectionLabel={course ? `${course.code} · ${section.section_code}` : section.section_code}
      sectionEndDate={section.end_date}
      activeStaff={activeStaff}
      requests={requests}
    />
  )
}
