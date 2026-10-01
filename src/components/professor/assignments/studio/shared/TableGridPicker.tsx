/**
 * TableGridPicker — a Google-Docs-style hover grid for picking table dimensions.
 *
 * Shared between the right palette's Table insert button and the `/table` slash command so both
 * surfaces offer the same size picker (no duplicated grid logic).
 *
 * Type: Client Component
 */
'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'

const MAX = 8

export function TableGridPicker({ onPick }: { onPick: (rows: number, cols: number) => void }) {
  const [hover, setHover] = useState({ r: 0, c: 0 })
  return (
    <div className="p-2">
      <div
        className="grid gap-0.5"
        style={{ gridTemplateColumns: `repeat(${MAX}, 1.25rem)` }}
        onMouseLeave={() => setHover({ r: 0, c: 0 })}
      >
        {Array.from({ length: MAX * MAX }, (_, i) => {
          const r = Math.floor(i / MAX) + 1
          const c = (i % MAX) + 1
          const active = r <= hover.r && c <= hover.c
          return (
            <button
              key={i}
              type="button"
              aria-label={`${r} by ${c}`}
              className={cn('h-5 w-5 rounded border transition-colors', active ? 'border-primary bg-primary/20' : 'border-border bg-background')}
              onMouseEnter={() => setHover({ r, c })}
              onClick={() => onPick(r, c)}
            />
          )
        })}
      </div>
      <p className="mt-1.5 text-center text-xs text-muted-foreground">{hover.r > 0 ? `${hover.r} × ${hover.c}` : 'Pick a size'}</p>
    </div>
  )
}
