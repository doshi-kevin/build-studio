// Per-student submission detail page — shows score header, question-by-question
// answer review, proctoring summary, and filterable activity event timeline
// all on a single page. Professors navigate here from the submissions list.
'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  Loader2,
  Award,
  Clock,
  CheckCircle2,
  XCircle,
  Minus,
  Keyboard,
  Copy,
  Clipboard,
  Scissors,
  EyeOff,
  Eye,
  AlertTriangle,
  Filter,
  Timer,
  Hash,
  TrendingUp,
  Pencil,
  Check,
  X,
  Users,
  Smartphone,
} from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { NumericInput } from '@/components/ui/numeric-input'
import { PageHeader } from '@/components/professor/PageHeader'
import { MarkdownLatex } from '@/components/shared/MarkdownLatex'
import { blankPlaceholderText } from '@/lib/quiz/fill-in-blank'
import {
  getQuizById,
  getStudentAttemptDetail,
  overrideAnswerScore,
  type StudentAttemptDetail,
  type StudentAnswerDetail,
} from '@/app/(dashboard)/professor/courses/[sectionId]/quizzes/actions'
import type { ProctoringEvent, ProctoringSummary } from '@/lib/validations/proctoring'
import {
  MOD_CTRL,
  MOD_SHIFT,
  MOD_ALT,
  MOD_META,
  PROCTORING_EVENT_TYPE_LABELS,
} from '@/lib/validations/proctoring'

interface StudentSubmissionPageProps {
  sectionId: string
  quizId: string
  attemptId: string
}

// ── Helpers ─────────────────────────────────────────────────────

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return s > 0 ? `${m}m ${s}s` : `${m}m`
}

function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

function formatModifiers(mod?: number): string {
  if (!mod) return ''
  const parts: string[] = []
  if (mod & MOD_META) parts.push('Cmd')
  if (mod & MOD_CTRL) parts.push('Ctrl')
  if (mod & MOD_ALT) parts.push('Alt')
  if (mod & MOD_SHIFT) parts.push('Shift')
  return parts.join('+')
}

const MODIFIER_KEY_NAMES = new Set(['Meta', 'Control', 'Alt', 'Shift'])

function formatKeyCombo(event: ProctoringEvent): string {
  if (event.type !== 'kd') return ''
  const mods = formatModifiers(event.mod)
  const key = event.key ?? ''
  if (MODIFIER_KEY_NAMES.has(key)) return mods || key
  if (!mods) return key
  return `${mods}+${key}`
}

function getEventIcon(type: string) {
  switch (type) {
    case 'kd': return <Keyboard className="h-3.5 w-3.5" />
    case 'cp': return <Copy className="h-3.5 w-3.5 text-warning-muted-foreground" />
    case 'ps': return <Clipboard className="h-3.5 w-3.5 text-warning-muted-foreground" />
    case 'ct': return <Scissors className="h-3.5 w-3.5 text-warning-muted-foreground" />
    case 'bl': return <EyeOff className="h-3.5 w-3.5 text-warning-muted-foreground" />
    case 'fc': return <Eye className="h-3.5 w-3.5 text-success-muted-foreground" />
    case 'mf': return <Users className="h-3.5 w-3.5 text-warning-muted-foreground" />
    case 'ph': return <Smartphone className="h-3.5 w-3.5 text-destructive" />
    default: return <Keyboard className="h-3.5 w-3.5" />
  }
}

function isSuspiciousEvent(event: ProctoringEvent): boolean {
  return event.type === 'cp' || event.type === 'ps' || event.type === 'bl' ||
    event.type === 'mf' || event.type === 'ph'
}

function formatQuestionType(type: string): string {
  switch (type) {
    case 'multiple_choice': return 'MCQ'
    case 'multi_select': return 'Multi-Select'
    case 'true_false': return 'True/False'
    case 'short_answer': return 'Short Answer'
    case 'fill_in_blank': return 'Fill in Blank'
    default: return type.replace(/_/g, ' ')
  }
}

// ── Answer Helpers ──────────────────────────────────────────────

function CorrectnessIcon({ isCorrect }: { isCorrect: boolean | null }) {
  if (isCorrect === true) return <CheckCircle2 className="h-5 w-5 text-success-muted-foreground shrink-0" />
  if (isCorrect === false) return <XCircle className="h-5 w-5 text-destructive shrink-0" />
  return <Minus className="h-5 w-5 text-muted-foreground shrink-0" />
}

function getStudentAnswerText(answer: StudentAnswerDetail): string {
  const content = answer.content
  if (!content) return '(no answer)'

  switch (content.questionType) {
    case 'multiple_choice':
    case 'multi_select': {
      if (!answer.selectedChoiceIds || answer.selectedChoiceIds.length === 0) return '(no answer)'
      const choices = content.choices ?? []
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const selected = choices.filter((c: any) => answer.selectedChoiceIds?.includes(c.id))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return selected.map((c: any) => c.text).join(', ') || '(no answer)'
    }
    case 'true_false':
      if (answer.booleanAnswer === undefined) return '(no answer)'
      return answer.booleanAnswer ? 'True' : 'False'
    case 'short_answer':
      return answer.textAnswer?.trim() || '(no answer)'
    case 'fill_in_blank': {
      if (!answer.blankAnswers) return '(no answer)'
      const entries = Object.entries(answer.blankAnswers)
      if (entries.length === 0) return '(no answer)'
      return entries.map(([k, v]) => `${k}: ${v}`).join(', ')
    }
    default:
      return '(no answer)'
  }
}

function getCorrectAnswerText(answer: StudentAnswerDetail): string {
  const content = answer.content
  if (!content) return ''

  switch (content.questionType) {
    case 'multiple_choice': {
      const choices = content.choices ?? []
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const correct = choices.find((c: any) => c.isCorrect)
      return correct?.text ?? ''
    }
    case 'multi_select': {
      const choices = content.choices ?? []
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return choices.filter((c: any) => c.isCorrect).map((c: any) => c.text).join(', ')
    }
    case 'true_false':
      return content.correctAnswer === true ? 'True' : 'False'
    case 'short_answer':
      return (content.acceptedAnswers ?? []).join(' / ')
    case 'fill_in_blank': {
      const blanks = content.blanks ?? []
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return blanks.map((b: any) => `${b.label}: ${(b.acceptedAnswers ?? []).join('/')}`).join(', ')
    }
    default:
      return ''
  }
}

// ── Event Filters ───────────────────────────────────────────────

const EVENT_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'suspicious', label: 'Flagged' },
  { value: 'kd', label: 'Keys' },
  { value: 'clipboard', label: 'Clipboard' },
  { value: 'bl', label: 'Tab Switch' },
  { value: 'mf', label: 'Multi Face' },
  { value: 'ph', label: 'Phone' },
] as const

/** Map compound filter values to matching event types */
function matchesFilter(event: ProctoringEvent, filter: string): boolean {
  if (filter === 'all') return true
  if (filter === 'suspicious') return isSuspiciousEvent(event)
  if (filter === 'clipboard') return event.type === 'cp' || event.type === 'ps' || event.type === 'ct'
  return event.type === filter
}

// ── Sub-Components ──────────────────────────────────────────────

function ScoreCard({ label, value, icon, sub }: {
  label: string
  value: string
  icon: React.ReactNode
  sub?: string
}) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 mb-1">
        {icon}
        <span className="text-xs text-muted-foreground font-medium">{label}</span>
      </div>
      <p className="text-3xl font-semibold tabular-nums">{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
    </Card>
  )
}

function QuestionReviewCard({
  answer,
  index,
  onSaveOverride,
  isSaving,
}: {
  answer: StudentAnswerDetail
  index: number
  /** Resolves true when the override was accepted; false leaves the editor open. */
  onSaveOverride: (questionId: string, pts: number, reason: string) => Promise<boolean>
  isSaving: boolean
}) {
  const studentAnswer = getStudentAnswerText(answer)
  const correctAnswer = getCorrectAnswerText(answer)
  const isUnanswered = studentAnswer === '(no answer)'
  const hasOverride = answer.overridePoints !== null

  const [editing, setEditing] = useState(false)
  // True while the typed override exceeds the question's max — surfaces the clamp (#620).
  const [typedOverMax, setTypedOverMax] = useState(false)
  const [draftPoints, setDraftPoints] = useState<number>(
    answer.overridePoints ?? answer.earnedPoints ?? 0,
  )
  const [draftReason, setDraftReason] = useState(answer.overrideReason ?? '')

  const borderColor = hasOverride
    ? 'border-warning/40'
    : answer.isCorrect === true
      ? 'border-success/40'
      : answer.isCorrect === false
        ? 'border-destructive/40'
        : 'border-border'

  const bgColor =
    answer.isCorrect === true
      ? 'bg-success-muted/40'
      : answer.isCorrect === false
        ? 'bg-destructive-muted/40'
        : ''

  const displayedPoints = answer.overridePoints ?? answer.earnedPoints ?? 0

  return (
    <div className={`py-4 px-4 border rounded-xl mb-3 ${borderColor} ${bgColor}`}>
      <div className="flex items-start gap-3">
        <CorrectnessIcon isCorrect={answer.isCorrect} />
        <div className="flex-1 min-w-0">
          {/* Question meta row */}
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-xs font-bold text-muted-foreground">Q{index + 1}</span>
            <Badge variant="outline" className="text-[10px] font-medium">
              {formatQuestionType(answer.questionType)}
            </Badge>
            <div className="flex items-center gap-2 ml-auto">
              {hasOverride && (
                <Badge variant="secondary" className="text-[10px] bg-warning-muted text-warning-muted-foreground">
                  Overridden
                </Badge>
              )}
              <span className="text-xs font-semibold tabular-nums">
                {displayedPoints}/{answer.points} pts
              </span>
              {!editing && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  title="Override score"
                  onClick={() => {
                    setDraftPoints(answer.overridePoints ?? answer.earnedPoints ?? 0)
                    setDraftReason(answer.overrideReason ?? '')
                    setTypedOverMax(false)
                    setEditing(true)
                  }}
                >
                  <Pencil className="h-3 w-3" />
                </Button>
              )}
            </div>
          </div>

          {/* Question text */}
          <MarkdownLatex content={blankPlaceholderText(answer.questionText)} className="text-sm font-medium mb-3" />

          {/* Override inline editor */}
          {editing && (
            <div className="mb-3 p-3 rounded-xl border bg-muted/30 space-y-2">
              <p className="text-xs font-semibold text-muted-foreground">Override Score</p>
              <div className="flex items-center gap-2">
                <NumericInput
                  min={0}
                  max={answer.points}
                  className="h-8 w-24 text-sm"
                  value={draftPoints}
                  onChange={(v) => setDraftPoints(parseFloat(v) || 0)}
                  /* NumericInput clamps to max on commit, so typing 10 on a 2-point question
                     silently became 2 — the professor could walk away believing they awarded
                     10 (#620). Watch the RAW keystrokes so we can say so; onChange only ever
                     sees the already-clamped value. */
                  onLiveChange={(raw) => setTypedOverMax(Number(raw) > answer.points)}
                />
                <span className="text-xs text-muted-foreground">/ {answer.points} pts max</span>
              </div>
              {typedOverMax && (
                <p role="status" className="text-xs font-medium text-warning-muted-foreground">
                  A question can&apos;t be worth more than its {answer.points} points — your
                  value will be set to {answer.points}.
                </p>
              )}
              <Input
                placeholder="Reason (optional)"
                className="h-8 text-sm"
                value={draftReason}
                onChange={(e) => setDraftReason(e.target.value)}
              />
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  className="h-7 text-xs"
                  disabled={isSaving}
                  onClick={async () => {
                    if (await onSaveOverride(answer.questionId, draftPoints, draftReason)) {
                      setEditing(false)
                    }
                  }}
                >
                  {isSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3 mr-1" />}
                  Save
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setEditing(false)}
                >
                  <X className="h-3 w-3 mr-1" />
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {/* Override reason badge */}
          {hasOverride && answer.overrideReason && !editing && (
            <p className="text-[11px] text-warning-muted-foreground mb-2 italic">
              Override reason: {answer.overrideReason}
            </p>
          )}

          {/* Student answer */}
          <div className="rounded-xl border p-3 mb-2 space-y-2">
            <div>
              <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-0.5">
                Student&apos;s Answer
              </p>
              <p className={`text-sm ${
                isUnanswered
                  ? 'text-muted-foreground italic'
                  : answer.isCorrect === false
                    ? 'text-destructive'
                    : answer.isCorrect === true
                      ? 'text-success-muted-foreground'
                      : ''
              }`}>
                {studentAnswer}
              </p>
            </div>

            {/* Always show correct answer so professor can compare */}
            {correctAnswer && (
              <div className="pt-2 border-t">
                <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-0.5">
                  Correct Answer
                </p>
                <p className="text-sm text-success-muted-foreground">{correctAnswer}</p>
              </div>
            )}
          </div>

          {/* Explanation */}
          {answer.explanation && (
            <MarkdownLatex content={answer.explanation} variant="compact" className="text-xs text-muted-foreground italic leading-relaxed" />
          )}

          {/* Adaptive grading detail — only present for adaptive attempts.
              Standard attempts have all these null, so nothing renders. */}
          {(answer.softScore != null || answer.rationale || (answer.nodesTotal ?? 0) > 0 || answer.misconceptionNode) && (
            <div className="mt-2 space-y-1.5 rounded-xl bg-muted/50 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Adaptive grading</span>
                {answer.softScore != null && (
                  <Badge variant="outline" className="text-[10px] tabular-nums">soft score {Math.round(answer.softScore * 100)}%</Badge>
                )}
                {(answer.nodesTotal ?? 0) > 0 && (
                  <span className="text-[11px] tabular-nums text-muted-foreground">{answer.nodesMet} of {answer.nodesTotal} key ideas covered</span>
                )}
              </div>
              {answer.rationale && <p className="text-sm text-foreground">{answer.rationale}</p>}
              {answer.misconceptionNode && (
                <div className="flex items-start gap-1.5">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning-muted-foreground" />
                  <MarkdownLatex content={answer.misconceptionNode} variant="compact" className="text-[11px] text-muted-foreground" />
                </div>
              )}
            </div>
          )}

          {/* Walkthrough transcript — the server-authoritative tutor conversation
              that was graded into θ̂ (guided-walkthrough items). */}
          {answer.walkthroughTranscript && answer.walkthroughTranscript.length > 0 && (
            <div className="mt-2 rounded-xl border border-border p-3">
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Walkthrough transcript</p>
              <div className="max-h-64 space-y-1.5 overflow-y-auto">
                {answer.walkthroughTranscript.map((turn, i) => (
                  <div key={i} className="text-xs leading-relaxed">
                    <span className="font-semibold text-muted-foreground">{turn.role === 'tutor' ? 'Tutor' : 'Student'}: </span>
                    <span className="text-foreground">{turn.text}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function StatPill({ icon, label, value, warn }: {
  icon: React.ReactNode
  label: string
  value: number
  warn?: boolean
}) {
  return (
    <div className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs ${
      warn ? 'bg-warning-muted text-warning-muted-foreground font-medium' : 'bg-muted/60'
    }`}>
      {icon}
      <span className={warn ? '' : 'text-muted-foreground'}>{label}</span>
      <span className="font-bold tabular-nums">{value}</span>
    </div>
  )
}

function ProctoringStatsCards({ summary }: { summary: ProctoringSummary }) {
  const hasVideoStats = summary.multipleFaceCount > 0 || summary.phoneDetectedCount > 0 || summary.webcamDenied

  return (
    <Card className="p-4 space-y-3">
      {/* Keyboard & Clipboard row */}
      <div>
        <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">Keyboard & Clipboard</p>
        <div className="flex flex-wrap gap-2">
          <StatPill icon={<Keyboard className="h-3.5 w-3.5" />} label="Keys" value={summary.totalKeystrokes} />
          <StatPill icon={<Copy className="h-3.5 w-3.5" />} label="Copy" value={summary.copyCount} warn={summary.copyCount > 0} />
          <StatPill icon={<Clipboard className="h-3.5 w-3.5" />} label="Paste" value={summary.pasteCount} warn={summary.pasteCount > 0} />
          <StatPill icon={<Scissors className="h-3.5 w-3.5" />} label="Cut" value={summary.cutCount} warn={summary.cutCount > 0} />
          <StatPill icon={<EyeOff className="h-3.5 w-3.5" />} label="Tab Switches" value={summary.tabSwitchCount} warn={summary.tabSwitchCount > 2} />
        </div>
      </div>

      {/* Video proctoring row */}
      {hasVideoStats && (
        <div>
          <div className="flex items-center gap-2 mb-2">
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Camera & Vision</p>
            {summary.webcamDenied && (
              <Badge variant="secondary" className="text-[10px] bg-destructive-muted text-destructive-muted-foreground">
                <AlertTriangle className="h-2.5 w-2.5 mr-0.5" /> Camera Denied
              </Badge>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <StatPill icon={<Users className="h-3.5 w-3.5 text-warning-muted-foreground" />} label="Multi Face" value={summary.multipleFaceCount} warn={summary.multipleFaceCount > 0} />
            <StatPill icon={<Smartphone className="h-3.5 w-3.5 text-destructive" />} label="Phone" value={summary.phoneDetectedCount} warn={summary.phoneDetectedCount > 0} />
          </div>
        </div>
      )}
    </Card>
  )
}

// ── Main Component ──────────────────────────────────────────────

export function StudentSubmissionPage({ sectionId, quizId, attemptId }: StudentSubmissionPageProps) {
  const router = useRouter()
  const [data, setData] = useState<StudentAttemptDetail | null>(null)
  const [quizTitle, setQuizTitle] = useState('')
  const [timeLimitMinutes, setTimeLimitMinutes] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [savingOverride, setSavingOverride] = useState<string | null>(null)
  // Default to suspicious-only so professor sees what matters first
  const [eventFilter, setEventFilter] = useState<string>('suspicious')

  useEffect(() => {
    async function load() {
      const [attemptResult, quizResult] = await Promise.all([
        getStudentAttemptDetail(sectionId, attemptId),
        getQuizById(sectionId, quizId),
      ])

      if (attemptResult.error || !attemptResult.data) {
        toast.error(attemptResult.error || 'Attempt not found')
        router.push(`/professor/courses/${sectionId}/quizzes/${quizId}/insights?tab=submissions`)
        return
      }

      setData(attemptResult.data)
      setQuizTitle(quizResult.data?.title ?? 'Quiz')
      setTimeLimitMinutes(quizResult.data?.timeLimitMinutes ?? null)
      setLoading(false)
    }
    load()
  }, [sectionId, quizId, attemptId, router])

  const handleSaveOverride = useCallback(async (
    questionId: string,
    overridePoints: number,
    overrideReason: string,
  ) => {
    setSavingOverride(questionId)
    try {
      const result = await overrideAnswerScore(sectionId, attemptId, questionId, {
        overridePoints,
        overrideReason,
      })
      if (result.error) {
        toast.error(result.error)
        // false → the editor stays open with the typed value intact, so a rejected
        // override (e.g. above the question's max points) can be corrected rather
        // than retyped from scratch (#311).
        return false
      }
      toast.success('Score updated')
      setData((prev) =>
        prev
          ? {
              ...prev,
              score: result.newScore ?? prev.score,
              earnedPoints: result.newEarnedPoints ?? prev.earnedPoints,
              answers: prev.answers.map((a) =>
                a.questionId === questionId
                  ? { ...a, overridePoints, overrideReason: overrideReason || null }
                  : a,
              ),
            }
          : prev,
      )
      return true
    } finally {
      setSavingOverride(null)
    }
  }, [sectionId, attemptId])

  const filteredEvents = useMemo(() => {
    if (!data) return []
    return data.proctoringEvents.filter((e) => matchesFilter(e, eventFilter))
  }, [data, eventFilter])

  if (loading || !data) {
    return (
      <div className="space-y-8">
        <Skeleton className="h-4 w-48 rounded-full" />
        <div className="space-y-2">
          <Skeleton className="h-8 w-56 rounded-xl" />
          <Skeleton className="h-4 w-40 rounded-full" />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24 w-full rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-48 w-full rounded-xl" />
      </div>
    )
  }

  const correctCount = data.answers.filter((a) => a.isCorrect === true).length
  const incorrectCount = data.answers.filter((a) => a.isCorrect === false).length
  const unanswered = data.answers.filter((a) => a.isCorrect === null).length
  const summary = data.proctoringSummary
  const hasSuspicious = summary && summary.suspiciousFlags.length > 0

  const timeRemainingAtSubmit = (() => {
    if (timeLimitMinutes == null) return null
    const totalAllowed = timeLimitMinutes * 60
    return Math.max(0, totalAllowed - data.timeSpentSeconds)
  })()

  const scoreColor =
    (data.score ?? 0) >= 80
      ? 'text-success-muted-foreground'
      : (data.score ?? 0) >= 60
        ? 'text-warning-muted-foreground'
        : 'text-destructive'

  return (
    <div className="space-y-8">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-1.5 text-xs text-muted-foreground flex-wrap">
        <Link href={`/professor/courses/${sectionId}/grades`} className="hover:text-foreground transition-colors">
          Grades
        </Link>
        <span className="opacity-40">/</span>
        <Link href={`/professor/courses/${sectionId}/grades/student/${data.studentId}`} className="hover:text-foreground transition-colors">
          {data.studentName}
        </Link>
        <span className="opacity-40">/</span>
        <span className="text-foreground font-medium truncate">{quizTitle}</span>
      </nav>

      {/* Student name + quiz title */}
      <PageHeader title={data.studentName} description={quizTitle} />

      {/* ─── Score & Time Summary Cards ─────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <ScoreCard
          label="Score"
          value={data.score != null ? `${data.score}%` : '\u2014'}
          icon={<Award className={`h-4 w-4 ${scoreColor}`} />}
          /* Always floored at 0, matching the % above it (#620).
             quiz_attempts.earned_points is written by two paths that disagreed: grading
             stores the TRUE raw sum, which negative marking can push below zero, while
             overrideAnswerScore stores a floored one. So this label meant "raw sum" until
             the first override and "floored sum" afterwards — the same text silently
             changing convention. Flooring here always is the honest reading, because the
             percentage beside it is computed from the floored value too. */
          sub={data.earnedPoints != null && data.totalPoints != null
            ? `${Math.max(0, data.earnedPoints)} / ${data.totalPoints} points`
            : undefined}
        />
        <ScoreCard
          label="Time Used"
          value={formatDuration(data.timeSpentSeconds)}
          icon={<Clock className="h-4 w-4 text-muted-foreground" />}
          sub={timeLimitMinutes != null
            ? `of ${formatDuration(timeLimitMinutes * 60)} allowed`
            : 'No time limit'}
        />
        <ScoreCard
          label="Time Remaining"
          value={timeRemainingAtSubmit != null
            ? timeRemainingAtSubmit > 0 ? formatDuration(timeRemainingAtSubmit) : 'Expired'
            : '\u2014'}
          icon={<Timer className={`h-4 w-4 ${timeRemainingAtSubmit === 0 ? 'text-destructive' : 'text-muted-foreground'}`} />}
          sub={timeRemainingAtSubmit === 0 ? 'Student ran out of time' : undefined}
        />
        <ScoreCard
          label="Questions"
          value={`${correctCount} / ${data.answers.length}`}
          icon={<Hash className="h-4 w-4 text-muted-foreground" />}
          sub={[
            correctCount > 0 ? `${correctCount} correct` : '',
            incorrectCount > 0 ? `${incorrectCount} wrong` : '',
            unanswered > 0 ? `${unanswered} unanswered` : '',
          ].filter(Boolean).join(', ')}
        />
      </div>

      {/* ─── Proctoring Section ─────────────────────────────── */}
      {summary && (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-base font-semibold">Activity Monitor</h2>
            {hasSuspicious && (
              <Badge variant="secondary" className="bg-destructive-muted text-destructive-muted-foreground text-xs tabular-nums">
                <AlertTriangle className="h-3 w-3 mr-1" />
                {summary.suspiciousFlags.length} flag{summary.suspiciousFlags.length !== 1 ? 's' : ''}
              </Badge>
            )}
          </div>

          <ProctoringStatsCards summary={summary} />

          {hasSuspicious && (
            <Card className="p-4 border-warning/30 bg-warning-muted/40">
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle className="h-4 w-4 text-warning-muted-foreground" />
                <span className="text-sm font-semibold text-warning-muted-foreground">
                  Suspicious Activity Flags
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                {summary.suspiciousFlags.map((flag) => (
                  <Badge
                    key={flag}
                    variant="secondary"
                    className="bg-warning-muted text-warning-muted-foreground"
                  >
                    {flag.replace(/_/g, ' ')}
                  </Badge>
                ))}
              </div>
            </Card>
          )}
        </div>
      )}

      {/* ─── Question-by-Question Answers ───────────────────── */}
      <div className="space-y-4">
        <h2 className="text-base font-semibold">
          Answers ({data.answers.length} questions)
        </h2>
        <div className="space-y-0">
          {data.answers.map((answer, i) => (
            <QuestionReviewCard
              key={answer.questionId}
              answer={answer}
              index={i}
              onSaveOverride={handleSaveOverride}
              isSaving={savingOverride === answer.questionId}
            />
          ))}
        </div>
      </div>

      {/* ─── Activity Event Timeline ────────────────────────── */}
      {data.proctoringEvents.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-base font-semibold">Activity Timeline</h2>
          <Card className="p-5">
            <div className="flex flex-wrap items-center gap-2 mb-4">
              <Filter className="h-3.5 w-3.5 text-muted-foreground" />
              {EVENT_FILTERS.map((f) => {
                const count = data.proctoringEvents.filter((e) => matchesFilter(e, f.value)).length
                if (count === 0 && f.value !== 'all' && f.value !== 'suspicious') return null
                return (
                  <Button
                    key={f.value}
                    variant={eventFilter === f.value ? 'default' : 'outline'}
                    size="sm"
                    className="text-xs h-7 px-2.5 gap-1.5"
                    onClick={() => setEventFilter(f.value)}
                  >
                    {f.label}
                    <span className="text-[10px] opacity-70">({count})</span>
                  </Button>
                )
              })}
            </div>

            {filteredEvents.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">
                No events match this filter.
              </p>
            ) : (
              <div className="max-h-[500px] overflow-y-auto rounded-xl border">
                <div className="grid grid-cols-[56px_130px_1fr_60px] gap-3 py-2 px-3 border-b text-[11px] text-muted-foreground font-semibold uppercase tracking-wide sticky top-0 bg-muted/50 backdrop-blur-sm">
                  <span>Time</span>
                  <span>Event</span>
                  <span>Detail</span>
                  <span>Q #</span>
                </div>

                {filteredEvents.map((event, i) => {
                  const suspicious = isSuspiciousEvent(event)

                  return (
                    <div
                      key={i}
                      className={`grid grid-cols-[56px_130px_1fr_60px] gap-3 py-2 px-3 border-b last:border-0 text-sm ${
                        suspicious ? 'bg-warning-muted/40' : ''
                      }`}
                    >
                      <span className="text-xs text-muted-foreground font-mono tabular-nums">
                        {formatTime(event.t)}
                      </span>
                      <span className="flex items-center gap-1.5">
                        {getEventIcon(event.type)}
                        <span className={`text-xs ${suspicious ? 'font-medium text-warning-muted-foreground' : ''}`}>
                          {PROCTORING_EVENT_TYPE_LABELS[event.type as keyof typeof PROCTORING_EVENT_TYPE_LABELS] ?? event.type}
                        </span>
                      </span>
                      <span className="text-xs font-mono truncate">
                        {event.type === 'kd' ? formatKeyCombo(event) : '\u2014'}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {event.qi !== undefined ? `Q${event.qi + 1}` : '\u2014'}
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  )
}
