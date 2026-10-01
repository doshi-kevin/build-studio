// Unified quiz analytics dashboard — combines analytics overview, time analysis,
// student submissions, and proctoring into a single tabbed view.
// Part of the 3-tier analytics architecture: Grades Hub → Quiz Analytics → Attempt Detail.
'use client'

import { useState, useEffect, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import {
  BarChart3,
  Users,
  Award,
  Target,
  Loader2,
  Pencil,
  Clock,
  Search,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
  Keyboard,
  Copy,
  Clipboard,
  EyeOff,
  MoreVertical,
  RotateCcw,
  ShieldAlert,
  Compass,
} from 'lucide-react'
import Link from 'next/link'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PageHeader } from '@/components/professor/PageHeader'
import { EmptyState } from '@/components/ui/empty-state'
import { MarkdownLatex } from '@/components/shared/MarkdownLatex'
import { blankPlaceholderText } from '@/lib/quiz/fill-in-blank'
import { QuizTimeChart } from './QuizTimeChart'
import { ProctoringDashboard } from './ProctoringDashboard'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  getQuizById,
  getQuizInsights,
  getQuizSubmissions,
  getQuizTimeAnalytics,
  getAdaptiveAnalytics,
  resetStudentAttempt,
  type QuizSubmissionRow,
  type TimeAnalyticsRow,
} from '@/app/(dashboard)/professor/courses/[sectionId]/quizzes/actions'
import type { Quiz, QuizInsights } from '@/lib/validations/quiz'

interface QuizInsightsDashboardProps {
  sectionId: string
  quizId: string
  defaultTab?: string
}

// ── Helpers ──────────────────────────────────────────────────────

type SortKey = 'name' | 'score' | 'time' | 'date'
type SortDir = 'asc' | 'desc'

// Shape returned by getAdaptiveAnalytics (cohort stats + top performers).
type AdaptiveAnalyticsData = Awaited<ReturnType<typeof getAdaptiveAnalytics>>['data']
type CohortStats = NonNullable<NonNullable<AdaptiveAnalyticsData>['adaptive']>

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return s > 0 ? `${m}m ${s}s` : `${m}m`
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

// Semantic score heatmap — mirrors the gradebook (≥80 success, ≥60 warning, else destructive).
function scoreColorClass(score: number): string {
  if (score >= 80) return 'text-success-muted-foreground'
  if (score >= 60) return 'text-warning-muted-foreground'
  return 'text-destructive'
}

// ── Main Component ───────────────────────────────────────────────

export function QuizInsightsDashboard({ sectionId, quizId, defaultTab }: QuizInsightsDashboardProps) {
  const router = useRouter()
  const [quiz, setQuiz] = useState<Quiz | null>(null)
  const [insights, setInsights] = useState<QuizInsights | null>(null)
  const [submissions, setSubmissions] = useState<QuizSubmissionRow[]>([])
  const [timeAnalytics, setTimeAnalytics] = useState<TimeAnalyticsRow[]>([])
  // Adaptive cohort analytics — only populated/shown for adaptive quizzes.
  const [adaptive, setAdaptive] = useState<AdaptiveAnalyticsData>(null)
  const [loading, setLoading] = useState(true)

  // Submissions filter/sort state
  const [sortKey, setSortKey] = useState<SortKey>('date')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [nameFilter, setNameFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'submitted' | 'in_progress'>('all')
  const [flagFilter, setFlagFilter] = useState<'all' | 'flagged' | 'clean'>('all')

  // Reset attempt state
  const [resetTarget, setResetTarget] = useState<{ attemptId: string; studentName: string } | null>(null)
  const [isResetting, setIsResetting] = useState(false)

  useEffect(() => {
    async function load() {
      const [quizResult, insightsResult, subsResult, timeResult, adaptiveResult] = await Promise.all([
        getQuizById(sectionId, quizId),
        getQuizInsights(sectionId, quizId),
        getQuizSubmissions(sectionId, quizId),
        getQuizTimeAnalytics(sectionId, quizId),
        getAdaptiveAnalytics(sectionId, quizId),
      ])

      if (quizResult.error || !quizResult.data) {
        toast.error(quizResult.error || 'Quiz not found')
        router.push(`/professor/courses/${sectionId}/quizzes`)
        return
      }

      setQuiz(quizResult.data)
      if (insightsResult.data) {
        setInsights(insightsResult.data)
      } else if (insightsResult.error) {
        toast.warning('Could not load quiz analytics')
      }
      if (!subsResult.error) setSubmissions(subsResult.data || [])
      if (!timeResult.error) {
        setTimeAnalytics(timeResult.data || [])
      } else {
        toast.warning('Could not load time analytics')
      }
      // Adaptive analytics only render for adaptive quizzes; a failure here is
      // non-blocking (the rest of the dashboard still works).
      if (adaptiveResult.data) setAdaptive(adaptiveResult.data)
      setLoading(false)
    }
    load()
  }, [sectionId, quizId, router])

  // Submissions computed data
  const submitted = useMemo(() => submissions.filter((r) => r.status === 'submitted'), [submissions])
  const inProgress = useMemo(() => submissions.filter((r) => r.status === 'in_progress'), [submissions])

  const avgScore = useMemo(() => {
    if (submitted.length === 0) return 0
    return Math.round(submitted.reduce((sum, r) => sum + (r.score ?? 0), 0) / submitted.length)
  }, [submitted])

  const passRate = useMemo(() => {
    if (!quiz || submitted.length === 0) return 0
    const passCount = submitted.filter((r) => (r.score ?? 0) >= quiz.passThreshold).length
    return Math.round((passCount / submitted.length) * 100)
  }, [submitted, quiz])

  const avgTime = useMemo(() => {
    if (submitted.length === 0) return 0
    return Math.round(submitted.reduce((sum, r) => sum + r.timeSpentSeconds, 0) / submitted.length)
  }, [submitted])

  // Filter + sort submissions
  const filteredSubmissions = useMemo(() => {
    let result = [...submissions]

    if (nameFilter.trim()) {
      const q = nameFilter.toLowerCase()
      result = result.filter((r) => r.studentName.toLowerCase().includes(q))
    }
    if (statusFilter !== 'all') {
      result = result.filter((r) => r.status === statusFilter)
    }
    if (flagFilter === 'flagged') {
      result = result.filter((r) => (r.proctoringSummary?.suspiciousFlags?.length ?? 0) > 0)
    } else if (flagFilter === 'clean') {
      result = result.filter((r) => !(r.proctoringSummary?.suspiciousFlags?.length))
    }

    result.sort((a, b) => {
      let diff = 0
      switch (sortKey) {
        case 'name': diff = a.studentName.localeCompare(b.studentName); break
        case 'score': diff = (a.score ?? -1) - (b.score ?? -1); break
        case 'time': diff = a.timeSpentSeconds - b.timeSpentSeconds; break
        case 'date':
          diff = new Date(a.submittedAt ?? a.startedAt).getTime() - new Date(b.submittedAt ?? b.startedAt).getTime()
          break
      }
      return sortDir === 'asc' ? diff : -diff
    })

    return result
  }, [submissions, nameFilter, statusFilter, flagFilter, sortKey, sortDir])

  function handleSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(key); setSortDir('desc') }
  }

  async function handleResetAttempt() {
    if (!resetTarget) return
    setIsResetting(true)
    const result = await resetStudentAttempt(resetTarget.attemptId, sectionId)
    setIsResetting(false)
    setResetTarget(null)
    if (result.error) {
      toast.error(result.error)
    } else {
      toast.success(`${resetTarget.studentName}'s attempt has been reset.`)
      setSubmissions((prev) => prev.filter((s) => s.attemptId !== resetTarget.attemptId))
    }
  }

  if (loading || !quiz) {
    return (
      <div className="space-y-6">
        <div className="space-y-2">
          <Skeleton className="h-4 w-32 rounded-full" />
          <Skeleton className="h-8 w-64 rounded-xl" />
          <Skeleton className="h-4 w-80 rounded-full" />
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-24 w-full rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-9 w-72 rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    )
  }

  const basePath = `/professor/courses/${sectionId}/quizzes/${quizId}`

  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Link href={`/professor/courses/${sectionId}/grades`} className="hover:text-foreground transition-colors">
          Grades
        </Link>
        <span className="opacity-40">/</span>
        <span className="text-foreground font-medium truncate">{quiz.title}</span>
      </nav>

      <PageHeader
        title={quiz.title}
        description={`Quiz analytics, student submissions${quiz.proctoringEnabled ? ', and proctoring' : ''}`}
      />

      {/* Summary Cards — always visible */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <Card>
          <CardContent className="pt-5 pb-4">
            <div className="flex items-center gap-2 mb-1">
              <Users className="h-4 w-4 text-muted-foreground" />
              <p className="text-xs font-medium text-muted-foreground">Submissions</p>
            </div>
            <p className="text-3xl font-semibold tabular-nums">{submitted.length}</p>
            {inProgress.length > 0 && (
              <p className="text-xs text-muted-foreground">{inProgress.length} in progress</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5 pb-4">
            <div className="flex items-center gap-2 mb-1">
              <Award className="h-4 w-4 text-muted-foreground" />
              <p className="text-xs font-medium text-muted-foreground">Average Score</p>
            </div>
            <p className={cn('text-3xl font-semibold tabular-nums', submitted.length > 0 && (avgScore >= quiz.passThreshold ? 'text-success-muted-foreground' : 'text-destructive'))}>
              {submitted.length > 0 ? `${avgScore}%` : '—'}
            </p>
            {submitted.length > 0 && (
              <p className="text-[10px] text-muted-foreground">Pass threshold: {quiz.passThreshold}%</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5 pb-4">
            <div className="flex items-center gap-2 mb-1">
              <Target className="h-4 w-4 text-muted-foreground" />
              <p className="text-xs font-medium text-muted-foreground">Pass Rate</p>
            </div>
            <p className={cn('text-3xl font-semibold tabular-nums', submitted.length > 0 && (passRate >= 50 ? 'text-success-muted-foreground' : 'text-destructive'))}>
              {submitted.length > 0 ? `${passRate}%` : '—'}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5 pb-4">
            <div className="flex items-center gap-2 mb-1">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <p className="text-xs font-medium text-muted-foreground">Avg Time</p>
            </div>
            <p className="text-3xl font-semibold tabular-nums">
              {submitted.length > 0 ? formatDuration(avgTime) : '—'}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5 pb-4">
            <div className="flex items-center gap-2 mb-1">
              <BarChart3 className="h-4 w-4 text-muted-foreground" />
              <p className="text-xs font-medium text-muted-foreground">Questions</p>
            </div>
            <p className="text-3xl font-semibold tabular-nums">{quiz.questionIds.length}</p>
          </CardContent>
        </Card>
      </div>

      {/* Tabbed Content: Overview + Submissions */}
      <Tabs defaultValue={defaultTab || 'overview'}>
        <TabsList>
          <TabsTrigger value="overview" className="gap-1.5">
            <BarChart3 className="h-3.5 w-3.5" />
            Overview
          </TabsTrigger>
          <TabsTrigger value="submissions" className="gap-1.5">
            <Users className="h-3.5 w-3.5" />
            Submissions
            {submissions.length > 0 && (
              <Badge variant="secondary" className="ml-1 text-[10px] px-1.5 py-0">
                {submissions.length}
              </Badge>
            )}
          </TabsTrigger>
          {quiz.proctoringEnabled && (
            <TabsTrigger value="proctoring" className="gap-1.5">
              <ShieldAlert className="h-3.5 w-3.5" />
              Proctoring
            </TabsTrigger>
          )}
        </TabsList>

        {/* ── Overview Tab ─────────────────────────────────────── */}
        <TabsContent value="overview" className="space-y-6 mt-4">
          {/* Adaptive cohort analytics — only for adaptive quizzes. Standard
              quizzes never render this block. */}
          {quiz.adaptiveMode && <AdaptiveAnalyticsSection data={adaptive} />}
          {insights ? (
            <>
              {/* Score Distribution */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-semibold">Score Distribution</CardTitle>
                </CardHeader>
                <CardContent>
                  {insights.totalAttempts === 0 ? (
                    <p className="text-sm text-muted-foreground">No attempts yet.</p>
                  ) : (
                    <div className="space-y-3">
                      {insights.scoreDistribution.map((bucket) => {
                        const pct = insights.totalAttempts > 0
                          ? (bucket.count / insights.totalAttempts) * 100
                          : 0
                        return (
                          <div key={bucket.range} className="flex items-center gap-3">
                            <span className="text-xs w-16 text-right font-medium text-muted-foreground">
                              {bucket.range}
                            </span>
                            <div className="flex-1 relative">
                              <Progress
                                value={pct}
                                className="h-7"
                              />
                              {bucket.count > 0 && (
                                <span className="absolute inset-y-0 left-2 flex items-center text-xs font-semibold text-primary-foreground mix-blend-difference">
                                  {bucket.count} student{bucket.count !== 1 ? 's' : ''}
                                </span>
                              )}
                            </div>
                            <span className="text-xs w-12 font-medium text-muted-foreground">
                              {pct.toFixed(0)}%
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Question Analysis */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-semibold">Question Analysis</CardTitle>
                </CardHeader>
                <CardContent>
                  {insights.questionAnalysis.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No data available.</p>
                  ) : (
                    <div className="divide-y">
                      {insights.questionAnalysis.map((qa, index) => (
                        <div key={qa.questionId} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                          <div className="flex items-center justify-center h-7 w-7 rounded-full bg-muted text-xs font-bold text-muted-foreground shrink-0">
                            {index + 1}
                          </div>
                          <div className="flex-1 min-w-0">
                            <MarkdownLatex content={blankPlaceholderText(qa.questionText)} variant="inline" className="text-sm line-clamp-1" />
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            {/* Correctness bar mini */}
                            <div className="hidden sm:flex items-center gap-1.5 w-24">
                              <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                                <div
                                  className={cn(
                                    'h-full rounded-full transition duration-200 ease-out',
                                    qa.correctRate >= 80
                                      ? 'bg-success'
                                      : qa.correctRate >= 50
                                        ? 'bg-warning'
                                        : 'bg-destructive',
                                  )}
                                  style={{ width: `${qa.correctRate}%` }}
                                />
                              </div>
                            </div>
                            <Badge
                              variant="secondary"
                              className={cn(
                                'text-[11px] font-semibold min-w-[72px] justify-center tabular-nums',
                                insights.totalAttempts === 0
                                  ? 'bg-muted text-muted-foreground'
                                  : qa.correctRate >= 80
                                    ? 'bg-success-muted text-success-muted-foreground'
                                    : qa.correctRate <= 40
                                      ? 'bg-destructive-muted text-destructive-muted-foreground'
                                      : 'bg-warning-muted text-warning-muted-foreground',
                              )}
                            >
                              {insights.totalAttempts === 0 ? '—' : `${qa.correctRate}% correct`}
                            </Badge>
                            {qa.averageTimeSeconds > 0 && (
                              <span className="text-xs text-muted-foreground hidden md:inline">
                                ~{qa.averageTimeSeconds}s
                              </span>
                            )}
                            <Button variant="ghost" size="sm" className="h-7 w-7 p-0 shrink-0" asChild>
                              <Link href={`${basePath}?step=1&focusQuestion=${qa.questionId}`} aria-label="Edit this question">
                                <Pencil className="h-3 w-3" aria-hidden="true" />
                              </Link>
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
              {/* Time Analysis */}
              {timeAnalytics.length > 0 ? (
                <>
                  {/* Summary cards */}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    {(() => {
                      const avgAll = Math.round(
                        timeAnalytics.reduce((s, r) => s + r.avgTime, 0) / timeAnalytics.length,
                      )
                      const slowest = timeAnalytics.reduce((a, b) => (a.avgTime > b.avgTime ? a : b))
                      const fastest = timeAnalytics.reduce((a, b) => (a.avgTime < b.avgTime ? a : b))
                      // Each row's own position, NOT its index here: timeAnalytics
                      // only holds questions with recorded time, so the array index
                      // drifts from the real question number (#311). position is
                      // 0-based in the DB, hence +1 for display.
                      const slowestNo = slowest.position + 1
                      const fastestNo = fastest.position + 1
                      function fmtSec(s: number) {
                        if (s < 60) return `${s}s`
                        const m = Math.floor(s / 60); const sec = s % 60
                        return sec > 0 ? `${m}m ${sec}s` : `${m}m`
                      }
                      return (
                        <>
                          <Card>
                            <CardContent className="pt-5 pb-4">
                              <div className="flex items-center gap-2 mb-1">
                                <Clock className="h-4 w-4 text-muted-foreground" />
                                <p className="text-xs font-medium text-muted-foreground">Avg per Question</p>
                              </div>
                              <p className="text-3xl font-semibold tabular-nums">{fmtSec(avgAll)}</p>
                            </CardContent>
                          </Card>
                          <Card>
                            <CardContent className="pt-5 pb-4">
                              <p className="text-xs font-medium text-muted-foreground mb-1">Slowest Question</p>
                              <p className="text-3xl font-semibold tabular-nums text-warning-muted-foreground">{fmtSec(slowest.avgTime)}</p>
                              <p className="text-xs text-muted-foreground truncate">Q{slowestNo}: {blankPlaceholderText(slowest.questionText).slice(0, 40)}{blankPlaceholderText(slowest.questionText).length > 40 ? '…' : ''}</p>
                            </CardContent>
                          </Card>
                          <Card>
                            <CardContent className="pt-5 pb-4">
                              <p className="text-xs font-medium text-muted-foreground mb-1">Fastest Question</p>
                              <p className="text-3xl font-semibold tabular-nums text-success-muted-foreground">{fmtSec(fastest.avgTime)}</p>
                              <p className="text-xs text-muted-foreground truncate">Q{fastestNo}: {blankPlaceholderText(fastest.questionText).slice(0, 40)}{blankPlaceholderText(fastest.questionText).length > 40 ? '…' : ''}</p>
                            </CardContent>
                          </Card>
                        </>
                      )
                    })()}
                  </div>
                  <QuizTimeChart data={timeAnalytics} />
                </>
              ) : (
                <Card>
                  <CardContent className="py-6">
                    <p className="text-sm text-muted-foreground text-center">
                      Time data is only available for attempts recorded after per-question time tracking was enabled.
                    </p>
                  </CardContent>
                </Card>
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No insights data available.</p>
          )}
        </TabsContent>

        {/* ── Submissions Tab ──────────────────────────────────── */}
        <TabsContent value="submissions" className="space-y-4 mt-4">
          {/* Filter bar */}
          {submissions.length > 0 && (
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative flex-1 min-w-48">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  placeholder="Search by name..."
                  className="pl-8 h-9 text-sm"
                  value={nameFilter}
                  onChange={(e) => setNameFilter(e.target.value)}
                />
              </div>
              <div className="flex items-center gap-1">
                {(['all', 'submitted', 'in_progress'] as const).map((s) => (
                  <Button
                    key={s}
                    variant={statusFilter === s ? 'default' : 'outline'}
                    size="sm"
                    className="h-8 text-xs"
                    onClick={() => setStatusFilter(s)}
                  >
                    {s === 'all' ? 'All Status' : s === 'submitted' ? 'Submitted' : 'In Progress'}
                  </Button>
                ))}
              </div>
              <div className="flex items-center gap-1">
                {(['all', 'flagged', 'clean'] as const).map((f) => (
                  <Button
                    key={f}
                    variant={flagFilter === f ? 'default' : 'outline'}
                    size="sm"
                    className="h-8 text-xs"
                    onClick={() => setFlagFilter(f)}
                  >
                    {f === 'all' ? 'All' : f === 'flagged' ? 'Flagged' : 'Clean'}
                  </Button>
                ))}
              </div>
              <span className="text-xs text-muted-foreground ml-auto">
                {filteredSubmissions.length} of {submissions.length}
              </span>
            </div>
          )}

          {/* Student list */}
          <Card className="divide-y">
            {/* Column headers */}
            {submissions.length > 0 && (
              <div className="px-6 py-2.5 flex items-center gap-4 bg-muted/30">
                <SortButton label="Student" sortKey="name" currentKey={sortKey} dir={sortDir} onClick={handleSort} className="flex-1 text-left" />
                <div className="flex items-center gap-5 shrink-0">
                  <SortButton label="Score" sortKey="score" currentKey={sortKey} dir={sortDir} onClick={handleSort} className="w-14 justify-end" />
                  <SortButton label="Time" sortKey="time" currentKey={sortKey} dir={sortDir} onClick={handleSort} className="w-16 justify-end" />
                  <SortButton label="Date" sortKey="date" currentKey={sortKey} dir={sortDir} onClick={handleSort} className="w-24 justify-end hidden md:flex" />
                  <span className="w-4" />
                </div>
              </div>
            )}

            {submissions.length === 0 ? (
              <EmptyState
                icon={Users}
                title="No attempts yet"
                description="Student submissions will appear here once they start the quiz."
              />
            ) : filteredSubmissions.length === 0 ? (
              <div className="px-6 py-8">
                <p className="text-sm text-muted-foreground text-center">No students match your filters.</p>
              </div>
            ) : (
              filteredSubmissions.map((row) => {
                const isSubmitted = row.status === 'submitted'
                const hasSuspicious = row.proctoringSummary && row.proctoringSummary.suspiciousFlags.length > 0
                return (
                  <div
                    key={row.attemptId}
                    className={cn(
                      'flex items-center gap-4 py-3 px-6 hover:bg-muted/40 transition-colors',
                      hasSuspicious && 'bg-warning-muted/40',
                    )}
                  >
                    <Link
                      href={`${basePath}/submissions/${row.attemptId}`}
                      className="flex items-center gap-4 flex-1 min-w-0"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">{row.studentName}</span>
                          <Badge
                            variant="secondary"
                            className={cn(
                              'text-[10px]',
                              isSubmitted
                                ? 'bg-success-muted text-success-muted-foreground'
                                : 'bg-warning-muted text-warning-muted-foreground',
                            )}
                          >
                            {isSubmitted ? 'Submitted' : 'In Progress'}
                          </Badge>
                          {/* Proctoring status dot */}
                          {row.proctoringSummary && (
                            <ProctoringStatusDot summary={row.proctoringSummary} />
                          )}
                        </div>
                        {/* Proctoring mini summary */}
                        {row.proctoringSummary && (
                          <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
                            <span className="flex items-center gap-0.5">
                              <Keyboard className="h-3 w-3" /> {row.proctoringSummary.totalKeystrokes}
                            </span>
                            {row.proctoringSummary.copyCount > 0 && (
                              <span className="flex items-center gap-0.5 text-warning-muted-foreground tabular-nums">
                                <Copy className="h-3 w-3" /> {row.proctoringSummary.copyCount}
                              </span>
                            )}
                            {row.proctoringSummary.pasteCount > 0 && (
                              <span className="flex items-center gap-0.5 text-warning-muted-foreground tabular-nums">
                                <Clipboard className="h-3 w-3" /> {row.proctoringSummary.pasteCount}
                              </span>
                            )}
                            {row.proctoringSummary.tabSwitchCount > 0 && (
                              <span className="flex items-center gap-0.5 text-warning-muted-foreground tabular-nums">
                                <EyeOff className="h-3 w-3" /> {row.proctoringSummary.tabSwitchCount}
                              </span>
                            )}
                          </div>
                        )}
                      </div>

                      <div className="flex items-center gap-5 shrink-0">
                        {isSubmitted && (
                          <div className="text-right w-14">
                            <p className={cn('text-sm font-semibold tabular-nums', scoreColorClass(row.score ?? 0))}>
                              {row.score}%
                            </p>
                          </div>
                        )}
                        <div className="text-right w-16">
                          <p className="text-sm text-muted-foreground">{formatDuration(row.timeSpentSeconds)}</p>
                        </div>
                        <div className="text-right hidden md:block w-24">
                          <p className="text-xs text-muted-foreground">
                            {row.submittedAt ? formatDateTime(row.submittedAt) : formatDateTime(row.startedAt)}
                          </p>
                        </div>
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      </div>
                    </Link>

                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          className="p-1.5 rounded-full hover:bg-muted transition-colors shrink-0"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <MoreVertical className="h-4 w-4 text-muted-foreground" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          onClick={() => setResetTarget({ attemptId: row.attemptId, studentName: row.studentName })}
                        >
                          <RotateCcw className="h-4 w-4 mr-2" />
                          Reset Attempt
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                )
              })
            )}
          </Card>
        </TabsContent>

        {/* ── Proctoring Tab ────────────────────────────────── */}
        {quiz.proctoringEnabled && (
          <TabsContent value="proctoring" className="mt-4">
            <ProctoringDashboard sectionId={sectionId} quizId={quizId} embedded />
          </TabsContent>
        )}
      </Tabs>

      {/* Reset Attempt Confirmation Dialog */}
      <AlertDialog open={!!resetTarget} onOpenChange={(open) => { if (!open) setResetTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset attempt?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete <span className="font-medium text-foreground">{resetTarget?.studentName}&apos;s</span> attempt
              and all their answers. They will be able to retake the quiz.
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isResetting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleResetAttempt}
              disabled={isResetting}
              variant="destructive"
            >
              {isResetting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <RotateCcw className="h-4 w-4 mr-2" />}
              Reset Attempt
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ── Sort Button Helper ────────────────────────────────────────────

function SortButton({ label, sortKey, currentKey, dir, onClick, className }: {
  label: string
  sortKey: SortKey
  currentKey: SortKey
  dir: SortDir
  onClick: (key: SortKey) => void
  className?: string
}) {
  const active = currentKey === sortKey
  return (
    <button
      className={cn('flex items-center gap-1 text-xs font-semibold', className)}
      onClick={() => onClick(sortKey)}
    >
      {label}
      {active ? (
        dir === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
      ) : (
        <ChevronsUpDown className="h-3 w-3 opacity-40" />
      )}
    </button>
  )
}

// ── Proctoring Status Dot ────────────────────────────────────────

function ProctoringStatusDot({ summary }: { summary: NonNullable<QuizSubmissionRow['proctoringSummary']> }) {
  const flagCount = (summary.suspiciousFlags?.length ?? 0)
    + (summary.tabSwitchCount > 3 ? 1 : 0)
    + (summary.phoneDetectedCount > 0 ? 1 : 0)
    + (summary.multipleFaceCount > 0 ? 1 : 0)

  if (flagCount === 0) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-medium text-success-muted-foreground">
        <span className="w-1.5 h-1.5 rounded-full bg-success" />
        Clean
      </span>
    )
  }

  if (flagCount <= 2) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-medium text-warning-muted-foreground tabular-nums">
        <span className="w-1.5 h-1.5 rounded-full bg-warning" />
        {flagCount} flag{flagCount > 1 ? 's' : ''}
      </span>
    )
  }

  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-medium text-destructive tabular-nums">
      <span className="w-1.5 h-1.5 rounded-full bg-destructive" />
      {flagCount} flags
    </span>
  )
}

// ── Adaptive Analytics Section ───────────────────────────────────
// Shown only for adaptive quizzes. Surfaces the ability (CCAT rating)
// distribution and the adaptive-vs-control cohort comparison that
// getAdaptiveAnalytics computes — data the standard Overview ignores.

function CohortPanel({ label, stats }: { label: string; stats: CohortStats | null }) {
  return (
    <div className="rounded-xl border border-border p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <span className="text-sm font-semibold text-foreground">{label}</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {stats ? `${stats.count} student${stats.count === 1 ? '' : 's'}` : 'No students'}
        </span>
      </div>
      {stats ? (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Avg score</p>
            <p className={cn('text-2xl font-semibold tabular-nums', scoreColorClass(stats.avgScore))}>{stats.avgScore}%</p>
            <p className="text-[10px] text-muted-foreground tabular-nums">range {stats.minScore}–{stats.maxScore}%</p>
          </div>
          <div>
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Avg ability</p>
            <p className="text-2xl font-semibold tabular-nums text-foreground">{stats.avgRating}</p>
            <p className="text-[10px] text-muted-foreground tabular-nums">range {stats.minRating}–{stats.maxRating}</p>
          </div>
        </div>
      ) : (
        <p className="text-sm italic text-muted-foreground">No attempts in this cohort yet.</p>
      )}
    </div>
  )
}

function AdaptiveAnalyticsSection({ data }: { data: AdaptiveAnalyticsData }) {
  const hasData = data && data.totalAttempts > 0
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <Compass className="h-4 w-4 text-muted-foreground" />
          Adaptive analytics
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Ability estimate (CCAT rating, 1200 = baseline) and adaptive-vs-control cohort comparison.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {!hasData ? (
          <p className="text-sm text-muted-foreground">No adaptive attempts recorded yet.</p>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <CohortPanel label="Adaptive cohort" stats={data.adaptive} />
              <CohortPanel label="Control cohort" stats={data.control} />
            </div>
            {data.topPerformers.length > 0 && (
              <div>
                <p className="mb-2 text-xs font-semibold text-foreground">Top by ability (adaptive cohort)</p>
                <div className="space-y-1.5">
                  {data.topPerformers.slice(0, 5).map((p, i) => (
                    <div key={p.studentId} className="flex items-center gap-3 text-sm">
                      <span className="w-4 text-right text-xs tabular-nums text-muted-foreground">{i + 1}</span>
                      <span className="flex-1 truncate text-foreground">{p.studentName}</span>
                      <span className="font-mono text-xs tabular-nums text-muted-foreground">{p.finalRating}</span>
                      <span className={cn('w-10 text-right text-xs font-medium tabular-nums', scoreColorClass(p.score))}>{p.score}%</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
