import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { calendarQueries } from '@/lib/supabase/queries'
import { OfficeHoursBooking } from '@/components/student/office-hours/OfficeHoursBooking'
import { CalendarFeedCard } from '@/components/shared/CalendarFeedCard'
import type { OfficeHours, Booking, BlockedTime } from '@/lib/validations/calendar'

export const metadata = {
  title: 'Office Hours — Scholera',
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const resolveJoin = (val: any) => (Array.isArray(val) ? val[0] : val)

export default async function StudentOfficeHoursPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Fetch profile + active office hours + student bookings + feed token
  const [profileResult, activeOH, studentBookings, calendarToken] = await Promise.all([
    supabase.from('profiles').select('id, name, email').eq('id', user.id).single(),
    calendarQueries.getActiveOfficeHours(supabase),
    calendarQueries.getBookingsForStudent(supabase, user.id),
    calendarQueries.getCalendarToken(supabase, user.id),
  ])

  const studentName = profileResult.data?.name || 'Student'
  const studentEmail = profileResult.data?.email || ''

  // Map DB office hours → app OfficeHours type
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const officeHours: OfficeHours[] = (activeOH || []).map((oh: any) => {
    const prof = resolveJoin(oh.professor)
    return {
      id: oh.id,
      professorId: oh.professor_id,
      professorName: prof?.name || 'Professor',
      title: oh.title,
      courseId: oh.course_id,
      courseName: oh.course_name,
      courseCode: oh.course_code,
      dayOfWeek: oh.day_of_week,
      startTime: oh.start_time,
      endTime: oh.end_time,
      slotDuration: oh.slot_duration,
      bufferMinutes: oh.buffer_minutes,
      meetingType: oh.meeting_type,
      location: oh.location,
      zoomLink: oh.zoom_link,
      isActive: oh.is_active,
      effectiveFrom: oh.effective_from,
      effectiveUntil: oh.effective_until,
      createdAt: oh.created_at,
      updatedAt: oh.updated_at,
    }
  })

  // Map DB bookings → app Booking type
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bookings: Booking[] = (studentBookings || []).map((b: any) => {
    const prof = resolveJoin(b.professor)
    return {
      id: b.id,
      slotId: '',
      officeHoursId: b.office_hours_id,
      professorId: b.professor_id,
      professorName: prof?.name || 'Professor',
      studentId: b.student_id,
      studentName,
      studentEmail,
      date: b.date,
      startTime: b.start_time,
      endTime: b.end_time,
      title: b.title,
      courseId: b.course_id,
      courseName: b.course_name,
      courseCode: b.course_code,
      meetingType: b.meeting_type,
      purpose: b.purpose,
      studentNote: b.student_note,
      professorNote: b.professor_note,
      location: b.location,
      zoomLink: b.zoom_link,
      status: b.status,
      cancelledBy: b.cancelled_by,
      cancellationReason: b.cancellation_reason,
      createdAt: b.created_at,
      updatedAt: b.updated_at,
    }
  })

  // Busy times for every professor whose office hours the student can book. Read via the
  // note-free RPC so a professor's private blocked-time notes never reach students — only the
  // time ranges (+ recurrence) needed to grey out overlapping slots.
  const profIds = [...new Set(officeHours.map((oh) => oh.professorId))]
  const busyByProfessor = await Promise.all(
    profIds.map((profId) => calendarQueries.getProfessorBusyTimes(supabase, profId)),
  )
  const blockedTimesArr: BlockedTime[] = []
  profIds.forEach((profId, i) => {
    for (const b of busyByProfessor[i]) {
      blockedTimesArr.push({
        id: `busy-${profId}-${b.date}-${b.start_time}`,
        professorId: profId,
        date: b.date,
        startTime: b.start_time,
        endTime: b.end_time,
        reason: 'other',
        note: '',
        courseId: null,
        courseName: null,
        courseCode: null,
        meetingType: null,
        location: '',
        zoomLink: '',
        recurrence: (b.recurrence as BlockedTime['recurrence']) ?? 'none',
        recurrenceUntil: b.recurrence_until ?? null,
        createdAt: '',
      })
    }
  })

  // Student's enrolled courses (for the booking form). Read via the admin client:
  // `courses` has RLS enabled with no SELECT policy (read through admin app-wide), so the
  // RLS-scoped client returns a null `course` join. Scoped to THIS student's own
  // enrollments (student_id = user.id), so there's no cross-tenant exposure.
  const adminDb = createAdminClient()
  const { data: enrollments } = await adminDb
    .from('enrollments')
    .select('section_id, section:course_sections(id, course:courses(id, title, code))')
    .eq('student_id', user.id)
    .in('status', ['enrolled', 'active', 'completed'])

  const courses = (enrollments || [])
    .map((e) => {
      const section = resolveJoin(e.section)
      const course = section ? resolveJoin(section.course) : null
      return course ? { id: course.id, name: course.title, code: course.code } : null
    })
    .filter(Boolean) as { id: string; name: string; code: string }[]

  const uniqueCourses = Array.from(new Map(courses.map((c) => [c.id, c])).values())

  /* Slots taken by OTHER students (#712). The page loaded only this student's own
     bookings, so a slot a classmate had already taken still rendered as available and
     inflated the slot count; the student found out when the server refused. Read with the
     admin client already in scope above because a student cannot select a classmate's
     booking row, and projected down to occupancy only — no names, no student ids. */
  const occupancyRows = await calendarQueries.getBookingOccupancy(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    adminDb as any,
    officeHours.map((oh) => oh.id),
  )
  /* Shaped as Booking only because that is what generateAllSlots takes; the booked check
     reads date + startTime + officeHoursId + status and nothing else. The viewer's OWN
     bookings go FIRST, because the check takes the first match and their own slot needs to
     carry its real booking id so Cancel still works. */
  const occupancy: Booking[] = [
    ...bookings,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...(occupancyRows as any[]).map((r) => ({
      id: r.id,
      officeHoursId: r.office_hours_id,
      date: r.date,
      startTime: r.start_time,
      status: r.status,
    } as Booking)),
  ]

  return (
    <div className="space-y-6">
      <OfficeHoursBooking
        studentId={user.id}
        studentName={studentName}
        studentEmail={studentEmail}
        courses={uniqueCourses}
        initialOfficeHours={officeHours}
        initialBookings={bookings}
        initialOccupancy={occupancy}
        initialBlockedTimes={blockedTimesArr}
      />
      <CalendarFeedCard initialToken={calendarToken} />
    </div>
  )
}
