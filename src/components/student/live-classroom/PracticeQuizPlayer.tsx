// Reveal-based practice quiz player. Ungraded, unlimited retakes — the student
// attempts each question, then reveals the pre-generated answer + explanation.
// MCQ/True-False show instant right/wrong (we hold the correct answer);
// free-text types reveal a model answer to self-check against. Nothing is
// graded server-side and nothing is persisted.

'use client'

import { useState } from 'react'
import { CheckCircle2, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { MarkdownLatex } from '@/components/shared/MarkdownLatex'
import type { PracticeQuestion } from '@/lib/validations/lc-class-insights'

export function PracticeQuizPlayer({ questions }: { questions: PracticeQuestion[] }) {
  // Reset key remounts the questions to clear all attempts ("retake").
  const [round, setRound] = useState(0)
  if (questions.length === 0) return null

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {questions.length} questions · ungraded · take it as many times as you like
        </p>
        <Button variant="outline" size="sm" onClick={() => setRound((r) => r + 1)}>
          <RotateCcw className="h-3.5 w-3.5" />
          Retake
        </Button>
      </div>
      {questions.map((q, i) => (
        <PracticeQuestionCard key={`${round}-${i}`} index={i} question={q} />
      ))}
    </div>
  )
}

function PracticeQuestionCard({ index, question }: { index: number; question: PracticeQuestion }) {
  const isChoice = question.options.length > 0
  const [selected, setSelected] = useState<string | null>(null)
  const [revealed, setRevealed] = useState(false)

  const reveal = () => setRevealed(true)

  return (
    <div className="rounded-2xl border border-border bg-card p-5">
      <div className="flex gap-2.5">
        <span className="text-sm font-semibold tabular-nums text-muted-foreground">{index + 1}.</span>
        <div className="flex-1 space-y-3">
          <div className="text-sm font-medium">
            <MarkdownLatex content={question.prompt} />
          </div>

          {isChoice ? (
            <div className="space-y-2">
              {question.options.map((opt) => {
                const isPicked = selected === opt
                const isCorrect = opt === question.correctAnswer
                // After reveal: correct option = success; a wrong pick = destructive.
                const stateClass = revealed
                  ? isCorrect
                    ? 'border-success bg-success-muted/40'
                    : isPicked
                      ? 'border-destructive bg-destructive-muted/40'
                      : 'border-border'
                  : isPicked
                    ? 'border-primary bg-primary text-primary-foreground font-medium shadow-sm'
                    : 'border-border hover:border-ring/50'
                return (
                  <button
                    key={opt}
                    type="button"
                    disabled={revealed}
                    onClick={() => setSelected(opt)}
                    className={`flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-left text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${stateClass}`}
                  >
                    {/* Same renderer as the prompt, correct answer and explanation
                        around it (#646). As plain text an option like $O(\log n)$
                        showed its raw dollar signs and backslash — visibly
                        inconsistent inside a single question on a CS product, where
                        notation in options is routine. */}
                    <span className="flex-1">
                      <MarkdownLatex content={opt} />
                    </span>
                    {revealed && isCorrect && <CheckCircle2 className="h-4 w-4 shrink-0 text-success" aria-hidden />}
                  </button>
                )
              })}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Think through your answer, then reveal the model answer to check yourself.
            </p>
          )}

          {!revealed ? (
            <Button
              variant="outline"
              size="sm"
              onClick={reveal}
              disabled={isChoice && selected === null}
            >
              {isChoice ? 'Check answer' : 'Reveal answer'}
            </Button>
          ) : (
            <div className="rounded-xl border border-border bg-muted/40 p-3.5">
              {!isChoice && (
                <div className="mb-2 text-sm">
                  <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                    Model answer
                  </span>
                  <div className="mt-1">
                    <MarkdownLatex content={question.correctAnswer} />
                  </div>
                </div>
              )}
              <div className="text-sm text-muted-foreground">
                <MarkdownLatex content={question.explanation} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
