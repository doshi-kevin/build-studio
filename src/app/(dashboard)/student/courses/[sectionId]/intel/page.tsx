/**
 * Course Alumni Intelligence Page — server component that fetches all intel data
 * and renders the IntelPanel client component.
 *
 * Type: Server Component
 * Route: /student/courses/[sectionId]/intel
 */

import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { intelQueries } from '@/lib/supabase/queries'
import { logger } from '@/lib/logger'
import { IntelPanel } from '@/components/student/intel/IntelPanel'
import { verifyFeatureEnabled } from '@/lib/validations/features'

interface IntelPageProps {
  params: Promise<{ sectionId: string }>
}

export default async function IntelPage({ params }: IntelPageProps) {
  const { sectionId } = await params

  /* Guard the PAGE, not just the layout: segments render in parallel, so a layout
     denial does not stop this component executing and streaming its payload.
     Also re-verifies session + enrollment. */
  await verifyFeatureEnabled(sectionId, 'intel')
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) return null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any

  const courseId = await intelQueries.getCourseIdFromSection(adminDb, sectionId)
  if (!courseId) {
    logger.warn('IntelPage: Could not resolve courseId', { sectionId })
    notFound()
  }

  // Parallel fetch all intel data
  const [
    isAlumni,
    reviews,
    reviewStats,
    userReview,
    questions,
    tips,
    tipVotes,
    resources,
    professorInsights,
    courseProfessors,
    overviewStats,
  ] = await Promise.all([
    intelQueries.verifyAlumniStatus(adminDb, courseId, user.id),
    intelQueries.getReviews(adminDb, courseId, user.id),
    intelQueries.getReviewStats(adminDb, courseId),
    intelQueries.getUserReview(adminDb, courseId, user.id),
    intelQueries.getQuestions(adminDb, courseId, user.id),
    intelQueries.getTips(adminDb, courseId, user.id),
    intelQueries.getTipVotes(adminDb, courseId, user.id),
    intelQueries.getResources(adminDb, courseId, user.id),
    intelQueries.getProfessorInsights(adminDb, courseId, user.id),
    intelQueries.getCourseProfessors(adminDb, courseId),
    intelQueries.getOverviewStats(adminDb, courseId),
  ])

  logger.info('IntelPage: Loaded', {
    sectionId,
    courseId,
    isAlumni,
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
      isAlumni={isAlumni}
      reviews={reviews}
      reviewStats={reviewStats}
      userReview={userReview}
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
