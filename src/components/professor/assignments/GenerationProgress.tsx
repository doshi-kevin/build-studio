'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'

/**
 * Shared "AI is working" loader — the same treatment the rubric editor uses for
 * drafting, reused for answer-key generation and whole-class grade suggestions.
 *
 * Most of these server actions report no incremental progress, so the bar eases
 * toward (never reaches) 92% to show liveness without falsely claiming completion.
 * When a caller HAS real progress (e.g. graded / total during a class stream), pass
 * `value` (0-100) and the simulation is skipped.
 *
 * `message` must be STATIC (no live counter): it sits in an aria-live region, so a
 * value that changes each tick would re-announce the whole sentence to a screen
 * reader. Let the progress bar and the trigger button carry any running count.
 *
 * `skeletonCount` renders that many placeholder cards under the bar (bounded 2-4),
 * so a re-draft over existing content doesn't collapse the panel height.
 */
export function GenerationProgress({
  active,
  message,
  value,
  skeletonCount = 0,
  'aria-label': ariaLabel = 'Progress',
}: {
  active: boolean
  message: ReactNode
  value?: number
  skeletonCount?: number
  'aria-label'?: string
}) {
  const simulated = value === undefined
  const [sim, setSim] = useState(0)
  // Restart the bar each time work begins — adjusted during render on the active
  // transition (not in the effect) so it stays lint-clean and resets before paint.
  const [wasActive, setWasActive] = useState(active)
  if (active !== wasActive) {
    setWasActive(active)
    if (active) setSim(0)
  }
  useEffect(() => {
    if (!active || !simulated) return
    const id = setInterval(() => setSim((p) => p + (92 - p) * 0.02), 300)
    return () => clearInterval(id)
  }, [active, simulated])

  if (!active) return null
  return (
    <div className="space-y-3" role="status" aria-live="polite">
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
        <span>{message}</span>
      </p>
      <Progress value={value ?? sim} className="h-1.5" aria-label={ariaLabel} />
      {skeletonCount > 0 &&
        Array.from({ length: Math.min(4, Math.max(2, skeletonCount)) }, (_, i) => (
          <div key={i} className="space-y-2 rounded-xl border border-border p-3">
            <div className="flex items-center gap-2">
              <Skeleton className="h-9 flex-1" />
              <Skeleton className="h-9 w-20" />
            </div>
            <div className="space-y-1.5 pl-3">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-3/4" />
            </div>
          </div>
        ))}
    </div>
  )
}
