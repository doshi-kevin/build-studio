import { describe, it, expect } from 'vitest'
import {
  buildStudentCalendarEvents,
  expandPersonalEvents,
  type StudentCalendarRawInput,
} from '@/lib/calendar/student-events'

// Minimal raw input with sensible defaults; override per test.
function raw(partial: Partial<StudentCalendarRawInput>): StudentCalendarRawInput {
  return {
    sectionCourseCode: new Map(),
    bookings: [],
    sessions: [],
    assignments: [],
    quizzes: [],
    deliverables: [],
    submissions: [],
    attempts: [],
    personalEvents: [],
    ...partial,
  }
}

describe('expandPersonalEvents', () => {
  const rangeStart = new Date('2026-07-01T00:00:00')
  const rangeEnd = new Date('2026-07-31T00:00:00')

  it('expands a weekly event into one occurrence per week through recurrence_until', () => {
    const out = expandPersonalEvents(
      [{ id: 'w1', title: 'Gym', date: '2026-07-06', recurrence: 'weekly', recurrence_until: '2026-07-27' }],
      rangeStart,
      rangeEnd,
    )
    // Anchor 07-06 repeats every 7 days through 07-27.
    expect(out.map((o) => o.date)).toEqual(['2026-07-06', '2026-07-13', '2026-07-20', '2026-07-27'])
  })

  it('passes a one-off event through unchanged', () => {
    const out = expandPersonalEvents(
      [{ id: 's1', title: 'Trip', date: '2026-07-10', recurrence: 'none', recurrence_until: null }],
      rangeStart,
      rangeEnd,
    )
    expect(out).toHaveLength(1)
    expect(out[0].date).toBe('2026-07-10')
  })

  it('open-ended weekly recurrence fills to the range end', () => {
    const out = expandPersonalEvents(
      [{ id: 'w2', title: 'Standup', date: '2026-07-06', recurrence: 'weekly', recurrence_until: null }],
      rangeStart,
      rangeEnd,
    )
    // 07-06, 13, 20, 27 all fall within July.
    expect(out).toHaveLength(4)
  })
})

describe('buildStudentCalendarEvents', () => {
  it('maps personal events (timed + all-day) to the personal kind', () => {
    const events = buildStudentCalendarEvents(
      raw({
        personalEvents: [
          { id: 'pe1', title: 'Study block', date: '2026-07-15', start_time: '14:00', end_time: '16:00', all_day: false, note: 'ch 4' },
          { id: 'pe2', title: 'Day off', date: '2026-07-16', start_time: null, end_time: null, all_day: true, note: null },
        ],
      }),
    )
    const timed = events.find((e) => e.id === 'personal-pe1')
    expect(timed?.kind).toBe('personal')
    expect(timed?.href).toBe('/student/calendar')
    expect(timed?.description).toBe('ch 4')
    expect(timed?.end).not.toBeNull()
    // All-day is rendered as a 00:00–23:59 block (has an end), not a point-in-time deadline.
    const allDay = events.find((e) => e.id === 'personal-pe2')
    expect(allDay?.kind).toBe('personal')
    expect(allDay?.end).not.toBeNull()
  })

  it('maps each source to its kind, href, and course code', () => {
    const sectionCourseCode = new Map([['sec-1', 'CS101']])
    const events = buildStudentCalendarEvents(
      raw({
        sectionCourseCode,
        sessions: [
          { id: 's1', name: 'Lecture', scheduled_at: '2026-07-10T14:00:00Z', status: 'scheduled', section_id: 'sec-1' },
        ],
        assignments: [
          { id: 'a1', title: 'Essay', due_at: '2026-07-11T23:59:00Z', section_id: 'sec-1' },
        ],
        quizzes: [
          { id: 'q1', title: 'Quiz 1', due_date: '2026-07-12T23:59:00Z', section_id: 'sec-1' },
        ],
        deliverables: [
          { phaseId: 'p1', projectId: 'proj1', projectTitle: 'Capstone', phaseTitle: 'Phase 1', sectionId: 'sec-1', dueAt: '2026-07-13T23:59:00Z', status: 'in_progress', assignmentId: null },
        ],
      }),
    )

    const byId = Object.fromEntries(events.map((e) => [e.id, e]))

    expect(byId['session-s1']).toMatchObject({
      kind: 'class_session',
      title: 'Lecture', // from lc_rooms.name
      courseCode: 'CS101',
      start: '2026-07-10T14:00:00.000Z', // from scheduled_at
      end: '2026-07-10T15:00:00.000Z', // v2 rooms have no end → +60min default block
      href: '/student/courses/sec-1/live-classroom',
    })
    expect(byId['assignment-a1']).toMatchObject({
      kind: 'assignment_due',
      href: '/student/courses/sec-1/assignments/a1',
    })
    expect(byId['quiz-q1']).toMatchObject({
      kind: 'quiz_due',
      href: '/student/courses/sec-1/quizzes/q1',
    })
    expect(byId['phase-p1']).toMatchObject({
      kind: 'project_due',
      title: 'Capstone — Phase 1',
      href: '/student/courses/sec-1/projects/proj1',
    })
  })

  it('gives deadlines a null end but keeps sessions/bookings ranged', () => {
    const events = buildStudentCalendarEvents(
      raw({
        sessions: [{ id: 's1', name: 'L', scheduled_at: '2026-07-10T14:00:00Z', status: 'scheduled', section_id: 'sec-1' }],
        assignments: [{ id: 'a1', title: 'A', due_at: '2026-07-11T23:59:00Z', section_id: 'sec-1' }],
      }),
    )
    const session = events.find((e) => e.id === 'session-s1')!
    const assignment = events.find((e) => e.id === 'assignment-a1')!

    expect(session.end).not.toBeNull()
    expect(assignment.end).toBeNull()
  })

  it('builds office-hours bookings from date + time and links to the office-hours page', () => {
    const events = buildStudentCalendarEvents(
      raw({
        bookings: [
          { id: 'b1', title: 'OH with Prof', date: '2026-07-10', start_time: '13:00', end_time: '13:30', meeting_type: 'in_person', location: 'Room 5', status: 'booked' },
        ],
      }),
    )
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      id: 'booking-b1',
      kind: 'office_hours_booking',
      href: '/student/office-hours',
      location: 'Room 5',
      courseCode: null,
    })
    // start/end resolve to the given ET wall-clock times. Jul 10 is daylight
    // time (EDT, -04:00), so 13:00 ET = 17:00Z — NOT 18:00Z. A fixed -05:00
    // offset was the "office hours show an hour late" bug (issue #423).
    expect(events[0].start).toBe('2026-07-10T17:00:00.000Z')
    expect(events[0].end).toBe('2026-07-10T17:30:00.000Z')
  })

  it('resolves booking times against the correct ET offset in both EST and EDT', () => {
    const events = buildStudentCalendarEvents(
      raw({
        bookings: [
          // Winter → Eastern Standard Time (-05:00): 14:00 ET = 19:00Z.
          { id: 'winter', title: 'OH', date: '2026-01-15', start_time: '14:00', end_time: '14:30', meeting_type: 'in_person', status: 'booked' },
          // Summer → Eastern Daylight Time (-04:00): 14:00 ET = 18:00Z.
          { id: 'summer', title: 'OH', date: '2026-07-15', start_time: '14:00', end_time: '14:30', meeting_type: 'in_person', status: 'booked' },
        ],
      }),
    )
    const byId = Object.fromEntries(events.map((e) => [e.id, e]))
    expect(byId['booking-winter'].start).toBe('2026-01-15T19:00:00.000Z')
    expect(byId['booking-summer'].start).toBe('2026-07-15T18:00:00.000Z')
  })

  it('collapses a project phase copied from an assignment already on the calendar', () => {
    const events = buildStudentCalendarEvents(
      raw({
        assignments: [
          { id: 'a1', title: 'Test Assignment', due_at: '2026-07-11T23:59:00Z', section_id: 'sec-1' },
        ],
        submissions: [{ assignment_id: 'a1', status: 'graded' }],
        deliverables: [
          // Mirrors a1 → suppressed (the assignment chip is authoritative).
          { phaseId: 'mirror', projectId: 'proj1', projectTitle: 'Cap', phaseTitle: 'Test Assignment', sectionId: 'sec-1', dueAt: '2026-07-11T23:59:00Z', status: 'not_started', assignmentId: 'a1' },
          // Not linked to any shown assignment → kept.
          { phaseId: 'standalone', projectId: 'proj1', projectTitle: 'Cap', phaseTitle: 'Design doc', sectionId: 'sec-1', dueAt: '2026-07-12T23:59:00Z', status: 'in_progress', assignmentId: null },
        ],
      }),
    )
    const ids = events.map((e) => e.id)
    expect(ids).toContain('assignment-a1')
    expect(ids).not.toContain('phase-mirror') // collapsed into the assignment
    expect(ids).toContain('phase-standalone') // unrelated phase survives
    // The kept chip reflects the real submission status, not the stale phase copy.
    expect(events.find((e) => e.id === 'assignment-a1')!.status).toBe('graded')
  })

  it('keeps a phase whose linked assignment is not itself on the calendar', () => {
    // The assignment is unpublished / out of window, so no assignment chip exists;
    // the phase is the only representation and must stay.
    const events = buildStudentCalendarEvents(
      raw({
        deliverables: [
          { phaseId: 'p1', projectId: 'proj1', projectTitle: 'Cap', phaseTitle: 'Ph', sectionId: 'sec-1', dueAt: '2026-07-13T23:59:00Z', status: 'in_progress', assignmentId: 'a-missing' },
        ],
      }),
    )
    expect(events.map((e) => e.id)).toContain('phase-p1')
  })

  it('uses the zoom link as location for zoom bookings', () => {
    const events = buildStudentCalendarEvents(
      raw({
        bookings: [
          { id: 'b1', title: 'OH', date: '2026-07-10', start_time: '13:00', end_time: '13:30', meeting_type: 'zoom', zoom_link: 'https://zoom/x', status: 'booked' },
        ],
      }),
    )
    expect(events[0].location).toBe('https://zoom/x')
  })

  it('skips rows with no usable date and leaves course code null when unmapped', () => {
    const events = buildStudentCalendarEvents(
      raw({
        // sectionCourseCode intentionally empty
        sessions: [{ id: 's1', name: 'L', scheduled_at: null, status: 'scheduled', section_id: 'sec-1' }], // no start → skipped
        assignments: [{ id: 'a1', title: 'A', due_at: '2026-07-11T23:59:00Z', section_id: 'sec-1' }],
      }),
    )
    expect(events.find((e) => e.id === 'session-s1')).toBeUndefined()
    expect(events.find((e) => e.id === 'assignment-a1')!.courseCode).toBeNull()
  })

  it('carries assignment/quiz description and normalizes empty/whitespace to null', () => {
    const events = buildStudentCalendarEvents(
      raw({
        assignments: [
          { id: 'a1', title: 'A', due_at: '2026-07-11T23:59:00Z', section_id: 'sec-1', description: '  Write 500 words  ' },
          { id: 'a2', title: 'A2', due_at: '2026-07-12T23:59:00Z', section_id: 'sec-1', description: '   ' },
        ],
        quizzes: [
          { id: 'q1', title: 'Q', due_date: '2026-07-13T23:59:00Z', section_id: 'sec-1', description: null },
        ],
        sessions: [
          { id: 's1', name: 'L', scheduled_at: '2026-07-10T14:00:00Z', status: 'scheduled', section_id: 'sec-1' },
        ],
      }),
    )
    const byId = Object.fromEntries(events.map((e) => [e.id, e]))
    expect(byId['assignment-a1'].description).toBe('Write 500 words') // trimmed
    expect(byId['assignment-a2'].description).toBeNull() // whitespace-only → null
    expect(byId['quiz-q1'].description).toBeNull() // null passthrough
    expect(byId['session-s1'].description).toBeNull() // sessions never carry one
  })

  it('derives per-student status from submissions, attempts, and phase status', () => {
    const events = buildStudentCalendarEvents(
      raw({
        assignments: [
          { id: 'a-none', title: 'A', due_at: '2026-07-11T23:59:00Z', section_id: 'sec-1' },
          { id: 'a-draft', title: 'A', due_at: '2026-07-11T23:59:00Z', section_id: 'sec-1' },
          { id: 'a-graded', title: 'A', due_at: '2026-07-11T23:59:00Z', section_id: 'sec-1' },
        ],
        quizzes: [
          { id: 'q-none', title: 'Q', due_date: '2026-07-12T23:59:00Z', section_id: 'sec-1' },
          { id: 'q-sub', title: 'Q', due_date: '2026-07-12T23:59:00Z', section_id: 'sec-1' },
        ],
        deliverables: [
          { phaseId: 'p1', projectId: 'proj1', projectTitle: 'Cap', phaseTitle: 'Ph', sectionId: 'sec-1', dueAt: '2026-07-13T23:59:00Z', status: 'in_progress', assignmentId: null },
        ],
        submissions: [
          { assignment_id: 'a-draft', status: 'draft' },
          { assignment_id: 'a-graded', status: 'graded' },
        ],
        // A quiz with both an abandoned and a submitted attempt resolves to submitted.
        attempts: [
          { quiz_id: 'q-sub', status: 'in_progress' },
          { quiz_id: 'q-sub', status: 'submitted' },
        ],
      }),
    )
    const byId = Object.fromEntries(events.map((e) => [e.id, e]))
    expect(byId['assignment-a-none'].status).toBe('not_started')
    expect(byId['assignment-a-draft'].status).toBe('in_progress')
    expect(byId['assignment-a-graded'].status).toBe('graded')
    expect(byId['quiz-q-none'].status).toBe('not_started')
    expect(byId['quiz-q-sub'].status).toBe('submitted')
    expect(byId['phase-p1'].status).toBe('in_progress')
  })

  it('lets a submitted quiz attempt win regardless of attempt order', () => {
    // Guards the `has()` tie-break: a submitted attempt must win even when it is
    // read BEFORE a later in-progress one (a naive last-write-wins map would lose).
    const events = buildStudentCalendarEvents(
      raw({
        quizzes: [{ id: 'q-sub', title: 'Q', due_date: '2026-07-12T23:59:00Z', section_id: 'sec-1' }],
        attempts: [
          { quiz_id: 'q-sub', status: 'submitted' },
          { quiz_id: 'q-sub', status: 'in_progress' },
        ],
      }),
    )
    expect(events.find((e) => e.id === 'quiz-q-sub')!.status).toBe('submitted')
  })

  it('returns events sorted by start time', () => {
    const events = buildStudentCalendarEvents(
      raw({
        assignments: [
          { id: 'late', title: 'Late', due_at: '2026-07-20T10:00:00Z', section_id: 'sec-1' },
          { id: 'early', title: 'Early', due_at: '2026-07-01T10:00:00Z', section_id: 'sec-1' },
        ],
        deliverables: [
          { phaseId: 'mid', projectId: 'proj1', projectTitle: 'Capstone', phaseTitle: 'Mid', sectionId: 'sec-1', dueAt: '2026-07-10T10:00:00Z', status: 'in_progress', assignmentId: null },
        ],
      }),
    )
    expect(events.map((e) => e.id)).toEqual(['assignment-early', 'phase-mid', 'assignment-late'])
  })
})
