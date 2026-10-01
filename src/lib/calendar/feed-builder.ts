/**
 * Feed Builder — aggregates calendar events for a user into ICalEvent[].
 *
 * Student events: reuse the SAME source as the /student/calendar page
 *   (getStudentCalendarEvents) so a subscribed feed can never drift from what the
 *   student sees — office-hours bookings, class sessions, and assignment/quiz/
 *   project deadlines all come through, with the DST-correct times.
 * Professor events: office hours (expanded to individual occurrences), student
 *   bookings, classroom sessions.
 */

import { addDays, format } from 'date-fns'
import type { ICalEvent } from './ical'
import { etWallClockToIso } from './utils'
import { expandOfficeHours } from './professor-events'
import {
  getStudentCalendarEvents,
  type StudentCalendarEvent,
  type StudentCalendarEventKind,
} from './student-events'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminDb = any

// ── Helpers ──────────────────────────────────────────────────────

/** Parse "HH:MM" time string and a date into a full Date object, resolving the
 *  real America/New_York offset for that date (EST/EDT) — never a fixed -05:00. */
function timeToDate(dateStr: string, timeStr: string): Date {
  return new Date(etWallClockToIso(dateStr, timeStr))
}

// ── Student calendar event → iCal mapping ─────────────────────────
// One category + alarm lead-time per kind, so the subscribed feed reads sensibly
// in Outlook/Apple Calendar.
const KIND_CATEGORY: Record<StudentCalendarEventKind, string> = {
  office_hours_booking: 'Office Hours',
  class_session: 'Class Session',
  assignment_due: 'Assignment',
  quiz_due: 'Quiz',
  project_due: 'Project',
  personal: 'Personal',
}
const KIND_ALARM_MIN: Record<StudentCalendarEventKind, number> = {
  office_hours_booking: 30,
  class_session: 10,
  assignment_due: 1440, // 1 day
  quiz_due: 1440,
  project_due: 1440,
  personal: 30,
}

function calendarEventToICal(e: StudentCalendarEvent): ICalEvent {
  const start = new Date(e.start)
  const isDeadline = e.end === null // point-in-time items have no end
  return {
    uid: `${e.id}@scholera.app`, // e.id is already kind-prefixed + unique
    summary: isDeadline
      ? `Due: ${e.courseCode ? `${e.courseCode} ` : ''}${e.title}`
      : e.title,
    description: e.description ?? undefined,
    location: e.location ?? undefined,
    dtstart: start,
    dtend: e.end ? new Date(e.end) : start,
    categories: [KIND_CATEGORY[e.kind]],
    alarmMinutes: KIND_ALARM_MIN[e.kind],
    status: 'CONFIRMED',
  }
}

/** Generate a stable UID for an event */
function uid(prefix: string, id: string, dateSuffix?: string): string {
  const suffix = dateSuffix ? `-${dateSuffix}` : ''
  return `${prefix}-${id}${suffix}@scholera.app`
}

// ── Feed Builder ─────────────────────────────────────────────────

export async function buildFeedEvents(
  adminDb: AdminDb,
  userId: string,
  role: 'student' | 'professor',
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  userName?: string
): Promise<ICalEvent[]> {
  const events: ICalEvent[] = []

  // Semester window: 4 months back to 4 months ahead
  const now = new Date()
  const windowStart = addDays(now, -120)
  const windowEnd = addDays(now, 120)
  const windowStartStr = format(windowStart, 'yyyy-MM-dd')
  const windowEndStr = format(windowEnd, 'yyyy-MM-dd')

  if (role === 'student') {
    // Reuse the calendar page's aggregator (already ±120-day bounded and
    // enrolment-scoped) so the feed and the page can't disagree.
    const { events: studentEvents } = await getStudentCalendarEvents(adminDb, userId)
    events.push(...studentEvents.map(calendarEventToICal))
  } else {
    await buildProfessorEvents(adminDb, userId, events, windowStart, windowEnd, windowStartStr, windowEndStr)
  }

  return events
}

// ── Professor Events ─────────────────────────────────────────────

async function buildProfessorEvents(
  adminDb: AdminDb,
  professorId: string,
  events: ICalEvent[],
  windowStart: Date,
  windowEnd: Date,
  windowStartStr: string,
  windowEndStr: string,
) {
  // 1. Office hours — expand recurring templates to individual events
  const { data: officeHours } = await adminDb
    .from('office_hours')
    .select('*')
    .eq('professor_id', professorId)
    .eq('is_active', true)

  if (officeHours) {
    for (const oh of officeHours) {
      const location = oh.meeting_type === 'zoom' ? (oh.zoom_link || 'Zoom') : (oh.location || '')

      // Shared with the dashboard calendar — a second copy of this expansion
      // would let the subscribed feed drift from what the professor sees in-app.
      for (const occ of expandOfficeHours(oh, windowStart, windowEnd)) {
        events.push({
          uid: uid('oh', oh.id, occ.date),
          summary: oh.title || 'Office Hours',
          description: oh.course_name ? `Course: ${oh.course_name} (${oh.course_code})` : undefined,
          location,
          dtstart: timeToDate(occ.date, occ.startTime),
          dtend: timeToDate(occ.date, occ.endTime),
          categories: ['Office Hours'],
          alarmMinutes: 15,
          status: 'CONFIRMED',
        })
      }
    }
  }

  // 2. Student bookings (meetings)
  const { data: bookings } = await adminDb
    .from('bookings')
    .select('id, title, date, start_time, end_time, location, zoom_link, meeting_type, status, student_id, course_name, purpose, student_note')
    .eq('professor_id', professorId)
    .eq('status', 'booked')
    .gte('date', windowStartStr)
    .lte('date', windowEndStr)

  if (bookings) {
    // Fetch student names for display
    const studentIds = [...new Set(bookings.map((b: { student_id: string }) => b.student_id))]
    const studentMap = new Map<string, string>()

    if (studentIds.length > 0) {
      const { data: students } = await adminDb
        .from('profiles')
        .select('id, name, email')
        .in('id', studentIds)

      if (students) {
        for (const s of students) {
          studentMap.set(s.id, s.name || s.email || 'Student')
        }
      }
    }

    for (const b of bookings) {
      const studentName = studentMap.get(b.student_id) || 'Student'
      const location = b.meeting_type === 'zoom' ? (b.zoom_link || 'Zoom') : (b.location || '')

      events.push({
        uid: uid('booking', b.id),
        summary: `Meeting: ${studentName} — ${b.title}`,
        description: [
          b.course_name && `Course: ${b.course_name}`,
          `Purpose: ${b.purpose}`,
          b.student_note && `Student note: ${b.student_note}`,
        ].filter(Boolean).join('\n'),
        location,
        dtstart: timeToDate(b.date, b.start_time),
        dtend: timeToDate(b.date, b.end_time),
        categories: ['Student Meeting'],
        alarmMinutes: 30,
        status: 'CONFIRMED',
      })
    }
  }

  // 3. Classroom sessions (created by this professor)
  const { data: sections } = await adminDb
    .from('course_sections')
    .select('id')
    .eq('professor_id', professorId)

  if (sections && sections.length > 0) {
    const sectionIds = sections.map((s: { id: string }) => s.id)

    // Live-classroom rooms scheduled ahead of time (v2 lc_rooms).
    const { data: sessions } = await adminDb
      .from('lc_rooms')
      .select('id, name, scheduled_at')
      .in('section_id', sectionIds)
      .eq('status', 'scheduled')
      .not('scheduled_at', 'is', null)

    if (sessions) {
      for (const s of sessions) {
        events.push({
          uid: uid('session', s.id),
          summary: s.name || 'Class Session',
          dtstart: new Date(s.scheduled_at),
          dtend: new Date(new Date(s.scheduled_at).getTime() + 60 * 60 * 1000),
          categories: ['Class Session'],
          alarmMinutes: 10,
          status: 'CONFIRMED',
        })
      }
    }
  }
}
