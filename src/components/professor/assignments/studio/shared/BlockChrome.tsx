/**
 * BlockChrome — a reusable wrapper for embed-block NodeViews giving the "frameless at rest,
 * chrome on hover" interaction grammar.
 *
 * - Rest: no border, no background, no buttons — just children with small vertical padding.
 * - Hover OR selected: a soft halo (ring-2 ring-accent; ring-ring when selected) + a floating
 *   pill toolbar overlapping the block's top-right edge with an optional Edit chip, align
 *   buttons, Duplicate, and Delete.
 * - Double-click opens the editor (calls onEdit, only when onEdit is provided).
 * - Resize handles appear on left/right edges when hovered/selected and onResize is provided.
 * - Respects `prefers-reduced-motion` (transition is skipped when reduced-motion is preferred).
 *
 * Optional props (align, onAlign, width, onResize, onEdit, editLabel) are all optional so that
 * Phase-1 blocks that pass only the original props keep working unchanged.
 */
'use client'

import { useState, useCallback, useRef } from 'react'
import { Copy, Trash2, AlignLeft, AlignCenter, AlignRight } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import type { Editor } from '@tiptap/core'

export type BlockAlign = 'left' | 'center' | 'right'

/** Width snaps: dragging snaps to the nearest of these percent values. */
const SNAPS = [25, 33, 50, 66, 75, 100]

function snapWidth(pct: number): number {
  let best = SNAPS[0]
  let bestDist = Math.abs(pct - best)
  for (const s of SNAPS) {
    const d = Math.abs(pct - s)
    if (d < bestDist) { best = s; bestDist = d }
  }
  return best
}

export interface BlockChromeProps {
  /** The TipTap editor instance — used to check isEditable. */
  editor: Editor
  /** Whether ProseMirror has selected this node. */
  selected: boolean
  /** Open the block's edit panel. Optional — if absent, no Edit chip is rendered. */
  onEdit?: () => void
  /** Delete the node from the document. */
  onDelete: () => void
  /** Insert a copy of the node after the current one. */
  onDuplicate: () => void
  /** Label for the primary Edit chip, e.g. "Edit chart". Required when onEdit is provided. */
  editLabel?: string
  children: React.ReactNode

  // ── Alignment ────────────────────────────────────────────────────────────────
  /** Current alignment of the block. When provided, three align buttons appear in the pill. */
  align?: BlockAlign
  /** Called when the user picks an alignment. Must be provided together with `align`. */
  onAlign?: (a: BlockAlign) => void

  // ── Width / resize ───────────────────────────────────────────────────────────
  /** Current width as a percent (25–100). When provided, side drag handles are rendered. */
  width?: number
  /** Called with the new snapped percent when the user finishes dragging. */
  onResize?: (pct: number) => void
}

export function BlockChrome({
  editor,
  selected,
  onEdit,
  onDelete,
  onDuplicate,
  editLabel,
  children,
  align,
  onAlign,
  width,
  onResize,
}: BlockChromeProps) {
  const canEdit = editor.isEditable
  const [hovered, setHovered] = useState(false)
  const [dragging, setDragging] = useState<'left' | 'right' | null>(null)
  const [liveWidth, setLiveWidth] = useState<number | null>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)

  const showChrome = canEdit && (hovered || selected)
  const displayWidth = liveWidth ?? width ?? 100
  const hasResize = canEdit && typeof width === 'number' && typeof onResize === 'function'
  const hasAlign = canEdit && typeof align === 'string' && typeof onAlign === 'function'

  // Deleting an embed block is easy to mis-click (small pill target, irreversible-looking). Fire an
  // undo toast that reverts via the editor's own history, so recovery is one obvious click.
  const handleDelete = useCallback(() => {
    onDelete()
    toast('Block deleted', { action: { label: 'Undo', onClick: () => editor.commands.undo() } })
  }, [onDelete, editor])

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (!canEdit || !onEdit) return
      e.preventDefault()
      onEdit()
    },
    [canEdit, onEdit],
  )

  // ── Resize drag logic ────────────────────────────────────────────────────────
  const startDrag = useCallback(
    (side: 'left' | 'right') => (e: React.MouseEvent) => {
      if (!hasResize || !wrapperRef.current) return
      e.preventDefault()
      e.stopPropagation()

      setDragging(side)
      const startX = e.clientX
      const containerWidth = wrapperRef.current.parentElement?.getBoundingClientRect().width ?? wrapperRef.current.getBoundingClientRect().width / ((width ?? 100) / 100)
      const startPct = width ?? 100

      function onMove(mv: MouseEvent) {
        const delta = mv.clientX - startX
        // Right handle: drag right = wider; left handle: drag left = wider.
        const sign = side === 'right' ? 1 : -1
        const newPct = Math.min(100, Math.max(25, startPct + sign * (delta / containerWidth) * 100))
        setLiveWidth(Math.round(newPct))
      }

      function onUp(mv: MouseEvent) {
        const delta = mv.clientX - startX
        const sign = side === 'right' ? 1 : -1
        const rawPct = startPct + sign * (delta / containerWidth) * 100
        const snapped = snapWidth(Math.min(100, Math.max(25, rawPct)))
        setLiveWidth(null)
        setDragging(null)
        onResize?.(snapped)
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }

      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [hasResize, width, onResize],
  )

  // Alignment wrapper classes.
  const alignClass =
    align === 'left' ? 'mr-auto' :
    align === 'right' ? 'ml-auto' :
    'mx-auto'

  return (
    // Outer div provides the centering/alignment context.
    <div
      style={hasResize ? { width: `${displayWidth}%` } : undefined}
      className={cn(
        hasResize && alignClass,
        !hasResize && 'w-full',
      )}
    >
      {/* Inner wrapper: halo + relative positioning for handles and toolbar */}
      <div
        ref={wrapperRef}
        className={cn(
          'relative my-4 py-1',
          'rounded-xl transition-shadow motion-reduce:transition-none',
          selected
            ? 'ring-2 ring-ring'
            : hovered
              ? 'ring-2 ring-accent'
              : 'ring-0',
        )}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onDoubleClick={handleDoubleClick}
      >
        {/* Floating pill toolbar — overlaps the block's top-right edge */}
        {showChrome && (
          <div
            className="absolute -top-3 right-2 z-10 flex items-center gap-0 overflow-hidden rounded-full border border-border bg-background/95 shadow-md backdrop-blur-sm"
            onMouseEnter={(e) => e.stopPropagation()}
          >
            {/* Align buttons — rendered before Edit/Duplicate when onAlign is provided */}
            {hasAlign && (
              <>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onAlign!('left') }}
                  title="Align left"
                  aria-label="Align left"
                  aria-pressed={align === 'left'}
                  className={cn(
                    'flex h-7 w-7 items-center justify-center transition-colors',
                    align === 'left'
                      ? 'bg-accent text-accent-foreground'
                      : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                  )}
                >
                  <AlignLeft className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onAlign!('center') }}
                  title="Align center"
                  aria-label="Align center"
                  aria-pressed={align === 'center'}
                  className={cn(
                    'flex h-7 w-7 items-center justify-center transition-colors',
                    align === 'center'
                      ? 'bg-accent text-accent-foreground'
                      : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                  )}
                >
                  <AlignCenter className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onAlign!('right') }}
                  title="Align right"
                  aria-label="Align right"
                  aria-pressed={align === 'right'}
                  className={cn(
                    'flex h-7 w-7 items-center justify-center transition-colors',
                    align === 'right'
                      ? 'bg-accent text-accent-foreground'
                      : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                  )}
                >
                  <AlignRight className="h-3.5 w-3.5" />
                </button>
                <div className="mx-0.5 h-4 w-px bg-border" aria-hidden />
              </>
            )}

            {/* Primary Edit chip — only when onEdit is provided */}
            {onEdit && editLabel && (
              <>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onEdit() }}
                  className="flex items-center gap-1.5 rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
                >
                  {editLabel}
                </button>
                <div className="mx-0.5 h-4 w-px bg-border" aria-hidden />
              </>
            )}

            {/* Duplicate */}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onDuplicate() }}
              title="Duplicate block"
              aria-label="Duplicate block"
              className="flex h-7 w-7 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <Copy className="h-3.5 w-3.5" />
            </button>

            {/* Delete — separated from Duplicate so it isn't mis-clicked; undoable via toast. */}
            <div className="mx-0.5 h-4 w-px bg-border" aria-hidden />
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); handleDelete() }}
              title="Delete block"
              aria-label="Delete block"
              className="flex h-7 w-7 items-center justify-center rounded-r-full text-muted-foreground transition-colors hover:bg-accent hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* Left resize handle */}
        {hasResize && showChrome && (
          <div
            className={cn(
              'absolute left-0 top-1/2 z-20 -translate-x-3 -translate-y-1/2',
              dragging === 'left' ? 'cursor-col-resize' : 'cursor-ew-resize',
            )}
            onMouseDown={startDrag('left')}
            aria-label="Resize left"
          >
            <div className="h-12 w-1.5 rounded-full bg-primary opacity-70 transition-opacity hover:opacity-100" />
          </div>
        )}

        {/* Right resize handle */}
        {hasResize && showChrome && (
          <div
            className={cn(
              'absolute right-0 top-1/2 z-20 translate-x-3 -translate-y-1/2',
              dragging === 'right' ? 'cursor-col-resize' : 'cursor-ew-resize',
            )}
            onMouseDown={startDrag('right')}
            aria-label="Resize right"
          >
            <div className="h-12 w-1.5 rounded-full bg-primary opacity-70 transition-opacity hover:opacity-100" />
          </div>
        )}

        {/* Width badge during drag */}
        {dragging && liveWidth !== null && (
          <div className="pointer-events-none absolute bottom-2 left-1/2 z-30 -translate-x-1/2 rounded-full border border-border bg-background/95 px-2 py-0.5 text-xs font-medium tabular-nums text-foreground shadow-md">
            {liveWidth}%
          </div>
        )}

        {children}
      </div>
    </div>
  )
}
