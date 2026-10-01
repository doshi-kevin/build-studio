// Wraps each editable block on the canvas.
//
// The canvas used to label every block with its type in small caps at all times
// ("TEXT", "KEY STATEMENT", "SECTION BREAK"), which is most of what made edit
// mode read as a form rather than as the page. Blocks that carry their own
// heading now show that heading and nothing else; only the ones with no heading
// of their own fall back to the type name, and the type name is always available
// on the toolbar's tooltips.
//
// States:
//   - Resting:  no border, no chrome. The block looks like its content.
//   - Hover:    a hairline border and a soft lift; the toolbar fades in.
//   - Editing:  (focus-within) a faint tint — "you are working here".
//   - Folded:   one summary line ("Weekly Schedule · 14 weeks"), click to open.
//
// Folding is a canvas-only view state (see BlockEditorContext); students never
// see it and it is never written to the database.

'use client'

import { type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { cn } from '@/lib/utils'
import type { AboutBlock } from '@/lib/validations/course-about'
import { BLOCK_REGISTRY, blockSummaryLine, useBlockEditor } from '../block-editor'
import { BlockToolbar } from './BlockToolbar'
import { ChangeReviewBar } from './ChangeReviewBar'

interface Props {
  block: AboutBlock
  children: ReactNode
}

/* Blocks that render their own title field inside their editor. Repeating it in
   the wrapper would print the same words twice on the canvas. `contact` is
   deliberately NOT in this set: its editor renders labeled fields (Name,
   Email, ...) but no title of its own, so expanded on the canvas it had no
   section identity at all — the wrapper's "Contact & Office Hours" fallback
   is the only thing naming it. */
const SELF_TITLING = new Set<AboutBlock['type']>([
  'syllabus', 'learning-outcomes', 'faq', 'callout', 'highlight-box', 'table',
])

export function SortableBlockWrapper({ block, children }: Props) {
  const { collapsedIds, toggleCollapsed, changedIds } = useBlockEditor()
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: block.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  const meta = BLOCK_REGISTRY[block.type]
  const label = meta?.label || block.type
  const isDivider = block.type === 'divider'
  const recentlyChanged = changedIds.has(block.id)
  // A block Athena just touched opens even if it would otherwise be folded —
  // reviewing a change inside a collapsed summary row isn't reviewing it.
  const collapsed = collapsedIds.has(block.id) && !isDivider && !recentlyChanged

  return (
    <div
      ref={setNodeRef}
      style={style}
      id={`about-block-${block.id}`}
      data-block-id={block.id}
      className={cn(
        'group relative rounded-2xl border border-transparent transition-[transform,background-color,border-color,box-shadow,opacity] duration-200',
        'hover:border-border hover:shadow-[0_4px_24px_-12px_rgba(0,0,0,0.12)] hover:-translate-y-0.5',
        'focus-within:bg-muted/30 focus-within:border-border',
        isDragging && 'opacity-60 border-foreground/30 bg-muted/40 shadow-lg',
        collapsed && 'border-border/60 bg-muted/20 hover:bg-muted/40',
        // The dedicated AI-provenance token, not `primary` — `--ring` (the
        // focus outline) is also `--primary`, so "Athena changed this" and
        // "this field is focused" would otherwise share a hue on the same
        // surface. This pair is contrast-checked for exactly this job and
        // already means "AI touched this" elsewhere (QuestionSourceChip).
        recentlyChanged && 'border-ai-muted-foreground/40 bg-ai-muted',
      )}
      {...attributes}
    >
      {/* Toolbar rail. A divider gets no heading row of its own — it is a rule,
          not a section, so the toolbar floats over it instead of above it.
          Folded rows stack below `sm`: side-by-side, the 44px touch-sized
          toolbar (see BlockToolbar) left a ~136px column for the label, and
          "Weekly Schedule · 14 weeks" wrapped to three cramped lines fighting
          the icon row. Stacked, the label gets the full width and the toolbar
          drops to its own line underneath. */}
      <div
        className={cn(
          'flex gap-3',
          isDivider ? 'absolute right-0 top-0 z-10 h-full px-2 items-center' : 'px-3 sm:px-4',
          collapsed
            ? 'flex-col items-stretch py-2.5 sm:flex-row sm:items-center sm:justify-between'
            : 'items-center justify-between pt-3 pb-1',
        )}
      >
        {/* Expanded + self-titling has no label to show here (the editor below
            renders its own title field) — the toolbar's own "Hide this
            section" button already gives an accessible, non-empty way to fold
            it, so this element renders nothing rather than a focusable button
            with no name and no visible box (a real screen-reader and
            keyboard-nav bug: "button, expanded", nowhere to draw a ring). */}
        {!isDivider && (collapsed || !SELF_TITLING.has(block.type)) && (
          <button
            type="button"
            onClick={() => toggleCollapsed(block.id)}
            aria-expanded={!collapsed}
            className={cn(
              'flex min-w-0 flex-1 items-center gap-2 rounded-xl text-left',
              collapsed
                ? 'text-sm font-medium text-foreground'
                : 'text-xs text-muted-foreground hover:text-foreground',
            )}
          >
            {/* A folded section has to read as a row you can open. Without the
                chevron it looked like a stray label floating in white space. */}
            {collapsed && <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
            {/* Wraps on a phone rather than truncating: "Weekly Schedule · 14
                weeks" was cut to "Weekly Schedu…", losing the count. */}
            <span className="whitespace-normal break-words sm:truncate">
              {collapsed ? blockSummaryLine(block, label) : label}
            </span>
          </button>
        )}
        <BlockToolbar block={block} dragListeners={listeners} />
      </div>

      {/* recentlyChanged forces collapsed false above, so this row only ever
          renders open — no folded state to coordinate spacing with. */}
      {recentlyChanged && !isDivider && (
        <div className="px-3 sm:px-4 pb-2">
          <ChangeReviewBar />
        </div>
      )}

      {!collapsed && (
        <div className={cn(isDivider ? 'px-4 py-2' : 'px-3 sm:px-4 pb-4')}>{children}</div>
      )}
    </div>
  )
}
