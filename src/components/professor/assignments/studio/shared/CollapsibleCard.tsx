/**
 * A collapsible card for the right rail. Closed/open on press; a chevron shows the state.
 * Used for Athena, Resources, and the Inspector so each section can be tucked away.
 */
'use client'

import { useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

export function CollapsibleCard({
  title, icon: Icon, defaultOpen = true, collapsible = true, badge, children,
}: {
  title: string
  icon: React.ComponentType<{ className?: string }>
  defaultOpen?: boolean
  /** When false, the card is a fixed section: header has no toggle and the body is always shown. */
  collapsible?: boolean
  badge?: ReactNode
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  const expanded = collapsible ? open : true

  const header = (
    <>
      <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-muted text-muted-foreground">
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
      <span className="text-sm font-semibold tracking-tight text-foreground">{title}</span>
      {badge}
      {collapsible && (
        <ChevronDown className={cn('ml-auto h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-150', open && 'rotate-180')} aria-hidden="true" />
      )}
    </>
  )

  return (
    <div className="rounded-2xl border border-border bg-card">
      {collapsible ? (
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-2 p-3 text-left">
          {header}
        </button>
      ) : (
        <div className="flex items-center gap-2 border-b border-border p-3">{header}</div>
      )}
      {expanded && <div className="space-y-3 px-3 pb-3 pt-3">{children}</div>}
    </div>
  )
}
