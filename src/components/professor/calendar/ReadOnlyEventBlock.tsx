'use client'

// Read-only overlay for the professor's teaching calendar — class sessions and
// assignment/quiz due dates, layered onto the same time grid as the editable
// office hours / bookings / blocked times (MeetingCard). Unlike those, this
// never opens an edit dialog: it links straight to the real page (the
// assignment, quiz, or live classroom) via the href the aggregator already
// computed.
//
// Positioning is NOT computed here — the parent clamps the event into the grid
// window and lane-packs those clamped intervals, then passes the result down.
// Both have to come from the same numbers: clamping here while packing on raw
// times upstream is what let two events land on one box and hide each other.

import Link from 'next/link'
import {
  EVENT_STYLE, tintStyle, accentStyle, isoToHHMM, layoutDayEvents,
} from '@/components/student/calendar/event-style'
import {
  calculateTopPx,
  calculateHeightPx,
  minutesToTime,
  timeToMinutes,
  formatTimeDisplay,
  clampToGridMinutes,
} from '@/lib/calendar/utils'
import type { StudentCalendarEvent } from '@/lib/calendar/student-events'

/** A deadline has no end time; give it a nominal span so it draws as a marker. */
const DEADLINE_BLOCK_MIN = 30

/** Same local day as `iso`, at `min` minutes past midnight. */
function withMinutes(iso: string, min: number): string {
  const d = new Date(iso)
  d.setHours(Math.floor(min / 60), min % 60, 0, 0)
  return d.toISOString()
}

export interface PositionedReadOnlyEvent {
  event: StudentCalendarEvent
  startMin: number
  endMin: number
  clampedFromMin: number | null
  leftPct: number
  widthPct: number
}

/**
 * Clamp one day's read-only events into the grid window, then lane-pack THOSE
 * clamped spans so overlaps-after-clamping sit side by side.
 *
 * Packing the raw times instead is a real defect, not a nicety: a 10 PM and an
 * 11:59 PM deadline don't overlap in real time, so each would take a full-width
 * lane — and then both clamp onto the same box, so the later one drawn hides the
 * earlier, and can equally hide a genuine 8:40 PM class.
 */
export function layoutReadOnlyDay(events: StudentCalendarEvent[]): PositionedReadOnlyEvent[] {
  const clamped = events.map((event) => {
    const rawStart = timeToMinutes(isoToHHMM(event.start))
    const rawEnd = event.end ? timeToMinutes(isoToHHMM(event.end)) : rawStart + DEADLINE_BLOCK_MIN
    const c = clampToGridMinutes(rawStart, rawEnd)
    return { event, rawStart, startMin: c.startMin, endMin: c.endMin, wasClamped: c.clamped }
  })

  // Reuse the shared lane packer by handing it events whose times ARE the
  // clamped ones; only leftPct/widthPct are taken from the result.
  const lanes = layoutDayEvents(
    clamped.map(({ event, startMin, endMin }) => ({
      ...event,
      start: withMinutes(event.start, startMin),
      end: withMinutes(event.start, endMin),
    })),
  )
  const laneOf = new Map(lanes.map((p) => [p.event.id, p]))

  return clamped.map(({ event, rawStart, startMin, endMin, wasClamped }) => ({
    event,
    startMin,
    endMin,
    clampedFromMin: wasClamped ? rawStart : null,
    leftPct: laneOf.get(event.id)?.leftPct ?? 0,
    widthPct: laneOf.get(event.id)?.widthPct ?? 100,
  }))
}

export function ReadOnlyEventBlock({
  event,
  startMin,
  endMin,
  clampedFromMin,
  leftPct = 0,
  widthPct = 100,
}: {
  event: StudentCalendarEvent
  /** Grid-clamped start/end, in minutes past midnight (from clampToGridMinutes). */
  startMin: number
  endMin: number
  /**
   * The event's REAL start minute when it had to be clamped, else null. Drives
   * the time prefix — without it a deadline pinned to the grid edge silently
   * reads as happening at the time it's drawn at.
   */
  clampedFromMin: number | null
  /** Lane position among overlapping events (from layoutDayEvents on the clamped spans). */
  leftPct?: number
  widthPct?: number
}) {
  const style = EVENT_STYLE[event.kind]
  const startTime = minutesToTime(startMin)
  const endTime = minutesToTime(endMin)
  const realTime = clampedFromMin != null ? formatTimeDisplay(minutesToTime(clampedFromMin)) : null

  const label = event.courseCode ? `${event.courseCode} · ${event.title}` : event.title
  // Time goes FIRST when clamped. A week column gives the label ~88px, so a
  // trailing correction is the first thing `truncate` eats — exactly the part
  // that stops the block being read as happening where it's drawn.
  const display = realTime ? `${realTime} · ${label}` : label

  return (
    <Link
      href={event.href}
      title={realTime ? `${label} — ${realTime}` : label}
      className="absolute flex items-center gap-1 overflow-hidden rounded-xl border-l-2 px-2 py-1 text-xs transition-shadow duration-200 ease-out hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40"
      style={{
        top: calculateTopPx(startTime),
        height: calculateHeightPx(startTime, endTime),
        left: `calc(${leftPct}% + 2px)`,
        width: `calc(${widthPct}% - 4px)`,
        ...tintStyle(event.kind),
        ...accentStyle(event.kind),
      }}
    >
      <style.Icon className="h-3 w-3 shrink-0" />
      <span className="truncate font-medium">{display}</span>
    </Link>
  )
}
