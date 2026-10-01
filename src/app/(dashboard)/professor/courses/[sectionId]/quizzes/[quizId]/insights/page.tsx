// Quiz Insights Page — unified analytics dashboard with Overview and Submissions tabs.
import { QuizInsightsDashboard } from '@/components/professor/quizzes/QuizInsightsDashboard'

interface InsightsPageProps {
  params: Promise<{ sectionId: string; quizId: string }>
  searchParams: Promise<{ tab?: string }>
}

// Known tabs — guards against stale deep-links (e.g. the removed ?tab=adaptive / ?tab=cohorts)
// rendering an empty tab body. Unknown values fall back to the dashboard's default (Overview).
const VALID_TABS = ['overview', 'submissions', 'proctoring']

export default async function QuizInsightsPage({ params, searchParams }: InsightsPageProps) {
  const { sectionId, quizId } = await params
  const { tab } = await searchParams
  const defaultTab = tab && VALID_TABS.includes(tab) ? tab : undefined

  return <QuizInsightsDashboard sectionId={sectionId} quizId={quizId} defaultTab={defaultTab} />
}
