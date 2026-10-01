// Compact countdown chip for live quizzes — shared by the student responders
// and the professor's live-quiz row. Recomputes the remaining time from the
// server-assigned `opened_at` on every tick (drift-proof, and survives a page
// reload since opened_at comes back in the snapshot). Clamped to
// [0, totalSeconds] so a skewed client clock can't show extra/negative time.
//
// Visual urgency cue. It does not itself end the quiz — but it fires `onExpire`
// once at zero so consumers can react (student responders auto-submit + lock).
// The professor's deadline watcher is the authoritative close.

'use client'

import { useEffect, useRef, useState } from 'react'
import { Clock } from 'lucide-react'
import { formatTime, quizTimeRemaining } from '@/lib/quiz/utils'

interface Props {
  /** Server timestamp (ISO 8601) when the quiz opened; null before it's set. */
  openedAt: string | null
  /** Quiz time limit in seconds (from payload.timeLimitSeconds). */
  totalSeconds: number
  /** Fired exactly once when the countdown reaches 0 (incl. if already past
   *  at mount). Used by student responders to auto-submit + lock at time-up. */
  onExpire?: () => void
}

export function QuizCountdown({ openedAt, totalSeconds, onExpire }: Props) {
  const compute = () => quizTimeRemaining(openedAt, totalSeconds)

  const [remaining, setRemaining] = useState(compute)
  // Keep the latest onExpire without re-running the interval effect.
  const onExpireRef = useRef(onExpire)
  onExpireRef.current = onExpire

  useEffect(() => {
    // New quiz (openedAt/totalSeconds changed) → allow firing again.
    let fired = false
    const tick = () => {
      const r = compute()
      setRemaining(r)
      if (r <= 0 && !fired) {
        fired = true
        onExpireRef.current?.()
      }
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
    // `compute` closes over openedAt/totalSeconds; restart the interval when they change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openedAt, totalSeconds])

  const isUp = remaining <= 0
  const low = remaining <= 10 // includes the terminal "Time's up" state

  return (
    <span
      role="timer"
      aria-live="off"
      className={`inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-xs font-semibold tabular-nums ${
        low ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground'
      }`}
    >
      <Clock className="h-3 w-3" aria-hidden />
      {isUp ? "Time's up" : formatTime(remaining)}
    </span>
  )
}
