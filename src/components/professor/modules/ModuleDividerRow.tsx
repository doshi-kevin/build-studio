/**
 * ModuleDividerRow — the professor's sortable, editable divider row: a labelled
 * break between module sections. Same treatment as the in-module section
 * divider (a `section_divider` item row) so the two read as one idea at two
 * levels.
 *
 * Students see the same breaks in the same order (StudentModulesList renders
 * DividerRule directly, and the roadmap reads the shared position scale) — this
 * component is only the professor's editing chrome on top of that.
 *
 * Type: Client Component
 */
'use client'

import { useEffect, useRef } from 'react'
import { useReducedMotion } from 'framer-motion'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical, Loader2, Pencil, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FOCUS_RING } from '@/components/shared/modules/module-item-display'
import { DividerRule } from '@/components/shared/modules/DividerRule'
import type { ModuleDivider } from '@/components/shared/modules/module-rows'
import { SECTION_ACTIONS, RowAction } from './ModuleRowActions'

interface ModuleDividerRowProps {
  divider: ModuleDivider
  /** Just created: scroll it into view and ring it, since it appends at the end
   *  of a list that is usually taller than the viewport. */
  highlight?: boolean
  /** This row is mid-save — the board's summary indicator is off-screen for
   *  anything below the fold, so the affordance travels to the row. */
  pending?: boolean
  onEdit: () => void
  onDelete: () => void
}

export function ModuleDividerRow({
  divider,
  highlight,
  pending,
  onEdit,
  onDelete,
}: ModuleDividerRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: divider.id,
    data: { type: 'divider' },
  })
  const rowRef = useRef<HTMLDivElement | null>(null)
  // The row appends at the end of the list, so this can animate the viewport
  // across the whole page — a vestibular trigger. The JS `behavior` option beats
  // CSS scroll-behavior, so the preference has to be honoured here (AnimatedItem,
  // which wraps this row, already does the same for its entrance).
  const reduce = useReducedMotion()

  useEffect(() => {
    if (highlight) rowRef.current?.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' })
  }, [highlight, reduce])

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  return (
    <div
      ref={(el) => { setNodeRef(el); rowRef.current = el }}
      style={style}
      className={cn(
        'group/section transition-shadow',
        /* A divider at rest is two hairlines and grey text — at 50% opacity with
           no fill there is nothing left to track across a 12-module list. While
           lifted it becomes a card, matching what a dragged module does. */
        isDragging && 'rounded-xl bg-card px-2 opacity-90 shadow-lg ring-2 ring-ring/30',
        highlight && 'rounded-xl px-2 -mx-2 ring-2 ring-ring/40',
      )}
    >
      <DividerRule
        title={divider.title}
        leading={
          pending ? (
            <span
              className="flex min-h-11 min-w-11 items-center justify-center text-muted-foreground sm:min-h-0 sm:min-w-0 sm:px-1"
              aria-live="polite"
              aria-label="Saving"
            >
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
            </span>
          ) : (
            <button
              type="button"
              aria-label={`Reorder ${divider.title}`}
              className={cn(
                'flex cursor-grab items-center justify-center text-muted-foreground/40 transition-colors hover:text-muted-foreground active:cursor-grabbing',
                'min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 sm:px-1',
                FOCUS_RING,
              )}
              {...attributes}
              {...listeners}
            >
              <GripVertical className="h-4 w-4" aria-hidden />
            </button>
          )
        }
        trailing={
          <div className={SECTION_ACTIONS}>
            <RowAction icon={Pencil} label={`Rename ${divider.title}`} onClick={onEdit} />
            <RowAction icon={Trash2} label={`Remove ${divider.title}`} onClick={onDelete} destructive />
          </div>
        }
      />
    </div>
  )
}
