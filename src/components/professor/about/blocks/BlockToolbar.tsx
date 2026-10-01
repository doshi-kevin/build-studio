// Per-block toolbar — only visible on hover so it doesn't compete with content.
// Monochrome icons; the delete uses muted-foreground (instead of the red
// destructive variant) so it doesn't shout at professors who are just trying
// to read their page. Delete fires an Undo toast — autosave runs ~1.5s after
// the action, so a toast is the only practical safety net before the loss
// becomes permanent on the server.

'use client'

import { GripVertical, Copy, Trash2, ChevronDown, ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useBlockEditor } from '../block-editor'
import type { AboutBlock } from '@/lib/validations/course-about'
import type { SyntheticListenerMap } from '@dnd-kit/core/dist/hooks/utilities'

interface Props {
  block: AboutBlock
  dragListeners?: SyntheticListenerMap
}

export function BlockToolbar({ block, dragListeners }: Props) {
  const { state, dispatch, collapsedIds, toggleCollapsed } = useBlockEditor()
  const collapsed = collapsedIds.has(block.id)

  const handleDelete = () => {
    const idx = state.blocks.findIndex((b) => b.id === block.id)
    if (idx === -1) return
    /* Snapshot the block + its position so Undo can restore both. */
    const removed = state.blocks[idx]
    dispatch({ type: 'REMOVE_BLOCK', payload: { blockId: block.id } })
    toast('Section removed', {
      action: {
        label: 'Undo',
        onClick: () => {
          dispatch({ type: 'ADD_BLOCK', payload: { block: removed, afterIndex: idx } })
        },
      },
    })
  }

  return (
    /* Visible by default, hover-revealed only where there IS a hover.
       This was `opacity-0 group-hover:opacity-100`, which on a touch device
       never resolves: the toolbar stayed invisible, so there was no way to
       reorder or delete a section on a phone — while the buttons still
       hit-tested, so tapping apparently-empty space deleted one. Pointer-events
       now track opacity, so an invisible toolbar is also an untappable one. */
    <div
      className={cn(
        'flex items-center gap-1 sm:gap-0.5 transition-opacity',
        'opacity-100',
        'sm:opacity-0 sm:pointer-events-none',
        'sm:group-hover:opacity-100 sm:group-hover:pointer-events-auto',
        'sm:focus-within:opacity-100 sm:focus-within:pointer-events-auto',
      )}
    >
      {/* Drag handle */}
      <button
        aria-label="Drag to reorder"
        className="flex h-11 w-11 sm:h-7 sm:w-7 cursor-grab active:cursor-grabbing items-center justify-center rounded-md hover:bg-muted text-muted-foreground"
        {...dragListeners}
      >
        <GripVertical className="h-3.5 w-3.5" />
      </button>

      {/* Collapse toggle (not for dividers) */}
      {block.type !== 'divider' && (
        <Button
          variant="ghost"
          size="icon"
          className="h-11 w-11 sm:h-7 sm:w-7 text-muted-foreground hover:text-foreground"
          onClick={() => toggleCollapsed(block.id)}
          aria-label={collapsed ? 'Show this section' : 'Hide this section'}
        >
          {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </Button>
      )}

      {/* Duplicate */}
      <Button
        variant="ghost"
        size="icon"
        className="h-11 w-11 sm:h-7 sm:w-7 text-muted-foreground hover:text-foreground"
        onClick={() => dispatch({ type: 'DUPLICATE_BLOCK', payload: { blockId: block.id } })}
        aria-label="Duplicate this section"
      >
        <Copy className="h-3.5 w-3.5" />
      </Button>

      {/* Delete — quiet by default, gains weight on hover so it's still a clear destructive action.
          Extra left margin below sm: a mis-tap next to Duplicate is the whole reason 28px targets
          weren't enough on their own — distance from its neighbor matters as much as its own size. */}
      <Button
        variant="ghost"
        size="icon"
        className="ml-2 sm:ml-0 h-11 w-11 sm:h-7 sm:w-7 text-muted-foreground hover:text-foreground hover:bg-muted"
        onClick={handleDelete}
        aria-label="Delete this section"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  )
}
