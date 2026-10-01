/**
 * CapacityBar -- displays enrolled/max students with a colored progress bar.
 *
 * Shows "12 / 30" text alongside a progress bar. The bar color changes based
 * on the fill percentage:
 * - Green (<70%): plenty of room
 * - Amber (70-90%): nearing capacity
 * - Red (>90%): nearly/fully full
 *
 * If max is null (no cap set), only the enrolled count is shown.
 *
 * Type: Server Component (pure display, no interactivity)
 */

import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'

interface CapacityBarProps {
  enrolled: number
  max: number | null
}

export function CapacityBar({ enrolled, max }: CapacityBarProps) {
  if (max == null) {
    return (
      <span className="text-sm text-muted-foreground">
        {enrolled} enrolled
      </span>
    )
  }

  const percentage = max > 0 ? Math.round((enrolled / max) * 100) : 0
  const capped = Math.min(percentage, 100)

  /** Determine color based on fill percentage */
  let colorClass: string
  if (percentage > 90) {
    colorClass = '[&_[data-slot=progress-indicator]]:bg-destructive'
  } else if (percentage >= 70) {
    colorClass = '[&_[data-slot=progress-indicator]]:bg-amber-500'
  } else {
    colorClass = '[&_[data-slot=progress-indicator]]:bg-emerald-500'
  }

  return (
    <div className="flex items-center gap-3 min-w-[120px]">
      <span className="text-sm text-muted-foreground whitespace-nowrap">
        {enrolled} / {max}
      </span>
      <Progress
        value={capped}
        className={cn('h-2 flex-1', colorClass)}
      />
    </div>
  )
}
