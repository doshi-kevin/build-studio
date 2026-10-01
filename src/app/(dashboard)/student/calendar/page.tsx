/**
 * Student Calendar Page — one place for a student's time-bound course items:
 * class sessions, assignment/quiz/project deadlines, and office-hours bookings.
 *
 * Aggregation is scoped to the student's enrolments; the page authenticates
 * first, then uses the admin client to read. Read-only + click-through. The ICS
 * subscribe details open in a dialog from the "Subscribe" button in the calendar
 * toolbar (the token is fetched here and passed down).
 *
 * Type: Server Component
 * Route: /student/calendar
 */

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getStudentCalendarEvents } from '@/lib/calendar/student-events'
import { logger } from '@/lib/logger'
import { StudentCalendar } from '@/components/student/calendar/StudentCalendar'
import { calendarQueries } from '@/lib/supabase/queries'
import type { PersonalEventRow } from '@/lib/validations/calendar'

export const metadata = {
  title: 'Calendar — Scholera',
}

export default async function StudentCalendarPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) return null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any
  const [{ events, error: loadError }, calendarToken, personalRes] = await Promise.all([
    getStudentCalendarEvents(adminDb, user.id),
    calendarQueries.getCalendarToken(supabase, user.id),
    adminDb
      .from('personal_events')
      .select('id, title, date, start_time, end_time, all_day, note, recurrence, recurrence_until')
      .eq('student_id', user.id)
      .order('date', { ascending: true }),
  ])
  const personalEvents = (personalRes?.data ?? []) as PersonalEventRow[]
  // A failed personal-events read is also a degraded load — surface it, don't show a blank calendar.
  const anyLoadError = loadError || Boolean(personalRes?.error)

  logger.info('StudentCalendarPage: Loaded', {
    studentId: user.id,
    events: events.length,
    loadError,
    personalError: Boolean(personalRes?.error),
  })

  return (
    // Fill the viewport (main has a definite height): the calendar flexes to the
    // available space — no page scroll.
    <div className="h-full min-h-0">
      <StudentCalendar
        events={events}
        loadError={anyLoadError}
        calendarToken={calendarToken}
        personalEvents={personalEvents}
      />
    </div>
  )
}
