/**
 * StudentModuleSection — one collapsible module of course material.
 *
 * The section is the only card on the screen; its items are rows inside it.
 * Collapsed is the default, so the header has to answer "what will I find in
 * here?" on its own — hence the contents summary ("3 readings, 1 deck").
 *
 * Type: Client Component
 */
'use client'

import { ChevronRight, Lock } from 'lucide-react'
import { cn } from '@/lib/utils'
import { isUnlockPending, unlockLabel } from '@/lib/modules/unlock'
import { sectionContentsSummary } from '@/components/shared/modules/module-item-display'
import { StudentModuleItemRow } from './StudentModuleItemRow'
import type { StudentModule, StudentModuleItem } from './types'

interface StudentModuleSectionProps {
  module: StudentModule
  items: StudentModuleItem[]
  sectionId: string
  expanded: boolean
  onToggle: () => void
  primerItemIds: Set<string>
  highlightedItemId: string | null
  deepLinkItemId?: string | null
  deepLinkPage?: number
  /** True while a search/filter is active — changes the empty copy. */
  filtering: boolean
}

export function StudentModuleSection({
  module,
  items,
  sectionId,
  expanded,
  onToggle,
  primerItemIds,
  highlightedItemId,
  deepLinkItemId,
  deepLinkPage,
  filtering,
}: StudentModuleSectionProps) {
  const summary = sectionContentsSummary(items)
  const contentCount = items.filter((i) => i.item_type !== 'section_divider').length
  const panelId = `module-panel-${module.id}`
  const headerId = `module-header-${module.id}`
  const summaryText = summary || (contentCount === 0 ? 'Empty' : `${contentCount} items`)
  const toggleLocked = filtering

  /* Published, but its open date hasn't arrived. Shown rather than hidden so the
     course visibly continues past today — the same call the roadmap makes. The page
     never fetched its items, so there is nothing to expand onto: this renders as a
     flat, inert row, not a collapsed one. An unpublished module never reaches here
     at all (the query drops it), which is the distinction being drawn. */
  if (isUnlockPending(module.unlock_date)) {
    const opens = unlockLabel(module.unlock_date)
    return (
      <div className="rounded-2xl border border-dashed border-border bg-muted/30 px-5 py-4">
        <div className="flex items-center gap-3">
          {/* Where the chevron would be, so the list keeps one left edge. */}
          <Lock className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0 flex-1 basis-0">
            {module.week_number !== null && (
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Week {module.week_number}
              </p>
            )}
            <h3 className="truncate text-sm font-semibold text-muted-foreground">{module.title}</h3>
            {module.description && (
              <p className="line-clamp-1 text-xs text-muted-foreground">{module.description}</p>
            )}
          </div>
          {/* suppressHydrationWarning: formatted in the reader's timezone, which can
              differ from the server's by a day near midnight. */}
          <span
            className="shrink-0 text-xs font-medium text-muted-foreground"
            suppressHydrationWarning
          >
            {opens ?? 'Not open yet'}
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card transition duration-200 ease-out hover:border-ring/40">
      <button
        type="button"
        id={headerId}
        onClick={toggleLocked ? undefined : onToggle}
        aria-expanded={expanded}
        aria-disabled={toggleLocked || undefined}
        {...(expanded ? { 'aria-controls': panelId } : {})}
        className="flex w-full items-center gap-3 px-5 py-4 text-left transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <ChevronRight
          className={cn(
            'h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200',
            expanded && 'rotate-90',
            toggleLocked && 'opacity-40',
          )}
          aria-hidden
        />

        <div className="min-w-0 flex-1 basis-0">
          {/* Week sits ABOVE the title, not beside it — a side rail made every
              week-less module start at a different x and left the list ragged. */}
          {module.week_number !== null && (
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Week {module.week_number}
            </p>
          )}
          <h3 className="truncate text-sm font-semibold text-foreground">{module.title}</h3>
          {module.description && (
            <p className="line-clamp-1 text-xs text-muted-foreground">{module.description}</p>
          )}
          {/* Own line on phones rather than hidden — see the professor section. */}
          <p className="text-xs tabular-nums text-muted-foreground sm:hidden">{summaryText}</p>
        </div>

        <span className="hidden shrink-0 text-xs tabular-nums text-muted-foreground sm:inline">
          {summaryText}
        </span>
      </button>

      {expanded && (
        <div
          id={panelId}
          role="region"
          aria-labelledby={headerId}
          className="border-t border-border/60"
        >
          {items.length > 0 ? (
            <div className="divide-y divide-border/50">
              {items.map((item) => (
                <StudentModuleItemRow
                  key={item.id}
                  item={item}
                  sectionId={sectionId}
                  primerAvailable={primerItemIds.has(item.id)}
                  highlighted={highlightedItemId === item.id}
                  openAtPage={deepLinkItemId === item.id ? deepLinkPage : undefined}
                />
              ))}
            </div>
          ) : (
            <p className="px-5 py-6 text-center text-xs text-muted-foreground">
              {filtering
                ? 'Nothing in this module matches your search.'
                : 'Your instructor hasn’t added anything here yet.'}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
