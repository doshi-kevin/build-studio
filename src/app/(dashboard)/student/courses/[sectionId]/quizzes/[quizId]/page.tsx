/**
 * Student Quiz Detail Page — pre-quiz instructions and start button.
 *
 * Type: Server Component
 * Route: /student/courses/[sectionId]/quizzes/[quizId]
 */

import { StudentQuizDetail } from '@/components/student/quizzes/StudentQuizDetail'
import { verifyFeatureEnabled } from '@/lib/validations/features'

interface QuizDetailPageProps {
  params: Promise<{ sectionId: string; quizId: string }>
}

export default async function StudentQuizDetailPage({ params }: QuizDetailPageProps) {
  const { sectionId, quizId } = await params

  /* Guard the PAGE, not just the layout: segments render in parallel, so a layout
     denial does not stop this component executing and streaming its payload.
     Also re-verifies session + enrollment. */
  await verifyFeatureEnabled(sectionId, 'quizzes')

  return <StudentQuizDetail sectionId={sectionId} quizId={quizId} />
}
