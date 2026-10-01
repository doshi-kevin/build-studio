/**
 * A fixed-width column with a drag handle on its LEFT edge, so the panel can be widened
 * (drag left) or narrowed (drag right) by the user. Used for the AI and inspector columns
 * on the right; the center canvas absorbs whatever space they give up.
 */
'use client'

import { useRef } from 'react'
import { cn } from '@/lib/utils'

interface Props {
  width: number
  onResize: (w: number) => void
  min?: number
  max?: number
  /** Which edge the drag handle sits on. 'left' (default) for right-side columns; 'right' for a left rail. */
  side?: 'left' | 'right'
  className?: string
  children: React.ReactNode
}

export function ResizableColumn({ width, onResize, min = 240, max = 520, side = 'left', className, children }: Props) {
  const drag = useRef<{ startX: number; startW: number } | null>(null)

  function onPointerDown(e: React.PointerEvent) {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { startX: e.clientX, startW: width }
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!drag.current) return
    // left handle: drag left → wider; right handle: drag right → wider.
    const delta = side === 'right' ? e.clientX - drag.current.startX : drag.current.startX - e.clientX
    onResize(Math.min(max, Math.max(min, drag.current.startW + delta)))
  }
  function onPointerUp(e: React.PointerEvent) {
    drag.current = null
    e.currentTarget.releasePointerCapture(e.pointerId)
  }

  return (
    <div className={cn('relative shrink-0', className)} style={{ width }}>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        className={cn(
          'group absolute top-0 z-10 flex h-full w-4 cursor-col-resize items-stretch justify-center',
          side === 'right' ? '-right-2' : '-left-2',
        )}
      >
        <span className="h-full w-px bg-border transition-[width,background-color] group-hover:w-0.5 group-hover:bg-primary/50" />
      </div>
      {children}
    </div>
  )
}
