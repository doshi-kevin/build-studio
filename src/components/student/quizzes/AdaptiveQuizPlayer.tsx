// Adaptive (CCAT) quiz player — serves ONE question at a time, chosen by the IRT
// engine from the student's answers so far. Distinct from the linear QuizPlayer
// (no free navigation / flagging): each Submit grades the answer server-side,
// recomputes ability θ̂±SE, and returns the next item or ends the quiz.
// See docs/designs/quizzes/ccat-system-design.md.
'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { MarkdownLatex } from '@/components/shared/MarkdownLatex'
import { QuestionDisplay } from '@/components/student/quizzes/QuestionDisplay'
import type { Answer, Question } from '@/lib/validations/quiz'
import {
  startAdaptiveAttempt,
  submitAdaptiveAnswer,
  adaptiveTutorTurn,
} from '@/app/(dashboard)/student/courses/[sectionId]/quizzes/actions'

type Turn = { role: 'student' | 'tutor'; text: string }

interface Props {
  sectionId: string
  quizId: string
}

export function AdaptiveQuizPlayer({ sectionId, quizId }: Props) {
  const router = useRouter()
  const [status, setStatus] = useState<'loading' | 'answering' | 'submitting' | 'error' | 'done'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [attemptId, setAttemptId] = useState<string>('')
  const [served, setServed] = useState<Question | null>(null)
  const [qNum, setQNum] = useState(1)
  const [targetItems, setTargetItems] = useState(10)
  const [draft, setDraft] = useState<Partial<Answer>>({})
  const started = useRef(false)
  // When the current item was first shown — used to record per-question time on
  // submit (the linear player tracks this too; without it adaptive insights
  // showed Avg Time = 0s).
  const questionShownAt = useRef(0)

  // Start (or resume) the attempt on mount, and serve the first item.
  useEffect(() => {
    if (started.current) return
    started.current = true
    ;(async () => {
      const res = await startAdaptiveAttempt(sectionId, quizId)
      if ('error' in res || !res.data) {
        setError(('error' in res && res.error) || 'Failed to start')
        setStatus('error')
        return
      }
      const d = res.data
      setAttemptId(d.attemptId)
      setTargetItems(d.targetItems)
      setQNum(d.answered + 1)
      if (d.stopped || !d.served) {
        router.replace(`/student/courses/${sectionId}/quizzes/${quizId}/results/${d.attemptId}`)
        return
      }
      setServed(d.served as Question)
      questionShownAt.current = Date.now()
      setStatus('answering')
    })()
  }, [sectionId, quizId, router])

  const onAnswer = useCallback((partial: Partial<Answer>) => {
    setDraft((prev) => ({ ...prev, ...partial }))
  }, [])

  const hasAnswer = (() => {
    if (!served) return false
    const t = served.content.questionType
    if (t === 'multiple_choice') return (draft.selectedChoiceIds?.length ?? 0) > 0
    if (t === 'true_false') return draft.booleanAnswer !== undefined
    if (t === 'short_answer' || t === 'explanation') return !!draft.textAnswer?.trim()
    if (t === 'fill_in_blank') return Object.keys(draft.blankAnswers ?? {}).length > 0
    return false
  })()

  const submit = useCallback(
    async () => {
      if (!served) return
      setStatus('submitting')
      // Time on this item: from when it was shown to this submit. Guard against
      // a missing start stamp (0) yielding a huge value.
      const timeSpentSeconds = questionShownAt.current
        ? Math.max(0, Math.round((Date.now() - questionShownAt.current) / 1000))
        : 0
      // Walkthrough transcript is NOT sent from here — it's graded from the
      // server-persisted transcript (see submitAdaptiveAnswer).
      const res = await submitAdaptiveAnswer(sectionId, attemptId, {
        questionId: served.id,
        selectedChoiceIds: draft.selectedChoiceIds,
        booleanAnswer: draft.booleanAnswer,
        textAnswer: draft.textAnswer,
        blankAnswers: draft.blankAnswers,
        timeSpentSeconds,
        tabSwitches: 0,
        copyAttempts: 0,
      })
      if ('error' in res || !res.data) {
        setError(('error' in res && res.error) || 'Failed to submit')
        setStatus('error')
        return
      }
      const d = res.data
      // Like a standard quiz: go straight to the next question — no per-item
      // feedback and no ability estimate shown during the attempt (both gated to
      // the results page).
      goNext((d.served as Question) ?? null, d.stopped)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [served, attemptId, sectionId, draft],
  )

  const goNext = useCallback(
    (next: Question | null, stopped: boolean) => {
      setDraft({})
      if (stopped || !next) {
        setStatus('done')
        router.replace(`/student/courses/${sectionId}/quizzes/${quizId}/results/${attemptId}`)
        return
      }
      setServed(next)
      questionShownAt.current = Date.now()
      setQNum((n) => n + 1)
      setStatus('answering')
    },
    [router, sectionId, quizId, attemptId],
  )

  if (status === 'loading') {
    return <CenterMsg><Loader2 className="h-5 w-5 animate-spin" /> Preparing your adaptive quiz…</CenterMsg>
  }
  if (status === 'error') {
    /* An exit is mandatory here (#379 part 2). This screen is reachable, and it used to render the
       error text and nothing else: browser QA measured zero links and zero buttons on the page, so a
       student who landed on "Maximum attempts reached" was stranded with only the sidebar.

       The race that lands them here did not reproduce, and fixing the dead end does not depend on
       it: a screen with no way forward is its own bug. The exhausted case gets its own wording
       because "maximum attempts reached" is a normal outcome, not a failure, and it should not be
       dressed as one. */
    const exhausted = /maximum attempts/i.test(error ?? '')
    return (
      <div className="mx-auto flex min-h-[40vh] max-w-md flex-col items-center justify-center gap-4 px-4 text-center">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          {!exhausted && <XCircle className="h-5 w-5 text-destructive" />}
          <span>
            {exhausted
              ? "You've used all your attempts on this quiz."
              : (error ?? 'Something went wrong starting this quiz.')}
          </span>
        </div>
        <Button
          variant={exhausted ? 'default' : 'outline'}
          onClick={() => router.push(`/student/courses/${sectionId}/quizzes`)}
        >
          {exhausted ? 'See your results' : 'Back to quizzes'}
        </Button>
      </div>
    )
  }
  if (status === 'done') {
    return <CenterMsg><Loader2 className="h-5 w-5 animate-spin" /> Scoring your results…</CenterMsg>
  }

  const isWalkthrough = served?.content.questionType === 'walkthrough'

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      {/* Progress header */}
      <div className="mb-6 flex items-center gap-3">
        <span className="text-sm font-medium text-foreground">Adaptive Quiz</span>
        <span className="text-sm tabular-nums text-muted-foreground">
          Question {qNum}{targetItems ? ` of ~${targetItems}` : ''}
        </span>
      </div>

      <Card className="p-6">
        {/* Question (objective + explanation) or walkthrough chat */}
        {served && !isWalkthrough && (status === 'answering' || status === 'submitting') && (
          <>
            <QuestionDisplay
              question={served}
              answer={draft as Answer}
              questionNumber={qNum}
              shuffleAnswers={false}
              onAnswer={onAnswer}
            />
            <div className="mt-6 flex justify-end">
              <Button onClick={() => submit()} disabled={!hasAnswer || status === 'submitting'}>
                {status === 'submitting' ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Saving…</> : 'Submit'}
              </Button>
            </div>
          </>
        )}

        {served && isWalkthrough && (status === 'answering' || status === 'submitting') && (
          <WalkthroughChat
            sectionId={sectionId}
            attemptId={attemptId}
            question={served}
            questionNumber={qNum}
            onFinish={() => submit()}
            submitting={status === 'submitting'}
          />
        )}
      </Card>
    </div>
  )
}

function CenterMsg({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-[40vh] items-center justify-center gap-2 text-sm text-muted-foreground">
      {children}
    </div>
  )
}

// ── Walkthrough interview (the item itself — transcript is scored) ──────────
// Exported for the studio's student preview, which renders it inert (`preview`):
// no tutor calls, inputs disabled — the professor sees the exact taking UI.
export function WalkthroughChat({
  sectionId,
  attemptId,
  question,
  questionNumber,
  onFinish,
  submitting,
  preview = false,
  headerAction,
}: {
  sectionId: string
  attemptId: string
  question: Question
  questionNumber: number
  onFinish: () => void
  submitting: boolean
  preview?: boolean
  headerAction?: React.ReactNode
}) {
  const opening =
    question.content.questionType === 'walkthrough' ? question.content.opening : ''
  const [transcript, setTranscript] = useState<Turn[]>(opening ? [{ role: 'tutor', text: opening }] : [])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const started = useRef(false)
  // Matches the server cap (adaptiveTutorTurn slices each student message to 4000).
  const MSG_MAX = 4000

  // If there's no scripted opening, ask the tutor for one.
  useEffect(() => {
    if (preview) return
    if (started.current) return
    started.current = true
    if (opening) return
    ;(async () => {
      setBusy(true)
      const res = await adaptiveTutorTurn(sectionId, attemptId, question.id, '')
      setBusy(false)
      if ('data' in res && res.data) setTranscript([{ role: 'tutor', text: res.data.reply }])
    })()
  }, [preview, opening, sectionId, attemptId, question.id])

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text) return
    const next = [...transcript, { role: 'student' as const, text }]
    setTranscript(next)
    setInput('')
    setBusy(true)
    // Send only the new student message; the server owns the authoritative transcript.
    const res = await adaptiveTutorTurn(sectionId, attemptId, question.id, text)
    setBusy(false)
    if ('data' in res && res.data) {
      setTranscript([...next, { role: 'tutor', text: res.data.reply }])
      if (res.data.done) setDone(true)
    }
  }, [input, transcript, sectionId, attemptId, question.id])

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="text-lg font-semibold tracking-tight text-foreground">
          Question {questionNumber}
        </span>
        <Badge variant="outline" className="text-[10px] uppercase tracking-wider">Guided Walkthrough</Badge>
        {headerAction && <span className="ml-auto">{headerAction}</span>}
      </div>
      <div className="rounded-2xl border border-border bg-card/50 p-5">
        <MarkdownLatex content={question.questionText} className="text-base font-medium" />
      </div>

      <div className="space-y-2 rounded-xl border border-border bg-muted/20 p-4">
        {preview && transcript.length === 0 && (
          <p className="text-sm italic text-muted-foreground">
            The tutor opens the conversation when the quiz starts.
          </p>
        )}
        {transcript.map((t, i) => (
          <div key={i} className={t.role === 'tutor' ? 'text-sm text-foreground' : 'text-sm text-muted-foreground'}>
            <span className="font-semibold">{t.role === 'tutor' ? 'Tutor: ' : 'You: '}</span>
            {t.text}
          </div>
        ))}
        {busy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      </div>

      {done && (
        <p className="text-xs text-muted-foreground">
          The tutor wrapped up — submit to score your reasoning, or add one more thought first.
        </p>
      )}

      <div className="flex gap-2">
        <div className="flex-1 space-y-1">
          <Textarea
            value={input}
            maxLength={MSG_MAX}
            disabled={preview}
            onChange={(e) => setInput(e.target.value.slice(0, MSG_MAX))}
            placeholder="Walk through your reasoning…"
            className="min-h-12 rounded-xl"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
          />
          <div className="flex justify-end">
            <span className="text-[11px] tabular-nums text-muted-foreground/70">
              {input.length.toLocaleString()}/{MSG_MAX.toLocaleString()}
            </span>
          </div>
        </div>
        <Button variant="outline" onClick={() => void send()} disabled={preview || busy || !input.trim()}>
          Send
        </Button>
      </div>

      <div className="flex justify-end">
        <Button onClick={() => onFinish()} disabled={preview || submitting || transcript.filter((t) => t.role === 'student').length === 0}>
          {submitting ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Scoring…</> : 'End & score'}
        </Button>
      </div>
    </div>
  )
}
