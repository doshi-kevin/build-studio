// Multi-question AI quiz responder — renders inline inside the sidebar
// "Live" tab. Pre-submit: all questions with single submit at the end.
// Post-submit: view-only with the student's answers highlighted, locked
// in until the professor closes the quiz.

'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { motion } from 'framer-motion'
import { Check, Loader2, Send, Hourglass, FileQuestion, CheckCircle2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { submitResponse } from '@/lib/live-classroom/interactions/actions'
import { seededShuffle } from '@/lib/live-classroom/shuffle'
import type { SnapshotInteraction, SnapshotResponse } from '@/lib/live-classroom/snapshot'
import { QuizCountdown } from '@/components/live-classroom/shared/QuizCountdown'
import { QuizReview } from '@/components/live-classroom/shared/QuizReview'
import { getQuizReveal } from '@/lib/live-classroom/history/actions'
import type { QuizReviewPayload } from '@/lib/live-classroom/quiz-review'
import { SPRING } from '@/lib/motion'

interface QuizQuestion {
  id: string
  prompt: string
  choices: Array<{ id: string; text: string }>
  correctChoiceId: string
  concept?: string
  explanation?: string
}

interface Props {
  interaction: SnapshotInteraction
  myResponse: SnapshotResponse | null
  userId: string
  onResponded?: (interactionId: string, response: Record<string, unknown>) => void
}

export function AiQuizResponder({ interaction, myResponse, userId, onResponded }: Props) {
  const payload = interaction.payload as {
    title?: string
    questions?: QuizQuestion[]
    timeLimitSeconds?: number
    revealAnswers?: boolean
  }
  const questions = payload.questions ?? []
  const title = payload.title ?? 'AI Quiz'
  const timeLimitSeconds = payload.timeLimitSeconds

  // Prior answers come from the snapshot's myResponse. This prop can arrive
  // AFTER mount (the open quiz is delivered via broadcast replay before the
  // snapshot response is threaded through), so we must derive `submitted`
  // from props reactively — NOT freeze it at mount with useState. Otherwise
  // a refresh shows the quiz as unanswered even though it was submitted.
  const priorAnswers = (myResponse?.response as { answers?: Record<string, string> })?.answers ?? null

  const [localAnswers, setLocalAnswers] = useState<Record<string, string>>({})
  const [locallySubmitted, setLocallySubmitted] = useState(false)
  const [pending, setPending] = useState(false)
  // Set once the countdown hits 0 — locks the inputs after a final auto-submit.
  const [expired, setExpired] = useState(false)

  // Reset transient state if a different quiz is surfaced into this same
  // mounted responder (InteractionResponder doesn't key it per interaction).
  // Uses React's "adjust state during render on prop change" pattern.
  const [trackedId, setTrackedId] = useState(interaction.id)
  if (trackedId !== interaction.id) {
    setTrackedId(interaction.id)
    setExpired(false)
    setLocalAnswers({})
    setLocallySubmitted(false)
  }

  // Locked-in answers (from server) take precedence over local selections.
  const answers = priorAnswers ?? localAnswers
  const submitted = locallySubmitted || priorAnswers != null
  const locked = submitted || expired
  // Immediate feedback: once submitted, show the right/wrong breakdown instead
  // of the "wait for the professor to close" holding state.
  const reveal = submitted && payload.revealAnswers === true

  // The live payload no longer carries correct answers (anti-cheat) — fetch the
  // answer-bearing questions from the server-gated reveal endpoint when allowed.
  const [revealQuestions, setRevealQuestions] = useState<QuizReviewPayload['questions'] | null>(null)
  useEffect(() => {
    if (!reveal) return
    let cancelled = false
    getQuizReveal(interaction.id).then((r) => {
      if (!cancelled && r.questions) setRevealQuestions(r.questions)
    })
    return () => {
      cancelled = true
    }
  }, [reveal, interaction.id])

  const answeredCount = Object.keys(answers).length
  const allAnswered = answeredCount === questions.length

  const handleSelect = (questionId: string, choiceId: string) => {
    if (locked) return
    setLocalAnswers((prev) => ({ ...prev, [questionId]: choiceId }))
  }

  const handleSubmit = async () => {
    if (!allAnswered || pending) return
    setPending(true)
    try {
      const result = await submitResponse({
        interactionId: interaction.id,
        response: { answers },
      })
      if (result.error) {
        toast.error(result.error)
      } else {
        setLocallySubmitted(true)
        onResponded?.(interaction.id, { answers })
        toast.success('Quiz submitted!')
      }
    } finally {
      setPending(false)
    }
  }

  // Time's up: auto-submit whatever's been answered so far (partial beats
  // losing their work), then lock. With nothing answered, just lock.
  const handleExpire = async () => {
    setExpired(true)
    if (submitted || pending || answeredCount === 0) return
    setPending(true)
    try {
      const result = await submitResponse({
        interactionId: interaction.id,
        response: { answers },
      })
      if (!result.error) {
        setLocallySubmitted(true)
        onResponded?.(interaction.id, { answers })
        toast.success("Time's up — your answers were submitted")
      }
    } finally {
      setPending(false)
    }
  }

  return (
    <motion.section
      key={interaction.id}
      initial={{ opacity: 0, y: 10, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={SPRING}
      className="rounded-3xl border border-foreground/35 bg-background overflow-hidden shadow-[0_8px_30px_-12px_rgba(0,0,0,0.12)]"
    >
      {/* Header */}
      <header className="flex items-center justify-between gap-3 px-5 py-4 border-b border-border bg-muted/30">
        <div className="flex items-center gap-2.5 min-w-0">
          <FileQuestion className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="text-xs uppercase tracking-widest font-semibold text-muted-foreground truncate">
            {submitted ? 'Quiz · submitted' : 'Live quiz'}
          </span>
        </div>
        {submitted ? (
          <Badge variant="outline" className="text-xs h-5 px-2 rounded-full font-semibold gap-1.5">
            <Check className="h-3 w-3" strokeWidth={3} />
            Done
          </Badge>
        ) : (
          <div className="flex items-center gap-2 shrink-0">
            {timeLimitSeconds ? (
              <QuizCountdown
                openedAt={interaction.opened_at}
                totalSeconds={timeLimitSeconds}
                onExpire={handleExpire}
              />
            ) : null}
            <Badge className="bg-success hover:bg-success text-success-foreground text-xs h-5 px-2 rounded-full font-semibold gap-1.5 tabular-nums">
              <span className="lc-live-dot h-1.5 w-1.5 text-success-foreground" aria-hidden />
              {answeredCount}/{questions.length}
            </Badge>
          </div>
        )}
      </header>

      <div className="px-5 py-5 space-y-5">
        <p className="text-base font-medium leading-snug">{title}</p>

        {reveal ? (
          revealQuestions ? (
            <QuizReview payload={{ title, questions: revealQuestions }} studentAnswers={answers} />
          ) : (
            <div className="flex min-h-[180px] items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )
        ) : (
        <>
        {/* Submitted banner */}
        {submitted && (
          <div className="flex items-start gap-3 rounded-2xl border border-success/30 bg-success-muted px-4 py-3">
            <div className="rounded-full bg-success text-success-foreground p-1.5 shrink-0 mt-0.5">
              <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2.5} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-foreground leading-tight">Answers locked in</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Your professor will share the concept breakdown when the quiz closes.
              </p>
            </div>
          </div>
        )}

        {/* Questions */}
        <div className="space-y-6">
          {questions.map((q, qIdx) => {
            const shuffledChoices = seededShuffle(q.choices, `${userId}:${interaction.id}:${q.id}`)
            const selectedChoice = answers[q.id] ?? null

            return (
              <div key={q.id} className="space-y-3">
                <div className="flex items-start gap-2.5">
                  <span className="shrink-0 inline-flex items-center justify-center w-6 h-6 rounded-xl bg-muted/50 border border-border text-xs font-semibold text-muted-foreground mt-0.5 tabular-nums">
                    {qIdx + 1}
                  </span>
                  <p className="text-sm font-medium leading-snug flex-1">{q.prompt}</p>
                </div>

                <div className="space-y-2 pl-[34px]">
                  {shuffledChoices.map((c, cIdx) => {
                    const isSelected = selectedChoice === c.id
                    const letter = String.fromCharCode(65 + cIdx)
                    return (
                      <motion.button
                        key={c.id}
                        type="button"
                        onClick={() => handleSelect(q.id, c.id)}
                        disabled={locked}
                        whileTap={locked ? undefined : { scale: 0.99 }}
                        className={`w-full text-left px-3.5 py-3 rounded-2xl border text-sm transition duration-200 ease-out ${
                          isSelected
                            ? submitted
                              ? 'border-success/60 bg-success-muted'
                              : 'border-primary bg-primary text-primary-foreground font-medium'
                            : locked
                              ? 'border-border bg-background opacity-50'
                              : 'border-border bg-background hover:border-foreground/40 hover:bg-muted/30'
                        }`}
                      >
                        <span className="flex items-center gap-2.5">
                          <span
                            className={`shrink-0 inline-flex items-center justify-center w-6 h-6 rounded-xl text-xs font-semibold tracking-wider transition-colors ${
                              isSelected
                                ? submitted
                                  ? 'bg-success text-success-foreground'
                                  : 'bg-background text-foreground'
                                : 'bg-muted/50 text-muted-foreground'
                            }`}
                            aria-hidden
                          >
                            {isSelected ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : letter}
                          </span>
                          <span className="flex-1 break-words">{c.text}</span>
                        </span>
                      </motion.button>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>

        {/* Footer: submit or waiting hint */}
        {submitted ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground px-1">
            <Hourglass className="h-3 w-3 shrink-0" aria-hidden />
            <span>Waiting for your professor to close the quiz and share results.</span>
          </div>
        ) : expired ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground px-1">
            <Hourglass className="h-3 w-3 shrink-0" aria-hidden />
            <span>Time&apos;s up — answering is closed.</span>
          </div>
        ) : (
          <Button
            onClick={handleSubmit}
            disabled={!allAnswered || pending}
            className="w-full rounded-full h-12 font-semibold text-sm"
          >
            {pending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Submitting…
              </>
            ) : (
              <>
                <Send className="h-3.5 w-3.5 mr-2" />
                {allAnswered ? 'Submit quiz' : `${questions.length - answeredCount} left to answer`}
              </>
            )}
          </Button>
        )}
        </>
        )}
      </div>
    </motion.section>
  )
}
