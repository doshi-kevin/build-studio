/**
 * Student Quizzes Page — list of available quizzes.
 *
 * Type: Server Component
 * Route: /student/courses/[sectionId]/quizzes
 */

import { StudentQuizList } from '@/components/student/quizzes/StudentQuizList'
import { verifyFeatureEnabled } from '@/lib/validations/features'

interface StudentQuizzesPageProps {
  params: Promise<{ sectionId: string }>
}

export default async function StudentQuizzesPage({ params }: StudentQuizzesPageProps) {
  const { sectionId } = await params

  /* Guard the PAGE, not just the layout: segments render in parallel, so a layout
     denial does not stop this component executing and streaming its payload.
     Also re-verifies session + enrollment. */
  await verifyFeatureEnabled(sectionId, 'quizzes')

  return <StudentQuizList sectionId={sectionId} />
}
