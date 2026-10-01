// Per-student submission detail page — shows answers, proctoring, and activity timeline.
// Thin server component that delegates to StudentSubmissionPage.

import { StudentSubmissionPage } from '@/components/professor/quizzes/StudentSubmissionPage'

interface Props {
  params: Promise<{ sectionId: string; quizId: string; attemptId: string }>
}

export default async function AttemptDetailPage({ params }: Props) {
  const { sectionId, quizId, attemptId } = await params
  return <StudentSubmissionPage sectionId={sectionId} quizId={quizId} attemptId={attemptId} />
}
