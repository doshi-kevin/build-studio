// Per-student proctoring detail view — shows summary stats and a filterable
// chronological event timeline with question context and suspicious highlights.
'use client'

import { useState, useEffect, useMemo } from 'react'
import {
  ArrowLeft,
  Keyboard,
  Copy,
  Clipboard,
  Scissors,
  EyeOff,
  Eye,
  AlertTriangle,
  Clock,
  Award,
  Filter,
  Users,
  Smartphone,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { blankPlaceholderText } from '@/lib/quiz/fill-in-blank'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { PageHeader } from '@/components/professor/PageHeader'
import {
  getAttemptProctoringDetail,
  getAttemptProctoringSnapshots,
} from '@/app/(dashboard)/professor/courses/[sectionId]/quizzes/actions'
import type { ProctoringEvent, ProctoringSummary, ProctoringSnapshot } from '@/lib/validations/proctoring'
import SnapshotGallery from './SnapshotGallery'
import {
  MOD_CTRL,
  MOD_SHIFT,
  MOD_ALT,
  MOD_META,
  PROCTORING_EVENT_TYPE_LABELS,
} from '@/lib/validations/proctoring'

interface ProctoringDetailViewProps {
  sectionId: string
  attemptId: string
  quizTitle: string
  onBack: () => void
}

interface DetailData {
  studentName: string
  studentEmail: string
  startedAt: string
  submittedAt: string | null
  score: number | null
  timeSpentSeconds: number
  summary: ProctoringSummary | null
  events: ProctoringEvent[]
  questionTexts: Record<number, string>
}

// Event type filter options
const EVENT_FILTERS = [
  { value: 'all', label: 'All Events' },
  { value: 'kd', label: 'Keystrokes' },
  { value: 'cp', label: 'Copy' },
  { value: 'ps', label: 'Paste' },
  { value: 'ct', label: 'Cut' },
  { value: 'bl', label: 'Tab Leave' },
  { value: 'fc', label: 'Tab Return' },
  { value: 'mf', label: 'Multi Face' },
  { value: 'ph', label: 'Phone' },
] as const

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
  // Skip if key is itself a modifier (legacy data from before the capture fix)
  if (MODIFIER_KEY_NAMES.has(key)) return mods || key
  if (!mods) return key
  return `${mods}+${key}`
}

function getEventIcon(type: string) {
  switch (type) {
    case 'kd': return <Keyboard className="h-3.5 w-3.5" />
    case 'cp': return <Copy className="h-3.5 w-3.5" />
    case 'ps': return <Clipboard className="h-3.5 w-3.5" />
    case 'ct': return <Scissors className="h-3.5 w-3.5" />
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

export function ProctoringDetailView({
  sectionId,
  attemptId,
  quizTitle,
  onBack,
}: ProctoringDetailViewProps) {
  const [data, setData] = useState<DetailData | null>(null)
  const [snapshots, setSnapshots] = useState<ProctoringSnapshot[]>([])
  const [loading, setLoading] = useState(true)
  const [eventFilter, setEventFilter] = useState<string>('all')

  useEffect(() => {
    async function load() {
      const [detailResult, snapshotResult] = await Promise.all([
        getAttemptProctoringDetail(sectionId, attemptId),
        getAttemptProctoringSnapshots(sectionId, attemptId),
      ])
      if (detailResult.error) {
        toast.error(detailResult.error)
        onBack()
        return
      }
      if (detailResult.data) {
        setData(detailResult.data)
      }
      if (snapshotResult.data) {
        setSnapshots(snapshotResult.data)
      }
      setLoading(false)
    }
    load()
  }, [sectionId, attemptId, onBack])

  const filteredEvents = useMemo(() => {
    if (!data) return []
    if (eventFilter === 'all') return data.events
    return data.events.filter((e) => e.type === eventFilter)
  }, [data, eventFilter])

  if (loading || !data) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-4 w-32 rounded-full" />
        <div className="space-y-2">
          <Skeleton className="h-8 w-56 rounded-xl" />
          <Skeleton className="h-4 w-72 rounded-full" />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-20 w-full rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    )
  }

  const { summary } = data

  return (
    <div className="space-y-6">
      <button
        onClick={onBack}
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3 w-3" />
        Back to Overview
      </button>

      {/* Student header */}
      <div className="space-y-2">
        <PageHeader
          title={data.studentName}
          description={`${quizTitle} — Proctoring Detail`}
        />
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1 tabular-nums">
            <Award className="h-3 w-3" />
            Score: {data.score ?? '—'}%
          </span>
          <span className="flex items-center gap-1 tabular-nums">
            <Clock className="h-3 w-3" />
            Time: {Math.round(data.timeSpentSeconds / 60)}min
          </span>
          <span className="tabular-nums">
            Started: {new Date(data.startedAt).toLocaleString()}
          </span>
          {data.submittedAt && (
            <span className="tabular-nums">
              Submitted: {new Date(data.submittedAt).toLocaleString()}
            </span>
          )}
        </div>
      </div>

      {/* Summary stats */}
      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <Card className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <Keyboard className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Keystrokes</span>
            </div>
            <p className="text-2xl font-semibold tabular-nums">{summary.totalKeystrokes}</p>
          </Card>
          <Card className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <Copy className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Copy</span>
            </div>
            <p className="text-2xl font-semibold tabular-nums">{summary.copyCount}</p>
          </Card>
          <Card className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <Clipboard className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Paste</span>
            </div>
            <p className="text-2xl font-semibold tabular-nums">{summary.pasteCount}</p>
          </Card>
          <Card className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <Scissors className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Cut</span>
            </div>
            <p className="text-2xl font-semibold tabular-nums">{summary.cutCount}</p>
          </Card>
          <Card className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <EyeOff className={cn('h-3.5 w-3.5', summary.tabSwitchCount > 0 ? 'text-warning-muted-foreground' : 'text-muted-foreground')} />
              <span className="text-xs text-muted-foreground">Tab Switches</span>
            </div>
            <p className={cn('text-2xl font-semibold tabular-nums', summary.tabSwitchCount > 0 && 'text-warning-muted-foreground')}>{summary.tabSwitchCount}</p>
          </Card>
        </div>
      )}

      {/* Video proctoring stats */}
      {summary && (summary.multipleFaceCount > 0 || summary.phoneDetectedCount > 0 || summary.webcamDenied) && (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          <Card className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <Users className={cn('h-3.5 w-3.5', summary.multipleFaceCount > 0 ? 'text-warning-muted-foreground' : 'text-muted-foreground')} />
              <span className="text-xs text-muted-foreground">Multiple Faces</span>
            </div>
            <p className={cn('text-2xl font-semibold tabular-nums', summary.multipleFaceCount > 0 && 'text-warning-muted-foreground')}>{summary.multipleFaceCount}</p>
          </Card>
          <Card className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <Smartphone className={cn('h-3.5 w-3.5', summary.phoneDetectedCount > 0 ? 'text-destructive' : 'text-muted-foreground')} />
              <span className="text-xs text-muted-foreground">Phone Detected</span>
            </div>
            <p className={cn('text-2xl font-semibold tabular-nums', summary.phoneDetectedCount > 0 && 'text-destructive')}>{summary.phoneDetectedCount}</p>
          </Card>
          {summary.webcamDenied && (
            <Card className="p-4 border-destructive/30">
              <div className="flex items-center gap-2 mb-1">
                <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
                <span className="text-xs text-destructive">Camera Denied</span>
              </div>
              <p className="text-sm text-destructive">Student did not grant camera access</p>
            </Card>
          )}
        </div>
      )}

      {/* Suspicious flags */}
      {summary && summary.suspiciousFlags.length > 0 && (
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

      {/* Event Timeline */}
      <Card className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold">
            Event Timeline ({filteredEvents.length.toLocaleString()} events)
          </h3>
          <div className="flex items-center gap-2">
            <Filter className="h-3.5 w-3.5 text-muted-foreground" />
            <div className="flex gap-1">
              {EVENT_FILTERS.map((f) => (
                <Button
                  key={f.value}
                  variant={eventFilter === f.value ? 'default' : 'outline'}
                  size="sm"
                  className="text-xs h-7 px-2"
                  onClick={() => setEventFilter(f.value)}
                >
                  {f.label}
                </Button>
              ))}
            </div>
          </div>
        </div>

        {filteredEvents.length === 0 ? (
          <p className="text-sm text-muted-foreground">No events to display.</p>
        ) : (
          <div className="max-h-[600px] overflow-y-auto">
            {/* Timeline header */}
            <div className="grid grid-cols-[60px_140px_1fr_1fr] gap-2 py-2 border-b text-xs text-muted-foreground font-medium sticky top-0 bg-background">
              <span>Time</span>
              <span>Event</span>
              <span>Detail</span>
              <span>Question</span>
            </div>

            {filteredEvents.map((event, i) => {
              const suspicious = isSuspiciousEvent(event)
              // FIB stems carry {{blank:id:answers}} tokens — collapse to "_____".
              const rawQuestionText =
                event.qi !== undefined ? data.questionTexts[event.qi] : undefined
              const questionText =
                rawQuestionText !== undefined ? blankPlaceholderText(rawQuestionText) : undefined

              return (
                <div
                  key={i}
                  className={cn(
                    'grid grid-cols-[60px_140px_1fr_1fr] gap-2 py-2 border-b last:border-0 text-sm',
                    suspicious && 'bg-warning-muted/40',
                  )}
                >
                  <span className="text-xs text-muted-foreground font-mono">
                    {formatTime(event.t)}
                  </span>
                  <span className="flex items-center gap-1.5">
                    {getEventIcon(event.type)}
                    <span className="text-xs">
                      {PROCTORING_EVENT_TYPE_LABELS[event.type as keyof typeof PROCTORING_EVENT_TYPE_LABELS] ?? event.type}
                    </span>
                  </span>
                  <span className="text-xs font-mono truncate">
                    {event.type === 'kd' ? formatKeyCombo(event) : '—'}
                  </span>
                  <span className="text-xs text-muted-foreground truncate">
                    {questionText
                      ? `Q${(event.qi ?? 0) + 1}: ${questionText}`
                      : event.qi !== undefined
                        ? `Q${event.qi + 1}`
                        : '—'}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </Card>

      {/* Violation Snapshots */}
      {snapshots.length > 0 && (
        <SnapshotGallery
          snapshots={snapshots}
          attemptStartedAt={data.startedAt}
        />
      )}
    </div>
  )
}
