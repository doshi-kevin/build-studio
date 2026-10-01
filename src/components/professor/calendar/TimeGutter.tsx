'use client'

import { generateTimeLabels, ROW_HEIGHT_PX } from '@/lib/calendar/utils'

/**
 * Left-side time gutter showing hour labels (7 AM – 9 PM).
 * Only shows labels on the hour (skips half-hour rows).
 */
export function TimeGutter() {
  const labels = generateTimeLabels()

  return (
    <div className="relative" style={{ width: 60 }}>
      {labels.map((label, i) => (
        <div
          key={i}
          className="absolute right-2 text-xs text-muted-foreground leading-none tabular-nums"
          style={{ top: i * ROW_HEIGHT_PX - 6 }}
        >
          {label}
        </div>
      ))}
    </div>
  )
}
