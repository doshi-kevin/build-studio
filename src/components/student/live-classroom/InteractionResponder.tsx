// Student response card. Surfaces the most-recently opened poll or quiz and
// lets the student submit a response. Single-choice polls + single-question
// quizzes for v1 — multi-question and word-cloud variants land later.
//
// Submitted state is designed to feel rewarding, not just dismissive: the
// student's actual answer stays visible (highlighted), the other options
// dim out, and a friendly thank-you sits above with a contextual hint
// about what happens next. This also survives page refresh because we
// hydrate the prior answer from `myResponses` instead of a transient
// component state flag.

'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Check,
  BarChart3,
  FileQuestion,
  Loader2,
  Send,
  Hourglass,
  CheckCircle2,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { submitResponse } from '@/lib/live-classroom/interactions/actions'
import { seededShuffle } from '@/lib/live-classroom/shuffle'
import type { SnapshotInteraction, SnapshotResponse } from '@/lib/live-classroom/snapshot'
import { AiQuizResponder } from './AiQuizResponder'
import { QuizCountdown } from '@/components/live-classroom/shared/QuizCountdown'
import { QuizReview } from '@/components/live-classroom/shared/QuizReview'
import type { QuizReviewPayload } from '@/lib/live-classroom/quiz-review'
import { getQuizReveal } from '@/lib/live-classroom/history/actions'
import { SPRING } from '@/lib/motion'

interface Props {
  interactions: SnapshotInteraction[]
  myResponses: SnapshotResponse[]
  /** Used to seed a per-student shuffle of choices so neighbours can't
   *  copy by saying "the answer is C" — same student always sees the
   *  same order for a given interaction. */
  userId: string
  onResponded?: (interactionId: string, response: Record<string, unknown>) => void
}

interface PollChoice {
  id: string
  text: string
}

export function InteractionResponder({ interactions, myResponses, userId, onResponded }: Props) {
  // Set when the quiz countdown reaches 0 → ResponseForm auto-submits + locks.
  const [expired, setExpired] = useState(false)
  // Track the surfaced interaction so we can clear the lock when it changes
  // (React's "adjust state during render on prop change" pattern).
  const [trackedOpenId, setTrackedOpenId] = useState<string | null>(null)

  // When the prof has multiple interactions open at once (e.g. pushes a quiz
  // while a poll is still active), surface the MOST RECENTLY opened one so
  // students aren't stuck answering an old prompt.
  const openInteractions = interactions.filter((i) => i.status === 'open')
  const open = openInteractions
    .slice()
    .sort((a, b) => {
      const at = a.opened_at ? new Date(a.opened_at).getTime() : 0
      const bt = b.opened_at ? new Date(b.opened_at).getTime() : 0
      return bt - at
    })[0]

  if (!open) return null

  // Multi-question quizzes (AI-generated) get a dedicated full responder
  const quizQuestions = open.kind === 'quiz'
    ? (open.payload.questions as Array<{ id: string }> | undefined)
    : undefined
  if (open.kind === 'quiz' && quizQuestions && quizQuestions.length > 1) {
    const myResponse = myResponses.find((r) => r.interaction_id === open.id) ?? null
    return (
      <AiQuizResponder
        interaction={open}
        myResponse={myResponse}
        userId={userId}
        onResponded={onResponded}
      />
    )
  }

  // Reset the time-up lock when a different interaction is surfaced here.
  if (open.id !== trackedOpenId) {
    setTrackedOpenId(open.id)
    setExpired(false)
  }

  const isPoll = open.kind === 'poll'
  const title = isPoll
    ? (open.payload.question as string | undefined) ?? 'Poll'
    : (open.payload.title as string | undefined) ?? 'Quiz'
  // Countdown is quiz-only (polls have no time limit).
  const timeLimitSeconds = isPoll
    ? undefined
    : (open.payload.timeLimitSeconds as number | undefined)

  // For v1 the quiz card responds to its first question; multi-question
  // quizzes get a richer flow in a follow-up.
  const authoredChoices: PollChoice[] = isPoll
    ? ((open.payload.choices as PollChoice[] | undefined) ?? [])
    : ((open.payload.questions as Array<{ choices: PollChoice[] }> | undefined)?.[0]?.choices ?? [])

  // Per-student deterministic shuffle. Same student always sees the same
  // order for a given interaction (so their A/B/C/D doesn't move mid-answer
  // or after refresh), but two different students see different orders so
  // they can't shout the answer letter to each other.
  const choices = seededShuffle(authoredChoices, `${userId}:${open.id}`)

  // Pull the student's prior answer from snapshot, so the "you already
  // answered" state survives page refresh and includes WHICH option they
  // picked — not just a binary "submitted" flag.
  const myPriorResponse = myResponses.find((r) => r.interaction_id === open.id)
  const priorChoiceId = extractChoiceId(myPriorResponse?.response, isPoll)

  // Single-question quiz immediate feedback: when the professor enabled
  // reveal-on-submit, the responder fetches the answer from the server-gated
  // reveal endpoint after the student submits (the live payload no longer
  // carries correct answers). Polls never reveal — no correct answer.
  const revealAnswers = !isPoll && open.payload.revealAnswers === true
  const questionId =
    (open.payload.questions as Array<{ id: string }> | undefined)?.[0]?.id ?? 'q1'

  return (
    <motion.section
      key={open.id}
      initial={{ opacity: 0, y: 10, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={SPRING}
      className="rounded-3xl border border-foreground/35 bg-background overflow-hidden shadow-[0_8px_30px_-12px_rgba(0,0,0,0.12)]"
    >
      <header className="flex items-center justify-between gap-3 px-5 py-4 border-b border-border bg-muted/30">
        <div className="flex items-center gap-2.5 min-w-0">
          {isPoll ? (
            <BarChart3 className="h-4 w-4 text-muted-foreground shrink-0" />
          ) : (
            <FileQuestion className="h-4 w-4 text-muted-foreground shrink-0" />
          )}
          <span className="text-xs uppercase tracking-widest font-semibold text-muted-foreground">
            {isPoll ? 'Live poll' : 'Live quiz'}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {timeLimitSeconds ? (
            <QuizCountdown
              openedAt={open.opened_at}
              totalSeconds={timeLimitSeconds}
              onExpire={() => setExpired(true)}
            />
          ) : null}
          <Badge className="bg-success hover:bg-success text-success-foreground text-xs h-5 px-2 rounded-full font-semibold gap-1.5">
            <span className="lc-live-dot h-1.5 w-1.5 text-success-foreground" aria-hidden />
            Active
          </Badge>
        </div>
      </header>

      <div className="px-5 py-5">
        <p className="text-base font-medium leading-snug mb-5">{title}</p>
        <ResponseForm
          interactionId={open.id}
          kind={open.kind}
          isPoll={isPoll}
          choices={choices}
          priorChoiceId={priorChoiceId}
          expired={expired}
          revealAnswers={revealAnswers}
          questionId={questionId}
          onSubmitted={(response) => onResponded?.(open.id, response)}
        />
      </div>
    </motion.section>
  )
}

/** Pull the chosen option ID out of a snapshot response payload. */
function extractChoiceId(response: unknown, isPoll: boolean): string | null {
  if (!response || typeof response !== 'object') return null
  const r = response as Record<string, unknown>
  if (isPoll) {
    const ids = r.choiceIds as string[] | undefined
    return ids?.[0] ?? null
  }
  const answers = r.answers as Record<string, string> | undefined
  return answers?.q1 ?? null
}

function ResponseForm({
  interactionId,
  kind,
  isPoll,
  choices,
  priorChoiceId,
  expired,
  revealAnswers,
  questionId,
  onSubmitted,
}: {
  interactionId: string
  kind: 'poll' | 'quiz' | 'question'
  isPoll: boolean
  choices: PollChoice[]
  priorChoiceId: string | null
  expired: boolean
  /** When true (reveal-on-submit quiz), the submitted state fetches the answer
   *  and shows the right/wrong review instead of the "wait for close" state. */
  revealAnswers: boolean
  questionId: string
  onSubmitted: (response: Record<string, unknown>) => void
}) {
  // priorChoiceId (from the snapshot's myResponse) can arrive AFTER mount —
  // the open interaction is delivered via broadcast replay before the
  // snapshot response is threaded through. Derive `submitted` from props
  // reactively so a refresh always shows the locked-in answer instead of
  // re-prompting. Local selection only matters before submitting.
  const [localSelected, setLocalSelected] = useState<string | null>(null)
  const [locallySubmitted, setLocallySubmitted] = useState(false)
  const [pending, setPending] = useState(false)

  const selected = priorChoiceId ?? localSelected
  const submitted = locallySubmitted || priorChoiceId != null

  const handleSubmit = async () => {
    if (!selected) return
    setPending(true)
    try {
      const response =
        kind === 'poll'
          ? { choiceIds: [selected] }
          : { answers: { q1: selected } }
      const result = await submitResponse({ interactionId, response })
      if (result.error) toast.error(result.error)
      else {
        setLocallySubmitted(true)
        onSubmitted(response)
        toast.success('Response submitted')
      }
    } finally {
      setPending(false)
    }
  }

  // Time's up: auto-submit the current selection (so it isn't lost) then lock.
  // With nothing selected, the `expired` flag alone locks the inputs below.
  useEffect(() => {
    if (!expired || submitted || pending) return
    if (selected) void handleSubmit()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expired])

  // Reveal-on-submit: the live payload has no answers (anti-cheat), so fetch
  // the answer-bearing question from the server-gated endpoint once submitted.
  const [revealQuestions, setRevealQuestions] = useState<QuizReviewPayload['questions'] | null>(null)
  useEffect(() => {
    if (!submitted || !revealAnswers) return
    let cancelled = false
    getQuizReveal(interactionId).then((r) => {
      if (!cancelled && r.questions) setRevealQuestions(r.questions)
    })
    return () => {
      cancelled = true
    }
  }, [submitted, revealAnswers, interactionId])

  // ── Already answered state ────────────────────────────────────────
  // Show the student's choice highlighted, dim the others, with a friendly
  // thank-you header and a contextual waiting hint.

  if (submitted) {
    // Reveal-on-submit quiz: show the per-question right/wrong breakdown once
    // the server-gated answers have loaded.
    if (revealAnswers && selected) {
      return (
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={SPRING}
        >
          {revealQuestions ? (
            <QuizReview payload={{ questions: revealQuestions }} studentAnswers={{ [questionId]: selected }} />
          ) : (
            <div className="flex min-h-[180px] items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}
        </motion.div>
      )
    }
    return (
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={SPRING}
        className="space-y-4"
      >
        {/* Thank-you header */}
        <div className="flex items-start gap-3 rounded-2xl border border-success/30 bg-success-muted px-4 py-3">
          <div className="rounded-full bg-success text-success-foreground p-1.5 shrink-0 mt-0.5">
            <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2.5} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-foreground leading-tight">
              You&apos;re in
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {isPoll
                ? 'Your vote is counted. Hang tight while everyone responds.'
                : 'Answer locked in. Hang tight while the rest finish up.'}
            </p>
          </div>
        </div>

        {/* All choices, but read-only — student's pick is highlighted, others
            are visibly dimmed so it's obvious what they chose. */}
        <ul className="space-y-2" role="list">
          {choices.map((c, idx) => {
            const isMine = priorChoiceId === c.id
            const letter = String.fromCharCode(65 + idx)
            return (
              <motion.li
                key={c.id}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ ...SPRING, delay: idx * 0.04 }}
                className={`relative w-full text-left px-4 py-3 rounded-2xl border text-sm transition-colors ${
                  isMine
                    ? 'border-success/60 bg-success-muted'
                    : 'border-border bg-background opacity-50'
                }`}
              >
                <div className="flex items-center gap-3">
                  <span
                    className={`shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-xl text-xs font-semibold tracking-wider ${
                      isMine
                        ? 'bg-success text-success-foreground'
                        : 'bg-muted/60 text-muted-foreground'
                    }`}
                    aria-hidden
                  >
                    {isMine ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : letter}
                  </span>
                  <span className={`break-words flex-1 ${isMine ? 'font-medium text-foreground' : 'text-muted-foreground'}`}>
                    {c.text}
                  </span>
                  {isMine && (
                    <span className="shrink-0 text-xs uppercase tracking-widest font-semibold text-success-muted-foreground">
                      Your answer
                    </span>
                  )}
                </div>
              </motion.li>
            )
          })}
        </ul>

        {/* Waiting hint */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground px-1">
          <Hourglass className="h-3 w-3 shrink-0" aria-hidden />
          <span>
            {isPoll
              ? 'Results are shared by your professor when the poll closes.'
              : 'Your professor will share the answer when the quiz closes.'}
          </span>
        </div>
      </motion.div>
    )
  }

  // ── Pre-submit state ──────────────────────────────────────────────

  return (
    <div className="space-y-4">
      <ul className="space-y-2" role="list">
        <AnimatePresence initial={false}>
          {choices.map((c, idx) => {
            const isSelected = selected === c.id
            const letter = String.fromCharCode(65 + idx)
            return (
              <motion.li
                key={c.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ ...SPRING, delay: idx * 0.05 }}
              >
                <motion.button
                  type="button"
                  onClick={() => { if (!expired) setLocalSelected(c.id) }}
                  disabled={expired}
                  whileTap={expired ? undefined : { scale: 0.99 }}
                  className={`group w-full text-left px-4 py-3.5 rounded-2xl border text-sm transition duration-200 ease-out ${
                    isSelected
                      ? 'border-primary bg-primary text-primary-foreground font-medium shadow-sm'
                      : 'border-border bg-background hover:border-foreground/40 hover:bg-muted/30'
                  } ${expired && !isSelected ? 'opacity-50' : ''}`}
                >
                  <span className="flex items-center gap-3">
                    <span
                      className={`shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-xl text-xs font-semibold tracking-wider transition-colors ${
                        isSelected
                          ? 'bg-background text-foreground'
                          : 'bg-muted/50 text-muted-foreground group-hover:bg-muted'
                      }`}
                      aria-hidden
                    >
                      {isSelected ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : letter}
                    </span>
                    <span className="break-words flex-1">{c.text}</span>
                  </span>
                </motion.button>
              </motion.li>
            )
          })}
        </AnimatePresence>
      </ul>
      {expired ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground px-1">
          <Hourglass className="h-3 w-3 shrink-0" aria-hidden />
          <span>Time&apos;s up — answering is closed.</span>
        </div>
      ) : (
        <Button
          onClick={handleSubmit}
          disabled={!selected || pending}
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
              {selected ? 'Submit response' : 'Pick an answer'}
            </>
          )}
        </Button>
      )}
    </div>
  )
}
