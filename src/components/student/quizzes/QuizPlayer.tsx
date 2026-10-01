'use client'

import { useState, useEffect, useCallback, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Bookmark, ChevronLeft, ChevronRight, ListChecks, Send, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { QuizPlayerProvider, useQuizPlayer } from '@/components/shared/quiz/quiz-context'
import { QuizTimerBar } from './QuizTimerBar'
import { QuestionDisplay } from './QuestionDisplay'
import { QuestionNavigator } from './QuestionNavigator'
import { FlaggedReviewScreen } from './FlaggedReviewScreen'
import { SubmitConfirmDialog } from './SubmitConfirmDialog'
import { FormulaSheetPanel } from './FormulaSheetPanel'
import CameraIndicator from './CameraIndicator'
import {
  getQuizForAttempt,
  startAttempt,
  saveAnswer,
  submitAttempt,
} from '@/app/(dashboard)/student/courses/[sectionId]/quizzes/actions'
import { enterFullscreen, exitFullscreen } from '@/lib/quiz/fullscreen'
import type { Quiz, Question, QuizAttempt } from '@/lib/validations/quiz'

// ── Inner Player (uses context) ─────────────────────────────

function QuizPlayerInner({ sectionId }: { sectionId: string }) {
  const router = useRouter()
  const { state, dispatch, getQuestionTime, lastSavedAt, saveFailed, cancelAutoSave, videoProctoringState } = useQuizPlayer()
  const { quiz, questions, attempt, currentQuestionIndex, timeRemainingSeconds } = state
  const [view, setView] = useState<'quiz' | 'review'>('quiz')
  const [submitDialogOpen, setSubmitDialogOpen] = useState(false)
  const [isSubmitting, startSubmitTransition] = useTransition()

  // Best-effort browser fullscreen. The real trigger is the Start/Resume click
  // gesture (see enterFullscreen() calls in the quiz list + StudentQuizDetail),
  // which persists across the SPA navigation into this page; this mount call is
  // a no-op when already fullscreen and a harmless retry otherwise.
  useEffect(() => {
    enterFullscreen().catch(() => {})
    return () => { exitFullscreen() }
  }, [])

  const currentQuestion = questions[currentQuestionIndex]
  const currentAnswer = attempt.answers[currentQuestion?.id]

  // Count flagged and unanswered
  const flaggedCount = Object.values(attempt.answers).filter((a) => a.isFlagged).length
  const unansweredCount = questions.filter((q) => {
    const a = attempt.answers[q.id]
    if (!a) return true
    return !(
      (a.selectedChoiceIds && a.selectedChoiceIds.length > 0) ||
      a.booleanAnswer !== undefined ||
      (a.textAnswer && a.textAnswer.trim()) ||
      (a.blankAnswers && Object.values(a.blankAnswers).some((v) => v.trim()))
    )
  }).length

  // Handle submit — cancels auto-save, flushes all answers, then grades server-side
  const handleSubmit = useCallback(() => {
    // Cancel any pending/in-flight auto-save to prevent stale data races
    cancelAutoSave()

    startSubmitTransition(async () => {
      // Flush per-question time for ALL questions (answered OR unanswered).
      // An unanswered question that the student visited still deserves a time record —
      // without this, questions the student skipped would have no quiz_answers row
      // at all, so no time chip would ever appear on the results page.
      const flushPromises = questions
        .map((question) => {
          const timeSpent = getQuestionTime(question.id)
          const answer = attempt.answers[question.id]
          // Skip if the student never visited this question (0 time, no answer)
          if (timeSpent === 0 && !answer) return null
          return saveAnswer(attempt.id, question.id, {
            selectedChoiceIds: answer?.selectedChoiceIds,
            booleanAnswer: answer?.booleanAnswer,
            textAnswer: answer?.textAnswer,
            blankAnswers: answer?.blankAnswers,
            isFlagged: answer?.isFlagged ?? false,
            timeSpentSeconds: timeSpent,
            optionChanges: answer?.optionChanges ?? 0,
            tabSwitches: answer?.tabSwitches ?? 0,
            copyAttempts: answer?.copyAttempts ?? 0,
          })
        })
        .filter((p): p is Promise<{ success?: boolean; error?: string }> => p !== null)
      await Promise.all(flushPromises)

      const result = await submitAttempt(sectionId, attempt.id)
      if (result.error) {
        // The attempt IS finished — the server auto-submitted it (expired timer on
        // resume) and this call lost the race. Send the student to their results
        // rather than an error toast over a blank, unmounted player (#311).
        if (result.alreadySubmitted) {
          await exitFullscreen()
          // Every other terminal path here confirms itself. Without this the
          // student is navigated out of a graded, fullscreen attempt with no
          // statement of what happened to their answers. The Toaster lives in the
          // root layout, so this survives the navigation onto the results page.
          toast.info('Your time ran out — this quiz was submitted automatically.')
          /* replace, not push: leaving the finished attempt URL in history means Back
             returns to a submitted attempt, and the player's own redirect effect then either
             bounces forward again or — if the page re-resolves into a fresh attempt — burns
             the student's next try (#616). */
          router.replace(
            `/student/courses/${sectionId}/quizzes/${quiz.id}/results/${attempt.id}`,
          )
          return
        }
        toast.error(result.error)
        return
      }
      if (result.data) {
        dispatch({ type: 'SUBMIT', payload: { submittedAt: result.data.submittedAt || new Date().toISOString() } })
        toast.success(`Quiz submitted! Score: ${result.data.score}%`)
        await exitFullscreen()
        router.replace(
          `/student/courses/${sectionId}/quizzes/${quiz.id}/results/${attempt.id}`,
        )
      }
    })
  }, [dispatch, attempt, questions, quiz.id, sectionId, router, getQuestionTime, cancelAutoSave])

  // Auto-submit when time runs out
  useEffect(() => {
    if (timeRemainingSeconds === 0 && attempt.status === 'in_progress') {
      toast.info("Time's up! Submitting your quiz...")
      handleSubmit()
    }
  }, [timeRemainingSeconds, attempt.status, handleSubmit])

  // Redirect to results if already submitted — must be in useEffect to avoid setState-in-render
  useEffect(() => {
    if (attempt.status === 'submitted') {
      router.replace(
        `/student/courses/${sectionId}/quizzes/${quiz.id}/results/${attempt.id}`,
      )
    }
  }, [attempt.status, sectionId, quiz.id, attempt.id, router])

  /* Was `return null` — a literally blank page for however long the navigation above takes,
     and the exact thing .claude/rules/dead-ends.md forbids. If the results push is slow or
     fails, the student is left staring at nothing right after submitting graded work, with no
     evidence it landed (#616). Say what happened and give a way through under its own steam. */
  if (attempt.status === 'submitted') {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden />
        <p className="text-sm font-medium text-foreground">Quiz submitted</p>
        <p className="text-sm text-muted-foreground">Taking you to your results…</p>
        <Button asChild variant="outline" size="sm" className="mt-1">
          <Link href={`/student/courses/${sectionId}/quizzes/${quiz.id}/results/${attempt.id}`}>
            View results
          </Link>
        </Button>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 bg-background overflow-y-auto">
      <div className="mx-auto max-w-6xl px-6 py-4">
      {view === 'review' ? (
        <FlaggedReviewScreen
          questions={questions}
          answers={attempt.answers}
          onGoToQuestion={(index) => {
            dispatch({ type: 'GO_TO_QUESTION', payload: { index } })
            setView('quiz')
          }}
          onBack={() => setView('quiz')}
          onSubmit={() => setSubmitDialogOpen(true)}
        />
      ) : (
        <div className="space-y-4">
          {/* Proctoring notice removed — student already acknowledged before starting */}

          {/* Video Proctoring Camera Indicator */}
          {quiz.videoProctoringEnabled && (
            <CameraIndicator
              isActive={videoProctoringState.isActive}
              isDenied={videoProctoringState.isDenied}
              violationCount={videoProctoringState.violationCount}
            />
          )}

          {/* Formula Sheet — mobile only (desktop renders in sidebar) */}
          {quiz.allowFormulaSheet && quiz.formulaSheetUrl && (
            <div className="lg:hidden">
              <FormulaSheetPanel url={quiz.formulaSheetUrl} />
            </div>
          )}

          {/* Timer & Progress */}
          <QuizTimerBar
            timeRemainingSeconds={timeRemainingSeconds}
            timeLimitMinutes={quiz.timeLimitMinutes}
            currentIndex={currentQuestionIndex}
            totalQuestions={questions.length}
          />

          <div className="grid grid-cols-1 lg:grid-cols-[1fr_240px] gap-6">
            {/* Main Question Area */}
            <Card className="p-6">
              {currentQuestion && (
                <>
                  <QuestionDisplay
                    question={currentQuestion}
                    answer={currentAnswer}
                    questionNumber={currentQuestionIndex + 1}
                    shuffleAnswers={quiz.shuffleAnswers}
                    onAnswer={(answer) =>
                      dispatch({
                        type: 'SET_ANSWER',
                        payload: { questionId: currentQuestion.id, answer },
                      })
                    }
                  />

                  <Separator className="my-4" />

                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <Button
                        variant={currentAnswer?.isFlagged ? 'default' : 'outline'}
                        size="sm"
                        onClick={() =>
                          dispatch({
                            type: 'TOGGLE_FLAG',
                            payload: { questionId: currentQuestion.id },
                          })
                        }
                        className={currentAnswer?.isFlagged ? 'bg-warning text-warning-foreground hover:bg-warning/90' : ''}
                      >
                        <Bookmark className="h-3.5 w-3.5 mr-1.5" />
                        {currentAnswer?.isFlagged ? 'Bookmarked' : 'Bookmark'}
                      </Button>
                    </div>
                  </div>

                  <div className="flex justify-between mt-4">
                    <Button
                      variant="outline"
                      onClick={() => dispatch({ type: 'PREV_QUESTION' })}
                      disabled={currentQuestionIndex === 0}
                    >
                      <ChevronLeft className="h-4 w-4 mr-1" />
                      Previous
                    </Button>
                    {currentQuestionIndex < questions.length - 1 ? (
                      <Button onClick={() => dispatch({ type: 'NEXT_QUESTION' })}>
                        Next
                        <ChevronRight className="h-4 w-4 ml-1" />
                      </Button>
                    ) : (
                      <Button onClick={() => setView('review')}>
                        <ListChecks className="h-4 w-4 mr-1.5" />
                        Review & Submit
                      </Button>
                    )}
                  </div>
                </>
              )}
            </Card>

            {/* Right Sidebar: Navigator */}
            <div className="space-y-4">
              {/* Formula Sheet — desktop sidebar for side-by-side reference */}
              {quiz.allowFormulaSheet && quiz.formulaSheetUrl && (
                <div className="hidden lg:block">
                  <FormulaSheetPanel url={quiz.formulaSheetUrl} />
                </div>
              )}

              <QuestionNavigator
                totalQuestions={questions.length}
                currentIndex={currentQuestionIndex}
                answers={attempt.answers}
                questionIds={questions.map((q) => q.id)}
                questionTypes={questions.map((q) => q.content.questionType)}
                onGoTo={(index) => dispatch({ type: 'GO_TO_QUESTION', payload: { index } })}
                lastSavedAt={lastSavedAt}
                saveFailed={saveFailed}
              />

              <Separator />

              <Button
                variant="outline"
                className="w-full"
                onClick={() => setSubmitDialogOpen(true)}
                loading={isSubmitting}
              >
                {!isSubmitting && <Send className="h-4 w-4" />}
                {isSubmitting ? 'Submitting…' : 'Submit Quiz'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Submit dialog rendered outside view toggle so it's always available */}
      <SubmitConfirmDialog
        open={submitDialogOpen}
        onOpenChange={setSubmitDialogOpen}
        flaggedCount={flaggedCount}
        unansweredCount={unansweredCount}
        totalQuestions={questions.length}
        onConfirm={handleSubmit}
      />
      </div>
    </div>
  )
}

// ── Outer Wrapper (loads data, provides context) ────────────

interface QuizPlayerProps {
  sectionId: string
  quizId: string
  attemptId: string
}

export function QuizPlayer({ sectionId, quizId, attemptId }: QuizPlayerProps) {
  const router = useRouter()
  const [data, setData] = useState<{
    quiz: Quiz
    questions: Question[]
    attempt: QuizAttempt
  } | null>(null)

  useEffect(() => {
    async function load() {
      // Get quiz + all questions for this section
      const quizResult = await getQuizForAttempt(sectionId, quizId)
      if (quizResult.error || !quizResult.data) {
        toast.error(quizResult.error || 'Quiz not found')
        router.push(`/student/courses/${sectionId}/quizzes`)
        return
      }

      // startAttempt will resume an in-progress attempt automatically
      const attemptResult = await startAttempt(sectionId, quizId)
      if (attemptResult.error || !attemptResult.data) {
        toast.error(attemptResult.error || 'Failed to load attempt')
        router.push(`/student/courses/${sectionId}/quizzes`)
        return
      }

      const attempt = attemptResult.data
      const allQuestions: Question[] = quizResult.questions || []
      const questionIds = attempt.resolvedQuestionIds.length > 0
        ? attempt.resolvedQuestionIds
        : quizResult.data.questionIds
      const questions = questionIds
        .map((id) => allQuestions.find((q) => q.id === id))
        .filter((q): q is Question => !!q)

      setData({ quiz: quizResult.data, questions, attempt })
    }
    load()
  }, [sectionId, quizId, attemptId, router])

  if (!data) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <QuizPlayerProvider quiz={data.quiz} questions={data.questions} attempt={data.attempt}>
      <QuizPlayerInner sectionId={sectionId} />
    </QuizPlayerProvider>
  )
}
