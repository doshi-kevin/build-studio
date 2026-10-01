// Post-session report (#54/#55/#56) — the professor's "how did class go"
// view. Fetches (or lazily generates) the stored report via
// getOrGenerateSessionReport, polling while another request is building
// it. All numbers are precomputed server-side; this only renders.

'use client'

import { useEffect, useMemo, useState } from 'react'
import { Cell, Pie, PieChart } from 'recharts'
import {
  AlertTriangle,
  ArrowUpDown,
  BarChart3,
  CheckCircle2,
  Clock,
  FileText,
  Layers,
  Loader2,
  MessageCircleQuestion,
  RefreshCw,
  Bot,
  UserCheck,
  Users,
  UserX,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AnimatedList, AnimatedItem } from '@/components/ui/animated-list'
import { ProgressBar } from '@/components/live-classroom/shared/ProgressBar'
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart'
import { MarkdownLatex } from '@/components/shared/MarkdownLatex'
import { getOrGenerateSessionReport } from '@/lib/live-classroom/report/actions'
import { logger } from '@/lib/logger'
import { RecordingSection } from '@/components/live-classroom/shared/RecordingPlayer'
import type {
  SessionReport,
  ReportConceptStat,
  ReportQuiz,
  ReportStudent,
} from '@/lib/live-classroom/report/compute'

// Semantic accuracy color: ≥80% success, ≥50% warning, else destructive.
// Mirrors the analytics charts (SkillPerformanceChart) so coloring is
// consistent across the app.
function accuracyColor(accuracy: number): string {
  if (accuracy >= 80) return 'var(--success)'
  if (accuracy >= 50) return 'var(--warning)'
  return 'var(--destructive)'
}

const GENERATING_POLL_MS = 3000
// Consecutive failed polls tolerated before showing the error state. A phone
// changing networks drops one or two; more than that isn't a blip.
const MAX_POLL_FAILURES = 3

interface Props {
  roomId: string
}

export function SessionReportView({ roomId }: Props) {
  const [report, setReport] = useState<SessionReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retryingNarrative, setRetryingNarrative] = useState(false)
  // Bumped by "Try again" to re-run the fetch effect.
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    // A rejected fetch used to escape `run` uncaught, so the re-arm below never
    // ran and the poll died silently — leaving the spinner up forever, since a
    // dead poll is indistinguishable from "still generating". Tolerate blips,
    // then fall through to the error state, which offers a retry.
    let consecutiveFailures = 0
    // Polls while another request holds the generation lock server-side.
    const run = async () => {
      try {
        const result = await getOrGenerateSessionReport(roomId)
        if (cancelled) return
        consecutiveFailures = 0
        if (result.generating) {
          timer = setTimeout(() => void run(), GENERATING_POLL_MS)
          return
        }
        if (result.error || !result.report) {
          setError(result.error ?? 'Failed to load the report')
          return
        }
        setReport(result.report)
      } catch (err) {
        if (cancelled) return
        consecutiveFailures++
        logger.error('SessionReportView.poll', err)
        if (consecutiveFailures >= MAX_POLL_FAILURES) {
          setError('Check your connection and try again.')
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

  const retryNarrative = async () => {
    setRetryingNarrative(true)
    const result = await getOrGenerateSessionReport(roomId, { retryNarrative: true })
    if (result.report) setReport(result.report)
    setRetryingNarrative(false)
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <span className="mb-5 inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
          <AlertTriangle className="h-6 w-6" aria-hidden />
        </span>
        <p className="text-sm font-medium">We couldn&apos;t load this report</p>
        <p className="mt-1 max-w-sm text-xs text-muted-foreground">{error}</p>
        <Button
          variant="outline"
          size="sm"
          className="mt-6 rounded-full"
          onClick={() => {
            setError(null)
            setAttempt((a) => a + 1)
          }}
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Try again
        </Button>
      </div>
    )
  }

  if (!report) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-24">
        <Loader2 className="h-7 w-7 animate-spin text-muted-foreground" />
        <div className="text-center">
          <p className="text-sm font-medium">Building your class report…</p>
          <p className="text-xs text-muted-foreground mt-1">
            Crunching attendance, quiz results, and the lecture transcript.
          </p>
        </div>
      </div>
    )
  }

  if (report.empty) {
    return (
      <div className="space-y-8">
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <span className="mb-5 inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
            <FileText className="h-6 w-6" aria-hidden />
          </span>
          <p className="text-sm font-medium">Not enough data for a report</p>
          <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">
            Nobody joined this session, and it ended with no slides shown, nothing
            transcribed, and no quizzes, polls or questions.
          </p>
        </div>
        {/* A recorded session with no other activity still has a replay to offer
            (renders nothing when no recording exists). */}
        <RecordingSection roomId={roomId} />
      </div>
    )
  }

  const { meta, attendance, participation, quizzes, polls, students, qa, struggleConcepts } = report
  /* Reports persisted before `qa.answered` existed only carry `qa.top`, which was
     truncated to 5 before being filtered — the bug. New reports carry the full
     list; old ones fall back to the old derivation rather than rendering nothing. */
  const answeredQuestions = qa.answered ?? qa.top.filter((q) => q.answered)

  return (
    <AnimatedList className="space-y-8" stagger={0.06}>
      {/* Stat cards */}
      <AnimatedItem className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <StatCard
          icon={Clock}
          label="Duration"
          value={formatDuration(meta.durationMinutes)}
          /* "8 of 20 slides" beats "20 slides": the first says how far the class got,
             the second only how long the file is. slidesShown is null when the deck
             was never advanced, and then there is nothing honest to report but the
             total. (#563) */
          detail={
            meta.slideCount
              ? `${meta.slidesShown != null ? `${meta.slidesShown} of ${meta.slideCount}` : meta.slideCount} slides${
                  meta.deckCount > 1 ? ` · ${meta.deckCount} decks` : ''
                }`
              : 'No deck'
          }
        />
        <StatCard
          icon={UserCheck}
          label="Attendance"
          value={attendance.tracked ? `${attendance.attendedCount}/${attendance.enrolledCount}` : '—'}
          /* A tracked session with nobody in it reads as a real zero, not as missing data
             (#645 part 2). "0% of enrolled" is a fact about the class; "Not tracked" is a
             statement about our records, and showing the wrong one misinforms. */
          detail={attendance.tracked ? `${attendance.rate}% of enrolled` : 'Not tracked'}
        />
        <StatCard
          icon={Users}
          label="Active participation"
          value={`${participation.activeCount}/${participation.enrolledCount}`}
          detail="answered or asked"
        />
        <StatCard
          icon={BarChart3}
          label="Quizzes & polls"
          value={String(quizzes.length + polls.length)}
          detail={`${quizzes.length} quiz${quizzes.length === 1 ? '' : 'zes'} · ${polls.length} poll${polls.length === 1 ? '' : 's'}`}
        />
        <StatCard
          icon={MessageCircleQuestion}
          label="Questions"
          value={String(qa.total)}
          detail={qa.total > 0 ? `${qa.answeredCount} answered` : 'none asked'}
        />
      </AnimatedItem>

      {/* AI narrative */}
      <AnimatedItem>
        <section className="rounded-2xl border border-border bg-card p-6">
          <div className="flex items-center justify-between gap-3 mb-4">
            <SectionLabel icon={Bot}>How the class went</SectionLabel>
            {report.narrativeFailed && (
              <Button variant="outline" size="sm" onClick={retryNarrative} disabled={retryingNarrative}>
                {retryingNarrative ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                Retry summary
              </Button>
            )}
          </div>
          {report.aiNarrative ? (
            <MarkdownLatex content={report.aiNarrative} />
          ) : (
            <p className="text-sm text-muted-foreground italic">
              {report.narrativeFailed
                ? 'The written summary couldn’t be generated — the numbers below are unaffected.'
                : /* Reachable for a whole class now that a transcript-less session gets a
                     report at all (#563), so say WHY rather than just that it is missing.
                     "Turn transcription on" is something the professor can act on; "no
                     written summary" leaves them guessing whether it failed. */
                  meta.slidesWithTranscript === 0
                  ? 'Nothing was transcribed in this session, so there’s no written summary. Turn on transcription to get one next time — everything below is unaffected.'
                  : 'No written summary for this session.'}
            </p>
          )}
        </section>
      </AnimatedItem>

      {/* Recording — reconstructed replay of the broadcast (hidden if none) */}
      <AnimatedItem>
        <RecordingSection roomId={roomId} />
      </AnimatedItem>

      {/* Decks — per-file breakdown when a session spanned more than one */}
      {meta.deckCount > 1 && (
        <AnimatedItem>
          <section className="space-y-2.5">
            <SectionLabel icon={Layers}>Decks presented</SectionLabel>
            {report.decks.map((d) => (
              <div
                key={d.id}
                className="flex items-center gap-3 rounded-2xl border border-border bg-card p-3.5"
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold tabular-nums text-muted-foreground">
                  {d.position}
                </span>
                <p className="flex-1 min-w-0 truncate text-sm font-medium">
                  {d.title?.trim() || `Deck ${d.position}`}
                </p>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {d.slidesShown != null ? `${d.slidesShown} of ${d.pageCount ?? 0}` : (d.pageCount ?? 0)} slides ·{' '}
                  {d.slidesWithTranscript} transcribed
                </span>
              </div>
            ))}
          </section>
        </AnimatedItem>
      )}

      {/* Struggle concepts */}
      {struggleConcepts.length > 0 && (
        <AnimatedItem>
          <section className="space-y-2.5">
            <SectionLabel icon={AlertTriangle}>Worth revisiting</SectionLabel>
            {struggleConcepts.map((c) => (
              <ConceptBar key={c.concept} concept={c} highlight />
            ))}
          </section>
        </AnimatedItem>
      )}

      {/* Attendance */}
      <AnimatedItem>
        <section className="space-y-3">
          <SectionLabel icon={UserCheck}>Attendance</SectionLabel>
          {/* Only for genuinely un-captured sessions now — a zero-attendance class falls
              through to the normal table, which already lists everyone as Absent. */}
          {!attendance.tracked ? (
            <p className="text-sm text-muted-foreground">
              Attendance wasn&apos;t tracked for this session.
            </p>
          ) : (
            <>
              <AttendanceDonut attendance={attendance} />
              <div className="flex flex-wrap gap-1.5">
                {attendance.attendees.map((a) => (
                  <span
                    key={a.id}
                    title={`Joined ${formatTime(a.joinedAt)} · ~${a.minutes} min in class`}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-xs"
                  >
                    <span className="max-w-[18ch] truncate font-medium">{a.name}</span>
                    <span className="text-muted-foreground tabular-nums">{a.minutes}m</span>
                    {a.lateJoin && (
                      <span className="rounded-full bg-warning/15 px-1.5 py-px text-xs font-semibold text-warning-muted-foreground">
                        late
                      </span>
                    )}
                  </span>
                ))}
              </div>
              {attendance.absent.length > 0 && (
                <div>
                  <p className="flex items-center gap-1.5 text-xs uppercase tracking-widest font-semibold text-muted-foreground mb-1.5">
                    <UserX className="h-3 w-3" aria-hidden />
                    Absent ({attendance.absent.length})
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {attendance.absent.map((s) => (
                      <span
                        key={s.id}
                        className="inline-flex max-w-[18ch] items-center truncate rounded-full border border-border bg-background px-2 py-0.5 text-xs text-muted-foreground"
                      >
                        {s.name}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </section>
      </AnimatedItem>

      {/* Per-student performance */}
      {students.length > 0 && (
        <AnimatedItem>
          <section className="space-y-3">
            <SectionLabel icon={Users}>Per-student performance</SectionLabel>
            <StudentTable students={students} hasQuizzes={quizzes.length > 0} />
          </section>
        </AnimatedItem>
      )}

      {/* Quizzes */}
      {quizzes.length > 0 && (
        <AnimatedItem>
          <section className="space-y-3">
            <SectionLabel icon={BarChart3}>Quizzes</SectionLabel>
            {quizzes.map((quiz) => (
              <QuizCard key={quiz.interactionId} quiz={quiz} />
            ))}
          </section>
        </AnimatedItem>
      )}

      {/* Polls */}
      {polls.length > 0 && (
        <AnimatedItem>
          <section className="space-y-3">
            <SectionLabel icon={BarChart3}>Polls</SectionLabel>
            {polls.map((poll) => (
              <div key={poll.interactionId} className="rounded-2xl border border-border bg-card p-5">
                <p className="text-sm font-semibold">{poll.question}</p>
                <p className="text-xs text-muted-foreground mt-0.5 mb-3">
                  {poll.total} {poll.total === 1 ? 'response' : 'responses'}
                </p>
                <div className="space-y-2">
                  {poll.choices.map((choice) => {
                    const share = poll.total > 0 ? Math.round((choice.count / poll.total) * 100) : 0
                    return (
                      <div key={choice.id}>
                        <div className="flex items-baseline justify-between gap-3 text-xs mb-1">
                          <span className="truncate">{choice.text}</span>
                          <span className="shrink-0 text-muted-foreground tabular-nums">
                            {choice.count} · {share}%
                          </span>
                        </div>
                        <ProgressBar value={share} className="bg-primary" />
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </section>
        </AnimatedItem>
      )}

      {/* Q&A */}
      {qa.total > 0 && (
        <AnimatedItem>
          <section className="space-y-3">
            <SectionLabel icon={MessageCircleQuestion}>Student questions</SectionLabel>
            {qa.unanswered.length > 0 && (
              <div className="rounded-2xl border border-warning/30 bg-warning/5 p-5">
                <p className="text-xs font-semibold text-warning-muted-foreground mb-2.5">
                  Still unanswered ({qa.unanswered.length}) — worth addressing next session
                </p>
                <ul className="space-y-2">
                  {qa.unanswered.map((q, i) => (
                    <li key={i} className="flex items-baseline gap-2 text-sm">
                      <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                        {q.upvotes > 0 ? `▲ ${q.upvotes}` : '·'}
                      </span>
                      {q.text}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {answeredQuestions.length > 0 && (
              <div className="rounded-2xl border border-border bg-card p-5">
                <p className="text-xs font-semibold text-muted-foreground mb-2.5">
                  Answered ({answeredQuestions.length})
                </p>
                <ul className="space-y-2">
                  {answeredQuestions.map((q, i) => (
                    <li key={i} className="flex items-baseline gap-2 text-sm">
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0 self-center text-success" aria-hidden />
                      {q.text}
                      {q.upvotes > 0 && (
                        <span className="text-xs text-muted-foreground tabular-nums">▲ {q.upvotes}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        </AnimatedItem>
      )}
    </AnimatedList>
  )
}

// ── Pieces ───────────────────────────────────────────────────────────

function SectionLabel({
  icon: Icon,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>
  children: React.ReactNode
}) {
  return (
    <p className="flex items-center gap-1.5 text-xs uppercase tracking-widest font-semibold text-muted-foreground">
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {children}
    </p>
  )
}

function StatCard({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string
  detail: string
}) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <p className="flex items-center gap-1.5 text-xs uppercase tracking-widest font-semibold text-muted-foreground">
        <Icon className="h-3 w-3" aria-hidden />
        {label}
      </p>
      <p className="text-2xl font-semibold tabular-nums mt-2 leading-none">{value}</p>
      <p className="text-xs text-muted-foreground mt-1.5">{detail}</p>
    </div>
  )
}

function ConceptBar({ concept, highlight = false }: { concept: ReportConceptStat; highlight?: boolean }) {
  // Color the accuracy bar/value red→amber→green so struggle areas read at a glance.
  const color = accuracyColor(concept.correctRate)
  return (
    <div
      className={`rounded-2xl border p-3.5 ${
        highlight ? 'border-foreground/20 bg-foreground/5' : 'border-border bg-card'
      }`}
    >
      <div className="flex items-center gap-3">
        {highlight ? (
          <AlertTriangle className="h-4 w-4 shrink-0 text-foreground/50" aria-hidden />
        ) : (
          <CheckCircle2 className="h-4 w-4 shrink-0 text-foreground/30" aria-hidden />
        )}
        <div className="flex-1 min-w-0">
          <p className={`text-sm leading-tight ${highlight ? 'font-semibold' : 'font-medium text-foreground/70'}`}>
            {concept.concept}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {concept.correctCount} of {concept.totalCount} answers correct
          </p>
        </div>
        <span className="shrink-0 text-sm font-semibold tabular-nums" style={{ color }}>
          {concept.correctRate}%
        </span>
      </div>
      <ProgressBar value={concept.correctRate} color={color} trackClassName="mt-2.5" />
    </div>
  )
}

function QuizCard({ quiz }: { quiz: ReportQuiz }) {
  const weakest = quiz.concepts.slice(0, 3)
  return (
    <div className="rounded-2xl border border-border bg-card p-5">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-semibold truncate">{quiz.title}</p>
        <span className="shrink-0 text-lg font-semibold tabular-nums" style={{ color: accuracyColor(quiz.accuracy) }}>
          {quiz.accuracy}%
        </span>
      </div>
      <p className="text-xs text-muted-foreground mt-0.5">
        {quiz.submissions} {quiz.submissions === 1 ? 'submission' : 'submissions'}
        {quiz.nonResponderCount > 0 && <> · {quiz.nonResponderCount} didn&apos;t answer</>}
      </p>
      {weakest.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-3">
          {weakest.map((c) => (
            <span
              key={c.concept}
              className="inline-flex items-center gap-1 rounded-full bg-muted/50 px-2 py-0.5 text-xs text-muted-foreground"
            >
              {c.concept}
              <span className="font-semibold tabular-nums">{c.correctRate}%</span>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function AttendanceDonut({ attendance }: { attendance: SessionReport['attendance'] }) {
  const lateCount = attendance.attendees.filter((a) => a.lateJoin).length
  const onTime = Math.max(0, attendance.attendedCount - lateCount)
  const absent = Math.max(0, attendance.enrolledCount - attendance.attendedCount)
  const data = [
    { key: 'onTime', label: 'On time', value: onTime, color: 'var(--success)' },
    { key: 'late', label: 'Late', value: lateCount, color: 'var(--warning)' },
    { key: 'absent', label: 'Absent', value: absent, color: 'var(--muted-foreground)' },
  ].filter((d) => d.value > 0)

  if (data.length === 0) return null

  return (
    <div className="flex items-center gap-5 rounded-2xl border border-border bg-card p-4">
      <ChartContainer config={{}} className="h-[120px] w-[120px] shrink-0">
        <PieChart>
          <ChartTooltip content={<ChartTooltipContent nameKey="label" />} />
          <Pie data={data} dataKey="value" nameKey="label" innerRadius={34} outerRadius={56} strokeWidth={2} paddingAngle={2}>
            {data.map((d) => (
              <Cell key={d.key} fill={d.color} />
            ))}
          </Pie>
        </PieChart>
      </ChartContainer>
      <div className="space-y-2">
        <p className="text-2xl font-semibold tabular-nums leading-none">{attendance.rate}%</p>
        <p className="text-xs text-muted-foreground -mt-1">
          {attendance.attendedCount} of {attendance.enrolledCount} attended
        </p>
        <div className="space-y-1 pt-1">
          {data.map((d) => (
            <div key={d.key} className="flex items-center gap-1.5 text-xs">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: d.color }} aria-hidden />
              <span className="text-muted-foreground">{d.label}</span>
              <span className="font-medium tabular-nums">{d.value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

type StudentSortKey = 'name' | 'attended' | 'quizAccuracy' | 'questionsAsked'

function SortableTh({
  k,
  children,
  align = 'left',
  sortKey,
  onToggle,
}: {
  k: StudentSortKey
  children: React.ReactNode
  align?: 'left' | 'right'
  sortKey: StudentSortKey | null
  onToggle: (k: StudentSortKey) => void
}) {
  return (
    <th className={`px-3 py-2 font-semibold ${align === 'right' ? 'text-right' : 'text-left'}`}>
      <button
        type="button"
        onClick={() => onToggle(k)}
        className={`inline-flex items-center gap-1 rounded-full transition-colors hover:text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring ${align === 'right' ? 'flex-row-reverse' : ''}`}
      >
        {children}
        <ArrowUpDown
          className={`h-3 w-3 ${sortKey === k ? 'text-foreground' : 'text-muted-foreground/40'}`}
          aria-hidden
        />
      </button>
    </th>
  )
}

function StudentTable({ students, hasQuizzes }: { students: ReportStudent[]; hasQuizzes: boolean }) {
  // Default order is at-risk-first from the server; let the professor re-sort
  // by any column. `null` accuracy (answered nothing) always sinks to the bottom.
  const [sortKey, setSortKey] = useState<StudentSortKey | null>(null)
  const [asc, setAsc] = useState(false)

  const sorted = useMemo(() => {
    if (!sortKey) return students
    const dir = asc ? 1 : -1
    return [...students].sort((a, b) => {
      switch (sortKey) {
        case 'name':
          return a.name.localeCompare(b.name) * dir
        case 'attended':
          return (Number(a.attended) - Number(b.attended)) * dir
        case 'questionsAsked':
          return (a.questionsAsked - b.questionsAsked) * dir
        case 'quizAccuracy': {
          /* Students with no quiz accuracy sort LAST in both directions. The
             sentinel this replaced (`?? -1`) is a real value, so it was scaled by
             `dir` like any other — floating "no data" to the TOP when ascending,
             which contradicts the nulls-last behaviour descending order showed. */
          if (a.quizAccuracy == null && b.quizAccuracy == null) return 0
          if (a.quizAccuracy == null) return 1
          if (b.quizAccuracy == null) return -1
          return (a.quizAccuracy - b.quizAccuracy) * dir
        }
      }
    })
  }, [students, sortKey, asc])

  const toggleSort = (key: StudentSortKey) => {
    if (sortKey === key) setAsc((v) => !v)
    else {
      setSortKey(key)
      setAsc(false)
    }
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-border">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-border bg-muted/40 text-xs uppercase tracking-widest text-muted-foreground">
            <tr>
              <SortableTh k="name" sortKey={sortKey} onToggle={toggleSort}>Student</SortableTh>
              <SortableTh k="attended" sortKey={sortKey} onToggle={toggleSort}>Attendance</SortableTh>
              {hasQuizzes && (
                <SortableTh k="quizAccuracy" align="right" sortKey={sortKey} onToggle={toggleSort}>
                  Quiz score
                </SortableTh>
              )}
              <SortableTh k="questionsAsked" align="right" sortKey={sortKey} onToggle={toggleSort}>
                Questions
              </SortableTh>
            </tr>
          </thead>
          <tbody>
            {sorted.map((s) => (
              <tr
                key={s.id}
                className={`border-b border-border last:border-0 ${s.atRisk ? 'bg-destructive-muted/30' : ''}`}
              >
                <td className="px-3 py-2.5">
                  <span className="flex items-center gap-2">
                    {s.atRisk && (
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" aria-hidden />
                    )}
                    <span className="max-w-[22ch] truncate font-medium">{s.name}</span>
                  </span>
                </td>
                <td className="px-3 py-2.5 text-muted-foreground">
                  {!s.attended ? (
                    <span className="text-destructive-muted-foreground">Absent</span>
                  ) : (
                    <span className="tabular-nums">
                      {s.minutes}m{s.lateJoin && <span className="ml-1.5 text-warning-muted-foreground">late</span>}
                    </span>
                  )}
                </td>
                {hasQuizzes && (
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {s.quizAccuracy == null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <span className="font-semibold" style={{ color: accuracyColor(s.quizAccuracy) }}>
                        {s.quizAccuracy}%
                      </span>
                    )}
                  </td>
                )}
                <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                  {s.questionsAsked || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Formatting ───────────────────────────────────────────────────────

function formatDuration(minutes: number): string {
  if (minutes < 1) return '<1 min'
  if (minutes < 60) return `${minutes} min`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}
