/**
 * Quiz Attempt Page — student takes the quiz using the standard batch QuizPlayer.
 *
 * Type: Server Component
 * Route: /student/courses/[sectionId]/quizzes/[quizId]/attempt/[attemptId]
 */

import { QuizPlayer } from '@/components/student/quizzes/QuizPlayer'
import { verifyFeatureEnabled } from '@/lib/validations/features'

interface AttemptPageProps {
  params: Promise<{ sectionId: string; quizId: string; attemptId: string }>
}

export default async function QuizAttemptPage({ params }: AttemptPageProps) {
  const { sectionId, quizId, attemptId } = await params

  /* Guard the PAGE, not just the layout: segments render in parallel, so a layout
     denial does not stop this component executing and streaming its payload.
     Also re-verifies session + enrollment. */
  await verifyFeatureEnabled(sectionId, 'quizzes')

  return <QuizPlayer sectionId={sectionId} quizId={quizId} attemptId={attemptId} />
}
