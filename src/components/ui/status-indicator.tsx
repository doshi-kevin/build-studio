/**
 * StatusIndicator -- small colored dot with optional text label for entity statuses.
 *
 * Renders a colored dot (8px) with an optional label next to it. Active and
 * suspended statuses include a CSS pulse animation via the status-dot-pulse class.
 *
 * Supported statuses:
 * - draft (amber)
 * - active (emerald, pulsing)
 * - inactive (muted)
 * - suspended (amber, pulsing)
 * - on_leave (sky)
 * - archived (muted, faint)
 * - cancelled / dropped (destructive)
 * - completed (emerald)
 * - enrolled (sky)
 *
 * Type: Client Component (simple, but often used inside client tables)
 */
'use client'

import { cn } from '@/lib/utils'

interface StatusIndicatorProps {
  status: string
  label?: string
  showLabel?: boolean
  className?: string
}

/** Map of status → { dot color class, whether to pulse, default label }
 * Colors are intentionally semantic — muted tones that fit the monochrome
 * editorial palette while still conveying meaning at a glance. */
const STATUS_CONFIG: Record<
  string,
  { dot: string; pulse: boolean; defaultLabel: string }
> = {
  draft: {
    dot: 'bg-warning',
    pulse: false,
    defaultLabel: 'Draft',
  },
  active: {
    dot: 'bg-success',
    pulse: true,
    defaultLabel: 'Active',
  },
  inactive: {
    dot: 'bg-muted-foreground/40',
    pulse: false,
    defaultLabel: 'Inactive',
  },
  suspended: {
    dot: 'bg-warning',
    pulse: true,
    defaultLabel: 'Suspended',
  },
  on_leave: {
    dot: 'bg-info',
    pulse: false,
    defaultLabel: 'On Leave',
  },
  archived: {
    dot: 'bg-muted-foreground/30',
    pulse: false,
    defaultLabel: 'Archived',
  },
  cancelled: {
    dot: 'bg-destructive',
    pulse: false,
    defaultLabel: 'Cancelled',
  },
  dropped: {
    dot: 'bg-destructive',
    pulse: false,
    defaultLabel: 'Dropped',
  },
  completed: {
    dot: 'bg-success',
    pulse: false,
    defaultLabel: 'Completed',
  },
  enrolled: {
    dot: 'bg-info',
    pulse: false,
    defaultLabel: 'Enrolled',
  },
  withdrawn: {
    dot: 'bg-destructive/70',
    pulse: false,
    defaultLabel: 'Withdrawn',
  },
}

const DEFAULT_CONFIG = { dot: 'bg-muted-foreground/40', pulse: false, defaultLabel: '' }

export function StatusIndicator({
  status,
  label,
  showLabel = true,
  className,
}: StatusIndicatorProps) {
  const config = STATUS_CONFIG[status] || DEFAULT_CONFIG
  const displayLabel = label || config.defaultLabel || status

  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      <span
        className={cn(
          'h-2 w-2 rounded-full shrink-0',
          config.dot,
          config.pulse && 'status-dot-pulse'
        )}
      />
      {showLabel && (
        <span className="text-sm text-muted-foreground">{displayLabel}</span>
      )}
    </span>
  )
}
