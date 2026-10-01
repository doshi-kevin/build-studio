// Student calendar aggregator — gathers a student's time-bound course items into
// one flat, typed event list for the interactive calendar page.
//
// Two layers, split so the mapping logic is unit-testable without a DB:
//   • buildStudentCalendarEvents(raw)  — PURE: maps already-fetched rows → events.
//   • getStudentCalendarEvents(db, id) — fetches the rows (bounded to a semester
//     window, scoped to the student's enrolments) and calls the pure builder.
//
// No new tables: reads lc_rooms (v2 live-classroom), assignments, quizzes and
// the student's own bookings. Timezone follows the existing calendar's
// America/New_York assumption (per-student timezones are out of scope).

import { addDays, format } from 'date-fns'
import { dashboardQueries } from '@/lib/supabase/queries'
import { WINDOW_DAYS, etWallClockToIso } from '@/lib/calendar/utils'
import type { ProjectDeliverableInput } from '@/lib/dashboard/todos'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminDb = any

export type StudentCalendarEventKind =
  | 'class_session'
  | 'assignment_due'
  | 'quiz_due'
  | 'project_due'
  | 'office_hours_booking'
  | 'personal'

/** The student's progress on a deadline item (null for class sessions / bookings). */
export type EventStatus =
  | 'not_started'
  | 'in_progress'
  | 'submitted'
  | 'graded'
  | 'completed'
  | 'blocked'

/** A ready-to-render calendar event. Deadlines are points in time (`end` null). */
export interface StudentCalendarEvent {
  /** Stable, unique — kind-prefixed source id. */
  id: string
  kind: StudentCalendarEventKind
  title: string
  /** ISO start (for deadlines, the due time). */
  start: string
  /** ISO end, or null for point-in-time deadlines. */
  end: string | null
  courseCode: string | null
  sectionId: string | null
  /** Internal click-through path. */
  href: string
  location: string | null
  /** Short context for the hover popup (assignment/quiz description); null when none. */
  description: string | null
  /** The student's progress on this item; null for class sessions / bookings. */
  status: EventStatus | null
  /** For editable personal events: the DB row id, so clicking the chip opens the editor.
   *  Undefined for course items (which navigate to their page instead). */
  editKey?: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const resolveJoin = (val: any) => (Array.isArray(val) ? val[0] : val)

/** Normalize a free-text field to a non-empty trimmed string, or null. */
const cleanText = (val: unknown): string | null => {
  const s = typeof val === 'string' ? val.trim() : ''
  return s.length > 0 ? s : null
}

/** assignment_submissions.status → the student's progress. No row ⇒ not started. */
const assignmentStatus = (raw: string | null | undefined): EventStatus =>
  raw === 'graded' ? 'graded' : raw === 'submitted' ? 'submitted' : raw === 'draft' ? 'in_progress' : 'not_started'

/** quiz_attempts.status (best across attempts) → progress. No attempt ⇒ not started. */
const quizStatus = (raw: string | null | undefined): EventStatus =>
  raw === 'submitted' ? 'submitted' : raw === 'in_progress' ? 'in_progress' : 'not_started'

/** project_phases.status → progress (values already align, with a safe default). */
const phaseStatus = (raw: string | null | undefined): EventStatus =>
  raw === 'completed' || raw === 'in_progress' || raw === 'blocked' ? raw : 'not_started'

/** Default block length for a scheduled class session — v2 rooms have no end time. */
const CLASS_SESSION_MIN = 60

export interface StudentCalendarRawInput {
  /** section_id → course code, for tagging events with their course. */
  sectionCourseCode: Map<string, string>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  bookings: any[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sessions: any[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assignments: any[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  quizzes: any[]
  /** Project deliverables (phases with a due date) — shown as project deadlines. */
  deliverables: ProjectDeliverableInput[]
  /** This student's assignment submissions: assignment_id → status row. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  submissions: any[]
  /** This student's quiz attempts: quiz_id → status row. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  attempts: any[]
  /** This student's own personal events (study blocks, reminders). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  personalEvents: any[]
}

/**
 * PURE: map already-fetched, already-window-bounded rows into calendar events,
 * sorted by start time. Rows with no usable date are skipped. Exported for tests.
 */
export function buildStudentCalendarEvents(raw: StudentCalendarRawInput): StudentCalendarEvent[] {
  const { sectionCourseCode, bookings, sessions, assignments, quizzes, deliverables, submissions, attempts, personalEvents } = raw
  const codeFor = (sectionId: string | null | undefined) =>
    (sectionId && sectionCourseCode.get(sectionId)) || null

  // Per-student progress: one submission per (assignment, student); quizzes may have
  // several attempts, so a submitted attempt wins over an in-progress one.
  const subByAssignment = new Map<string, string>()
  for (const s of submissions) if (s.assignment_id) subByAssignment.set(s.assignment_id, s.status)
  const attemptByQuiz = new Map<string, string>()
  for (const a of attempts) {
    if (!a.quiz_id) continue
    if (a.status === 'submitted' || !attemptByQuiz.has(a.quiz_id)) attemptByQuiz.set(a.quiz_id, a.status)
  }

  const events: StudentCalendarEvent[] = []

  // Office-hours bookings — timed blocks.
  for (const b of bookings) {
    if (!b.date || !b.start_time) continue
    const location = b.meeting_type === 'zoom' ? (b.zoom_link || 'Zoom') : (b.location || null)
    events.push({
      id: `booking-${b.id}`,
      kind: 'office_hours_booking',
      title: b.title || 'Office Hours',
      start: etWallClockToIso(b.date, b.start_time),
      end: b.end_time ? etWallClockToIso(b.date, b.end_time) : null,
      courseCode: null,
      sectionId: null,
      href: '/student/office-hours',
      location,
      description: null,
      status: null,
    })
  }

  // Class sessions (v2 live-classroom rooms) — timed blocks. v2 rooms carry a
  // scheduled start but no scheduled end, so render a fixed-length default block.
  for (const s of sessions) {
    if (!s.scheduled_at) continue
    const start = new Date(s.scheduled_at)
    events.push({
      id: `session-${s.id}`,
      kind: 'class_session',
      title: s.name || 'Class Session',
      start: start.toISOString(),
      end: new Date(start.getTime() + CLASS_SESSION_MIN * 60_000).toISOString(),
      courseCode: codeFor(s.section_id),
      sectionId: s.section_id ?? null,
      href: `/student/courses/${s.section_id}/live-classroom`,
      location: null,
      description: null,
      status: null,
    })
  }

  // Assignment deadlines — points in time. Track which assignments produced a
  // chip so a project phase copied from one of them (project_phases.assignment_id)
  // can be collapsed away below instead of rendering the same item twice.
  const shownAssignmentIds = new Set<string>()
  for (const a of assignments) {
    if (!a.due_at) continue
    shownAssignmentIds.add(a.id)
    events.push({
      id: `assignment-${a.id}`,
      kind: 'assignment_due',
      title: a.title || 'Assignment',
      start: new Date(a.due_at).toISOString(),
      end: null,
      courseCode: codeFor(a.section_id),
      sectionId: a.section_id ?? null,
      href: `/student/courses/${a.section_id}/assignments/${a.id}`,
      location: null,
      description: cleanText(a.description),
      status: assignmentStatus(subByAssignment.get(a.id)),
    })
  }

  // Quiz deadlines — points in time (column is `due_date`).
  for (const q of quizzes) {
    if (!q.due_date) continue
    events.push({
      id: `quiz-${q.id}`,
      kind: 'quiz_due',
      title: q.title || 'Quiz',
      start: new Date(q.due_date).toISOString(),
      end: null,
      courseCode: codeFor(q.section_id),
      sectionId: q.section_id ?? null,
      href: `/student/courses/${q.section_id}/quizzes/${q.id}`,
      location: null,
      description: cleanText(q.description),
      status: quizStatus(attemptByQuiz.get(q.id)),
    })
  }

  // Project deliverable deadlines (phase due dates) — points in time. A phase
  // copied from an assignment already on the calendar is the same deliverable:
  // drop it and keep the assignment chip, which carries the authoritative
  // submission/grade status (the phase's own status is a stale one-time copy).
  for (const d of deliverables) {
    if (!d.dueAt) continue
    if (d.assignmentId && shownAssignmentIds.has(d.assignmentId)) continue
    events.push({
      id: `phase-${d.phaseId}`,
      kind: 'project_due',
      title: d.projectTitle ? `${d.projectTitle} — ${d.phaseTitle}` : d.phaseTitle,
      start: new Date(d.dueAt).toISOString(),
      end: null,
      courseCode: codeFor(d.sectionId),
      sectionId: d.sectionId,
      href: d.sectionId && d.projectId
        ? `/student/courses/${d.sectionId}/projects/${d.projectId}`
        : '/student/courses',
      location: null,
      description: null,
      status: phaseStatus(d.status),
    })
  }

  // The student's own personal events — timed blocks, or all-day (rendered 00:00–23:59).
  for (const p of personalEvents) {
    if (!p.date) continue
    const startTime = p.all_day ? '00:00' : p.start_time || '00:00'
    const start = etWallClockToIso(p.date, startTime)
    const end = p.all_day
      ? etWallClockToIso(p.date, '23:59')
      : p.end_time
        ? etWallClockToIso(p.date, p.end_time)
        : null
    events.push({
      // Weekly occurrences share the DB id but need unique calendar/ICS ids per date.
      id: p.recurrence === 'weekly' ? `personal-${p.id}-${p.date}` : `personal-${p.id}`,
      kind: 'personal',
      title: p.title || 'Personal event',
      start,
      end,
      courseCode: null,
      sectionId: null,
      // Personal events aren't a course page; keep the student on the calendar.
      href: '/student/calendar',
      location: null,
      description: cleanText(p.note),
      status: null,
      // The DB row id (not the per-occurrence calendar id) so a click edits the series.
      editKey: p.id,
    })
  }

  return events.sort((x, y) => x.start.localeCompare(y.start))
}

/**
 * Expand weekly-recurring personal events into per-date occurrences within [rangeStart,
 * rangeEnd]; one-off events pass through unchanged. Noon-anchored so DST/midnight never
 * shifts the weekday. Mirrors expandBlockedTimes. Exported for tests.
 */
export function expandPersonalEvents(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rows: any[],
  rangeStart: Date,
  rangeEnd: Date,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any[] {
  const rangeEndStr = format(rangeEnd, 'yyyy-MM-dd')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: any[] = []
  for (const p of rows) {
    if (!p.date) continue
    if (p.recurrence !== 'weekly') {
      out.push(p)
      continue
    }
    const anchor = new Date(`${p.date}T12:00:00`)
    const untilStr = p.recurrence_until || rangeEndStr
    let cur = anchor > rangeStart ? new Date(anchor) : new Date(rangeStart)
    cur.setHours(12, 0, 0, 0)
    while (format(cur, 'yyyy-MM-dd') <= rangeEndStr) {
      const curStr = format(cur, 'yyyy-MM-dd')
      if (curStr >= p.date && curStr <= untilStr && cur.getDay() === anchor.getDay()) {
        out.push({ ...p, date: curStr })
      }
      cur = addDays(cur, 1)
    }
  }
  return out
}

/**
 * Fetch a student's calendar events for the semester window (±WINDOW_DAYS),
 * scoped to their enrolled sections plus their own bookings. Reads are bounded
 * by the window and run in parallel. Caller must have authenticated the student
 * and pass an admin client.
 */
export async function getStudentCalendarEvents(
  adminDb: AdminDb,
  studentId: string,
): Promise<{ events: StudentCalendarEvent[]; error: boolean }> {
  const now = new Date()
  const startDate = addDays(now, -WINDOW_DAYS)
  const endDate = addDays(now, WINDOW_DAYS)
  const startIso = startDate.toISOString()
  const endIso = endDate.toISOString()
  const startDay = format(startDate, 'yyyy-MM-dd')
  const endDay = format(endDate, 'yyyy-MM-dd')

  // Enrolled sections + their course codes.
  const { data: enrollments, error: enrollError } = await adminDb
    .from('enrollments')
    .select('section_id, section:course_sections(id, course:courses(code))')
    .eq('student_id', studentId)
    .in('status', ['enrolled', 'completed'])

  const sectionCourseCode = new Map<string, string>()
  const sectionIds: string[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const e of (enrollments || []) as any[]) {
    if (!e.section_id) continue
    sectionIds.push(e.section_id)
    const course = resolveJoin(resolveJoin(e.section)?.course)
    if (course?.code) sectionCourseCode.set(e.section_id, course.code)
  }

  // Bookings depend only on the student; the section-scoped reads need sectionIds.
  const bookingsPromise = adminDb
    .from('bookings')
    .select('id, title, date, start_time, end_time, location, zoom_link, meeting_type, status')
    .eq('student_id', studentId)
    .eq('status', 'booked')
    .gte('date', startDay)
    .lte('date', endDay)

  // Personal events depend only on the student (no section), like bookings — so they
  // show even for a student with no enrolments.
  const personalPromise = adminDb
    .from('personal_events')
    .select('id, title, date, start_time, end_time, all_day, note, recurrence, recurrence_until')
    .eq('student_id', studentId)
    .lte('date', endDay)
    // One-off events must fall in the window; recurring events (any anchor date) are kept and
    // expanded to in-window occurrences below, so a weekly event from months ago still shows.
    .or(`recurrence.neq.none,date.gte.${startDay}`)

  if (sectionIds.length === 0) {
    const [{ data: bookings, error: bookingsError }, { data: personalEvents, error: personalError }] =
      await Promise.all([bookingsPromise, personalPromise])
    return {
      events: buildStudentCalendarEvents({
        sectionCourseCode,
        bookings: bookings || [],
        sessions: [],
        assignments: [],
        quizzes: [],
        deliverables: [],
        submissions: [],
        attempts: [],
        personalEvents: expandPersonalEvents(personalEvents || [], startDate, endDate),
      }),
      error: Boolean(enrollError || bookingsError || personalError),
    }
  }

  const [bookingsRes, sessionsRes, assignmentsRes, quizzesRes, submissionsRes, attemptsRes, allDeliverables, personalRes] = await Promise.all([
    bookingsPromise,
    adminDb
      .from('lc_rooms')
      .select('id, name, scheduled_at, status, section_id')
      .in('section_id', sectionIds)
      .in('status', ['scheduled', 'live'])
      .not('scheduled_at', 'is', null)
      .gte('scheduled_at', startIso)
      .lte('scheduled_at', endIso),
    adminDb
      .from('assignments')
      .select('id, title, due_at, section_id, status, description')
      .in('section_id', sectionIds)
      .eq('status', 'published')
      .not('due_at', 'is', null)
      .gte('due_at', startIso)
      .lte('due_at', endIso),
    adminDb
      .from('quizzes')
      .select('id, title, due_date, section_id, status, description')
      .in('section_id', sectionIds)
      .eq('status', 'published')
      .not('due_date', 'is', null)
      .gte('due_date', startIso)
      .lte('due_date', endIso),
    // The student's own submission/attempt status — for the hover progress badge.
    // Scoped by student only; the builder ignores rows for events not in the window.
    adminDb.from('assignment_submissions').select('assignment_id, status').eq('student_id', studentId),
    adminDb.from('quiz_attempts').select('quiz_id, status').eq('student_id', studentId),
    // Project deliverables reuse the dashboard query (same enrollment/visibility/team
    // gating). It isn't window-bounded, so narrow to the calendar window here.
    dashboardQueries.getStudentProjectDeliverables(adminDb, studentId),
    personalPromise,
  ])

  const deliverables = allDeliverables.filter((d) => {
    if (!d.dueAt) return false
    const t = new Date(d.dueAt).getTime()
    return t >= startDate.getTime() && t <= endDate.getTime()
  })

  // Deliverables swallow their own errors (return []), so the failure flag comes
  // from the directly-read sources; any of them erroring means a degraded load.
  const error = Boolean(
    enrollError ||
      bookingsRes.error ||
      sessionsRes.error ||
      assignmentsRes.error ||
      quizzesRes.error ||
      personalRes.error,
  )

  return {
    events: buildStudentCalendarEvents({
      sectionCourseCode,
      bookings: bookingsRes.data || [],
      sessions: sessionsRes.data || [],
      assignments: assignmentsRes.data || [],
      quizzes: quizzesRes.data || [],
      deliverables,
      submissions: submissionsRes.data || [],
      attempts: attemptsRes.data || [],
      personalEvents: expandPersonalEvents(personalRes.data || [], startDate, endDate),
    }),
    error,
  }
}
