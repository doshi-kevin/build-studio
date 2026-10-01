/**
 * Quiz Results Page — student reviews their submission.
 *
 * Type: Server Component
 * Route: /student/courses/[sectionId]/quizzes/[quizId]/results/[attemptId]
 */

// AdaptiveResults renders the CCAT results (grade + θ̂±SE + mastery + misconceptions)
// for adaptive attempts and transparently delegates to the linear QuizResults
// otherwise — so this one route serves both quiz types.
import { AdaptiveResults } from '@/components/student/quizzes/AdaptiveResults'
import { verifyFeatureEnabled } from '@/lib/validations/features'

interface ResultsPageProps {
  params: Promise<{ sectionId: string; quizId: string; attemptId: string }>
}

export default async function QuizResultsPage({ params }: ResultsPageProps) {
  const { sectionId, quizId, attemptId } = await params

  /* Guard the PAGE, not just the layout: segments render in parallel, so a layout
     denial does not stop this component executing and streaming its payload.
     Also re-verifies session + enrollment. */
  /* A finished attempt is the student's own work, so it stays readable even if
     the school later drops Quizzes — see §4.5. The professor's per-section
     toggle still applies; only the institution ceiling is waived. */
  await verifyFeatureEnabled(sectionId, 'quizzes', { historical: true })

  return <AdaptiveResults sectionId={sectionId} quizId={quizId} attemptId={attemptId} />
}
