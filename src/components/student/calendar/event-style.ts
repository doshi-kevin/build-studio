// Visual style + small helpers for the student calendar's event kinds.
// Uses semantic design tokens (chart-*/success) — never raw Tailwind colors —
// per the UI rules. The professor calendar's util palette uses raw colors and is
// deliberately NOT reused here.

import { format } from 'date-fns'
import { GraduationCap, FileText, ListChecks, FolderKanban, Clock, Star, type LucideIcon } from 'lucide-react'
import { formatDateISO, formatTimeDisplay } from '@/lib/calendar/utils'
import {
  KIND_CATEGORY, dotStyle as catDotStyle, tintStyle as catTintStyle, accentStyle as catAccentStyle,
} from '@/lib/calendar/category-colors'
import type { StudentCalendarEvent, StudentCalendarEventKind, EventStatus } from '@/lib/calendar/student-events'

export interface KindStyle {
  label: string
  Icon: LucideIcon
}

/** Status badge label + on-theme classes (muted tints, AA-verified in globals.css). */
export const STATUS_META: Record<EventStatus, { label: string; className: string }> = {
  not_started: { label: 'Not started', className: 'bg-muted text-muted-foreground' },
  in_progress: { label: 'In progress', className: 'bg-warning-muted text-warning-muted-foreground' },
  submitted:   { label: 'Submitted',   className: 'bg-success-muted text-success-muted-foreground' },
  graded:      { label: 'Graded',       className: 'bg-success-muted text-success-muted-foreground' },
  completed:   { label: 'Completed',    className: 'bg-success-muted text-success-muted-foreground' },
  blocked:     { label: 'Blocked',      className: 'bg-destructive-muted text-destructive-muted-foreground' },
}

export const EVENT_STYLE: Record<StudentCalendarEventKind, KindStyle> = {
  class_session:        { label: 'Class',        Icon: GraduationCap },
  assignment_due:       { label: 'Assignment',   Icon: FileText },
  quiz_due:             { label: 'Quiz',         Icon: ListChecks },
  project_due:          { label: 'Project',      Icon: FolderKanban },
  office_hours_booking: { label: 'Office Hours', Icon: Clock },
  personal:             { label: 'Personal',     Icon: Star },
}

// Inline color styles per event kind — resolve to the student's chosen category
// colors (CSS variables), so they stay uniform across every surface.
export const dotStyle = (kind: StudentCalendarEventKind) => catDotStyle(KIND_CATEGORY[kind])
export const tintStyle = (kind: StudentCalendarEventKind) => catTintStyle(KIND_CATEGORY[kind])
export const accentStyle = (kind: StudentCalendarEventKind) => catAccentStyle(KIND_CATEGORY[kind])

/** Kinds shown in every legend / order they appear. */
export const EVENT_KIND_ORDER: StudentCalendarEventKind[] = [
  'class_session',
  'assignment_due',
  'quiz_due',
  'project_due',
  'office_hours_booking',
  'personal',
]

/** A deadline is a point in time (no end); timed events have a start + end. */
export function isDeadline(e: StudentCalendarEvent): boolean {
  return e.end === null
}

/** Local "HH:MM" for grid positioning (ET assumed, matching the aggregator). */
export function isoToHHMM(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Human time label, e.g. "2:00 PM". */
export function formatEventTime(iso: string): string {
  return formatTimeDisplay(isoToHHMM(iso))
}

/** Human day label, e.g. "Fri, Jul 18". */
export function formatEventDay(iso: string): string {
  return format(new Date(iso), 'EEE, MMM d')
}

/** Hour label for the gutter, e.g. 0 → "12 AM", 13 → "1 PM". */
export function formatHourLabel(h: number): string {
  if (h === 0) return '12 AM'
  if (h === 12) return '12 PM'
  return h < 12 ? `${h} AM` : `${h - 12} PM`
}

/** Group events by their local calendar day (yyyy-MM-dd). */
export function groupEventsByDay(events: StudentCalendarEvent[]): Map<string, StudentCalendarEvent[]> {
  const map = new Map<string, StudentCalendarEvent[]>()
  for (const e of events) {
    const key = formatDateISO(new Date(e.start))
    const arr = map.get(key) ?? []
    arr.push(e)
    map.set(key, arr)
  }
  return map
}

/** An event positioned in a day column: vertical by time, horizontal by lane. */
export interface PositionedEvent {
  event: StudentCalendarEvent
  topPct: number
  /** null for deadlines (rendered as a fixed-height marker pill). */
  heightPct: number | null
  leftPct: number
  widthPct: number
}

/** A deadline has no duration; give it a nominal span so near-simultaneous ones get their own lane. */
const DEADLINE_SPAN_MIN = 30
const MIN_TIMED_SPAN_MIN = 20

function minutesOfDay(iso: string): number {
  const d = new Date(iso)
  return d.getHours() * 60 + d.getMinutes()
}

/**
 * Lay out one day's events into side-by-side lanes so overlapping items never
 * cover each other (the standard calendar column-packing): sort by start, place
 * each event in the first lane it fits, and split a cluster's width evenly among
 * its lanes. Vertical position/height come from the times; deadlines keep a null
 * height (drawn as a marker) but still occupy a lane for horizontal spacing.
 *
 * `windowStartMin`/`windowEndMin` bound the vertical scale: top/height are
 * expressed as a percentage of that window (default = the full 24h day, so the
 * full-calendar grid is unchanged). The mini calendar passes a narrower window to
 * trim dead hours; callers must pick a window that contains every event's span.
 */
export function layoutDayEvents(
  events: StudentCalendarEvent[],
  windowStartMin = 0,
  windowEndMin = 1440,
): PositionedEvent[] {
  const span = Math.max(1, windowEndMin - windowStartMin)
  const items = events
    .map((e) => {
      const startMin = minutesOfDay(e.start)
      const deadline = isDeadline(e)
      const endMin = deadline
        ? startMin + DEADLINE_SPAN_MIN
        : Math.max(startMin + MIN_TIMED_SPAN_MIN, minutesOfDay(e.end as string))
      return { e, startMin, endMin, deadline }
    })
    .sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin)

  type Item = (typeof items)[number]
  const lane = new Map<Item, number>()
  const laneCount = new Map<Item, number>()
  let columns: Item[][] = []
  let clusterEnd = -Infinity

  const flush = () => {
    const n = columns.length
    columns.forEach((col, ci) => col.forEach((it) => { lane.set(it, ci); laneCount.set(it, n) }))
    columns = []
  }

  for (const it of items) {
    if (it.startMin >= clusterEnd) { flush(); clusterEnd = -Infinity }
    const col = columns.find((c) => c[c.length - 1].endMin <= it.startMin)
    if (col) col.push(it)
    else columns.push([it])
    clusterEnd = Math.max(clusterEnd, it.endMin)
  }
  flush()

  return items.map((it) => {
    const lanes = laneCount.get(it) ?? 1
    const widthPct = 100 / lanes
    return {
      event: it.e,
      topPct: ((it.startMin - windowStartMin) / span) * 100,
      heightPct: it.deadline ? null : ((it.endMin - it.startMin) / span) * 100,
      leftPct: (lane.get(it) ?? 0) * widthPct,
      widthPct,
    }
  })
}
