// Availability — turns two people's calendars into "when could you two meet".
//
// Pure and DB-free on purpose: every function here is a function of its
// arguments, so the interval arithmetic (the part that is easy to get subtly
// wrong) is unit-testable without a database or a browser. The page fetches;
// this module decides.
//
// Runs on the SERVER, and that is a privacy property as much as a correctness
// one: only the merged blocks and the free slots cross to the browser, so the
// professor's page payload never contains the student's event titles, their
// other courses' deadlines, or the notes on their personal events.
//
// FOUR RULES, each of which the naive version gets wrong:
//
//   1. A DEADLINE IS NOT AN APPOINTMENT. StudentCalendarEvent carries end:null
//      for assignment_due / quiz_due / project_due. An assignment due at 11:59
//      PM does not put the student anywhere at 11:59 PM, and coursework
//      generates a lot of these — counting them would mark a student busy every
//      evening of the semester. Only intervals with a real end count.
//
//   2. BOTH PEOPLE HAVE TO BE FREE. Busy is the union of the student's
//      commitments and the professor's own, including times the professor
//      blocked off. A grid showing only the student would send the professor to
//      a second tab to cross-reference, which is the work this is meant to save.
//
//   3. A GAP BETWEEN TWO CLASSES IS NOT A SLOT. 1:00 out, 1:30 in, is a walk
//      across campus. Busy blocks are widened by TRANSIT_PAD_MIN on each side
//      BEFORE merging, so the padding of two adjacent classes collapses into
//      the merge on its own with no special case.
//
//   4. THE CLOCK IS EASTERN. The searched window is a campus window, so it means
//      Eastern regardless of where the reader sits. Day bucketing goes through
//      isoToEtWallClock rather than the runtime's accessors, which on Cloud Run
//      are UTC and would push every late-evening event onto the following day.

import { GRID_END_HOUR, GRID_START_HOUR, isoToEtWallClock, timeToMinutes } from '@/lib/calendar/utils'
import type { StudentCalendarEvent } from '@/lib/calendar/student-events'

/** Minutes of slack added either side of a commitment, for getting there. */
export const TRANSIT_PAD_MIN = 10

/** Shortest gap worth offering as a meeting. */
export const DEFAULT_MEETING_MIN = 30

/** First and last minute of the day this feature will suggest (7 AM – 9 PM ET). */
export const WINDOW_START_MIN = GRID_START_HOUR * 60
export const WINDOW_END_MIN = GRID_END_HOUR * 60

const MINUTES_PER_DAY = 24 * 60

/**
 * One occupied stretch of one Eastern day. Minutes are from ET midnight, which
 * makes every comparison in here integer arithmetic on the same scale.
 */
export interface BusyInterval {
  /** ET wall-clock day, `yyyy-MM-dd`. */
  date: string
  startMin: number
  endMin: number
  /**
   * What to write on the block, or null to render it opaque. Only ever set for
   * a class session in a section the viewing professor teaches — never an event
   * title, which could say anything. Everything else stays unlabelled by
   * design: the professor needs to know the student is unavailable, not why.
   */
  label: string | null
}

/** A stretch where neither person has anything, long enough to be worth offering. */
export interface FreeSlot {
  date: string
  startMin: number
  endMin: number
}

/**
 * `count` consecutive `yyyy-MM-dd` keys starting at `startDate`.
 *
 * Steps the date through UTC accessors on purpose. `startDate` is already an
 * Eastern calendar date (it came from isoToEtWallClock), so this is plain
 * calendar arithmetic on a string, not a timezone conversion — going through
 * local accessors would re-introduce the zone this module just removed.
 */
export function etDayKeys(startDate: string, count: number): string[] {
  const [y, m, d] = startDate.split('-').map(Number)
  const cursor = new Date(Date.UTC(y, m - 1, d))
  const pad = (n: number) => String(n).padStart(2, '0')
  const keys: string[] = []

  for (let i = 0; i < count; i++) {
    keys.push(
      `${cursor.getUTCFullYear()}-${pad(cursor.getUTCMonth() + 1)}-${pad(cursor.getUTCDate())}`,
    )
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return keys
}

/**
 * Map calendar events onto busy intervals, dropping everything that isn't a
 * real block of occupied time (rule 1).
 *
 * `labelSectionIds` are the sections the viewing professor teaches; a class
 * session in one of those gets its course code as a label so the professor can
 * see their own class in the student's week. Pass an empty set for the
 * professor's own events — labelling those tells the reader nothing they don't
 * already know, and the grid is about the student.
 *
 * An event that straddles ET midnight is clipped at the end of its start day.
 * The suggestion window stops at 9 PM, so the discarded tail is outside it
 * anyway, and clipping keeps every interval on exactly one day's number line.
 */
export function toBusyIntervals(
  events: StudentCalendarEvent[],
  labelSectionIds: ReadonlySet<string> = new Set(),
): BusyInterval[] {
  const out: BusyInterval[] = []

  for (const event of events) {
    // Rule 1: no end means a point in time, not an occupied stretch.
    if (!event.end) continue

    const start = isoToEtWallClock(event.start)
    const end = isoToEtWallClock(event.end)

    const startMin = timeToMinutes(start.time)
    // Same day: use the real end. Rolls past midnight: clip to the day's edge.
    const endMin = end.date === start.date ? timeToMinutes(end.time) : MINUTES_PER_DAY

    // A zero- or negative-length interval occupies nothing.
    if (endMin <= startMin) continue

    const labelled =
      event.kind === 'class_session' &&
      event.sectionId != null &&
      labelSectionIds.has(event.sectionId)

    out.push({
      date: start.date,
      startMin,
      endMin,
      label: labelled ? event.courseCode : null,
    })
  }

  return out
}

/**
 * Fuse overlapping and touching intervals, one Eastern day at a time.
 *
 * `padMinutes` widens each interval before merging (rule 3). Call it twice with
 * different padding rather than trying to do both jobs at once:
 *
 *   • 0 for the grid, so the professor sees the real shape of the day.
 *   • TRANSIT_PAD_MIN for slot-finding, so a walk-across-campus gap doesn't
 *     get offered as a meeting.
 *
 * A merged block keeps the first label among its members. When the professor's
 * own class overlaps something opaque, the merged block still says "your class
 * is in here", which is true and is the useful half.
 */
export function mergeBusyIntervals(
  intervals: BusyInterval[],
  padMinutes = 0,
  options: { keepLabelsSeparate?: boolean } = {},
): Map<string, BusyInterval[]> {
  const byDay = new Map<string, BusyInterval[]>()

  for (const interval of intervals) {
    const padded: BusyInterval = {
      date: interval.date,
      startMin: Math.max(0, interval.startMin - padMinutes),
      endMin: Math.min(MINUTES_PER_DAY, interval.endMin + padMinutes),
      label: interval.label,
    }
    const day = byDay.get(padded.date)
    if (day) day.push(padded)
    else byDay.set(padded.date, [padded])
  }

  for (const [date, day] of byDay) {
    day.sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin)

    const merged: BusyInterval[] = []
    for (const interval of day) {
      const last = merged[merged.length - 1]
      /* Only fuse blocks that carry the same label when the caller asked to
         keep them apart. A 1-hour class touching 2 hours of office hours would
         otherwise become one 3-hour block wearing the class's course code, so
         the grid would claim the class runs three times as long as it does.
         Found by running live data through this and reading the output. */
      const labelsAgree = !options.keepLabelsSeparate || last?.label === interval.label
      // `<=` so blocks that merely touch (10:00 end, 10:00 start) become one
      // block rather than two with a zero-width gap between them.
      if (last && labelsAgree && interval.startMin <= last.endMin) {
        last.endMin = Math.max(last.endMin, interval.endMin)
        last.label = last.label ?? interval.label
      } else {
        merged.push({ ...interval })
      }
    }
    byDay.set(date, merged)
  }

  return byDay
}

/**
 * The complement of the busy blocks inside the suggestion window, for each of
 * `dates`, keeping only gaps at least `minMinutes` long.
 *
 * `notBefore` drops slots that have already passed: pass the current ET date
 * and minute-of-day and the rest of today is trimmed rather than the whole day
 * being thrown away. A day with no busy blocks at all yields one slot spanning
 * the window, which is correct — the caller decides whether an empty calendar
 * means "free" or "we have no data", because those are different claims.
 */
export function invertToFreeSlots(
  dates: string[],
  mergedByDay: Map<string, BusyInterval[]>,
  options: {
    minMinutes?: number
    notBefore?: { date: string; minute: number }
  } = {},
): FreeSlot[] {
  const minMinutes = options.minMinutes ?? DEFAULT_MEETING_MIN
  const notBefore = options.notBefore
  const slots: FreeSlot[] = []

  for (const date of dates) {
    if (notBefore && date < notBefore.date) continue

    /* On today, the window opens at whichever is later: 7 AM or right now,
       rounded up to the next quarter hour. Without the rounding the first
       suggestion of the day is stamped with the exact minute the page was
       loaded, so the professor ends up emailing a student to propose "9:54am". */
    const dayStart =
      notBefore && date === notBefore.date
        ? Math.max(WINDOW_START_MIN, Math.ceil(notBefore.minute / 15) * 15)
        : WINDOW_START_MIN

    let cursor = dayStart
    for (const busy of mergedByDay.get(date) ?? []) {
      if (busy.endMin <= cursor) continue
      if (busy.startMin >= WINDOW_END_MIN) break
      if (busy.startMin - cursor >= minMinutes) {
        slots.push({ date, startMin: cursor, endMin: busy.startMin })
      }
      cursor = Math.max(cursor, busy.endMin)
    }

    if (WINDOW_END_MIN - cursor >= minMinutes) {
      slots.push({ date, startMin: cursor, endMin: WINDOW_END_MIN })
    }
  }

  return slots
}

/**
 * Order free slots for the "propose a time" list and take the first `limit`.
 *
 * Soonest first, because a meeting the professor is trying to arrange is
 * usually about something happening now. Weekdays rank ahead of weekend days on
 * the same date distance, since a weekend slot is technically free but rarely
 * what either person meant. Long slots are trimmed to `meetingMinutes` so the
 * offered time is a specific half hour and not "some point in this three-hour
 * stretch".
 */
export function suggestMeetingSlots(
  slots: FreeSlot[],
  options: { limit?: number; meetingMinutes?: number } = {},
): FreeSlot[] {
  const limit = options.limit ?? 6
  const meetingMinutes = options.meetingMinutes ?? DEFAULT_MEETING_MIN

  const isWeekend = (date: string) => {
    // Parse as an ET-noon instant so the weekday can't be shifted by the
    // runtime's zone the way `new Date('2026-09-12')` (parsed as UTC) can be.
    const [y, m, d] = date.split('-').map(Number)
    const day = new Date(y, m - 1, d, 12).getDay()
    return day === 0 || day === 6
  }

  return [...slots]
    .sort((a, b) => {
      const weekendDiff = Number(isWeekend(a.date)) - Number(isWeekend(b.date))
      if (weekendDiff !== 0) return weekendDiff
      if (a.date !== b.date) return a.date < b.date ? -1 : 1
      return a.startMin - b.startMin
    })
    .slice(0, limit)
    .map((slot) => ({
      ...slot,
      endMin: Math.min(slot.endMin, slot.startMin + meetingMinutes),
    }))
}
