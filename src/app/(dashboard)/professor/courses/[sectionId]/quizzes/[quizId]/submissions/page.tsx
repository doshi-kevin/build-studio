// Professor submissions page — redirects to the insights page with
// the submissions tab active, since submissions are now integrated there.
import { redirect } from 'next/navigation'

interface SubmissionsPageProps {
  params: Promise<{ sectionId: string; quizId: string }>
}

export default async function SubmissionsPage({ params }: SubmissionsPageProps) {
  const { sectionId, quizId } = await params
  redirect(`/professor/courses/${sectionId}/quizzes/${quizId}/insights?tab=submissions`)
}
