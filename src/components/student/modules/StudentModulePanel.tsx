/**
 * StudentModulePanel — the selected week's materials, full width under its row.
 *
 * The tile grid's counterpart to the list's expanded section. It carries the same
 * element ids the list section does (`module-panel-<id>`, and it points back at the
 * tile's `module-header-<id>`) because that is what the citation deep links scroll
 * to — see the `?item=` / `?section=` handling in StudentModulesList.
 *
 * Materials are the SAME rows the list renders, unchanged. A row deliberately owns
 * no border of its own, so here each one gets a card wrapper — the panel is a
 * tinted surface, and rows sitting directly on it would read as one undivided
 * block.
 *
 * Type: Client Component
 */
'use client'

import { ChevronUp } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { StudentModuleItemRow } from './StudentModuleItemRow'
import type { StudentModule, StudentModuleItem } from './types'

interface StudentModulePanelProps {
  module: StudentModule
  items: StudentModuleItem[]
  sectionId: string
  onCollapse: () => void
  primerItemIds: Set<string>
  highlightedItemId: string | null
  deepLinkItemId?: string | null
  deepLinkPage?: number
}

export function StudentModulePanel({
  module,
  items,
  sectionId,
  onCollapse,
  primerItemIds,
  highlightedItemId,
  deepLinkItemId,
  deepLinkPage,
}: StudentModulePanelProps) {
  return (
    <div
      /* -1: programmatically focusable, never a tab stop of its own. The reader is
         moved here by the tile's click handler (see StudentModulesList.selectTile)
         rather than by an effect in here — the panel is a SIBLING of its tile, up
         to a full row away in reading order, so opening one has to bring the reader
         to it. Doing it from the handler means a panel RESTORED on load doesn't
         steal focus or yank the page before the reader has touched anything. */
      tabIndex={-1}
      id={`module-panel-${module.id}`}
      role="region"
      /* Names the region with the panel's own heading, not the tile's whole
         accessible name — that would announce the week, title, description AND
         contents summary before the word "region" in a landmark list. */
      aria-labelledby={`module-panel-title-${module.id}`}
      className="rounded-2xl border border-border bg-muted/30 p-4 focus:outline-none sm:p-5"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          {module.week_number !== null && (
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Week {module.week_number}
            </p>
          )}
          {/* line-clamp-2, not truncate: the tile that got the reader here shows
              two lines, and the detail view must never show LESS of the title
              than the summary card above it. */}
          <h3
            id={`module-panel-title-${module.id}`}
            className="line-clamp-2 text-base font-semibold text-foreground"
          >
            {module.title}
          </h3>
          {module.description && (
            <p className="mt-0.5 text-sm text-muted-foreground">{module.description}</p>
          )}
        </div>

        <Button variant="outline" size="sm" onClick={onCollapse} className="shrink-0 self-start">
          Collapse
          <ChevronUp className="h-4 w-4" aria-hidden />
        </Button>
      </div>

      {items.length > 0 ? (
        /* Two columns only at xl, where the panel is wide enough for them. At sm
           each column left ~19 characters of title after the row's fixed chrome
           (icon chip, gap, trailing controls, padding ≈ 134px), and a filename
           carries its distinguishing part in the TAIL — `_v3_FINAL` — so two files
           from one week collapsed to the same visible string. */
        <div className="mt-4 grid gap-3 xl:grid-cols-2">
          {items.map((item) => (
            <div
              key={item.id}
              className={cn(
                // A divider is structure, not material — it labels everything after
                // it, so it spans the grid and takes no card chrome.
                item.item_type === 'section_divider'
                  ? 'xl:col-span-2'
                  : 'rounded-xl border border-border bg-card',
              )}
            >
              <StudentModuleItemRow
                item={item}
                sectionId={sectionId}
                primerAvailable={primerItemIds.has(item.id)}
                highlighted={highlightedItemId === item.id}
                openAtPage={deepLinkItemId === item.id ? deepLinkPage : undefined}
              />
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-4 py-6 text-center text-xs text-muted-foreground">
          Your instructor hasn’t added anything here yet.
        </p>
      )}
    </div>
  )
}
