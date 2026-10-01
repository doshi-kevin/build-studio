import { redirect } from 'next/navigation'
import { addDays } from 'date-fns'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { calendarQueries } from '@/lib/supabase/queries'
import { CalendarManager } from '@/components/professor/calendar/CalendarManager'
import { CalendarFeedCard } from '@/components/shared/CalendarFeedCard'
import { getProfessorCalendarEvents, expandOfficeHours } from '@/lib/calendar/professor-events'
import { WINDOW_DAYS } from '@/lib/calendar/utils'

export default async function ProfessorCalendarPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Admin client for the two cross-user reads below. Both come back null through the
  // RLS client: `courses` has RLS enabled with no SELECT policy, and a booking's student
  // profile isn't "visible" to the professor via RLS (office hours are section-less).
  // Every admin read here is scoped to the professor's OWN rows (professor_id = user.id),
  // so there is no cross-tenant exposure.
  const adminDb = createAdminClient()

  // Fetch calendar data + feed token in parallel. Bookings go through the admin client so
  // the joined student name is populated — the calendar shows WHO booked, not just the title.
  const [officeHours, bookings, blockedTimes, calendarToken, calendarEvents] = await Promise.all([
    calendarQueries.getOfficeHoursForProfessor(supabase, user.id),
    calendarQueries.getBookingsForProfessor(adminDb, user.id),
    calendarQueries.getBlockedTimesForProfessor(supabase, user.id),
    calendarQueries.getCalendarToken(supabase, user.id),
    // Class sessions + assignment/quiz due dates — the same aggregator behind the
    // dashboard's mini calendar, so this page doesn't show a poorer picture of the
    // professor's week than the widget that links into it. Office hours/bookings
    // are excluded: this page already renders those from its own editable state.
    getProfessorCalendarEvents(adminDb, user.id),
  ])
  const readOnlyEvents = calendarEvents.events.filter((e) => e.kind !== 'office_hours_booking')

  // Month view has no time grid, so it can't render office hours from the
  // bookable `slots` the way Week/Day do — it previously showed none at all,
  // which made the dashboard's mini calendar (which does show them) look
  // richer than the full calendar it expands into. Expanded here with the same
  // shared function the feed and the mini calendar use, so all three agree.
  // One chip per office-hours block per day, NOT per 30-min bookable slot.
  const now = new Date()
  const officeHoursOccurrences = officeHours
    .filter((oh) => oh.is_active)
    .flatMap((oh) =>
      expandOfficeHours(oh, addDays(now, -WINDOW_DAYS), addDays(now, WINDOW_DAYS)).map((occ) => ({
        id: `oh-${oh.id}-${occ.date}`,
        date: occ.date,
        startTime: occ.startTime,
        title: (oh.title as string | null)?.trim() || 'Office Hours',
        courseId: (oh.course_id as string | null) ?? null,
      })),
    )

  // Professor's courses for the office hours form (admin — see note above).
  const { data: sections } = await adminDb
    .from('course_sections')
    .select('id, course:courses(id, title, code)')
    .eq('professor_id', user.id)
    .eq('status', 'active')

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resolveJoin = (val: any) => (Array.isArray(val) ? val[0] : val)
  const courses = (sections || [])
    .map((s) => {
      const c = resolveJoin(s.course)
      return c ? { id: c.id, name: c.title, code: c.code } : null
    })
    .filter(Boolean) as { id: string; name: string; code: string }[]

  // Deduplicate courses
  const uniqueCourses = Array.from(
    new Map(courses.map((c) => [c.id, c])).values()
  )

  // Get profile name
  const { data: profile } = await supabase
    .from('profiles')
    .select('id, name')
    .eq('id', user.id)
    .single()

  return (
    <div className="space-y-6">
      <CalendarManager
        professorId={user.id}
        professorName={profile?.name || 'Professor'}
        courses={uniqueCourses}
        initialOfficeHours={officeHours}
        initialBookings={bookings}
        initialBlockedTimes={blockedTimes}
        readOnlyEvents={readOnlyEvents}
        officeHoursOccurrences={officeHoursOccurrences}
      />
      <CalendarFeedCard initialToken={calendarToken} professorId={user.id} />
    </div>
  )
}
