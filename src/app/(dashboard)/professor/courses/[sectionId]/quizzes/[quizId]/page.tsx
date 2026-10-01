/**
 * Quiz Editor Page — loads the quiz studio in edit mode.
 * Supports ?focusQuestion=<id> for deep-linking from the insights dashboard
 * to a specific question (?step=N from old links is accepted and ignored),
 * and ?preview=1 to open with the student preview showing (quiz-card entry).
 *
 * Freshly-created drafts from the quiz list's own "Create quiz" button land
 * here on a CLEAN URL — the "just created" intent (open the setup spotlight,
 * or the AI dialog) is handed off via sessionStorage and consumed on mount.
 * Drafts created via the dashboard's "Create a Quiz" quick action are
 * resolved server-side (see the quizzes list `page.tsx`) and redirect here
 * with `?intent=setup` instead — that path has no client render on the list
 * to carry a sessionStorage write, so the URL is the only channel available.
 *
 * Type: Server Component
 * Route: /professor/courses/[sectionId]/quizzes/[quizId]
 */

import { notFound } from 'next/navigation'
import { QuizStudio } from '@/components/professor/quizzes/wizard/QuizStudio'
import {
  getQuizById,
  getQuestions,
  getQuizGenerationState,
  getQuizSubmissionCounts,
} from '@/app/(dashboard)/professor/courses/[sectionId]/quizzes/actions'
import type { Question } from '@/lib/validations/quiz'

interface QuizEditorPageProps {
  params: Promise<{ sectionId: string; quizId: string }>
  searchParams: Promise<{ focusQuestion?: string; step?: string; preview?: string; intent?: string }>
}

export default async function QuizEditorPage({ params, searchParams }: QuizEditorPageProps) {
  const { sectionId, quizId } = await params
  const { focusQuestion, preview, intent } = await searchParams

  const [quizResult, questionsResult, genState, attemptCounts] = await Promise.all([
    getQuizById(sectionId, quizId),
    getQuestions(sectionId),
    getQuizGenerationState(sectionId, quizId),
    // Feeds the Studio's unpublish confirmation: withdrawing a quiz students have already
    // attempted is a different decision from withdrawing an untouched one (#615).
    getQuizSubmissionCounts(sectionId),
  ])

  // Previously a silent redirect to the quiz list, which teleported the professor
  // with no explanation. notFound() is caught by the course-level boundary
  // (courses/[sectionId]/not-found.tsx), which explains what happened and keeps
  // the section icon rail for the trip back. (No quiz-specific boundary:
  // not-found.tsx receives no route params, so it couldn't build the
  // /courses/[sectionId]/quizzes href anyway.)
  if (quizResult.error || !quizResult.data) {
    notFound()
  }

  const quiz = quizResult.data
  const allBankQuestions = questionsResult.data || []

  // Get questions assigned to this quiz (in order)
  const assignedQuestions = quiz.questionIds
    .map((id: string) => allBankQuestions.find((q: Question) => q.id === id))
    .filter(Boolean) as typeof allBankQuestions

  // Athena's provider now lives on the quizzes LAYOUT so the list can reach it too. Nesting a
  // second provider here would split registrations across two docks — the studio registering
  // into the inner one while the list's trigger drives the outer — so this page mounts none.
  return (
    <>
      <QuizStudio
        sectionId={sectionId}
        mode="edit"
        quizId={quizId}
        initialQuiz={quiz}
        initialQuestions={assignedQuestions}
        allBankQuestions={allBankQuestions}
        focusQuestion={focusQuestion}
        initialPreview={preview === '1'}
        initiallyGenerating={genState.data?.generating ?? false}
        initialIntent={intent}
        /* null, NOT 0, when the count could not be read. `?? 0` made a FAILED lookup
           render as "no attempts" by omission — the same fail-open shape as #574, in a
           confirmation whose whole job is to say what withdrawing costs. */
        attemptCount={attemptCounts.error ? null : (attemptCounts.data?.[quizId]?.submitted ?? 0)}
      />
    </>
  )
}
