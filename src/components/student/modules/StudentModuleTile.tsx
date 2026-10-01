/**
 * StudentModuleTile — one week of course material as a card in the tile grid.
 *
 * The tile is a SUMMARY, not a container: selecting it opens the full-width
 * StudentModulePanel under its row of tiles, and the tile itself only takes a
 * highlighted border and flips its chevron. So the header has to answer "what will
 * I find in here?" on its own — hence the contents summary ("2 readings, 1 deck"),
 * the same one the collapsed list section shows.
 *
 * A week that hasn't opened yet renders as an inert card with no way in, matching
 * the list's locked row: the page never fetched its items, so there is nothing
 * behind it to open, and this component must never print items even if handed some.
 *
 * Type: Client Component
 */
'use client'

import { ChevronDown, Lock } from 'lucide-react'
import { cn } from '@/lib/utils'
import { isUnlockPending, unlockLabel } from '@/lib/modules/unlock'
import {
  sectionContentsSummary,
  FOCUS_RING,
} from '@/components/shared/modules/module-item-display'
import type { StudentModule, StudentModuleItem } from './types'

interface StudentModuleTileProps {
  module: StudentModule
  items: StudentModuleItem[]
  /** This week's panel is the one currently open. */
  selected: boolean
  onSelect: () => void
}

/** Shared by both states so the grid keeps one card silhouette. */
const CARD = 'flex h-full flex-col rounded-2xl px-4 py-3 text-left'

export function StudentModuleTile({ module, items, selected, onSelect }: StudentModuleTileProps) {
  const week = module.week_number !== null ? `Week ${module.week_number}` : null

  /* Published, but its open date hasn't arrived. Shown rather than hidden so the
     course visibly continues past today — the same call the list and the roadmap
     make. Rendered as a plain div, never a button: no expand affordance is the
     disclosure boundary these tests assert on. */
  if (isUnlockPending(module.unlock_date)) {
    return (
      /* cursor-not-allowed is the only hover response an inert card can honestly
         give: in a grid every sibling is a card-shaped button, so the shape itself
         reads as clickable even with five other "you can't" signals. */
      <div
        className={cn(
          CARD,
          'cursor-not-allowed border border-dashed border-border bg-muted/30',
        )}
      >
        <div className="flex items-start justify-between gap-2">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {week ? `${week} · Locked` : 'Locked'}
          </p>
          <Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        </div>
        {/* The title stays the title. Everything else on a locked card is muted,
            but four hierarchy levels in one grey — with the title among them —
            drops the one line students actually scan under the contrast floor. */}
        <h3 className="mt-1 line-clamp-2 text-sm font-semibold text-foreground/70">
          {module.title}
        </h3>
        {module.description && (
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{module.description}</p>
        )}
        {/* suppressHydrationWarning: formatted in the reader's timezone, which can
            differ from the server's by a day near midnight. */}
        <p
          className="mt-auto border-t border-border/60 pt-2.5 text-right text-xs font-medium text-muted-foreground"
          suppressHydrationWarning
        >
          {unlockLabel(module.unlock_date) ?? 'Not open yet'}
        </p>
      </div>
    )
  }

  const summary = sectionContentsSummary(items)
  const contentCount = items.filter((i) => i.item_type !== 'section_divider').length
  // Same fallback copy as the collapsed list section, so the two views agree.
  const summaryText = summary || (contentCount === 0 ? 'Empty' : `${contentCount} items`)

  return (
    <button
      type="button"
      id={`module-header-${module.id}`}
      onClick={onSelect}
      aria-expanded={selected}
      {...(selected ? { 'aria-controls': `module-panel-${module.id}` } : {})}
      className={cn(
        CARD,
        'w-full border bg-card transition duration-200 ease-out',
        FOCUS_RING,
        /* Selection is a FILL, not a ring. `--ring` and `--primary` are the same
           token, and Tailwind's ring utilities share one custom property — so a
           `ring-1 ring-primary` selection was overridden by the 3px focus ring the
           moment the tile was focused, leaving a keyboard reader to tell "open"
           from "focused" by ring thickness alone. The chevron flip is the second,
           non-colour signal; the panel appearing is the third. */
        selected
          ? 'border-primary bg-accent/50'
          : 'border-border hover:border-ring/40 hover:bg-muted/30',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{week}</p>
        <ChevronDown
          className={cn(
            'h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200',
            selected && 'rotate-180',
          )}
          aria-hidden
        />
      </div>

      <h3 className="mt-1 line-clamp-2 text-sm font-semibold text-foreground">{module.title}</h3>
      {module.description && (
        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{module.description}</p>
      )}

      <p className="mt-auto border-t border-border/60 pt-2.5 text-xs tabular-nums text-muted-foreground">
        {summaryText}
      </p>
    </button>
  )
}
