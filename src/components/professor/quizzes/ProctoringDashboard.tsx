// Professor proctoring overview dashboard — shows summary stats per student
// for a proctored quiz. Click a row to expand the per-student event timeline.
// Supports `embedded` prop to render inline within QuizInsightsDashboard (no header/back-link).
'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft,
  Keyboard,
  EyeOff,
  Users,
  AlertTriangle,
  ChevronRight,
  Camera,
  CameraOff,
  Smartphone,
} from 'lucide-react'
import Link from 'next/link'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { PageHeader } from '@/components/professor/PageHeader'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  getQuizById,
  getQuizProctoringOverview,
} from '@/app/(dashboard)/professor/courses/[sectionId]/quizzes/actions'
import type { Quiz } from '@/lib/validations/quiz'
import type { ProctoringSummary } from '@/lib/validations/proctoring'
import { ProctoringDetailView } from './ProctoringDetailView'

interface OverviewRow {
  attemptId: string
  studentId: string
  studentName: string
  studentEmail: string
  score: number | null
  submittedAt: string | null
  timeSpentSeconds: number
  summary: ProctoringSummary | null
}

interface ProctoringDashboardProps {
  sectionId: string
  quizId: string
  embedded?: boolean
}

/** Column definitions for the proctoring table. Each entry describes a data column. */
const BASE_COLUMNS = [
  { key: 'score', label: 'Score', tooltip: 'Quiz score percentage' },
  { key: 'keys', label: 'Keys', tooltip: 'Total keystrokes during the attempt' },
  { key: 'copy', label: 'Copy', tooltip: 'Number of copy (Ctrl+C) events detected' },
  { key: 'paste', label: 'Paste', tooltip: 'Number of paste (Ctrl+V) events detected' },
  { key: 'tab', label: 'Tab', tooltip: 'Number of tab/window switches detected' },
] as const

const VIDEO_COLUMNS = [
  { key: 'faces', label: 'Faces', tooltip: 'Times multiple faces were detected on camera' },
  { key: 'snaps', label: 'Snaps', tooltip: 'Webcam snapshots captured during the attempt' },
] as const

export function ProctoringDashboard({ sectionId, quizId, embedded }: ProctoringDashboardProps) {
  const router = useRouter()
  const [quiz, setQuiz] = useState<Quiz | null>(null)
  const [rows, setRows] = useState<OverviewRow[]>([])
  const [selectedAttemptId, setSelectedAttemptId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      const [quizResult, overviewResult] = await Promise.all([
        getQuizById(sectionId, quizId),
        getQuizProctoringOverview(sectionId, quizId),
      ])

      if (quizResult.error || !quizResult.data) {
        toast.error(quizResult.error || 'Quiz not found')
        router.push(`/professor/courses/${sectionId}/quizzes`)
        return
      }

      setQuiz(quizResult.data)

      if (overviewResult.error) {
        toast.error(overviewResult.error)
      } else {
        setRows(overviewResult.data || [])
      }

      setLoading(false)
    }
    load()
  }, [sectionId, quizId, router])

  if (loading || !quiz) {
    return (
      <div className="space-y-6">
        {!embedded && (
          <div className="space-y-2">
            <Skeleton className="h-8 w-72 rounded-xl" />
            <Skeleton className="h-4 w-96 rounded-full" />
          </div>
        )}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24 w-full rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    )
  }

  // If viewing a specific student's detail, show that
  if (selectedAttemptId) {
    return (
      <ProctoringDetailView
        sectionId={sectionId}
        attemptId={selectedAttemptId}
        quizTitle={quiz.title}
        onBack={() => setSelectedAttemptId(null)}
      />
    )
  }

  // Aggregate stats
  const totalAttempts = rows.length
  const flaggedCount = rows.filter(
    (r) => r.summary && r.summary.suspiciousFlags.length > 0,
  ).length
  const avgTabSwitches =
    totalAttempts > 0
      ? Math.round(
          rows.reduce((sum, r) => sum + (r.summary?.tabSwitchCount ?? 0), 0) / totalAttempts,
        )
      : 0
  const avgKeystrokes =
    totalAttempts > 0
      ? Math.round(
          rows.reduce((sum, r) => sum + (r.summary?.totalKeystrokes ?? 0), 0) / totalAttempts,
        )
      : 0
  const totalMultiFace = rows.reduce((sum, r) => sum + (r.summary?.multipleFaceCount ?? 0), 0)
  const totalPhoneDetected = rows.reduce((sum, r) => sum + (r.summary?.phoneDetectedCount ?? 0), 0)
  const totalSnapshots = rows.reduce((sum, r) => sum + (r.summary?.snapshotCount ?? 0), 0)
  const cameraDeniedCount = rows.filter((r) => r.summary?.webcamDenied).length
  const hasVideoProctoring = quiz.videoProctoringEnabled

  // Build the grid-cols string: Student (1fr) + data columns (80px each) + chevron (32px)
  const dataColumns = hasVideoProctoring
    ? [...BASE_COLUMNS, ...VIDEO_COLUMNS]
    : [...BASE_COLUMNS]
  // Use complete static class strings so Tailwind can detect them at build time.
  // Dynamic template literals (e.g. `grid-cols-[1fr_${x}]`) get purged.
  const gridCols = hasVideoProctoring
    ? 'grid-cols-[1fr_80px_80px_80px_80px_80px_80px_80px_32px]'
    : 'grid-cols-[1fr_80px_80px_80px_80px_80px_32px]'

  return (
    <div className="space-y-6">
      {!embedded && (
        <>
          <Link
            href={`/professor/courses/${sectionId}/quizzes/${quizId}`}
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-3 w-3" />
            Back to Editor
          </Link>

          <PageHeader
            title={`${quiz.title} — Proctoring Report`}
            description="Keyboard activity, clipboard usage, and tab switch monitoring for proctored attempts."
          />
        </>
      )}

      {/* Summary Cards */}
      <div className={`grid grid-cols-2 ${hasVideoProctoring ? 'md:grid-cols-4 lg:grid-cols-7' : 'md:grid-cols-4'} gap-4`}>
        <Card className="p-4">
          <div className="flex items-center gap-2 mb-2">
            <Users className="h-4 w-4 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">Proctored Attempts</span>
          </div>
          <p className="text-3xl font-semibold tabular-nums">{totalAttempts}</p>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle className={cn('h-4 w-4', flaggedCount > 0 ? 'text-warning-muted-foreground' : 'text-muted-foreground')} />
            <span className="text-xs text-muted-foreground">Flagged</span>
          </div>
          <p className={cn('text-3xl font-semibold tabular-nums', flaggedCount > 0 && 'text-warning-muted-foreground')}>{flaggedCount}</p>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-2 mb-2">
            <EyeOff className="h-4 w-4 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">Avg Tab Switches</span>
          </div>
          <p className="text-3xl font-semibold tabular-nums">{avgTabSwitches}</p>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-2 mb-2">
            <Keyboard className="h-4 w-4 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">Avg Keystrokes</span>
          </div>
          <p className="text-3xl font-semibold tabular-nums">{avgKeystrokes}</p>
        </Card>
        {hasVideoProctoring && (
          <>
            <Card className="p-4">
              <div className="flex items-center gap-2 mb-2">
                <Users className={cn('h-4 w-4', totalMultiFace > 0 ? 'text-warning-muted-foreground' : 'text-muted-foreground')} />
                <span className="text-xs text-muted-foreground">Multiple Faces</span>
              </div>
              <p className={cn('text-3xl font-semibold tabular-nums', totalMultiFace > 0 && 'text-warning-muted-foreground')}>{totalMultiFace}</p>
            </Card>
            <Card className="p-4">
              <div className="flex items-center gap-2 mb-2">
                <Smartphone className={cn('h-4 w-4', totalPhoneDetected > 0 ? 'text-destructive' : 'text-muted-foreground')} />
                <span className="text-xs text-muted-foreground">Phone Detected</span>
              </div>
              <p className={cn('text-3xl font-semibold tabular-nums', totalPhoneDetected > 0 && 'text-destructive')}>{totalPhoneDetected}</p>
            </Card>
            <Card className="p-4">
              <div className="flex items-center gap-2 mb-2">
                <Camera className="h-4 w-4 text-muted-foreground" />
                <span className="text-xs text-muted-foreground">Snapshots</span>
              </div>
              <p className="text-3xl font-semibold tabular-nums">
                {totalSnapshots}
                {cameraDeniedCount > 0 && (
                  <span className="text-sm text-destructive ml-2">
                    <CameraOff className="h-3 w-3 inline" /> {cameraDeniedCount} denied
                  </span>
                )}
              </p>
            </Card>
          </>
        )}
      </div>

      {/* Student Table — horizontally scrollable for many columns */}
      <Card className="p-6">
        <h3 className="text-sm font-semibold mb-4">Student Activity</h3>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No proctored attempts yet.</p>
        ) : (
          <TooltipProvider>
            <div className="overflow-x-auto">
              <div className="min-w-[600px] space-y-0">
                {/* Table header */}
                <div
                  className={`grid ${gridCols} gap-2 py-2 border-b text-xs text-muted-foreground font-medium`}
                >
                  <span>Student</span>
                  {dataColumns.map((col) => (
                    <Tooltip key={col.key}>
                      <TooltipTrigger asChild>
                        <span className="text-right cursor-help">{col.label}</span>
                      </TooltipTrigger>
                      <TooltipContent side="top">
                        <p>{col.tooltip}</p>
                      </TooltipContent>
                    </Tooltip>
                  ))}
                  <span />
                </div>

                {/* Table rows */}
                {rows.map((row) => {
                  const hasSuspicious = row.summary && row.summary.suspiciousFlags.length > 0
                  return (
                    <button
                      key={row.attemptId}
                      onClick={() => setSelectedAttemptId(row.attemptId)}
                      className={cn(
                        `w-full grid ${gridCols} gap-2 py-3 border-b last:border-0 hover:bg-muted/50 text-left transition-colors`,
                        hasSuspicious && 'bg-warning-muted/40',
                      )}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-sm truncate">{row.studentName}</span>
                        {hasSuspicious && (
                          <Badge variant="secondary" className="bg-warning-muted text-warning-muted-foreground text-[10px] shrink-0">
                            Flagged
                          </Badge>
                        )}
                        {row.summary?.webcamDenied && (
                          <Badge variant="secondary" className="bg-destructive-muted text-destructive-muted-foreground text-[10px] shrink-0">
                            <CameraOff className="h-2.5 w-2.5 mr-0.5" />
                            No Cam
                          </Badge>
                        )}
                      </div>
                      <span className="text-sm text-right tabular-nums">{row.score ?? '—'}%</span>
                      <span className="text-sm text-right tabular-nums">{row.summary?.totalKeystrokes ?? 0}</span>
                      <span className="text-sm text-right tabular-nums">{row.summary?.copyCount ?? 0}</span>
                      <span className="text-sm text-right tabular-nums">{row.summary?.pasteCount ?? 0}</span>
                      <span className="text-sm text-right tabular-nums">{row.summary?.tabSwitchCount ?? 0}</span>
                      {hasVideoProctoring && <span className="text-sm text-right tabular-nums">{row.summary?.multipleFaceCount ?? 0}</span>}
                      {hasVideoProctoring && <span className="text-sm text-right tabular-nums">{row.summary?.snapshotCount ?? 0}</span>}
                      <ChevronRight className="h-4 w-4 text-muted-foreground self-center" />
                    </button>
                  )
                })}
              </div>
            </div>
          </TooltipProvider>
        )}
      </Card>
    </div>
  )
}
