// Redirect old proctoring URL to the insights page proctoring tab.
// Preserves bookmarks and existing links.

import { redirect } from 'next/navigation'

interface ProctoringPageProps {
  params: Promise<{ sectionId: string; quizId: string }>
}

export default async function ProctoringPage({ params }: ProctoringPageProps) {
  const { sectionId, quizId } = await params
  redirect(`/professor/courses/${sectionId}/quizzes/${quizId}/insights?tab=proctoring`)
}
