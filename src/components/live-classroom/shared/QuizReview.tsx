// Read-only review of a CLOSED live quiz: each question with the student's
// pick vs the correct answer (✓/✗) and the reasoning when available. Pure
// presentation over `buildQuizReview` — shared by the student's in-session
// reveal and the after-class history. Only ever render for closed quizzes.
//
// `studentAnswers === null` renders an "answer key" view (correct answers +
// reasoning, no pick/score) — used as the professor fallback when a quiz has
// no stored results report.

'use client'

import { Check, X, CircleDot, Lightbulb } from 'lucide-react'
import { buildQuizReview, type QuizReviewPayload } from '@/lib/live-classroom/quiz-review'

interface Props {
  payload: QuizReviewPayload
  studentAnswers: Record<string, string> | null
  className?: string
}

export function QuizReview({ payload, studentAnswers, className = '' }: Props) {
  const model = buildQuizReview(payload, studentAnswers)
  const isAnswerKey = studentAnswers === null

  return (
    <div className={`space-y-5 ${className}`}>
      {/* Score header (only when we're reviewing a student's own attempt) */}
      {!isAnswerKey && (
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-muted/20 px-4 py-3">
          <div>
            <p className="text-xs uppercase tracking-widest font-semibold text-muted-foreground">
              Your result
            </p>
            <p className="text-sm font-medium mt-0.5">
              {model.correctCount} of {model.totalCount} correct
            </p>
          </div>
          <ScoreBadge pct={model.scorePct} />
        </div>
      )}

      {model.questions.map((q, idx) => (
        <div key={q.id} className="space-y-2.5">
          <div className="flex items-start gap-2.5">
            <span className="shrink-0 inline-flex items-center justify-center w-6 h-6 rounded-lg bg-muted/50 border border-border text-xs font-semibold text-muted-foreground mt-0.5">
              {idx + 1}
            </span>
            <p className="text-sm font-medium leading-snug flex-1">{q.prompt}</p>
            {!isAnswerKey && (
              <span className="shrink-0 mt-0.5">
                {q.isCorrect ? (
                  <Check className="h-4 w-4 text-success-muted-foreground" strokeWidth={3} aria-label="Correct" />
                ) : (
                  <X className="h-4 w-4 text-destructive" strokeWidth={3} aria-label="Incorrect" />
                )}
              </span>
            )}
          </div>

          <ul className="space-y-1.5 pl-[34px]" role="list">
            {q.choices.map((c, cIdx) => {
              const letter = String.fromCharCode(65 + cIdx)
              const pickedWrong = c.isPicked && !c.isCorrect
              return (
                <li
                  key={c.id}
                  className={`flex items-center gap-2.5 px-3.5 py-2.5 rounded-2xl border text-sm ${
                    c.isCorrect
                      ? 'border-success/60 bg-success-muted'
                      : pickedWrong
                        ? 'border-destructive/50 bg-destructive/10'
                        : 'border-border bg-background opacity-60'
                  }`}
                >
                  <span
                    className={`shrink-0 inline-flex items-center justify-center w-6 h-6 rounded-lg text-xs font-semibold tracking-wider ${
                      c.isCorrect
                        ? 'bg-success text-success-foreground'
                        : pickedWrong
                          ? 'bg-destructive text-destructive-foreground'
                          : 'bg-muted/60 text-muted-foreground'
                    }`}
                    aria-hidden
                  >
                    {c.isCorrect ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : pickedWrong ? <X className="h-3.5 w-3.5" strokeWidth={3} /> : letter}
                  </span>
                  <span className="flex-1 break-words">{c.text}</span>
                  {c.isCorrect && (
                    <span className="shrink-0 text-xs uppercase tracking-widest font-semibold text-success-muted-foreground">
                      {c.isPicked ? 'Your answer' : 'Correct'}
                    </span>
                  )}
                  {pickedWrong && (
                    <span className="shrink-0 text-xs uppercase tracking-widest font-semibold text-destructive">
                      Your answer
                    </span>
                  )}
                </li>
              )
            })}
          </ul>

          {/* Not-answered note (student attempts only) */}
          {!isAnswerKey && !q.answered && (
            <p className="pl-[34px] flex items-center gap-1.5 text-xs text-muted-foreground">
              <CircleDot className="h-3 w-3 shrink-0" aria-hidden />
              You didn&apos;t answer this one.
            </p>
          )}

          {/* Reasoning, when the quiz carries one */}
          {q.explanation && (
            <div className="ml-[34px] flex items-start gap-2 rounded-2xl border border-border bg-muted/20 px-3.5 py-2.5">
              <Lightbulb className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" aria-hidden />
              <p className="text-sm leading-relaxed text-muted-foreground">{q.explanation}</p>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function ScoreBadge({ pct }: { pct: number }) {
  const tone =
    pct >= 80
      ? 'bg-success-muted text-success-muted-foreground'
      : pct >= 50
        ? 'bg-muted text-foreground'
        : 'bg-destructive/10 text-destructive'
  return (
    <span className={`inline-flex items-center rounded-full px-3 py-1 text-sm font-semibold tabular-nums ${tone}`}>
      {pct}%
    </span>
  )
}
