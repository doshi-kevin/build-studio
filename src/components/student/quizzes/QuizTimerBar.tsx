// Timer bar shown during quiz — displays question progress and countdown.
// Shows checkpoint warnings at 5min, 2min, and 30sec remaining.
'use client'

import { useState, useEffect, useRef } from 'react'
import { Clock, AlertTriangle } from 'lucide-react'
import { Progress } from '@/components/ui/progress'
import { formatTime } from '@/lib/quiz/utils'

interface QuizTimerBarProps {
  timeRemainingSeconds: number | null
  timeLimitMinutes: number | null
  currentIndex: number
  totalQuestions: number
}

const WARNING_THRESHOLDS: { seconds: number; label: string; severe?: boolean }[] = [
  { seconds: 300, label: '5 minutes remaining' },
  { seconds: 120, label: '2 minutes remaining' },
  { seconds: 30, label: '30 seconds — quiz will auto-submit', severe: true },
]

export function QuizTimerBar({
  timeRemainingSeconds,
  timeLimitMinutes,
  currentIndex,
  totalQuestions,
}: QuizTimerBarProps) {
  const progressPercent =
    totalQuestions > 0 ? ((currentIndex + 1) / totalQuestions) * 100 : 0

  const isLowTime =
    timeRemainingSeconds !== null && timeLimitMinutes !== null && timeRemainingSeconds < 60

  // Checkpoint warnings — show once per threshold, derived from time
  const triggeredRef = useRef<Set<number>>(new Set())
  const [warning, setWarning] = useState<{ text: string; severe: boolean } | null>(null)

  useEffect(() => {
    if (timeRemainingSeconds === null) return

    // Check thresholds from highest to lowest. The triggeredRef Set ensures
    // each warning fires at most once, so we only need a <= check — no narrow
    // 2-second window that could be skipped if the timer jumps past a threshold.
    for (const threshold of WARNING_THRESHOLDS) {
      if (
        timeRemainingSeconds <= threshold.seconds &&
        !triggeredRef.current.has(threshold.seconds)
      ) {
        triggeredRef.current.add(threshold.seconds)
        setWarning({ text: threshold.label, severe: !!threshold.severe }) // eslint-disable-line react-hooks/set-state-in-effect

        if (!threshold.severe) {
          setTimeout(() => setWarning(null), 4000)
        }
        break
      }
    }
  }, [timeRemainingSeconds])

  return (
    <div className="space-y-0">
      <div className="flex items-center gap-4 rounded-xl bg-muted/30 px-4 py-3">
        <span className="text-xs tabular-nums text-muted-foreground">
          {currentIndex + 1} / {totalQuestions}
        </span>

        <Progress value={progressPercent} className="h-2 flex-1" />

        {timeRemainingSeconds !== null && (
          <div
            className={`flex items-center gap-1.5 text-sm font-medium tabular-nums ${
              isLowTime ? 'text-destructive animate-pulse' : 'text-foreground'
            }`}
          >
            <Clock className="h-4 w-4" />
            {formatTime(timeRemainingSeconds)}
          </div>
        )}
      </div>

      {/* Checkpoint warning banner */}
      {warning && (
        <div
          className={`flex items-center justify-center gap-2 rounded-b-xl px-3 py-1.5 text-xs font-medium ${
            warning.severe
              ? 'bg-destructive-muted text-destructive-muted-foreground'
              : 'bg-warning-muted text-warning-muted-foreground'
          }`}
        >
          <AlertTriangle className="h-3 w-3" />
          {warning.text}
        </div>
      )}
    </div>
  )
}
