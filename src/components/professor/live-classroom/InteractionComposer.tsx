// Composer + control surface for polls and quizzes inside a live classroom.
// Renders a "create" launcher row, a focused composer card when active,
// and a list of currently-open interactions with live aggregate counts.
// Visual layer only — server actions and event-bus wiring are unchanged.

'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { motion } from 'framer-motion'
import {
  Play,
  Square,
  X,
  BarChart3,
  FileQuestion,
  Loader2,
  ChevronDown,
  Check,
  Clock,
  Zap,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  openInteraction,
  closeInteraction,
} from '@/lib/live-classroom/interactions/actions'
import {
  closeQuizWithReport,
  getInteractionNonResponders,
  type QuizReport,
  type NonResponder,
} from '@/app/(dashboard)/professor/courses/[sectionId]/live-classroom/actions'
import { getQuizReveal } from '@/lib/live-classroom/history/actions'
import type { SnapshotInteraction } from '@/lib/live-classroom/snapshot'
import type { EventBus } from '@/lib/live-classroom/broadcast/event-bus'
import { LiveQuizButton } from './LiveQuizButton'
import { NewInteractionComposer } from '@/components/live-classroom/shared/NewInteractionComposer'
import { QuizCountdown } from '@/components/live-classroom/shared/QuizCountdown'
import { SPRING } from '@/lib/motion'

interface Props {
  roomId: string
  openInteractions: SnapshotInteraction[]
  closedInteractions?: SnapshotInteraction[]
  aggregatesById: Record<string, Record<string, unknown>>
  hasTranscription?: boolean
  /** Shared room event bus — used to optimistically remove an interaction
   *  from the local UI the moment a close succeeds, rather than waiting for
   *  the trigger's broadcast to round-trip back to this client. */
  bus?: EventBus
  /** Surface a quiz report (manual close or past-quiz click) to the dashboard,
   *  which owns the report modal so it can also auto-open on deadline close. */
  onViewReport: (report: QuizReport) => void
}

export function InteractionComposer({ roomId, openInteractions, closedInteractions = [], aggregatesById, hasTranscription = false, bus, onViewReport }: Props) {
  return (
    <TooltipProvider delayDuration={250}>
      <section className="rounded-3xl ring-1 ring-border/50 shadow-sm bg-background overflow-hidden">
        <div className="p-4 space-y-4">
          {/* Create a poll or quiz — shared with the pre-class prep surface.
              The live surface slots in the transcription-based AI quiz button. */}
          <NewInteractionComposer
            roomId={roomId}
            quizExtras={({ timeLimitSeconds, revealAnswers }) => (
              <LiveQuizButton
                roomId={roomId}
                hasTranscription={hasTranscription}
                timeLimitSeconds={timeLimitSeconds}
                revealAnswers={revealAnswers}
              />
            )}
          />

          {/* Past quiz results */}
          {closedInteractions.filter((i) => i.kind === 'quiz' && (i.payload as Record<string, unknown>).report).length > 0 && (
            <div className="space-y-2">
              <p className="text-xs uppercase tracking-widest font-semibold text-muted-foreground">
                Past quizzes
              </p>
              {closedInteractions
                .filter((i) => i.kind === 'quiz' && (i.payload as Record<string, unknown>).report)
                .map((i) => {
                  const report = (i.payload as Record<string, unknown>).report as QuizReport
                  const title = (i.payload as Record<string, unknown>).title as string | undefined
                  return (
                    <button
                      key={i.id}
                      type="button"
                      onClick={() => onViewReport(report)}
                      className="w-full flex items-center gap-3 rounded-2xl border border-border bg-background hover:bg-muted/30 hover:border-foreground/30 transition-colors p-3 text-left"
                    >
                      <div className="rounded-xl bg-muted/40 border border-border p-2">
                        <BarChart3 className="h-3.5 w-3.5 text-muted-foreground" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{title || 'AI Quiz'}</p>
                        <p className="text-xs text-muted-foreground">
                          {report.overallAccuracy}% accuracy · {report.totalStudents} {report.totalStudents === 1 ? 'student' : 'students'}
                        </p>
                      </div>
                    </button>
                  )
                })}
            </div>
          )}

          {/* Empty state */}
          {openInteractions.length === 0 && (
            <div className="flex flex-col items-center text-center py-8 px-4 rounded-2xl border border-dashed border-border bg-muted/10">
              <div className="rounded-full bg-background border border-border p-3 mb-3">
                <Zap className="h-5 w-5 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium mb-1">Nothing live yet</p>
              <p className="text-xs text-muted-foreground max-w-[260px] leading-relaxed">
                Create a poll or quiz above and push it to wake up the room. Responses stream in here in real time.
              </p>
            </div>
          )}

          {/* Open interactions list */}
          {openInteractions.length > 0 && (
            <div className="space-y-2">
              {openInteractions.map((interaction) => (
                <InteractionRow
                  key={interaction.id}
                  interaction={interaction}
                  aggregate={aggregatesById[interaction.id]}
                  bus={bus}
                  onClosed={interaction.kind === 'quiz' ? onViewReport : undefined}
                />
              ))}
            </div>
          )}
        </div>
      </section>
    </TooltipProvider>
  )
}

function InteractionRow({
  interaction,
  aggregate,
  onClosed,
  bus,
}: {
  interaction: SnapshotInteraction
  aggregate?: Record<string, unknown>
  onClosed?: (report: QuizReport) => void
  bus?: EventBus
}) {
  const [pending, setPending] = useState(false)
  const [showAggregate, setShowAggregate] = useState(true)
  const [showQuestions, setShowQuestions] = useState(false)
  // Correct answers no longer ride the live payload (anti-cheat); the professor
  // fetches them server-side for the "View questions" answer-key modal.
  const [answerKey, setAnswerKey] = useState<
    Array<{ id: string; prompt: string; choices: Array<{ id: string; text: string }>; correctChoiceId: string; concept?: string }> | null
  >(null)
  useEffect(() => {
    if (!showQuestions || answerKey) return
    let cancelled = false
    getQuizReveal(interaction.id).then((r) => {
      if (!cancelled && r.questions) setAnswerKey(r.questions)
    })
    return () => {
      cancelled = true
    }
  }, [showQuestions, answerKey, interaction.id])
  const isPoll = interaction.kind === 'poll'
  const isOpen = interaction.status === 'open'
  // #87 — enrolled students who haven't answered yet. Refetched whenever the
  // response total ticks up (see effect below) so it shrinks live.
  const [nonResponders, setNonResponders] = useState<NonResponder[] | null>(null)
  const [showWaiting, setShowWaiting] = useState(false)
  const title = isPoll
    ? (interaction.payload.question as string | undefined) ?? 'Poll'
    : (interaction.payload.title as string | undefined) ?? 'Quiz'
  const quizTimeLimit = !isPoll
    ? (interaction.payload.timeLimitSeconds as number | undefined)
    : undefined

  const choices = isPoll
    ? ((interaction.payload.choices as Array<{ id: string; text: string }> | undefined) ?? [])
    : ((interaction.payload.questions as Array<{ choices: Array<{ id: string; text: string }> }> | undefined)?.[0]?.choices ?? [])

  const totalResponses = aggregate
    ? isPoll
      ? Object.values(aggregate).reduce<number>((s, v) => s + (typeof v === 'number' ? v : 0), 0)
      : ((aggregate.submissions as number | undefined) ?? 0)
    : 0

  // Refetch the non-responder list while open, re-running each time a new
  // response lands (totalResponses ticks) so the "waiting on" list shrinks
  // live. Closed interactions keep their last-known list (no refetch).
  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    getInteractionNonResponders(interaction.id).then((r) => {
      if (!cancelled && r.nonResponders) setNonResponders(r.nonResponders)
    })
    return () => {
      cancelled = true
    }
  }, [isOpen, interaction.id, totalResponses])

  // Optimistically remove a just-closed interaction from the local UI by
  // emitting interaction_closed on the shared bus. The DB trigger also
  // broadcasts this, but relying on that round-trip leaves the professor's
  // own UI showing "open" until a refresh — the local emit closes that gap.
  // The handler in use-interactions is idempotent (filters by id), so the
  // duplicate from the broadcast is harmless.
  const emitClosedLocally = () => {
    bus?.emit({
      type: 'interaction_closed',
      seq: null,
      ts: new Date().toISOString(),
      data: { id: interaction.id, kind: interaction.kind, status: 'closed' },
    })
  }

  const handleToggle = async () => {
    setPending(true)
    try {
      if (isOpen && interaction.kind === 'quiz') {
        const result = await closeQuizWithReport(interaction.id)
        if (result.error) {
          toast.error(result.error)
        } else {
          emitClosedLocally()
          if (result.report && onClosed) onClosed(result.report)
        }
      } else {
        const result = isOpen
          ? await closeInteraction({ interactionId: interaction.id })
          : await openInteraction({ interactionId: interaction.id })
        if (result.error) toast.error(result.error)
        else if (isOpen) emitClosedLocally()
      }
    } finally {
      setPending(false)
    }
  }

  // Top choice for the leader strip
  const leaderChoice = isPoll && choices.length > 0
    ? choices.reduce<{ text: string; count: number } | null>((acc, c) => {
        const count = (aggregate?.[c.id] as number | undefined) ?? 0
        if (!acc || count > acc.count) return { text: c.text, count }
        return acc
      }, null)
    : null

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={SPRING}
      className={`rounded-2xl border transition-colors overflow-hidden ${
        isOpen ? 'border-foreground/25 bg-muted/15' : 'border-border bg-background'
      }`}
    >
      <div className="p-3.5">
        <div className="flex items-start justify-between gap-2 mb-2.5">
          <div className="flex items-center gap-2 min-w-0">
            {isPoll ? (
              <BarChart3 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            ) : (
              <FileQuestion className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            )}
            <span className="text-xs uppercase tracking-widest font-semibold text-muted-foreground">
              {interaction.kind}
            </span>
            {isOpen && (
              <Badge className="bg-success hover:bg-success text-success-foreground text-xs h-4 px-1.5 font-semibold gap-1 rounded-full">
                <span className="lc-live-dot h-1 w-1 text-success-foreground" aria-hidden />
                Live
              </Badge>
            )}
            {isOpen && !isPoll && quizTimeLimit ? (
              <QuizCountdown openedAt={interaction.opened_at} totalSeconds={quizTimeLimit} />
            ) : null}
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant={isOpen ? 'outline' : 'default'}
                onClick={handleToggle}
                disabled={pending}
                className="h-7 px-3 text-xs rounded-full"
              >
                {pending ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : isOpen ? (
                  <>
                    <Square className="h-3 w-3 mr-1 fill-current" />
                    Close
                  </>
                ) : (
                  <>
                    <Play className="h-3 w-3 mr-1 fill-current" />
                    Push
                  </>
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {isOpen ? 'Stop accepting responses' : 'Push to students'}
            </TooltipContent>
          </Tooltip>
        </div>

        <p className="text-sm break-words leading-snug mb-3">{title}</p>

        {/* Stats strip — total + leader */}
        {aggregate && (
          <div className="flex items-baseline justify-between gap-3 mb-2">
            <div className="flex items-baseline gap-1.5">
              <span className="text-3xl font-semibold leading-none tabular-nums">
                {totalResponses}
              </span>
              <span className="text-xs text-muted-foreground">
                {isPoll
                  ? totalResponses === 1 ? 'response' : 'responses'
                  : totalResponses === 1 ? 'submission' : 'submissions'}
              </span>
            </div>
            {leaderChoice && totalResponses > 0 && (
              <div className="text-right min-w-0">
                <p className="text-xs uppercase tracking-widest font-semibold text-muted-foreground">
                  Leading
                </p>
                <p className="text-xs truncate max-w-[140px]" title={leaderChoice.text}>
                  {leaderChoice.text}
                </p>
              </div>
            )}
          </div>
        )}

        {/* Aggregate bars (polls only) */}
        {aggregate && isPoll && choices.length > 0 && (
          <div className="space-y-1.5">
            <button
              type="button"
              onClick={() => setShowAggregate((s) => !s)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <ChevronDown
                className={`h-3 w-3 transition-transform ${showAggregate ? '' : '-rotate-90'}`}
              />
              <span>{showAggregate ? 'Hide breakdown' : 'Show breakdown'}</span>
            </button>

            {showAggregate && (
              <div className="space-y-2 pt-1">
                {choices.map((c) => {
                  const count = (aggregate[c.id] as number | undefined) ?? 0
                  const pct = totalResponses > 0 ? Math.round((count / totalResponses) * 100) : 0
                  const isLeader = leaderChoice?.text === c.text && count > 0
                  return (
                    <div key={c.id} className="space-y-1">
                      <div className="flex items-center justify-between text-xs gap-2">
                        <span className={`truncate ${isLeader ? 'font-medium text-foreground' : ''}`}>
                          {c.text}
                        </span>
                        <span className="text-muted-foreground tabular-nums shrink-0 text-xs">
                          {pct}% <span className="text-muted-foreground/60">·</span> {count}
                        </span>
                      </div>
                      <div className="h-2 rounded-full bg-muted overflow-hidden">
                        <motion.div
                          initial={{ width: 0 }}
                          animate={{ width: `${pct}%` }}
                          transition={SPRING}
                          className={isLeader ? 'h-full bg-foreground' : 'h-full bg-foreground/50'}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* Quiz fallback message when no aggregate yet */}
        {!aggregate && isOpen && (
          <p className="text-xs text-muted-foreground italic">
            Waiting for first response…
          </p>
        )}

        {/* #87 — who hasn't answered yet (live) */}
        {isOpen && nonResponders && nonResponders.length > 0 && (
          <div className="mt-2 space-y-1.5">
            <button
              type="button"
              onClick={() => setShowWaiting((s) => !s)}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <ChevronDown
                className={`h-3 w-3 transition-transform ${showWaiting ? '' : '-rotate-90'}`}
              />
              <Clock className="h-3 w-3 shrink-0" aria-hidden />
              <span>Waiting on {nonResponders.length}</span>
            </button>
            {showWaiting && (
              <div className="flex flex-wrap gap-1 pt-0.5">
                {nonResponders.map((s) => (
                  <span
                    key={s.id}
                    title={s.name}
                    className="inline-flex max-w-[14ch] items-center truncate rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                  >
                    {s.name}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {/* View questions link (opens modal) */}
        {!isPoll && (() => {
          const quizQuestions = (interaction.payload.questions as Array<{
            id: string
            prompt: string
            choices: Array<{ id: string; text: string }>
            correctChoiceId: string
            concept?: string
          }> | undefined) ?? []
          if (quizQuestions.length <= 1) return null
          return (
            <button
              type="button"
              onClick={() => setShowQuestions(true)}
              className="mt-2 text-xs text-muted-foreground hover:text-foreground transition-colors underline underline-offset-2"
            >
              View {quizQuestions.length} questions
            </button>
          )
        })()}

        {/* Questions modal */}
        {!isPoll && (() => {
          // Prefer the server-fetched answer key (carries correctChoiceId); fall
          // back to the live payload (sanitized — no correct answer marked).
          const quizQuestions = answerKey ?? ((interaction.payload.questions as Array<{
            id: string
            prompt: string
            choices: Array<{ id: string; text: string }>
            correctChoiceId: string
            concept?: string
          }> | undefined) ?? [])
          if (quizQuestions.length === 0) return null
          const quizTitle = (interaction.payload.title as string | undefined) ?? 'Quiz'
          return (
            <Dialog open={showQuestions} onOpenChange={setShowQuestions}>
              <DialogContent
                showCloseButton={false}
                className="p-0 gap-0 max-h-[80vh] flex flex-col overflow-hidden rounded-3xl"
              >
                <header className="flex items-center justify-between px-6 py-5 border-b border-border shrink-0">
                  <div>
                    <DialogTitle className="text-base font-semibold">{quizTitle}</DialogTitle>
                    <DialogDescription className="text-xs text-muted-foreground">
                      {quizQuestions.length} questions
                    </DialogDescription>
                  </div>
                  <button
                    onClick={() => setShowQuestions(false)}
                    className="rounded-full p-2 hover:bg-muted transition-colors"
                    aria-label="Close"
                  >
                    <X className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                  </button>
                </header>
                <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
                  {quizQuestions.map((q, idx) => (
                    <div key={q.id} className="rounded-2xl border border-border p-3.5">
                      <p className="text-sm leading-snug">
                        <span className="text-muted-foreground font-semibold mr-2">{idx + 1}.</span>
                        {q.prompt}
                      </p>
                      <ul className="mt-2 space-y-1 pl-5">
                        {q.choices.map((c, cIdx) => {
                          const isCorrect = c.id === q.correctChoiceId
                          return (
                            <li key={c.id} className={`text-xs flex items-start gap-1.5 ${isCorrect ? 'font-medium' : 'text-muted-foreground'}`}>
                              <span className="shrink-0 text-xs w-4">{String.fromCharCode(65 + cIdx)}.</span>
                              <span>{c.text}</span>
                              {isCorrect && <Check className="h-3 w-3 shrink-0 mt-0.5" />}
                            </li>
                          )
                        })}
                      </ul>
                      {q.concept && (
                        <span className="inline-block mt-2 text-xs text-muted-foreground bg-muted/50 rounded-full px-2 py-0.5">
                          {q.concept}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
                <footer className="shrink-0 border-t border-border px-6 py-4">
                  <Button
                    onClick={() => setShowQuestions(false)}
                    variant="outline"
                    className="w-full rounded-full h-10 border"
                  >
                    Close
                  </Button>
                </footer>
              </DialogContent>
            </Dialog>
          )
        })()}
      </div>
    </motion.div>
  )
}
