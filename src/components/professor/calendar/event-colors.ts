/**
 * Token-based event colors for the professor calendar.
 *
 * The shared `@/lib/calendar/utils` color palette is expressed in raw Tailwind
 * colors with `border-l-*` stripes (and is also consumed by the student
 * calendar, so it stays as-is). This module is the professor calendar's
 * design-system-compliant equivalent: course events cycle through the
 * `chart-1..5` data-viz tokens as a subtle full tint + leading color dot —
 * no side-stripes, no raw colors. Status/blocked styling resolves to the
 * semantic status tokens.
 */

import { EVENT_BLOCK_REASONS, type BlockReason, type SlotStatus } from '@/lib/validations/calendar'

export interface EventColor {
  /** subtle full-block tint */
  bg: string
  /** readable label text on the tint */
  text: string
  /** small leading dot (solid token) */
  dot: string
}

// Cycle through the five data-viz tokens; general/no-course falls back to muted.
const CHART_EVENT_COLORS: EventColor[] = [
  { bg: 'bg-chart-1/10', text: 'text-foreground', dot: 'bg-chart-1' },
  { bg: 'bg-chart-2/10', text: 'text-foreground', dot: 'bg-chart-2' },
  { bg: 'bg-chart-3/10', text: 'text-foreground', dot: 'bg-chart-3' },
  { bg: 'bg-chart-4/10', text: 'text-foreground', dot: 'bg-chart-4' },
  { bg: 'bg-chart-5/10', text: 'text-foreground', dot: 'bg-chart-5' },
]

export const GENERAL_EVENT_COLOR: EventColor = {
  bg: 'bg-muted',
  text: 'text-foreground',
  dot: 'bg-muted-foreground',
}

/** Build a stable course → token-color mapping (keyed by course id). */
export function buildEventColorMap(courseIds: string[]): Record<string, EventColor> {
  const unique = [...new Set(courseIds)]
  const map: Record<string, EventColor> = {}
  unique.forEach((id, idx) => {
    map[id] = CHART_EVENT_COLORS[idx % CHART_EVENT_COLORS.length]
  })
  // '__general__' is a reserved key for course-less events; safe because course
  // ids are UUIDs and can't collide with it.
  map['__general__'] = GENERAL_EVENT_COLOR
  return map
}

/**
 * Card treatment for a one-off calendar entry. Scheduled events (lecture / exam / seminar
 * / meeting / conference) read as real calendar entries with a calm info tint; pure
 * availability blocks (lunch / personal / other) keep the muted-amber "unavailable" look.
 */
export function blockedTimeStyle(reason: BlockReason): { card: string; dot: string } {
  if (EVENT_BLOCK_REASONS.includes(reason)) {
    return { card: 'bg-info-muted text-info-muted-foreground', dot: 'bg-info' }
  }
  return { card: 'bg-warning-muted text-warning-muted-foreground', dot: 'bg-warning' }
}

/** Booking-status badge classes (semantic status tokens). */
export const STATUS_BADGE: Record<SlotStatus, string> = {
  available: 'bg-success-muted text-success-muted-foreground border-success/30',
  booked: 'bg-info-muted text-info-muted-foreground border-info/30',
  completed: 'bg-muted text-muted-foreground border-border',
  cancelled: 'bg-destructive-muted text-destructive-muted-foreground border-destructive/30',
  no_show: 'bg-warning-muted text-warning-muted-foreground border-warning/30',
}
