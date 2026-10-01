/**
 * Adaptive Quiz Page — student takes a CCAT (IRT) adaptive quiz, one server-
 * selected question at a time. The attempt is created/resumed by the player on
 * mount (startAdaptiveAttempt), so no attemptId is needed in the route.
 *
 * Type: Server Component
 * Route: /student/courses/[sectionId]/quizzes/[quizId]/adaptive
 */

import { AdaptiveQuizPlayer } from '@/components/student/quizzes/AdaptiveQuizPlayer'

interface AdaptivePageProps {
  params: Promise<{ sectionId: string; quizId: string }>
}

export default async function AdaptiveQuizPage({ params }: AdaptivePageProps) {
  const { sectionId, quizId } = await params
  return <AdaptiveQuizPlayer sectionId={sectionId} quizId={quizId} />
}
