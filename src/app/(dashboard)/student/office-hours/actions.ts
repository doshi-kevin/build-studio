/**
 * Student Office Hours Server Actions — booking creation, cancellation, listing.
 *
 * Verifies the student role before any mutation.
 * Uses admin client for DB operations (bypasses RLS).
 */
'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import { logEvent } from '@/lib/supabase/event-logger'
import { sendBookingConfirmed } from '@/lib/email'
import { emitEvent } from '@/lib/events/emit'
import { createBookingFormSchema } from '@/lib/validations/calendar'
import { etWallClockToIso, timeToMinutes, timesOverlap } from '@/lib/calendar/utils'

// ── Helpers ──────────────────────────────────────────────────────

async function getAuthUser() {
  const supabase = await createClient()
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) return null
  return user
}

async function verifyStudent(userId: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any
  const { data: profile, error } = await adminDb
    .from('profiles')
    .select('id, role, name, email, institution_id')
    .eq('id', userId)
    .single()

  if (error || !profile || profile.role !== 'student') {
    return { verified: false as const, adminDb, profile: null }
  }
  return { verified: true as const, adminDb, profile }
}

const ohPath = '/student/office-hours'

// ── Create Booking ───────────────────────────────────────────────

export async function createBooking(input: {
  officeHoursId: string
  date: string
  startTime: string
  endTime: string
  title: string
  courseId: string | null
  courseName?: string | null
  courseCode?: string | null
  meetingType: string
  purpose: string
  studentNote: string
}) {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { verified, adminDb, profile } = await verifyStudent(user.id)
    if (!verified || !profile) return { error: 'Not authorized' }

    const parsed = createBookingFormSchema.safeParse({
      title: input.title,
      courseId: input.courseId,
      meetingType: input.meetingType,
      purpose: input.purpose,
      studentNote: input.studentNote,
    })
    if (!parsed.success) return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }

    // date/startTime/endTime aren't part of createBookingFormSchema, and `date` is interpolated
    // into a raw .or() filter below — validate their format explicitly. A stray comma in `date`
    // could otherwise inject extra OR-clauses, and a malformed time makes timeToMinutes return
    // NaN (every comparison then silently false, so a bad value would sail past the slot guards).
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) return { error: 'Invalid date.' }
    if (!/^\d{2}:\d{2}$/.test(input.startTime) || !/^\d{2}:\d{2}$/.test(input.endTime)) {
      return { error: 'Invalid time.' }
    }

    // Verify the office hours slot exists and is active
    const { data: oh, error: ohErr } = await adminDb
      .from('office_hours')
      .select('id, professor_id, title, location, zoom_link, meeting_type, is_active, day_of_week, start_time, end_time, effective_from, effective_until, slot_duration, buffer_minutes')
      .eq('id', input.officeHoursId)
      .single()

    if (ohErr || !oh) return { error: 'Office hours not found' }
    if (!oh.is_active) return { error: 'These office hours are no longer active' }

    // C2: office hours are section-less; enforce that the professor is in the student's
    // institution. This action uses the admin client (bypasses RLS), so the check lives
    // here too. prof.institution_id is reused for the notification below.
    const { data: prof } = await adminDb
      .from('profiles')
      .select('institution_id')
      .eq('id', oh.professor_id)
      .maybeSingle()
    if (!prof?.institution_id || prof.institution_id !== profile.institution_id) {
      return { error: 'These office hours are not available to you.' }
    }

    // The booking mode must match the office hour's mode (a hybrid slot lets the student
    // pick either) — guards against a client posting a mismatched meeting type.
    if (oh.meeting_type !== 'hybrid' && parsed.data.meetingType !== oh.meeting_type) {
      return { error: 'That meeting type is not available for this slot.' }
    }

    // Validate the requested slot against the template — never trust client date/time.
    const DOW = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
    const requestedDow = DOW[new Date(`${input.date}T00:00:00`).getDay()]
    if (requestedDow !== oh.day_of_week) {
      return { error: 'That day is not offered for these office hours.' }
    }
    if (input.startTime < oh.start_time || input.endTime > oh.end_time || input.startTime >= input.endTime) {
      return { error: 'That time is outside these office hours.' }
    }
    if (input.date < oh.effective_from || (oh.effective_until && input.date > oh.effective_until)) {
      return { error: 'These office hours are not available on that date.' }
    }

    // Slot alignment: the request must be a REAL generated slot — exactly one slot_duration long,
    // starting on a (slot_duration + buffer) boundary from the template start. The window check
    // above isn't enough: two overlapping bookings with different start times would both pass it,
    // and the uniq_booking_active_slot index (keyed on exact start_time) wouldn't catch them —
    // double-booking the professor.
    const startMin = timeToMinutes(input.startTime)
    const endMin = timeToMinutes(input.endTime)
    const step = oh.slot_duration + (oh.buffer_minutes ?? 0)
    if (endMin - startMin !== oh.slot_duration || (startMin - timeToMinutes(oh.start_time)) % step !== 0) {
      return { error: 'That is not a bookable slot.' }
    }

    // Don't book over the professor's own calendar (lectures/exams/blocks) — verified server-side,
    // since the client greys these out only from a note-free RPC an attacker can ignore. Weekly
    // recurring blocks are matched by weekday within their recurrence window.
    const reqDow = new Date(`${input.date}T12:00:00`).getDay()
    const { data: blocks, error: blocksErr } = await adminDb
      .from('blocked_times')
      .select('date, start_time, end_time, recurrence, recurrence_until')
      .eq('professor_id', oh.professor_id)
      .lte('date', input.date)
      .or(`recurrence.neq.none,date.eq.${input.date}`)
    if (blocksErr) {
      // Fail CLOSED: if we can't read the professor's blocks we can't confirm the slot is free,
      // so don't fall through to an empty list and book over a lecture/exam/block.
      logger.error('createBooking: blocked_times check failed', blocksErr)
      return { error: 'Could not verify availability. Please try again.' }
    }
    const overlapsBlock = ((blocks ?? []) as {
      date: string; start_time: string; end_time: string; recurrence: string; recurrence_until: string | null
    }[]).some((bt) => {
      const landsToday =
        bt.date === input.date ||
        (bt.recurrence === 'weekly' &&
          bt.date <= input.date &&
          (!bt.recurrence_until || bt.recurrence_until >= input.date) &&
          new Date(`${bt.date}T12:00:00`).getDay() === reqDow)
      return landsToday && timesOverlap(bt.start_time, bt.end_time, input.startTime, input.endTime)
    })
    if (overlapsBlock) return { error: 'That time is no longer available.' }

    if (new Date(etWallClockToIso(input.date, input.startTime)).getTime() <= Date.now()) {
      return { error: 'That time has already passed.' }
    }

    // Check for double-booking: same professor, same date/time, still booked
    // (fast path; the uniq_booking_active_slot index is the real atomic guard below).
    const { data: existingBookings } = await adminDb
      .from('bookings')
      .select('id')
      .eq('office_hours_id', input.officeHoursId)
      .eq('date', input.date)
      .eq('start_time', input.startTime)
      .eq('status', 'booked')

    if (existingBookings && existingBookings.length > 0) {
      return { error: 'This time slot is already booked' }
    }

    const { data, error } = await adminDb
      .from('bookings')
      .insert({
        office_hours_id: input.officeHoursId,
        professor_id: oh.professor_id,
        student_id: user.id,
        date: input.date,
        start_time: input.startTime,
        end_time: input.endTime,
        title: parsed.data.title,
        course_id: parsed.data.courseId,
        course_name: input.courseName || null,
        course_code: input.courseCode || null,
        meeting_type: parsed.data.meetingType,
        purpose: parsed.data.purpose,
        student_note: parsed.data.studentNote,
        // Carry only the relevant detail for the chosen mode.
        location: parsed.data.meetingType === 'zoom' ? '' : (oh.location || ''),
        zoom_link: parsed.data.meetingType === 'in_person' ? '' : (oh.zoom_link || ''),
        status: 'booked',
      })
      .select('*')
      .single()

    if (error) {
      // M1: the uniq_booking_active_slot index rejected a concurrent double-book.
      if ((error as { code?: string }).code === '23505') {
        return { error: 'This time slot was just booked by someone else.' }
      }
      logger.error('createBooking: Insert failed', error)
      return { error: 'Failed to create booking' }
    }

    await logEvent({
      userId: user.id,
      eventType: 'booking.created',
      eventCategory: 'calendar',
      metadata: { bookingId: data.id, title: data.title, professorId: oh.professor_id },
    })

    // Immediate confirmation email to the student who booked. Office hours aren't
    // section-scoped, so this is email-only (no in-app feed item). Best-effort.
    if (profile.email) {
      const when = `${data.date} · ${String(data.start_time).slice(0, 5)}–${String(data.end_time).slice(0, 5)}`
      const location = data.location || (data.zoom_link ? 'Online (link in Scholera)' : null)
      void sendBookingConfirmed(profile.email, profile.name ?? 'there', {
        title: data.title,
        when,
        location,
      })
    }

    // In-app notification to the professor (prof.institution_id resolved above).
    const whenLabel = `${data.date} · ${String(data.start_time).slice(0, 5)}`
    await emitEvent({
      type: 'booking_confirmed',
      institutionId: prof.institution_id,
      audience: [oh.professor_id],
      actorId: user.id,
      entity: { type: 'booking', id: data.id },
      title: 'New office-hours booking',
      body: `${profile.name ?? 'A student'} booked "${data.title}" — ${whenLabel}.`,
      linkUrl: '/professor/calendar',
      actionable: false,
    })

    revalidatePath(ohPath)
    return { data }
  } catch (error) {
    logger.error('createBooking: Unexpected error', error)
    return { error: 'An unexpected error occurred' }
  }
}

// ── Cancel Booking (Student Side) ────────────────────────────────

export async function cancelBooking(bookingId: string, reason?: string) {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { verified, adminDb } = await verifyStudent(user.id)
    if (!verified) return { error: 'Not authorized' }

    const { data: existing } = await adminDb
      .from('bookings')
      .select('id, student_id, professor_id, title')
      .eq('id', bookingId)
      .single()

    if (!existing || existing.student_id !== user.id) return { error: 'Not authorized' }

    // M3: transition guarded in the WHERE (status='booked') so a double-cancel is a no-op
    // and doesn't re-fire the notification below.
    const { data, error } = await adminDb
      .from('bookings')
      .update({
        status: 'cancelled',
        cancelled_by: 'student',
        cancellation_reason: reason || '',
        updated_at: new Date().toISOString(),
      })
      .eq('id', bookingId)
      .eq('status', 'booked')
      .select('*')
      .maybeSingle()

    if (error) {
      logger.error('cancelBooking (student): Update failed', error)
      return { error: 'Failed to cancel booking' }
    }
    if (!data) return { data: existing } // already cancelled/completed — nothing to do

    await logEvent({
      userId: user.id,
      eventType: 'booking.cancelled',
      eventCategory: 'calendar',
      metadata: { bookingId, cancelledBy: 'student', title: existing.title },
    })

    // In-app notification to the professor that the student cancelled.
    const { data: prof } = await adminDb
      .from('profiles')
      .select('institution_id')
      .eq('id', existing.professor_id)
      .maybeSingle()
    if (prof?.institution_id) {
      await emitEvent({
        type: 'booking_cancelled',
        institutionId: prof.institution_id,
        audience: [existing.professor_id],
        actorId: user.id,
        entity: { type: 'booking', id: bookingId },
        title: 'Office-hours booking cancelled',
        body: `A student cancelled "${existing.title}".`,
        linkUrl: '/professor/calendar',
        actionable: false,
      })
    }

    revalidatePath(ohPath)
    return { data }
  } catch (error) {
    logger.error('cancelBooking (student): Unexpected error', error)
    return { error: 'An unexpected error occurred' }
  }
}

// ── Get My Bookings ──────────────────────────────────────────────

export async function getMyBookings() {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated', data: [] }

    const { verified, adminDb } = await verifyStudent(user.id)
    if (!verified) return { error: 'Not authorized', data: [] }

    const { data, error } = await adminDb
      .from('bookings')
      .select('*, professor:profiles!bookings_professor_id_fkey(id, name, email, avatar_url), office_hour:office_hours(id, title, location, zoom_link)')
      .eq('student_id', user.id)
      .order('date', { ascending: false })
      .order('start_time', { ascending: false })

    if (error) {
      logger.error('getMyBookings: Fetch failed', error)
      return { error: 'Failed to load bookings', data: [] }
    }

    return { data: data || [] }
  } catch (error) {
    logger.error('getMyBookings: Unexpected error', error)
    return { error: 'An unexpected error occurred', data: [] }
  }
}

// Fetch a single booking WITH the professor profile — used to enrich a Realtime event
// (the postgres_changes payload carries no join). Scoped to the student's own bookings.
export async function getStudentBooking(bookingId: string) {
  try {
    const user = await getAuthUser()
    if (!user) return { data: null }

    const { verified, adminDb } = await verifyStudent(user.id)
    if (!verified) return { data: null }

    const { data } = await adminDb
      .from('bookings')
      .select('*, professor:profiles!bookings_professor_id_fkey(id, name, email, avatar_url)')
      .eq('id', bookingId)
      .eq('student_id', user.id)
      .maybeSingle()
    return { data }
  } catch (error) {
    logger.error('getStudentBooking: Unexpected error', error)
    return { data: null }
  }
}
