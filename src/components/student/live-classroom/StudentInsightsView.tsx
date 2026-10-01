// Student Class Insights — fetches the PII-free study blob + the student's own
// numbers via getStudentClassInsights (polling while it generates) and renders:
// lecture summary, how you did vs the class (suppressed when too few answered),
// full quiz review with explanations, focus areas, flashcards, practice quiz.

'use client'

import { useEffect, useState } from 'react'
import { AlertTriangle, BookOpen, GraduationCap, Layers, Loader2, NotebookPen, RefreshCw, Target, Bot } from 'lucide-react'
import { MarkdownLatex } from '@/components/shared/MarkdownLatex'
import { Button } from '@/components/ui/button'
import { AnimatedList, AnimatedItem } from '@/components/ui/animated-list'
import { ProgressBar } from '@/components/live-classroom/shared/ProgressBar'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { FlashcardDeck } from './FlashcardDeck'
import { PracticeQuizPlayer } from './PracticeQuizPlayer'
import { RecordingSection } from '@/components/live-classroom/shared/RecordingPlayer'
import { LiveNotesEditor } from './LiveNotesEditor'
import { useLiveNotes } from '@/lib/live-classroom/notes/use-notes'
import { logger } from '@/lib/logger'
import {
  getStudentClassInsights,
  type StudentInsightsResult,
  type MyQuizResult,
} from '@/lib/live-classroom/insights/student-actions'
import type { StudentInsightQuiz } from '@/lib/validations/lc-class-insights'

const GENERATING_POLL_MS = 3000
// Consecutive failed polls tolerated before we stop waiting. A phone changing
// networks drops one or two; more than that isn't a blip.
const MAX_POLL_FAILURES = 3

function accuracyColor(accuracy: number): string {
  if (accuracy >= 80) return 'var(--success)'
  if (accuracy >= 50) return 'var(--warning)'
  return 'var(--destructive)'
}

export function StudentInsightsView({ roomId }: { roomId: string }) {
  const [result, setResult] = useState<StudentInsightsResult | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    // A rejected fetch used to escape `run` uncaught, so the re-arm below never
    // ran and the poll died silently. `result` stayed null, which renders the
    // same spinner as "still generating" — so the page spun forever with no
    // error and no hint that reloading would fix it. Tolerate blips, then stop
    // waiting: see the catch block for why the two cases differ.
    let consecutiveFailures = 0
    const run = async () => {
      try {
        const res = await getStudentClassInsights(roomId)
        if (cancelled) return
        consecutiveFailures = 0
        setResult(res)
        // Keep polling while it's still generating, OR while the deterministic
        // content is ready but the LLM extras are still being produced.
        const stillWorking = res.status === 'generating' || (res.status === 'ready' && !!res.content?.extrasPending)
        if (stillWorking) timer = setTimeout(() => void run(), GENERATING_POLL_MS)
      } catch (err) {
        if (cancelled) return
        consecutiveFailures++
        logger.error('StudentInsightsView.poll', err)
        if (consecutiveFailures >= MAX_POLL_FAILURES) {
          // Content already on screen? Keep it — the student is reading their quiz
          // review, and only the LLM extras were still outstanding. Clearing
          // extrasPending hides those sections instead of spinning them forever.
          // Nothing rendered yet? Then the error state with its retry is all we have.
          setResult((prev) =>
            prev?.content
              ? { ...prev, content: { ...prev.content, extrasPending: false } }
              : { status: 'error', error: 'Check your connection and try again.' },
          )
          return
        }
        timer = setTimeout(() => void run(), GENERATING_POLL_MS)
      }
    }
    void run()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [roomId, attempt])

  if (!result || result.status === 'generating') {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-24">
        <Loader2 className="h-7 w-7 animate-spin text-muted-foreground" />
        <div className="text-center">
          <p className="text-sm font-medium">Putting together your study pack…</p>
          <p className="text-xs text-muted-foreground mt-1">Summary, flashcards, and a practice quiz from this class.</p>
        </div>
      </div>
    )
  }

  if (result.status === 'error') {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <span className="mb-5 inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
          <AlertTriangle className="h-6 w-6" aria-hidden />
        </span>
        <p className="text-sm font-medium">We couldn&apos;t load your study pack</p>
        <p className="mt-1 max-w-sm text-xs text-muted-foreground">
          {result.error ?? 'Could not load your insights.'}
        </p>
        <Button
          variant="outline"
          size="sm"
          className="mt-6 rounded-full"
          onClick={() => setAttempt((a) => a + 1)}
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Try again
        </Button>
      </div>
    )
  }

  if (result.status === 'empty' || !result.content) {
    return (
      <div className="space-y-8">
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <span className="mb-5 inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
            <BookOpen className="h-6 w-6" aria-hidden />
          </span>
          <p className="text-sm font-medium">Nothing to study here</p>
          <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
            This class ended without enough content to build a study pack.
          </p>
        </div>
        {/* A recorded session with no other activity still has a replay to offer
            (renders nothing when no recording exists). */}
        <RecordingSection roomId={roomId} />
        {/* Even with no AI study pack, the student's own notes are theirs to keep. */}
        <MyNotesSection roomId={roomId} />
      </div>
    )
  }

  const { content } = result
  const myByQuiz = new Map((result.myQuizzes ?? []).map((m) => [m.interactionId, m]))

  return (
    <AnimatedList className="space-y-8" stagger={0.06}>
      {/* No lecture audio captured → AI extras were skipped to avoid hallucination.
          Show one calm note in their place; the deterministic sections still render. */}
      {content.noMaterials && (
        <AnimatedItem>
          <section className="rounded-2xl border border-border bg-card p-6">
            <SectionLabel icon={Bot}>Study pack</SectionLabel>
            <p className="mt-3 text-sm text-muted-foreground">
              No lecture audio was captured for this session, so there&apos;s no AI summary,
              flashcards, or practice quiz.
              {/* "below" has to point at something. This card is only reachable today when
                  the session had interactions, but that is a property of the empty gate in
                  compute-student.ts rather than of this component — so it is checked here
                  instead of assumed, and loosening that gate can't silently strand the
                  sentence. (#563) */}
              {content.quizzes.length > 0 ? ' Your quiz results are below.' : ''}
            </p>
          </section>
        </AnimatedItem>
      )}

      {/* Practice quiz — anchored at the top so it's always one click away and
          opens in its own roomy window instead of stacking down the page. */}
      {!content.noMaterials && content.practiceQuiz?.questions.length ? (
        <AnimatedItem>
          <div className="group flex flex-col items-start gap-3 rounded-2xl border border-border bg-card p-4 transition duration-200 ease-out hover:border-ring/40 hover:shadow-sm sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3 min-w-0">
              <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <GraduationCap className="h-5 w-5" aria-hidden />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold">Practice quiz</p>
                <p className="text-xs text-muted-foreground">
                  Test yourself on this class · {content.practiceQuiz.questions.length} questions · ungraded
                </p>
              </div>
            </div>
            <Dialog>
              <DialogTrigger asChild>
                <Button className="w-full shrink-0 sm:w-auto">
                  <BookOpen className="h-4 w-4" />
                  Start practice quiz
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-3xl max-h-[85vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>Practice quiz</DialogTitle>
                </DialogHeader>
                <PracticeQuizPlayer questions={content.practiceQuiz.questions} />
              </DialogContent>
            </Dialog>
          </div>
        </AnimatedItem>
      ) : !content.noMaterials && content.extrasPending ? (
        <AnimatedItem>
          <Preparing label="Building your practice quiz…" />
        </AnimatedItem>
      ) : null}

      {/* Recording — reconstructed replay of the lecture (hidden if none) */}
      <AnimatedItem>
        <RecordingSection roomId={roomId} />
      </AnimatedItem>

      {/* Lecture summary */}
      {!content.noMaterials && (content.summary || content.extrasPending) && (
        <AnimatedItem>
          <section className="rounded-2xl border border-border bg-card p-6">
            <SectionLabel icon={Bot}>Lecture summary</SectionLabel>
            <div className="mt-3">
              {content.summary ? (
                <MarkdownLatex content={content.summary} />
              ) : (
                <Preparing label="Writing your lecture summary…" />
              )}
            </div>
          </section>
        </AnimatedItem>
      )}

      {/* You vs class + quiz review */}
      {content.quizzes.length > 0 && (
        <AnimatedItem>
          <section className="space-y-3">
            <SectionLabel icon={GraduationCap}>How you did</SectionLabel>
            {content.quizzes.map((quiz) => (
              <QuizReviewCard key={quiz.interactionId} quiz={quiz} mine={myByQuiz.get(quiz.interactionId)} />
            ))}
          </section>
        </AnimatedItem>
      )}

      {/* Focus areas */}
      {content.concepts.some((c) => c.correctRate != null && c.correctRate < 60) && (
        <AnimatedItem>
          <section className="space-y-2.5">
            <SectionLabel icon={Target}>Focus areas</SectionLabel>
            <div className="rounded-2xl border border-border bg-card p-5">
              <p className="text-xs text-muted-foreground mb-3">Concepts the class found hardest — worth a review.</p>
              <div className="flex flex-wrap gap-1.5">
                {content.concepts
                  .filter((c) => c.correctRate != null && c.correctRate < 60)
                  .map((c) => (
                    <span
                      key={c.concept}
                      className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs"
                    >
                      {c.concept}
                      <span className="font-semibold tabular-nums" style={{ color: accuracyColor(c.correctRate!) }}>
                        {c.correctRate}%
                      </span>
                    </span>
                  ))}
              </div>
            </div>
          </section>
        </AnimatedItem>
      )}

      {/* Flashcards */}
      {!content.noMaterials && (content.flashcards?.length || content.extrasPending) ? (
        <AnimatedItem>
          <section className="space-y-3">
            <SectionLabel icon={Layers}>Flashcards</SectionLabel>
            {content.flashcards?.length ? (
              <FlashcardDeck cards={content.flashcards} />
            ) : (
              <Preparing label="Generating flashcards…" />
            )}
          </section>
        </AnimatedItem>
      ) : null}

      {/* The student's own notes from this session — review and extend them. */}
      <AnimatedItem>
        <MyNotesSection roomId={roomId} />
      </AnimatedItem>
    </AnimatedList>
  )
}

// ── Pieces ───────────────────────────────────────────────────────────

// The student's freeform notes from the session. Reuses the same hook +
// editor as the live classroom sidebar, so notes flow straight through to
// review and stay editable here.
function MyNotesSection({ roomId }: { roomId: string }) {
  const notes = useLiveNotes(roomId)
  return (
    <section className="space-y-3">
      <SectionLabel icon={NotebookPen}>Your notes</SectionLabel>
      <LiveNotesEditor
        getInitialContent={notes.getInitialContent}
        onChange={notes.onChange}
        saveState={notes.saveState}
        loaded={notes.loaded}
        variant="page"
      />
    </section>
  )
}

function Preparing({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-2xl border border-border bg-card p-4 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      {label}
    </div>
  )
}

function SectionLabel({ icon: Icon, children }: { icon: React.ComponentType<{ className?: string }>; children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-1.5 text-xs uppercase tracking-widest font-semibold text-muted-foreground">
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {children}
    </p>
  )
}

function QuizReviewCard({ quiz, mine }: { quiz: StudentInsightQuiz; mine?: MyQuizResult }) {
  const [open, setOpen] = useState(false)
  const myAccuracy = mine?.myAccuracy ?? null

  return (
    <div className="rounded-2xl border border-border bg-card p-5">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-semibold truncate">{quiz.title}</p>
        {myAccuracy != null ? (
          <span className="shrink-0 text-lg font-semibold tabular-nums" style={{ color: accuracyColor(myAccuracy) }}>
            {myAccuracy}%
          </span>
        ) : (
          <span className="shrink-0 text-xs text-muted-foreground">You didn&apos;t answer</span>
        )}
      </div>

      {/* You vs class: a bar for your score with the class average marked. */}
      {myAccuracy != null && (
        <div className="mt-3">
          <ProgressBar value={myAccuracy} color={accuracyColor(myAccuracy)} height="h-2">
            {quiz.classAccuracy != null && (
              <span
                title={`Class average ${quiz.classAccuracy}%`}
                className="absolute top-1/2 h-3.5 w-0.5 -translate-y-1/2 bg-foreground"
                style={{ left: `${quiz.classAccuracy}%` }}
                aria-hidden
              />
            )}
          </ProgressBar>
          <p className="mt-1.5 text-xs text-muted-foreground">
            You: {mine?.myCorrect}/{mine?.myTotal} correct
            {quiz.classAccuracy != null ? (
              <> · class average {quiz.classAccuracy}%</>
            ) : (
              <> · not enough classmates answered to compare</>
            )}
          </p>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="mt-3 inline-flex min-h-10 items-center rounded-full py-1.5 text-xs font-medium text-primary hover:underline outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {open ? 'Hide review' : 'Review questions & explanations'}
      </button>

      {open && (
        <div className="mt-3 space-y-3 border-t border-border pt-3">
          {quiz.questions.map((q, i) => {
            const myChoice = mine?.myAnswers?.[q.id]
            return (
              <div key={q.id} className="text-sm">
                <div className="flex gap-2">
                  <span className="tabular-nums text-muted-foreground">{i + 1}.</span>
                  <div className="flex-1 space-y-1.5">
                    <div className="font-medium">
                      <MarkdownLatex content={q.prompt} />
                    </div>
                    <div className="space-y-1">
                      {q.choices.map((c) => {
                        const isCorrect = c.id === q.correctChoiceId
                        const isMine = c.id === myChoice
                        return (
                          <div
                            key={c.id}
                            className={`rounded-xl border px-2.5 py-1.5 text-xs ${
                              isCorrect
                                ? 'border-success bg-success-muted/40'
                                : isMine
                                  ? 'border-destructive bg-destructive-muted/40'
                                  : 'border-border'
                            }`}
                          >
                            {c.text}
                            {isCorrect && <span className="ml-1.5 font-semibold text-success-muted-foreground">correct</span>}
                            {isMine && !isCorrect && <span className="ml-1.5 font-semibold text-destructive-muted-foreground">your answer</span>}
                          </div>
                        )
                      })}
                    </div>
                    {q.explanation && (
                      <div className="text-xs text-muted-foreground">
                        <MarkdownLatex content={q.explanation} />
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
