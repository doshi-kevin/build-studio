/**
 * Student personal calendar events — create / update / delete.
 *
 * Student-owned: every action authenticates, confirms the caller is a student, and
 * scopes writes to `student_id = caller` (the admin client bypasses RLS, so this
 * in-code check is the gate — see the SELECT-only policy in the migration). Returns
 * { error } / { success } and never throws.
 */
'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import { logEvent } from '@/lib/supabase/event-logger'
import {
  MAX_CALENDAR_IMPORT,
  personalEventSchema,
  type PersonalEventInput,
  type PersonalEventRow,
} from '@/lib/validations/calendar'

type Result<T = undefined> = { success?: boolean; error?: string; data?: T }

async function getStudent() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any
  const { data: profile } = await adminDb
    .from('profiles')
    .select('institution_id, role')
    .eq('id', user.id)
    .maybeSingle()
  if (!profile || profile.role !== 'student' || !profile.institution_id) return null
  return { userId: user.id as string, institutionId: profile.institution_id as string, adminDb }
}

/** Map validated input → the DB column shape. All-day clears the times. */
function toRow(input: PersonalEventInput) {
  return {
    title: input.title.trim(),
    date: input.date,
    all_day: input.allDay,
    start_time: input.allDay ? null : input.startTime || null,
    end_time: input.allDay ? null : input.endTime || null,
    note: (input.note || '').trim() || null,
    recurrence: input.recurrence,
    recurrence_until: input.recurrence === 'weekly' ? input.recurrenceUntil || null : null,
  }
}

export async function listPersonalEvents(): Promise<Result<PersonalEventRow[]>> {
  try {
    const auth = await getStudent()
    if (!auth) return { error: 'Not authenticated' }
    const { data, error } = await auth.adminDb
      .from('personal_events')
      .select('id, title, date, start_time, end_time, all_day, note, recurrence, recurrence_until')
      .eq('student_id', auth.userId)
      .order('date', { ascending: true })
    if (error) {
      logger.error('listPersonalEvents', error, { userId: auth.userId })
      return { error: 'Failed to load your events' }
    }
    return { success: true, data: (data ?? []) as PersonalEventRow[] }
  } catch (error) {
    logger.error('listPersonalEvents', error)
    return { error: 'Something went wrong' }
  }
}

export async function createPersonalEvent(input: PersonalEventInput): Promise<Result<{ id: string }>> {
  try {
    const auth = await getStudent()
    if (!auth) return { error: 'Not authenticated' }
    const parsed = personalEventSchema.safeParse(input)
    if (!parsed.success) return { error: parsed.error.issues[0]?.message || 'Invalid input' }

    const { data, error } = await auth.adminDb
      .from('personal_events')
      .insert({ student_id: auth.userId, institution_id: auth.institutionId, ...toRow(parsed.data) })
      .select('id')
      .single()
    if (error) {
      logger.error('createPersonalEvent', error, { userId: auth.userId })
      return { error: 'Failed to save your event' }
    }

    await logEvent({
      userId: auth.userId,
      eventType: 'student.personal_event_created',
      eventCategory: 'calendar',
      metadata: { id: data.id },
    })
    revalidatePath('/student/calendar')
    return { success: true, data: { id: data.id as string } }
  } catch (error) {
    logger.error('createPersonalEvent', error)
    return { error: 'Something went wrong' }
  }
}

export async function updatePersonalEvent(id: string, input: PersonalEventInput): Promise<Result> {
  try {
    const auth = await getStudent()
    if (!auth) return { error: 'Not authenticated' }
    const parsed = personalEventSchema.safeParse(input)
    if (!parsed.success) return { error: parsed.error.issues[0]?.message || 'Invalid input' }

    // Ownership is enforced by the student_id filter (admin client bypasses RLS). A row
    // that isn't the caller's matches nothing; .select() lets us report that as not-found.
    const { data, error } = await auth.adminDb
      .from('personal_events')
      .update({ ...toRow(parsed.data), updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('student_id', auth.userId)
      .eq('institution_id', auth.institutionId)
      .select('id')
    if (error) {
      logger.error('updatePersonalEvent', error, { id })
      return { error: 'Failed to update your event' }
    }
    if (!data || data.length === 0) return { error: 'Event not found' }

    await logEvent({ userId: auth.userId, eventType: 'student.personal_event_updated', eventCategory: 'calendar', metadata: { id } })
    revalidatePath('/student/calendar')
    return { success: true }
  } catch (error) {
    logger.error('updatePersonalEvent', error)
    return { error: 'Something went wrong' }
  }
}

export async function deletePersonalEvent(id: string): Promise<Result> {
  try {
    const auth = await getStudent()
    if (!auth) return { error: 'Not authenticated' }
    const { error } = await auth.adminDb
      .from('personal_events')
      .delete()
      .eq('id', id)
      .eq('student_id', auth.userId)
      .eq('institution_id', auth.institutionId)
    if (error) {
      logger.error('deletePersonalEvent', error, { id })
      return { error: 'Failed to delete your event' }
    }
    await logEvent({ userId: auth.userId, eventType: 'student.personal_event_deleted', eventCategory: 'calendar', metadata: { id } })
    revalidatePath('/student/calendar')
    return { success: true }
  } catch (error) {
    logger.error('deletePersonalEvent', error)
    return { error: 'Something went wrong' }
  }
}

/**
 * Import events from a parsed .ics upload as personal events (bulk, single round-trip).
 * Same input shape as the professor's importCalendarEvents; converts each ISO start/end into
 * date + "HH:MM". An event whose start == end is stored all-day. Imported events are one-off
 * (recurrence 'none') even if the source had an RRULE — v1 doesn't parse recurrence.
 */
export async function importPersonalEvents(
  events: { summary: string; description: string; location: string; dtstart: string; dtend: string }[],
): Promise<{ error?: string; count: number }> {
  try {
    const auth = await getStudent()
    if (!auth) return { error: 'Not authenticated', count: 0 }

    // Bound a client-supplied payload — an .ics upload is parsed on the client, so cap the
    // number of rows a single import can insert. Shared with the dialog so the button can
    // stop offering an import it cannot perform.
    if (events.length > MAX_CALENDAR_IMPORT) {
      return { error: `Please import at most ${MAX_CALENDAR_IMPORT} events at a time.`, count: 0 }
    }

    const pad = (n: number) => String(n).padStart(2, '0')
    const rows = events
      .map((event) => {
        const start = new Date(event.dtstart)
        const end = new Date(event.dtend)
        if (isNaN(start.getTime()) || isNaN(end.getTime())) return null
        const date = start.toISOString().split('T')[0]
        const startTime = `${pad(start.getHours())}:${pad(start.getMinutes())}`
        const endTime = `${pad(end.getHours())}:${pad(end.getMinutes())}`
        const allDay = startTime === endTime
        const note =
          [event.location && `Location: ${event.location}`, event.description]
            .filter(Boolean)
            .join('\n')
            .slice(0, 500) || null
        return {
          student_id: auth.userId,
          institution_id: auth.institutionId,
          title: (event.summary || 'Imported event').slice(0, 120),
          date,
          all_day: allDay,
          start_time: allDay ? null : startTime,
          end_time: allDay ? null : endTime,
          note,
          recurrence: 'none' as const,
          recurrence_until: null,
        }
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)

    if (rows.length === 0) return { count: 0 }

    const { data: inserted, error } = await auth.adminDb
      .from('personal_events')
      .insert(rows)
      .select('id')
    if (error) {
      logger.error('importPersonalEvents', error, { userId: auth.userId })
      return { error: 'Failed to import events', count: 0 }
    }
    const count = inserted?.length ?? rows.length
    await logEvent({
      userId: auth.userId,
      eventType: 'student.personal_events_imported',
      eventCategory: 'calendar',
      metadata: { count, total: events.length },
    })
    revalidatePath('/student/calendar')
    return { count }
  } catch (error) {
    logger.error('importPersonalEvents', error)
    return { error: 'An unexpected error occurred', count: 0 }
  }
}
