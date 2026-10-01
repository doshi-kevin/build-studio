/**
 * Professor Course Intel Page — read-only view of alumni intelligence data.
 *
 * Professors see the same IntelPanel as students but are always treated
 * as having full access (isAlumni = true) so they can view all content.
 *
 * Type: Server Component
 * Route: /professor/courses/[sectionId]/intel
 */

import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { intelQueries } from '@/lib/supabase/queries'
import { logger } from '@/lib/logger'
import { IntelPanel } from '@/components/student/intel/IntelPanel'

interface ProfessorIntelPageProps {
  params: Promise<{ sectionId: string }>
}

export default async function ProfessorIntelPage({ params }: ProfessorIntelPageProps) {
  const { sectionId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) return null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any

  const courseId = await intelQueries.getCourseIdFromSection(adminDb, sectionId)
  if (!courseId) {
    logger.warn('ProfessorIntelPage: Could not resolve courseId', { sectionId })
    notFound()
  }

  // Parallel fetch all intel data
  const [
    reviews,
    reviewStats,
    questions,
    tips,
    tipVotes,
    resources,
    professorInsights,
    courseProfessors,
    overviewStats,
  ] = await Promise.all([
    intelQueries.getReviews(adminDb, courseId, user.id),
    intelQueries.getReviewStats(adminDb, courseId),
    intelQueries.getQuestions(adminDb, courseId, user.id),
    intelQueries.getTips(adminDb, courseId, user.id),
    intelQueries.getTipVotes(adminDb, courseId, user.id),
    intelQueries.getResources(adminDb, courseId, user.id),
    intelQueries.getProfessorInsights(adminDb, courseId, user.id),
    intelQueries.getCourseProfessors(adminDb, courseId),
    intelQueries.getOverviewStats(adminDb, courseId),
  ])

  logger.info('ProfessorIntelPage: Loaded', {
    sectionId,
    courseId,
    reviewCount: reviews.length,
    questionCount: questions.length,
    tipCount: tips.length,
    resourceCount: resources.length,
  })

  return (
    <IntelPanel
      courseId={courseId}
      sectionId={sectionId}
      userId={user.id}
      isAlumni={true}
      reviews={reviews}
      reviewStats={reviewStats}
      userReview={null}
      questions={questions}
      tips={tips}
      tipVotes={tipVotes}
      resources={resources}
      professorInsights={professorInsights}
      courseProfessors={courseProfessors}
      overviewStats={overviewStats}
    />
  )
}
