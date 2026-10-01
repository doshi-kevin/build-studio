// Drawing stroke shape — sent over the ephemeral topic for live render
// and batched into lc_events for late-joiner replay.

export interface StrokePoint {
  x: number
  y: number
  /** ms since stroke start; lets renderers reproduce drawing speed if desired. */
  t: number
}

export interface Stroke {
  id: string
  slideIndex: number
  points: StrokePoint[]
  /** Tailwind/CSS-style color string (e.g. 'currentColor', '#ef4444'). */
  color: string
  /** Stroke width in CSS pixels at the canvas's intrinsic resolution. */
  width: number
  authorId: string
}

export interface StrokeBatch {
  strokes: Stroke[]
}

export const MAX_STROKES_PER_BATCH = 200
