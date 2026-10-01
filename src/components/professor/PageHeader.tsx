/**
 * PageHeader — the standard title block for every professor course-dashboard tab.
 *
 * One source of truth for tab-title typography (replaces the old per-tab
 * `font-[family-name:var(--font-instrument-serif)] text-[32px]` headers that
 * had drifted to 24/28/32px). Title can be a string or node (for an inline
 * icon); `actions` holds right-aligned controls (e.g. a primary button).
 *
 * Server-safe (no client hooks).
 */

import { cn } from '@/lib/utils'

export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between', className)}>
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}
