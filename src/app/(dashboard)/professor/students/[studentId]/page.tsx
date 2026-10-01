/**
 * Student Profile — the professor's view of one student they currently teach.
 *
 * Answers the three questions a professor has when a student's name comes up:
 * who they are, what else they are carrying this term, and when the two of them
 * could meet. Reached by clicking a name on the course Roster, and from the
 * per-section analytics page. Deliberately not in the sidebar: it needs a
 * student id, so there is nothing to navigate to without one.
 *
 * Lives at the professor level rather than under a section because "what else
 * is this student taking" is not section-scoped. A section-shaped URL would be
 * lying about the scope of what the page shows.
 *
 * SECURITY. `(dashboard)/professor/layout.tsx` admits professors, institution
 * admins AND course assistants, and a layout that denies by rendering a message
 * does not stop this page from running (layouts and pages render in parallel,
 * so the page's data still lands in the response — see
 * `.claude/rules/dead-ends.md`, written after PR #555 leaked ten pages' worth of
 * another institution's roster exactly that way). So this page performs its own
 * check, before its first read of anything, and everything it hands to a client
 * component is rebuilt field by field rather than passed straight through.
 *
 * Type: Server Component
 * Route: /professor/students/[studentId]
 * Tables: enrollments, course_sections, courses, profiles, plus the calendar
 *   sources behind the two aggregators (lc_rooms, bookings, personal_events,
 *   assignments, quizzes, office_hours, blocked_times)
 */

import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { calendarQueries, profileQueries, studentQueries } from '@/lib/supabase/queries'
import { getStudentCalendarEvents } from '@/lib/calendar/student-events'
import { getProfessorCalendarEvents } from '@/lib/calendar/professor-events'
import {
  etDayKeys,
  invertToFreeSlots,
  mergeBusyIntervals,
  suggestMeetingSlots,
  toBusyIntervals,
  TRANSIT_PAD_MIN,
  type BusyInterval,
} from '@/lib/calendar/availability'
import { expandBlockedTimes, isoToEtWallClock, timeToMinutes } from '@/lib/calendar/utils'
import { parseStudentProfile } from '@/lib/validations/student-profile'
import type { BlockedTime } from '@/lib/validations/calendar'
import { logger } from '@/lib/logger'
import { StudentProfileView } from '@/components/professor/students/StudentProfileView'

/** How far ahead the availability grid looks. Two teaching weeks. */
const WINDOW_DAY_COUNT = 14

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const resolveJoin = (val: any) => (Array.isArray(val) ? val[0] : val)

/** Exactly what the view receives per class. Nothing else crosses the wire. */
interface EnrolledClass {
  sectionId: string
  courseCode: string | null
  courseTitle: string | null
  sectionCode: string | null
  semester: string | null
  year: number | null
  isMine: boolean
  finalGrade: string | null
  finalScore: number | null
}

interface EnrollmentRow {
  final_grade: string | null
  final_score: number | null
  section: {
    id: string
    section_code: string | null
    semester: string | null
    year: number | null
    status: string | null
    professor_id: string | null
    course: { id: string; code: string | null; title: string | null } | null
  } | null
}

interface StudentProfilePageProps {
  params: Promise<{ studentId: string }>
}

export default async function ProfessorStudentProfilePage({ params }: StudentProfilePageProps) {
  const { studentId } = await params

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) notFound()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any

  /* ── The access check. Runs before anything is rendered or returned. ────────
     One read establishes the whole relationship: an ENROLLED row for this
     student in an ACTIVE section whose professor is the caller. Enrollments
     cannot span institutions, so a hit also proves same-tenant; the explicit
     comparison below is belt and braces.

     'enrolled' only, never 'completed' or 'dropped'. Finishing or leaving a
     course should not keep granting a professor a live view of that student's
     week. Note the ceiling on this: nothing in the schema marks a term as over
     (sections are 'active' or 'draft' and nothing moves them out of 'active',
     and end_date is unset everywhere), so an old section that is still 'active'
     still grants access. That is a platform gap, not one this page can close. */
  const enrollmentRows = (await studentQueries.getEnrolledSectionsForStudent(
    adminDb,
    studentId,
  )) as EnrollmentRow[]

  const mySections = enrollmentRows.filter((row) => {
    const section = resolveJoin(row.section)
    return section?.professor_id === user.id && section?.status === 'active'
  })

  if (mySections.length === 0) {
    /* Fused with "no such student" ON PURPOSE, the same way getStudentAnalytics
       does it: distinguishing them would let any professor use this URL to probe
       which student ids exist in other people's courses. */
    logger.warn('ProfessorStudentProfilePage: no shared active section', { studentId, userId: user.id })
    notFound()
  }

  const [student, callerProfile] = await Promise.all([
    // Filters role='student' itself, so this doubles as the role check.
    studentQueries.getById(adminDb, studentId),
    profileQueries.getProfileById(supabase, user.id),
  ])

  if (!student) {
    logger.warn('ProfessorStudentProfilePage: profile missing', { studentId })
    notFound()
  }

  if (student.institution_id !== callerProfile?.institution_id) {
    logger.warn('ProfessorStudentProfilePage: cross-tenant access blocked', {
      studentId,
      studentInstitution: student.institution_id,
      callerInstitution: callerProfile?.institution_id,
    })
    notFound()
  }

  /* ── Past the gate. Everything below is authorized. ─────────────────────── */

  const mySectionIds = new Set<string>(
    mySections
      .map((row) => resolveJoin(row.section)?.id as string | undefined)
      .filter((id): id is string => Boolean(id)),
  )

  /* Both calendars plus the professor's own blocked-off time. The blocked times
     come through the note-free RPC rather than the table: it returns time ranges
     with no reason or note attached, which is the shape this page wants anyway.
     It authorizes on auth.uid(), so it must use the RLS client, not the admin one. */
  const [studentCalendar, professorCalendar, busyRows] = await Promise.all([
    getStudentCalendarEvents(adminDb, studentId),
    getProfessorCalendarEvents(adminDb, user.id),
    calendarQueries.getProfessorBusyTimes(supabase, user.id),
  ])

  const nowEt = isoToEtWallClock(new Date().toISOString())
  const dayKeys = etDayKeys(nowEt.date, WINDOW_DAY_COUNT)
  const windowStart = dayKeys[0]
  const windowEnd = dayKeys[dayKeys.length - 1]
  const inWindow = (date: string) => date >= windowStart && date <= windowEnd

  /* The professor's blocked times as busy intervals. Mapped into the full
     BlockedTime shape so `expandBlockedTimes` can do the weekly recurrence —
     same approach as student/office-hours/page.tsx, and better than a second
     implementation of recurrence expansion living here. */
  const blockedTemplates: BlockedTime[] = busyRows.map((row, i) => ({
    id: `busy-${i}`,
    professorId: user.id,
    date: row.date,
    startTime: row.start_time,
    endTime: row.end_time,
    reason: 'other',
    note: '',
    courseId: null,
    courseName: null,
    courseCode: null,
    meetingType: null,
    location: '',
    zoomLink: '',
    recurrence: (row.recurrence as BlockedTime['recurrence']) ?? 'none',
    recurrenceUntil: row.recurrence_until ?? null,
    createdAt: '',
  }))

  const blockedIntervals: BusyInterval[] = expandBlockedTimes(
    blockedTemplates,
    new Date(`${windowStart}T12:00:00`),
    new Date(`${windowEnd}T12:00:00`),
  )
    .filter((block) => inWindow(block.date))
    .map((block) => ({
      date: block.date,
      startMin: timeToMinutes(block.startTime),
      endMin: timeToMinutes(block.endTime),
      label: null,
    }))
    .filter((interval) => interval.endMin > interval.startMin)

  /* Only the caller's own sections get a label, and the label is the course
     code — never an event title, which could say anything.

     BOTH feeds are labelled with the SAME section set on purpose. A class the
     professor teaches this student in sits on both calendars, so it arrives here
     twice; matching labels are what let the merge below recognise the two copies
     as one commitment. Labelling only the student's side drew a labelled block
     and an unlabelled one on top of each other — invisible while everything
     merged indiscriminately, obvious the moment it stopped. */
  const allBusy: BusyInterval[] = [
    ...toBusyIntervals(studentCalendar.events, mySectionIds),
    ...toBusyIntervals(professorCalendar.events, mySectionIds),
    ...blockedIntervals,
  ].filter((interval) => inWindow(interval.date))

  /* Unpadded for the grid, so the professor sees the real shape of the day, and
     with labelled blocks kept out of their neighbours so a 1-hour class touching
     2 hours of office hours doesn't render as a 3-hour block wearing the course
     code. Free-slot finding below deliberately does the opposite: for "can we
     meet", busy is busy and the labels are irrelevant. */
  const displayByDay = mergeBusyIntervals(allBusy, 0, { keepLabelsSeparate: true })
  // Padded for slot-finding, so a walk-across-campus gap isn't offered (rule 3).
  const freeSlots = invertToFreeSlots(dayKeys, mergeBusyIntervals(allBusy, TRANSIT_PAD_MIN), {
    notBefore: { date: nowEt.date, minute: timeToMinutes(nowEt.time) },
  })
  const suggestions = suggestMeetingSlots(freeSlots)

  /* ── Whitelisting. Every object below is a fresh literal. ─────────────────
     Passing a Supabase row through and trusting its TypeScript type to narrow it
     does nothing at runtime: the whole row lands in the RSC payload. That is not
     hypothetical here — the enrollment rows carry final_grade and final_score
     for OTHER professors' sections. */
  const classes: EnrolledClass[] = []
  for (const row of enrollmentRows) {
    const section = resolveJoin(row.section)
    if (!section) continue
    /* Draft sections are not running yet, so a student enrolled in one is not
       "enrolled this term" in any sense the professor means. The sandbox has a
       real example of this (a draft 506 section with live enrolments), which is
       how it was caught. */
    if (section.status !== 'active') continue
    const course = resolveJoin(section.course)
    const isMine = mySectionIds.has(section.id)
    classes.push({
      sectionId: section.id,
      courseCode: course?.code ?? null,
      courseTitle: course?.title ?? null,
      sectionCode: section.section_code ?? null,
      semester: section.semester ?? null,
      year: section.year ?? null,
      isMine,
      // Grades ONLY for sections this professor owns. Another professor's grade
      // for this student is not theirs to see.
      finalGrade: isMine ? row.final_grade ?? null : null,
      finalScore: isMine ? row.final_score ?? null : null,
    })
  }
  // Own courses first, then by course code, so the professor's own row leads.
  classes.sort(
    (a, b) =>
      Number(b.isMine) - Number(a.isMine) ||
      (a.courseCode ?? '').localeCompare(b.courseCode ?? ''),
  )

  /* The grid draws free time as its own blocks rather than as the gaps between
     busy ones, so it needs the free set per day too. These are the PADDED
     inversion, so the thin uncoloured sliver either side of a class is the
     transit room made visible. */
  const freeByDay = new Map<string, typeof freeSlots>()
  for (const slot of freeSlots) {
    const day = freeByDay.get(slot.date)
    if (day) day.push(slot)
    else freeByDay.set(slot.date, [slot])
  }

  const days = dayKeys.map((date) => ({
    date,
    busy: (displayByDay.get(date) ?? []).map((block) => ({
      startMin: block.startMin,
      endMin: block.endMin,
      label: block.label,
    })),
    free: (freeByDay.get(date) ?? []).map((slot) => ({
      startMin: slot.startMin,
      endMin: slot.endMin,
    })),
  }))

  const profileData = parseStudentProfile(student.settings as Record<string, unknown>)
  const studentName =
    student.name ||
    `${student.first_name || ''} ${student.last_name || ''}`.trim() ||
    student.email

  /* A student with no calendar rows at all is not "free all week" — we simply
     have nothing on record. The view needs to be able to tell the difference,
     and a failed calendar read is a third case again. */
  const hasCalendarData = allBusy.length > 0
  const calendarLoadError = studentCalendar.error || professorCalendar.error

  logger.info('ProfessorStudentProfilePage: Loaded', {
    studentId,
    professorId: user.id,
    mySections: mySections.length,
    totalClasses: classes.length,
    busyBlocks: allBusy.length,
    suggestions: suggestions.length,
    calendarLoadError,
  })

  return (
    <StudentProfileView
      student={{
        id: studentId,
        name: studentName,
        email: student.email,
        cwid: student.cwid ?? null,
        phone: student.phone ?? null,
        status: student.status ?? 'active',
        initials: `${(student.first_name?.[0] || student.name?.[0] || '?').toUpperCase()}${(student.last_name?.[0] || '').toUpperCase()}`,
        bio: profileData.bio,
        linkedinUrl: profileData.linkedinUrl,
        githubUrl: profileData.githubUrl,
      }}
      classes={classes}
      availability={{
        days,
        suggestions,
        hasCalendarData,
        loadError: calendarLoadError,
      }}
    />
  )
}
