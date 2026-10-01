// Professor calendar aggregator — the professor mirror of `student-events.ts`,
// gathering their teaching week into one flat event list for the dashboard's
// mini calendar.
//
// Reuses `StudentCalendarEvent` verbatim rather than forking a near-identical
// type: it is the shared shape the dashboard calendar renders, and reusing it
// means one set of styles, one hover card, one layout engine for both roles.
// Only the sources and the click-through paths differ.
//
// Five sources: scheduled/live class sessions, the professor's own office-hours
// blocks, students' bookings against them, and assignment + quiz due dates
// across their sections.
//
// `expandOfficeHours` is exported because the subscribable iCal feed
// (`feed-builder.ts`) needs the exact same weekly expansion — two
// implementations would drift, and a calendar that disagrees with its own
// subscription feed is worse than no feed.

import { addDays, addWeeks, format, isAfter, isBefore, parseISO } from 'date-fns'
import { WINDOW_DAYS, etWallClockToIso } from '@/lib/calendar/utils'
import { safeHref } from '@/lib/dashboard/todos'
import type { StudentCalendarEvent } from '@/lib/calendar/student-events'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminDb = any

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const resolveJoin = (val: any) => (Array.isArray(val) ? val[0] : val)

const cleanText = (val: unknown): string | null => {
  const s = typeof val === 'string' ? val.trim() : ''
  return s.length > 0 ? s : null
}

/** A scheduled class runs an hour unless we know better — matches student-events. */
const CLASS_SESSION_MIN = 60

const DAY_INDEX: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
}

/**
 * A single office-hours occurrence rendered as one calendar chip — used by the
 * full calendar's Month view, which has no time grid and so can't derive them
 * from bookable slots the way Week/Day do.
 */
export interface OfficeHoursChip {
  id: string
  /** yyyy-MM-dd */
  date: string
  /** HH:MM — sorts the chip among the day's other events. */
  startTime: string
  title: string
  courseId: string | null
}

/** One weekly office-hours occurrence, as wall-clock date + times. */
export interface OfficeHoursOccurrence {
  date: string // yyyy-MM-dd
  startTime: string // HH:MM
  endTime: string // HH:MM
}

/** Next occurrence of `dayIndex` on or after `ref`. */
function nextDayOfWeek(ref: Date, dayIndex: number): Date {
  const d = new Date(ref)
  d.setDate(d.getDate() + ((dayIndex - d.getDay() + 7) % 7))
  return d
}

/**
 * Expand a weekly office-hours template into individual occurrences inside
 * [windowStart, windowEnd], respecting the row's own effective_from/until.
 *
 * Shared with the iCal feed builder — see the module header.
 */
export function expandOfficeHours(
  row: {
    day_of_week: string
    start_time: string
    end_time: string
    effective_from?: string | null
    effective_until?: string | null
  },
  windowStart: Date,
  windowEnd: Date,
): OfficeHoursOccurrence[] {
  const dayIdx = DAY_INDEX[row.day_of_week]
  if (dayIdx === undefined) return []

  const from = row.effective_from ? parseISO(row.effective_from) : windowStart
  const until = row.effective_until ? parseISO(row.effective_until) : windowEnd
  const rangeStart = isAfter(from, windowStart) ? from : windowStart
  const rangeEnd = isBefore(until, windowEnd) ? until : windowEnd

  const out: OfficeHoursOccurrence[] = []
  let current = nextDayOfWeek(rangeStart, dayIdx)
  if (isBefore(current, rangeStart)) current = addWeeks(current, 1)

  // Guard against a pathological effective range producing an unbounded loop:
  // the window is ±120 days, so ~35 weekly occurrences is the natural ceiling.
  let guard = 0
  while ((isBefore(current, rangeEnd) || format(current, 'yyyy-MM-dd') === format(rangeEnd, 'yyyy-MM-dd')) && guard++ < 400) {
    out.push({
      date: format(current, 'yyyy-MM-dd'),
      startTime: row.start_time,
      endTime: row.end_time,
    })
    current = addWeeks(current, 1)
  }
  return out
}

/**
 * Fetch the professor's calendar events for the semester window (±WINDOW_DAYS).
 *
 * SECURITY: reads with an admin client, so every query is scoped either to
 * `professor_id = professorId` or to the professor's own `sectionIds`.
 * Caller must have authenticated the professor.
 */
export async function getProfessorCalendarEvents(
  adminDb: AdminDb,
  professorId: string,
): Promise<{ events: StudentCalendarEvent[]; error: boolean }> {
  const now = new Date()
  const startDate = addDays(now, -WINDOW_DAYS)
  const endDate = addDays(now, WINDOW_DAYS)
  const startIso = startDate.toISOString()
  const endIso = endDate.toISOString()
  const startDay = format(startDate, 'yyyy-MM-dd')
  const endDay = format(endDate, 'yyyy-MM-dd')

  const events: StudentCalendarEvent[] = []
  let failed = false

  // The professor's own sections + course codes.
  const { data: sections, error: sectionError } = await adminDb
    .from('course_sections')
    .select('id, course:courses(code)')
    .eq('professor_id', professorId)
    .eq('status', 'active')

  if (sectionError) failed = true

  const codeBySection = new Map<string, string>()
  const sectionIds: string[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const s of (sections || []) as any[]) {
    sectionIds.push(s.id)
    const course = resolveJoin(s.course)
    if (course?.code) codeBySection.set(s.id, course.code)
  }

  // Office hours + bookings depend only on the professor; the rest need sectionIds.
  const [officeHoursRes, bookingsRes, roomsRes, assignmentsRes, quizzesRes] = await Promise.all([
    adminDb
      .from('office_hours')
      .select('id, title, day_of_week, start_time, end_time, location, meeting_type, zoom_link, effective_from, effective_until, course_code')
      .eq('professor_id', professorId)
      .eq('is_active', true),
    adminDb
      .from('bookings')
      .select('id, title, date, start_time, end_time, location, zoom_link, meeting_type, purpose, course_code, student:profiles!bookings_student_id_fkey(name, email)')
      .eq('professor_id', professorId)
      .eq('status', 'booked')
      .gte('date', startDay)
      .lte('date', endDay),
    sectionIds.length
      ? adminDb
          .from('lc_rooms')
          .select('id, name, scheduled_at, section_id')
          .in('section_id', sectionIds)
          .in('status', ['scheduled', 'live'])
          .not('scheduled_at', 'is', null)
          .gte('scheduled_at', startIso)
          .lte('scheduled_at', endIso)
      : Promise.resolve({ data: [], error: null }),
    sectionIds.length
      ? adminDb
          .from('assignments')
          .select('id, title, due_at, section_id, description')
          .in('section_id', sectionIds)
          .eq('status', 'published')
          .not('due_at', 'is', null)
          .gte('due_at', startIso)
          .lte('due_at', endIso)
      : Promise.resolve({ data: [], error: null }),
    sectionIds.length
      ? adminDb
          .from('quizzes')
          .select('id, title, due_date, section_id, description')
          .in('section_id', sectionIds)
          .eq('status', 'published')
          .not('due_date', 'is', null)
          .gte('due_date', startIso)
          .lte('due_date', endIso)
      : Promise.resolve({ data: [], error: null }),
  ])

  for (const res of [officeHoursRes, bookingsRes, roomsRes, assignmentsRes, quizzesRes]) {
    if (res.error) failed = true
  }

  // ── Office-hours blocks (recurring template → occurrences) ────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const oh of (officeHoursRes.data || []) as any[]) {
    const location = oh.meeting_type === 'zoom' ? cleanText(oh.zoom_link) ?? 'Zoom' : cleanText(oh.location)
    for (const occ of expandOfficeHours(oh, startDate, endDate)) {
      events.push({
        id: `oh-${oh.id}-${occ.date}`,
        kind: 'office_hours_booking',
        title: cleanText(oh.title) ?? 'Office Hours',
        start: etWallClockToIso(occ.date, occ.startTime),
        end: etWallClockToIso(occ.date, occ.endTime),
        courseCode: cleanText(oh.course_code),
        sectionId: null,
        href: '/professor/calendar',
        location,
        description: null,
        status: null,
      })
    }
  }

  // ── Student bookings ──────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const b of (bookingsRes.data || []) as any[]) {
    const student = resolveJoin(b.student)
    const who = cleanText(student?.name) ?? cleanText(student?.email) ?? 'Student'
    const location = b.meeting_type === 'zoom' ? cleanText(b.zoom_link) ?? 'Zoom' : cleanText(b.location)
    events.push({
      id: `booking-${b.id}`,
      kind: 'office_hours_booking',
      // Who booked is the useful part — the professor already knows it's a meeting.
      title: `${who} — ${cleanText(b.title) ?? 'Meeting'}`,
      start: etWallClockToIso(b.date, b.start_time),
      end: etWallClockToIso(b.date, b.end_time),
      courseCode: cleanText(b.course_code),
      sectionId: null,
      href: '/professor/calendar',
      location,
      description: cleanText(b.purpose),
      status: null,
    })
  }

  // ── Class sessions ────────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const r of (roomsRes.data || []) as any[]) {
    const start = new Date(r.scheduled_at)
    events.push({
      id: `session-${r.id}`,
      kind: 'class_session',
      title: cleanText(r.name) ?? 'Class Session',
      start: start.toISOString(),
      end: new Date(start.getTime() + CLASS_SESSION_MIN * 60_000).toISOString(),
      courseCode: codeBySection.get(r.section_id) ?? null,
      sectionId: r.section_id,
      // safeHref on every DB-derived path: these land in a <Link> in the mini
      // calendar and the full calendar's read-only overlay. The literal prefix
      // already makes an off-site URL structurally impossible, so this is
      // belt-and-braces — but it's the same guard the to-do engine applies, and
      // it means a future event source that forwards a stored URL has a backstop.
      href: safeHref(`/professor/courses/${r.section_id}/live-classroom`),
      location: null,
      description: null,
      status: null,
    })
  }

  // ── Deadlines the professor set ───────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const a of (assignmentsRes.data || []) as any[]) {
    events.push({
      id: `assignment-${a.id}`,
      kind: 'assignment_due',
      title: cleanText(a.title) ?? 'Assignment',
      start: new Date(a.due_at).toISOString(),
      end: null,
      courseCode: codeBySection.get(a.section_id) ?? null,
      sectionId: a.section_id,
      href: safeHref(`/professor/courses/${a.section_id}/assignments/${a.id}`),
      location: null,
      description: cleanText(a.description),
      status: null,
    })
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const q of (quizzesRes.data || []) as any[]) {
    events.push({
      id: `quiz-${q.id}`,
      kind: 'quiz_due',
      title: cleanText(q.title) ?? 'Quiz',
      start: new Date(q.due_date).toISOString(),
      end: null,
      courseCode: codeBySection.get(q.section_id) ?? null,
      sectionId: q.section_id,
      href: safeHref(`/professor/courses/${q.section_id}/quizzes/${q.id}`),
      location: null,
      description: cleanText(q.description),
      status: null,
    })
  }

  events.sort((a, b) => a.start.localeCompare(b.start))
  return { events, error: failed }
}
