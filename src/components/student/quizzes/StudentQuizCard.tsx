'use client'

// Single quiz card shown in the student quiz list.
// Displays quiz state (not started / in progress / completed / exhausted),
// meta info, best score, and the appropriate action button.

import { Clock, FileQuestion, Play, RotateCcw, Trophy, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { attemptsExhausted, type Quiz, type QuizAttempt } from '@/lib/validations/quiz'
import { formatDate, isPastDue } from '@/lib/quiz/utils'

interface StudentQuizCardProps {
  quiz: Quiz
  attempts: QuizAttempt[]
  onStart: () => void
  onResume: (attemptId: string) => void
  onViewResults: (attemptId: string) => void
}

type QuizState = 'not_started' | 'in_progress' | 'completed' | 'exhausted' | 'missed'

function getQuizState(quiz: Quiz, attempts: QuizAttempt[]): QuizState {
  const inProgress = attempts.find((a) => a.status === 'in_progress')
  if (inProgress) return 'in_progress'
  const submitted = attempts.filter((a) => a.status === 'submitted')
  if (attemptsExhausted(quiz.maxAttempts, submitted.length)) return 'exhausted'
  if (submitted.length > 0) return 'completed'
  // The server already refuses to start an attempt once dueDate has passed
  // (quizzes/actions.ts) — this just stops the card offering a Start button
  // that would only error. It MUST go through isPastDue for that to hold: a
  // due date is picked with type="date", so it is stored at UTC midnight, and
  // comparing that instant directly marks the quiz missed for the whole of its
  // own due day (#311) while the server is still accepting attempts.
  if (isPastDue(quiz.dueDate)) return 'missed'
  return 'not_started'
}

const STATE_CONFIG: Record<QuizState, { label: string; dot: string; text: string }> = {
  not_started: { label: 'Not Started',      dot: 'bg-muted-foreground/30', text: 'text-muted-foreground' },
  in_progress:  { label: 'In Progress',      dot: 'bg-warning',             text: 'text-warning-muted-foreground' },
  completed:    { label: 'Completed',        dot: 'bg-success',             text: 'text-success-muted-foreground' },
  exhausted:    { label: 'All Attempts Used', dot: 'bg-muted-foreground/30', text: 'text-muted-foreground' },
  missed:       { label: 'Missed',           dot: 'bg-destructive',         text: 'text-destructive' },
}

function scoreColor(score: number): string {
  if (score >= 80) return 'text-success-muted-foreground'
  if (score >= 60) return 'text-warning-muted-foreground'
  return 'text-destructive'
}

export function StudentQuizCard({
  quiz,
  attempts,
  onStart,
  onResume,
  onViewResults,
}: StudentQuizCardProps) {
  const quizState = getQuizState(quiz, attempts)
  const inProgressAttempt = attempts.find((a) => a.status === 'in_progress')
  const bestAttempt = attempts
    .filter((a) => a.status === 'submitted')
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0]
  const submittedCount = attempts.filter((a) => a.status === 'submitted').length
  const stateConfig = STATE_CONFIG[quizState]

  return (
    <div className="group rounded-xl border border-border bg-card p-5 transition duration-200 ease-out hover:border-ring/40 hover:shadow-sm">
      {/* Stacks below sm (#547). This was a fixed two-column row with a `shrink-0` action
          column, so at 390px the Start / Resume / Retry / Results button rendered off the
          right edge and was clipped — a student could not start a quiz from the list on a
          phone at all, which is the population most likely to be on one. Not polish: a hard
          block on the primary action. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">

        {/* Left: content */}
        <div className="flex-1 min-w-0 space-y-3">
          {/* Title row */}
          <div className="flex items-center gap-2.5">
            <div className={cn('h-1.5 w-1.5 rounded-full shrink-0', stateConfig.dot)} />
            <h3 className="text-sm font-semibold leading-tight">{quiz.title}</h3>
            <span className={cn('text-xs font-medium shrink-0', stateConfig.text)}>
              {stateConfig.label}
            </span>
          </div>

          {quiz.description && (
            <p className="text-xs text-muted-foreground line-clamp-1">{quiz.description}</p>
          )}

          {/* Meta chips */}
          <div className="flex items-center flex-wrap gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <FileQuestion className="h-3 w-3" />
              {`${quiz.questionIds.length} ${quiz.questionIds.length === 1 ? 'question' : 'questions'}`}
            </span>
            {quiz.timeLimitMinutes && (
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {quiz.timeLimitMinutes} min
              </span>
            )}
            <span className="tabular-nums">
              {quiz.maxAttempts === null
                ? `${submittedCount} used · unlimited`
                : `${submittedCount}/${quiz.maxAttempts} attempts used`}
            </span>
            {quiz.dueDate && (
              <span className="font-medium text-warning-muted-foreground">
                Due {formatDate(quiz.dueDate)}
              </span>
            )}
            {bestAttempt && bestAttempt.score != null && (
              <span className={cn('flex items-center gap-1 font-semibold tabular-nums', scoreColor(bestAttempt.score))}>
                <Trophy className="h-3 w-3" />
                Best: {bestAttempt.score}%
              </span>
            )}
          </div>
        </div>

        {/* Right on desktop, a full-width row underneath on mobile. Wraps rather than
            clipping when a state shows two controls plus the "Last attempt" warning. */}
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {quizState === 'not_started' && (
            <Button size="sm" onClick={onStart} className="gap-1.5">
              <Play className="h-3.5 w-3.5" />
              Start
            </Button>
          )}
          {quizState === 'in_progress' && inProgressAttempt && (
            <Button
              size="sm"
              onClick={() => onResume(inProgressAttempt.id)}
              className="gap-1.5"
              title="Continue your in-progress attempt"
            >
              <Play className="h-3.5 w-3.5" />
              Resume
            </Button>
          )}
          {quizState === 'completed' && (
            <>
              <Button size="sm" variant="outline" onClick={() => bestAttempt && onViewResults(bestAttempt.id)}>
                Results
              </Button>
              {quiz.maxAttempts !== null && quiz.maxAttempts - submittedCount === 1 && (
                <span className="flex items-center gap-1 text-[10px] font-medium text-warning-muted-foreground">
                  <AlertTriangle className="h-3 w-3" />
                  Last attempt
                </span>
              )}
              <Button
                size="sm"
                onClick={onStart}
                className="gap-1.5"
                title={
                  quiz.maxAttempts === null
                    ? 'Start a new attempt (no limit)'
                    : `Start a new attempt (${quiz.maxAttempts - submittedCount} remaining)`
                }
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Retry
              </Button>
            </>
          )}
          {quizState === 'exhausted' && bestAttempt && (
            <Button size="sm" variant="outline" onClick={() => onViewResults(bestAttempt.id)}>
              View Results
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
