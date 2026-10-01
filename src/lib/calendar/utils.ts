/**
 * Calendar utility functions — slot generation, time math, color maps.
 */

import { addDays, startOfWeek, format, getDay } from 'date-fns'
import { nowISO } from '@/lib/quiz/utils'
import type {
  OfficeHours,
  Booking,
  BlockedTime,
  Slot,
  SlotStatus,
  DayOfWeek,
} from '@/lib/validations/calendar'

/**
 * Semester window (± days) the student calendar loads in one bounded read set.
 * Lives here — a client-safe module — so client components (e.g. the dashboard
 * MiniCalendar) can read it without value-importing the server-coupled
 * student-events aggregator (which reaches the admin client). See design doc.
 */
export const WINDOW_DAYS = 120

// ── Grid Constants ────────────────────────────────────────────

export const GRID_START_HOUR = 7 // 7:00 AM
export const GRID_END_HOUR = 21 // 9:00 PM
export const MINUTES_PER_ROW = 30
export const ROW_HEIGHT_PX = 40
export const TOTAL_ROWS = (GRID_END_HOUR - GRID_START_HOUR) * 2 // 28

// ── Time Helpers ──────────────────────────────────────────────

/** Parse "HH:MM" to total minutes since midnight */
export function timeToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number)
  return h * 60 + m
}

/** Convert total minutes to "HH:MM" */
export function minutesToTime(mins: number): string {
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/**
 * America/New_York UTC offset (minutes, e.g. -240 EDT / -300 EST) at an instant,
 * from the runtime's IANA tz data — no external dependency, correct across DST.
 */
function etOffsetMinutes(instant: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(instant)
  const p: Record<string, string> = {}
  for (const part of parts) if (part.type !== 'literal') p[part.type] = part.value
  // hour12:false can emit '24' at midnight — normalize to 0.
  const hour = p.hour === '24' ? 0 : Number(p.hour)
  const asEt = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), hour, Number(p.minute), Number(p.second))
  return Math.round((asEt - instant.getTime()) / 60_000)
}

/**
 * Combine a `yyyy-MM-dd` date + `HH:MM` Eastern wall-clock time into a UTC ISO
 * instant, honoring EST/EDT for that date. Office-hours bookings store a bare
 * local date + time, so a fixed `-05:00` is wrong for ~8 months of the year:
 * during EDT it renders every booking an hour late. This resolves the real ET
 * offset instead. Office-hours times sit far from the 2 AM DST boundary, so a
 * single offset correction is exact.
 */
export function etWallClockToIso(dateStr: string, timeStr: string): string {
  const hhmm = (timeStr || '00:00').slice(0, 5)
  const [y, mo, d] = dateStr.split('-').map(Number)
  const [h, mi] = hhmm.split(':').map(Number)
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0)
  const offset = etOffsetMinutes(new Date(guess))
  return new Date(guess - offset * 60_000).toISOString()
}

/**
 * Split a UTC ISO instant into the America/New_York wall-clock date and time a
 * person on campus would call it — the inverse of `etWallClockToIso`, exact
 * outside the DST transition hours.
 *
 * The round trip is not exact in the 1–4 AM band on the two changeover days,
 * because `etWallClockToIso` resolves the offset from a guessed instant (its own
 * docstring says as much). Every surface that uses either function reads
 * daytime hours, so this has no caller today; don't rely on it at 2 AM.
 *
 * Needed by anything that buckets stored instants into days. `new Date(iso)`
 * plus the runtime's own accessors buckets in whatever zone the process runs in,
 * which on Cloud Run is UTC — so an 8 PM Eastern class lands on the NEXT day, and
 * a 7–9 PM search window silently loses it. Reuses `etOffsetMinutes`, so DST is
 * handled the same way in both directions.
 */
export function isoToEtWallClock(iso: string): { date: string; time: string } {
  const instant = new Date(iso)
  // etOffsetMinutes returns (ET wall clock read as UTC) - instant, so adding it
  // makes the UTC accessors below read out the Eastern wall clock.
  const et = new Date(instant.getTime() + etOffsetMinutes(instant) * 60_000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return {
    date: `${et.getUTCFullYear()}-${pad(et.getUTCMonth() + 1)}-${pad(et.getUTCDate())}`,
    time: `${pad(et.getUTCHours())}:${pad(et.getUTCMinutes())}`,
  }
}

/** Format "HH:MM" → "2:00 PM" */
export function formatTimeDisplay(time: string): string {
  const [h, m] = time.split(':').map(Number)
  const period = h >= 12 ? 'PM' : 'AM'
  const displayH = h === 0 ? 12 : h > 12 ? h - 12 : h
  return `${displayH}:${String(m).padStart(2, '0')} ${period}`
}

/** Check if two time ranges overlap */
export function timesOverlap(
  s1: string,
  e1: string,
  s2: string,
  e2: string,
): boolean {
  const a1 = timeToMinutes(s1)
  const a2 = timeToMinutes(e1)
  const b1 = timeToMinutes(s2)
  const b2 = timeToMinutes(e2)
  return a1 < b2 && b1 < a2
}

// ── Grid Position Helpers ─────────────────────────────────────

/** Calculate top px offset for absolute positioning in the time grid */
export function calculateTopPx(startTime: string): number {
  const [h, m] = startTime.split(':').map(Number)
  const minutesFromStart = (h - GRID_START_HOUR) * 60 + m
  return (minutesFromStart / MINUTES_PER_ROW) * ROW_HEIGHT_PX
}

/** Calculate height px for absolute positioning in the time grid */
export function calculateHeightPx(startTime: string, endTime: string): number {
  const duration = timeToMinutes(endTime) - timeToMinutes(startTime)
  return (duration / MINUTES_PER_ROW) * ROW_HEIGHT_PX
}

/** Keeps a clamped sliver tall enough to still read and click. */
export const MIN_BLOCK_MIN = 20

/**
 * Squeeze an event's [start, end] minute range into the visible grid window
 * (GRID_START_HOUR..GRID_END_HOUR). An 11:59 PM deadline would otherwise be
 * positioned ~240px BELOW the grid, and a midnight one above it, painting over
 * the day header.
 *
 * Exported (rather than living inside the block component) because the lane
 * packing MUST run on the same clamped intervals the blocks are drawn at.
 * Packing on raw times instead gives two events that don't overlap in real time
 * — say a 10 PM and an 11:59 PM deadline — a full-width lane each, and then
 * both render at the identical clamped position, so one completely hides the
 * other (including hiding a real late class behind a deadline).
 */
export function clampToGridMinutes(startMin: number, endMin: number): {
  startMin: number
  endMin: number
  clamped: boolean
} {
  const lo = GRID_START_HOUR * 60
  const hi = GRID_END_HOUR * 60
  const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max)

  const s = clamp(startMin, lo, hi - MIN_BLOCK_MIN)
  const e = clamp(endMin, s + MIN_BLOCK_MIN, hi)
  return { startMin: s, endMin: e, clamped: s !== startMin || e !== endMin }
}

// ── Day Helpers ───────────────────────────────────────────────

const DAY_INDEX_MAP: Record<number, DayOfWeek> = {
  0: 'sunday',
  1: 'monday',
  2: 'tuesday',
  3: 'wednesday',
  4: 'thursday',
  5: 'friday',
  6: 'saturday',
}

/** Get DayOfWeek from a Date object */
export function getDayName(date: Date): DayOfWeek {
  return DAY_INDEX_MAP[getDay(date)]
}

/** Format Date as "YYYY-MM-DD" */
export function formatDateISO(date: Date): string {
  return format(date, 'yyyy-MM-dd')
}

/** Get Monday-based week days for a given date */
export function getWeekDays(date: Date): Date[] {
  const monday = startOfWeek(date, { weekStartsOn: 1 })
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i))
}

/** Generate time labels for the gutter (7:00 AM, 7:30 AM, ...) */
export function generateTimeLabels(): string[] {
  const labels: string[] = []
  for (let h = GRID_START_HOUR; h < GRID_END_HOUR; h++) {
    labels.push(formatTimeDisplay(`${String(h).padStart(2, '0')}:00`))
    labels.push('') // half-hour — no label
  }
  return labels
}

// ── Slot Generation ───────────────────────────────────────────

/**
 * Generate concrete Slot records from an OfficeHours template for a date range.
 * Excludes times overlapping with blocked times and marks booked slots.
 */
export function generateSlotsForDateRange(
  template: OfficeHours,
  rangeStart: Date,
  rangeEnd: Date,
  existingBookings: Booking[],
  existingBlockedTimes: BlockedTime[],
): Slot[] {
  if (!template.isActive) return []

  const slots: Slot[] = []
  let current = new Date(rangeStart)

  while (current <= rangeEnd) {
    const dayName = getDayName(current)
    if (dayName !== template.dayOfWeek) {
      current = addDays(current, 1)
      continue
    }

    const dateStr = formatDateISO(current)

    // Check effective range
    if (dateStr < template.effectiveFrom) {
      current = addDays(current, 1)
      continue
    }
    if (template.effectiveUntil && dateStr > template.effectiveUntil) {
      current = addDays(current, 1)
      continue
    }

    // Generate time slots
    let slotStartMins = timeToMinutes(template.startTime)
    const blockEndMins = timeToMinutes(template.endTime)

    while (slotStartMins + template.slotDuration <= blockEndMins) {
      const startTimeStr = minutesToTime(slotStartMins)
      const endTimeStr = minutesToTime(slotStartMins + template.slotDuration)

      // Check if overlaps with any blocked time
      const isBlocked = existingBlockedTimes.some(
        (bt) =>
          bt.date === dateStr &&
          bt.professorId === template.professorId &&
          timesOverlap(bt.startTime, bt.endTime, startTimeStr, endTimeStr),
      )

      if (!isBlocked) {
        // Check if already booked
        const existingBooking = existingBookings.find(
          (b) =>
            b.date === dateStr &&
            b.startTime === startTimeStr &&
            b.officeHoursId === template.id &&
            b.status !== 'cancelled',
        )

        const status: SlotStatus = existingBooking ? existingBooking.status : 'available'

        slots.push({
          id: `slot-${template.id}-${dateStr}-${startTimeStr}`,
          officeHoursId: template.id,
          professorId: template.professorId,
          date: dateStr,
          startTime: startTimeStr,
          endTime: endTimeStr,
          status,
          bookingId: existingBooking?.id ?? null,
          createdAt: nowISO(),
          updatedAt: nowISO(),
        })
      }

      // Advance by slotDuration + buffer
      slotStartMins += template.slotDuration + template.bufferMinutes
    }

    current = addDays(current, 1)
  }

  return slots
}

/**
 * Expand recurring blocked times into concrete per-date occurrences for a visible range.
 * A one-off entry passes through unchanged; a weekly entry emits one occurrence per matching
 * weekday (the weekday of its start date) from its start through its recurrence-until date
 * (or the range end, if open-ended). Occurrences carry the SERIES id — so a click/delete
 * targets the whole series — but are flagged recurrence:'none' so re-expansion is a no-op.
 */
export function expandBlockedTimes(
  blockedTimes: BlockedTime[],
  rangeStart: Date,
  rangeEnd: Date,
): BlockedTime[] {
  const rangeEndStr = formatDateISO(rangeEnd)
  const out: BlockedTime[] = []
  for (const bt of blockedTimes) {
    if (bt.recurrence !== 'weekly') {
      out.push(bt)
      continue
    }
    const anchor = new Date(bt.date + 'T12:00:00')
    const untilStr = bt.recurrenceUntil || rangeEndStr
    let cur = anchor > rangeStart ? new Date(anchor) : new Date(rangeStart)
    cur.setHours(12, 0, 0, 0)
    while (formatDateISO(cur) <= rangeEndStr) {
      const curStr = formatDateISO(cur)
      if (curStr >= bt.date && curStr <= untilStr && getDayName(cur) === getDayName(anchor)) {
        out.push({ ...bt, date: curStr, recurrence: 'none' })
      }
      cur = addDays(cur, 1)
    }
  }
  return out
}

/**
 * Generate all slots for the visible date range from all office hours templates. Recurring
 * blocked times are expanded to concrete occurrences first, so a weekly lecture blocks the
 * overlapping office-hours slot in every week it repeats.
 */
export function generateAllSlots(
  officeHours: OfficeHours[],
  rangeStart: Date,
  rangeEnd: Date,
  bookings: Booking[],
  blockedTimes: BlockedTime[],
): Slot[] {
  const expandedBlocked = expandBlockedTimes(blockedTimes, rangeStart, rangeEnd)
  return officeHours.flatMap((oh) =>
    generateSlotsForDateRange(oh, rangeStart, rangeEnd, bookings, expandedBlocked),
  )
}

// ── Color Maps ────────────────────────────────────────────────

export interface CourseColor {
  bg: string
  border: string
  text: string
  dot: string
}

export const COURSE_COLOR_PALETTE: CourseColor[] = [
  { bg: 'bg-blue-50', border: 'border-l-blue-500', text: 'text-blue-700', dot: 'bg-blue-500' },
  { bg: 'bg-emerald-50', border: 'border-l-emerald-500', text: 'text-emerald-700', dot: 'bg-emerald-500' },
  { bg: 'bg-violet-50', border: 'border-l-violet-500', text: 'text-violet-700', dot: 'bg-violet-500' },
  { bg: 'bg-amber-50', border: 'border-l-amber-500', text: 'text-amber-700', dot: 'bg-amber-500' },
  { bg: 'bg-rose-50', border: 'border-l-rose-500', text: 'text-rose-700', dot: 'bg-rose-500' },
  { bg: 'bg-cyan-50', border: 'border-l-cyan-500', text: 'text-cyan-700', dot: 'bg-cyan-500' },
  { bg: 'bg-orange-50', border: 'border-l-orange-500', text: 'text-orange-700', dot: 'bg-orange-500' },
  { bg: 'bg-pink-50', border: 'border-l-pink-500', text: 'text-pink-700', dot: 'bg-pink-500' },
]

const GENERAL_COLOR: CourseColor = {
  bg: 'bg-slate-50',
  border: 'border-l-slate-400',
  text: 'text-slate-600',
  dot: 'bg-slate-400',
}

/** Build a stable course → color mapping */
export function buildCourseColorMap(
  courseIds: string[],
): Record<string, CourseColor> {
  const unique = [...new Set(courseIds)]
  const map: Record<string, CourseColor> = {}
  unique.forEach((id, idx) => {
    map[id] = COURSE_COLOR_PALETTE[idx % COURSE_COLOR_PALETTE.length]
  })
  map['__general__'] = GENERAL_COLOR
  return map
}

export const SLOT_STATUS_COLORS: Record<SlotStatus, { bg: string; text: string; badge: string }> = {
  available: { bg: 'bg-green-50', text: 'text-green-700', badge: 'bg-green-100 text-green-800' },
  booked: { bg: 'bg-blue-50', text: 'text-blue-700', badge: 'bg-blue-100 text-blue-800' },
  completed: { bg: 'bg-gray-50', text: 'text-gray-600', badge: 'bg-gray-100 text-gray-700' },
  cancelled: { bg: 'bg-red-50', text: 'text-red-600', badge: 'bg-red-100 text-red-700' },
  no_show: { bg: 'bg-yellow-50', text: 'text-yellow-700', badge: 'bg-yellow-100 text-yellow-800' },
}

export const BLOCKED_TIME_COLORS = {
  bg: 'bg-gray-100',
  border: 'border-l-gray-400',
  text: 'text-gray-500',
}
