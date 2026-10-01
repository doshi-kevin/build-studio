/**
 * Professor Calendar Server Actions — office hours, blocked times, booking management.
 *
 * Verifies the professor role before any mutation.
 * Uses admin client for DB operations (bypasses RLS).
 */
'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import { logEvent } from '@/lib/supabase/event-logger'
import { sendBookingCancelled } from '@/lib/email'
import { emitEvent } from '@/lib/events/emit'
import {
  MAX_CALENDAR_IMPORT,
  createOfficeHoursFormSchema,
  blockTimeFormSchema,
} from '@/lib/validations/calendar'

// ── Helpers ──────────────────────────────────────────────────────

async function getAuthUser() {
  const supabase = await createClient()
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) return null
  return user
}

async function verifyProfessor(userId: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any
  const { data: profile, error } = await adminDb
    .from('profiles')
    .select('id, role')
    .eq('id', userId)
    .single()

  if (error || !profile || profile.role !== 'professor') {
    return { verified: false as const, adminDb }
  }
  return { verified: true as const, adminDb }
}

const calPath = '/professor/calendar'

// ── Office Hours CRUD ────────────────────────────────────────────

export async function createOfficeHours(input: {
  title: string
  courseId: string | null
  courseName?: string | null
  courseCode?: string | null
  dayOfWeek: string
  startTime: string
  endTime: string
  slotDuration: number
  bufferMinutes: number
  meetingType: string
  location: string
  zoomLink: string
  effectiveFrom: string
  effectiveUntil: string | null
}) {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { verified, adminDb } = await verifyProfessor(user.id)
    if (!verified) return { error: 'Not authorized' }

    const parsed = createOfficeHoursFormSchema.safeParse(input)
    if (!parsed.success) return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }

    const { data, error } = await adminDb
      .from('office_hours')
      .insert({
        professor_id: user.id,
        title: parsed.data.title,
        course_id: parsed.data.courseId,
        course_name: input.courseName || null,
        course_code: input.courseCode || null,
        day_of_week: parsed.data.dayOfWeek,
        start_time: parsed.data.startTime,
        end_time: parsed.data.endTime,
        slot_duration: parsed.data.slotDuration,
        buffer_minutes: parsed.data.bufferMinutes,
        meeting_type: parsed.data.meetingType,
        location: parsed.data.location,
        zoom_link: parsed.data.zoomLink,
        effective_from: parsed.data.effectiveFrom,
        effective_until: parsed.data.effectiveUntil,
      })
      .select('*')
      .single()

    if (error) {
      logger.error('createOfficeHours: Insert failed', error)
      return { error: 'Failed to create office hours' }
    }

    await logEvent({
      userId: user.id,
      eventType: 'office_hours.created',
      eventCategory: 'calendar',
      metadata: { officeHoursId: data.id, title: data.title },
    })

    revalidatePath(calPath)
    return { data }
  } catch (error) {
    logger.error('createOfficeHours: Unexpected error', error)
    return { error: 'An unexpected error occurred' }
  }
}

export async function updateOfficeHours(officeHoursId: string, input: {
  title?: string
  courseId?: string | null
  courseName?: string | null
  courseCode?: string | null
  dayOfWeek?: string
  startTime?: string
  endTime?: string
  slotDuration?: number
  bufferMinutes?: number
  meetingType?: string
  location?: string
  zoomLink?: string
  effectiveFrom?: string
  effectiveUntil?: string | null
}) {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { verified, adminDb } = await verifyProfessor(user.id)
    if (!verified) return { error: 'Not authorized' }

    // Verify ownership
    const { data: existing, error: fetchErr } = await adminDb
      .from('office_hours')
      .select('id, professor_id, title, course_id, day_of_week, start_time, end_time, slot_duration, buffer_minutes, meeting_type, location, zoom_link, effective_from, effective_until')
      .eq('id', officeHoursId)
      .single()

    if (fetchErr || !existing) return { error: 'Office hours not found' }
    if (existing.professor_id !== user.id) return { error: 'Not authorized' }

    // Validate the RESULT of the merge against the SAME schema createOfficeHours uses, so the
    // update path can't drift from create (BUG-12) — a bare edit must never be able to write a
    // window that generates zero slots, a malformed time, an out-of-range buffer, or a mode
    // missing its location/link. Re-deriving the rules by hand is exactly how the two drifted;
    // merge existing + input, then safeParse. Times → HH:MM (columns are TEXT, sometimes HH:MM:SS).
    const hhmm = (t: string) => String(t).slice(0, 5)
    const merged = {
      title: input.title ?? existing.title,
      courseId: input.courseId !== undefined ? input.courseId : existing.course_id,
      dayOfWeek: input.dayOfWeek ?? existing.day_of_week,
      startTime: hhmm(input.startTime ?? existing.start_time),
      endTime: hhmm(input.endTime ?? existing.end_time),
      slotDuration: input.slotDuration ?? existing.slot_duration,
      bufferMinutes: input.bufferMinutes ?? existing.buffer_minutes,
      meetingType: input.meetingType ?? existing.meeting_type,
      location: input.location ?? existing.location ?? '',
      zoomLink: input.zoomLink ?? existing.zoom_link ?? '',
      effectiveFrom: input.effectiveFrom ?? existing.effective_from,
      effectiveUntil:
        input.effectiveUntil !== undefined ? input.effectiveUntil : existing.effective_until,
    }
    const parsed = createOfficeHoursFormSchema.safeParse(merged)
    if (!parsed.success) return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }

    // Build update payload (snake_case). Persist the PARSED values, not raw input — the schema
    // coerces (numbers) and we normalized times to HH:MM, so writing input.* would let a value
    // that only passed validation in its truncated/coerced form ("09:00xyz" → validated as
    // "09:00") reach the column untouched. Only write fields the caller actually touched.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload: Record<string, any> = { updated_at: new Date().toISOString() }
    if (input.title !== undefined) payload.title = parsed.data.title
    if (input.courseId !== undefined) payload.course_id = parsed.data.courseId
    if (input.courseName !== undefined) payload.course_name = input.courseName
    if (input.courseCode !== undefined) payload.course_code = input.courseCode
    if (input.dayOfWeek !== undefined) payload.day_of_week = parsed.data.dayOfWeek
    if (input.startTime !== undefined) payload.start_time = parsed.data.startTime
    if (input.endTime !== undefined) payload.end_time = parsed.data.endTime
    if (input.slotDuration !== undefined) payload.slot_duration = parsed.data.slotDuration
    if (input.bufferMinutes !== undefined) payload.buffer_minutes = parsed.data.bufferMinutes
    if (input.meetingType !== undefined) payload.meeting_type = parsed.data.meetingType
    if (input.location !== undefined) payload.location = parsed.data.location
    if (input.zoomLink !== undefined) payload.zoom_link = parsed.data.zoomLink
    if (input.effectiveFrom !== undefined) payload.effective_from = parsed.data.effectiveFrom
    if (input.effectiveUntil !== undefined) payload.effective_until = parsed.data.effectiveUntil

    const { data, error } = await adminDb
      .from('office_hours')
      .update(payload)
      .eq('id', officeHoursId)
      .select('*')
      .single()

    if (error) {
      logger.error('updateOfficeHours: Update failed', error)
      return { error: 'Failed to update office hours' }
    }

    await logEvent({
      userId: user.id,
      eventType: 'office_hours.updated',
      eventCategory: 'calendar',
      metadata: { officeHoursId },
    })

    revalidatePath(calPath)
    return { data }
  } catch (error) {
    logger.error('updateOfficeHours: Unexpected error', error)
    return { error: 'An unexpected error occurred' }
  }
}

export async function deleteOfficeHours(officeHoursId: string) {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { verified, adminDb } = await verifyProfessor(user.id)
    if (!verified) return { error: 'Not authorized' }

    const { data: existing } = await adminDb
      .from('office_hours')
      .select('id, professor_id, title')
      .eq('id', officeHoursId)
      .single()

    if (!existing || existing.professor_id !== user.id) return { error: 'Not authorized' }

    // Deleting cascades to bookings (office_hours_id FK is ON DELETE CASCADE), which would wipe
    // students' appointments and history. Refuse when any real (non-cancelled) booking exists —
    // the UI routes "remove" through toggleOfficeHoursActive to deactivate and preserve them.
    // The check-and-delete is one atomic statement (delete_office_hours_if_unbooked): a plain
    // count-then-delete failed OPEN if the count errored, and had a TOCTOU race where a booking
    // committed between the count and the delete got silently cascade-deleted.
    const { data: deleted, error } = await adminDb.rpc('delete_office_hours_if_unbooked', {
      p_office_hours_id: officeHoursId,
    })

    if (error) {
      logger.error('deleteOfficeHours: Delete failed', error)
      return { error: 'Failed to delete office hours' }
    }
    if (deleted === false) {
      return {
        error: 'These office hours have bookings — deactivate them instead so students keep their appointments.',
      }
    }

    await logEvent({
      userId: user.id,
      eventType: 'office_hours.deleted',
      eventCategory: 'calendar',
      metadata: { officeHoursId, title: existing.title },
    })

    revalidatePath(calPath)
    return { success: true }
  } catch (error) {
    logger.error('deleteOfficeHours: Unexpected error', error)
    return { error: 'An unexpected error occurred' }
  }
}

export async function toggleOfficeHoursActive(officeHoursId: string, isActive: boolean) {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { verified, adminDb } = await verifyProfessor(user.id)
    if (!verified) return { error: 'Not authorized' }

    const { data: existing } = await adminDb
      .from('office_hours')
      .select('id, professor_id')
      .eq('id', officeHoursId)
      .single()

    if (!existing || existing.professor_id !== user.id) return { error: 'Not authorized' }

    const { data, error } = await adminDb
      .from('office_hours')
      .update({ is_active: isActive, updated_at: new Date().toISOString() })
      .eq('id', officeHoursId)
      .select('*')
      .single()

    if (error) {
      logger.error('toggleOfficeHoursActive: Update failed', error)
      return { error: 'Failed to update office hours' }
    }

    revalidatePath(calPath)
    return { data }
  } catch (error) {
    logger.error('toggleOfficeHoursActive: Unexpected error', error)
    return { error: 'An unexpected error occurred' }
  }
}

// ── Blocked Times ────────────────────────────────────────────────

export async function createBlockedTime(input: {
  date: string
  startTime: string
  endTime: string
  reason: string
  note: string
  courseId?: string | null
  courseName?: string | null
  courseCode?: string | null
  meetingType?: string | null
  location?: string
  zoomLink?: string
  recurrence?: string
  recurrenceUntil?: string | null
}) {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { verified, adminDb } = await verifyProfessor(user.id)
    if (!verified) return { error: 'Not authorized' }

    const parsed = blockTimeFormSchema.safeParse(input)
    if (!parsed.success) return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }

    const { data, error } = await adminDb
      .from('blocked_times')
      .insert({
        professor_id: user.id,
        date: parsed.data.date,
        start_time: parsed.data.startTime,
        end_time: parsed.data.endTime,
        reason: parsed.data.reason,
        note: parsed.data.note,
        course_id: parsed.data.courseId,
        course_name: input.courseName || null,
        course_code: input.courseCode || null,
        meeting_type: parsed.data.meetingType,
        location: parsed.data.location,
        zoom_link: parsed.data.zoomLink,
        recurrence: parsed.data.recurrence,
        recurrence_until: parsed.data.recurrenceUntil,
      })
      .select('*')
      .single()

    if (error) {
      logger.error('createBlockedTime: Insert failed', error)
      return { error: 'Failed to create blocked time' }
    }

    await logEvent({
      userId: user.id,
      eventType: 'blocked_time.created',
      eventCategory: 'calendar',
      metadata: { blockedTimeId: data.id, reason: data.reason, recurrence: data.recurrence },
    })

    revalidatePath(calPath)
    return { data }
  } catch (error) {
    logger.error('createBlockedTime: Unexpected error', error)
    return { error: 'An unexpected error occurred' }
  }
}

export async function updateBlockedTime(blockedTimeId: string, input: {
  date: string
  startTime: string
  endTime: string
  reason: string
  note: string
  courseId?: string | null
  courseName?: string | null
  courseCode?: string | null
  meetingType?: string | null
  location?: string
  zoomLink?: string
  recurrence?: string
  recurrenceUntil?: string | null
}) {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { verified, adminDb } = await verifyProfessor(user.id)
    if (!verified) return { error: 'Not authorized' }

    // Verify ownership before the write (IDOR guard).
    const { data: existing } = await adminDb
      .from('blocked_times')
      .select('id, professor_id')
      .eq('id', blockedTimeId)
      .single()
    if (!existing || existing.professor_id !== user.id) return { error: 'Not authorized' }

    const parsed = blockTimeFormSchema.safeParse(input)
    if (!parsed.success) return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }

    const { data, error } = await adminDb
      .from('blocked_times')
      .update({
        date: parsed.data.date,
        start_time: parsed.data.startTime,
        end_time: parsed.data.endTime,
        reason: parsed.data.reason,
        note: parsed.data.note,
        course_id: parsed.data.courseId,
        course_name: input.courseName || null,
        course_code: input.courseCode || null,
        meeting_type: parsed.data.meetingType,
        location: parsed.data.location,
        zoom_link: parsed.data.zoomLink,
        recurrence: parsed.data.recurrence,
        recurrence_until: parsed.data.recurrenceUntil,
      })
      .eq('id', blockedTimeId)
      .eq('professor_id', user.id)
      .select('*')
      .single()

    if (error) {
      logger.error('updateBlockedTime: Update failed', error)
      return { error: 'Failed to update event' }
    }

    await logEvent({
      userId: user.id,
      eventType: 'blocked_time.updated',
      eventCategory: 'calendar',
      metadata: { blockedTimeId, reason: data.reason },
    })

    revalidatePath(calPath)
    return { data }
  } catch (error) {
    logger.error('updateBlockedTime: Unexpected error', error)
    return { error: 'An unexpected error occurred' }
  }
}

export async function deleteBlockedTime(blockedTimeId: string) {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { verified, adminDb } = await verifyProfessor(user.id)
    if (!verified) return { error: 'Not authorized' }

    const { data: existing } = await adminDb
      .from('blocked_times')
      .select('id, professor_id')
      .eq('id', blockedTimeId)
      .single()

    if (!existing || existing.professor_id !== user.id) return { error: 'Not authorized' }

    const { error } = await adminDb
      .from('blocked_times')
      .delete()
      .eq('id', blockedTimeId)

    if (error) {
      logger.error('deleteBlockedTime: Delete failed', error)
      return { error: 'Failed to delete blocked time' }
    }

    revalidatePath(calPath)
    return { success: true }
  } catch (error) {
    logger.error('deleteBlockedTime: Unexpected error', error)
    return { error: 'An unexpected error occurred' }
  }
}

// ── Booking Management (Professor Side) ──────────────────────────

export async function cancelBooking(bookingId: string, reason: string) {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { verified, adminDb } = await verifyProfessor(user.id)
    if (!verified) return { error: 'Not authorized' }

    const { data: existing } = await adminDb
      .from('bookings')
      .select('id, professor_id, student_id, title')
      .eq('id', bookingId)
      .single()

    if (!existing || existing.professor_id !== user.id) return { error: 'Not authorized' }

    // M3: transition guarded in the WHERE (status='booked') so a double-cancel is a no-op
    // and doesn't re-fire the student's email + notification below.
    const { data, error } = await adminDb
      .from('bookings')
      .update({
        status: 'cancelled',
        cancelled_by: 'professor',
        cancellation_reason: reason || '',
        updated_at: new Date().toISOString(),
      })
      .eq('id', bookingId)
      .eq('status', 'booked')
      .select('*')
      .maybeSingle()

    if (error) {
      logger.error('cancelBooking (prof): Update failed', error)
      return { error: 'Failed to cancel booking' }
    }
    if (!data) return { data: existing } // already cancelled/completed — nothing to do

    await logEvent({
      userId: user.id,
      eventType: 'booking.cancelled',
      eventCategory: 'calendar',
      metadata: { bookingId, cancelledBy: 'professor', title: existing.title },
    })

    // Immediate email to the student whose booking was cancelled. Office hours aren't
    // section-scoped, so this is email-only (no in-app feed item). Best-effort.
    if (existing.student_id) {
      const { data: student } = await adminDb
        .from('profiles')
        .select('email, name, institution_id')
        .eq('id', existing.student_id)
        .maybeSingle()
      if (student?.email) {
        const when = `${data.date} · ${String(data.start_time).slice(0, 5)}–${String(data.end_time).slice(0, 5)}`
        void sendBookingCancelled(student.email, student.name ?? 'there', {
          title: data.title,
          when,
          reason: reason || null,
        })
      }
      // In-app notification to the student that the professor cancelled.
      if (student?.institution_id) {
        await emitEvent({
          type: 'booking_cancelled',
          institutionId: student.institution_id,
          audience: [existing.student_id],
          actorId: user.id,
          entity: { type: 'booking', id: bookingId },
          title: 'Office-hours booking cancelled',
          body: `Your professor cancelled "${data.title}"${reason ? ` — ${reason}` : ''}.`,
          linkUrl: '/student/office-hours',
          actionable: false,
        })
      }
    }

    revalidatePath(calPath)
    return { data }
  } catch (error) {
    logger.error('cancelBooking (prof): Unexpected error', error)
    return { error: 'An unexpected error occurred' }
  }
}

export async function markBookingStatus(bookingId: string, status: 'completed' | 'no_show') {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { verified, adminDb } = await verifyProfessor(user.id)
    if (!verified) return { error: 'Not authorized' }

    const { data: existing } = await adminDb
      .from('bookings')
      .select('id, professor_id')
      .eq('id', bookingId)
      .single()

    if (!existing || existing.professor_id !== user.id) return { error: 'Not authorized' }

    // M3: only a still-booked meeting can be marked completed/no-show (idempotent).
    const { data, error } = await adminDb
      .from('bookings')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', bookingId)
      .eq('status', 'booked')
      .select('*')
      .maybeSingle()

    if (error) {
      logger.error('markBookingStatus: Update failed', error)
      return { error: 'Failed to update booking status' }
    }
    if (!data) return { error: 'This meeting can no longer be updated.' }

    revalidatePath(calPath)
    return { data }
  } catch (error) {
    logger.error('markBookingStatus: Unexpected error', error)
    return { error: 'An unexpected error occurred' }
  }
}

export async function updateProfessorNote(bookingId: string, note: string) {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { verified, adminDb } = await verifyProfessor(user.id)
    if (!verified) return { error: 'Not authorized' }

    const { data: existing } = await adminDb
      .from('bookings')
      .select('id, professor_id')
      .eq('id', bookingId)
      .single()

    if (!existing || existing.professor_id !== user.id) return { error: 'Not authorized' }

    const { data, error } = await adminDb
      .from('bookings')
      .update({ professor_note: note, updated_at: new Date().toISOString() })
      .eq('id', bookingId)
      .select('*')
      .single()

    if (error) {
      logger.error('updateProfessorNote: Update failed', error)
      return { error: 'Failed to update note' }
    }

    revalidatePath(calPath)
    return { data }
  } catch (error) {
    logger.error('updateProfessorNote: Unexpected error', error)
    return { error: 'An unexpected error occurred' }
  }
}

// Fetch a single booking WITH the student profile — used to enrich a Realtime event
// (the postgres_changes payload carries no join). Scoped to the professor's own bookings.
export async function getProfessorBooking(bookingId: string) {
  try {
    const user = await getAuthUser()
    if (!user) return { data: null }

    const { verified, adminDb } = await verifyProfessor(user.id)
    if (!verified) return { data: null }

    const { data } = await adminDb
      .from('bookings')
      .select('*, student:profiles!bookings_student_id_fkey(id, name, email, avatar_url)')
      .eq('id', bookingId)
      .eq('professor_id', user.id)
      .maybeSingle()
    return { data }
  } catch (error) {
    logger.error('getProfessorBooking: Unexpected error', error)
    return { data: null }
  }
}

// ── Import Calendar Events (from .ics) ──────────────────────────

export async function importCalendarEvents(events: {
  summary: string
  description: string
  location: string
  dtstart: string
  dtend: string
}[]): Promise<{ error?: string; count: number }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated', count: 0 }

    const { verified, adminDb } = await verifyProfessor(user.id)
    if (!verified) return { error: 'Not authorized', count: 0 }

    /* This path had NO bound at all: the whole client-supplied array was mapped and
       bulk-inserted, so a decade-long calendar export was an unbounded write from the
       browser. The student's import has capped at 500 since it shipped; both now read
       one constant, which is also what lets the shared dialog refuse before the click
       rather than after it. (#713 part 7) */
    if (events.length > MAX_CALENDAR_IMPORT) {
      return { error: `Please import at most ${MAX_CALENDAR_IMPORT} events at a time.`, count: 0 }
    }

    // Build all rows first, then insert in one round-trip. A .ics upload can carry many
    // events (and the multi-file import merges them), so a per-event awaited insert was an
    // N+1. All-day events (start == end / 00:00–00:00) and unparseable dates are dropped.
    const rows = events
      .map((event) => {
        const start = new Date(event.dtstart)
        const end = new Date(event.dtend)
        if (isNaN(start.getTime()) || isNaN(end.getTime())) return null

        const dateStr = start.toISOString().split('T')[0] // YYYY-MM-DD
        const startTime = `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`
        const endTime = `${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}`

        if (startTime === endTime) return null

        const note = [
          event.summary,
          event.location && `Location: ${event.location}`,
          event.description,
        ].filter(Boolean).join('\n')

        return {
          professor_id: user.id,
          date: dateStr,
          start_time: startTime,
          end_time: endTime,
          reason: 'meeting' as const,
          note: note.slice(0, 500),
        }
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)

    if (rows.length === 0) {
      return { count: 0 }
    }

    const { data: inserted, error } = await adminDb
      .from('blocked_times')
      .insert(rows)
      .select('id')

    if (error) {
      logger.error('importCalendarEvents: Bulk insert failed', error)
      return { error: 'Failed to import events', count: 0 }
    }

    const imported = inserted?.length ?? rows.length

    await logEvent({
      userId: user.id,
      eventType: 'calendar.imported',
      eventCategory: 'calendar',
      metadata: { count: imported, total: events.length },
    })

    revalidatePath(calPath)
    return { count: imported }
  } catch (error) {
    logger.error('importCalendarEvents: Unexpected error', error)
    return { error: 'An unexpected error occurred', count: 0 }
  }
}
