// Thin meter that grows to its value on mount (skipped under
// prefers-reduced-motion), shared by the after-class report and student
// insights so the fill timing/easing lives in one place. Supports the
// red→amber→green accuracy ramp (via `color`) and an optional overlay child
// (e.g. the class-average marker on the "you vs class" bar).

'use client'

import { motion, useReducedMotion } from 'framer-motion'
import { SPRING } from '@/lib/motion'

export function ProgressBar({
  value,
  className,
  color,
  trackClassName,
  height = 'h-1.5',
  children,
}: {
  value: number
  /** Tailwind fill color (e.g. `bg-primary`). Ignored when `color` is set. */
  className?: string
  /** Explicit fill color for the red→amber→green accuracy ramp. */
  color?: string
  /** Extra classes on the track (e.g. margin). */
  trackClassName?: string
  /** Track height token (default `h-1.5`). */
  height?: string
  /** Overlay rendered inside the track, above the fill (e.g. an average marker).
   *  When present the track is not clipped so a marker can extend past it. */
  children?: React.ReactNode
}) {
  const reduce = useReducedMotion()
  return (
    <div
      className={`relative ${height} rounded-full bg-muted ${children ? '' : 'overflow-hidden'} ${trackClassName ?? ''}`}
    >
      <motion.div
        className={`h-full rounded-full ${color ? '' : className ?? ''}`}
        style={color ? { backgroundColor: color } : undefined}
        initial={reduce ? false : { scaleX: 0 }}
        animate={{ scaleX: value / 100 }}
        transition={SPRING}
      />
      {children}
    </div>
  )
}
