/**
 * Calendar & Office Hours — Zod schemas, types, and constant maps.
 */

import { z } from 'zod'

// ── Enums / Constants ─────────────────────────────────────────

export const DAYS_OF_WEEK = [
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
] as const
export type DayOfWeek = (typeof DAYS_OF_WEEK)[number]

export const DAY_LABELS: Record<DayOfWeek, string> = {
  monday: 'Monday',
  tuesday: 'Tuesday',
  wednesday: 'Wednesday',
  thursday: 'Thursday',
  friday: 'Friday',
  saturday: 'Saturday',
  sunday: 'Sunday',
}

export const DAY_SHORT_LABELS: Record<DayOfWeek, string> = {
  monday: 'Mon',
  tuesday: 'Tue',
  wednesday: 'Wed',
  thursday: 'Thu',
  friday: 'Fri',
  saturday: 'Sat',
  sunday: 'Sun',
}

/**
 * Most events one .ics upload may import at a time.
 *
 * Shared on purpose. The import dialog is used by two different server actions, and
 * before this constant existed only ONE of them had a bound: the student's personal-event
 * import capped at 500 and returned an error above it, while the professor's blocked-time
 * import mapped the whole client-supplied array straight into a bulk insert with no limit
 * at all. So the same dialog either promised an import that was guaranteed to fail, or
 * performed an unbounded write — and it knew about neither, which is why it offered a
 * clickable "Import 501 Events". Both actions and the dialog now read this. (#713 part 7)
 */
export const MAX_CALENDAR_IMPORT = 500

export const SLOT_DURATIONS = [15, 30, 45, 60] as const
export type SlotDuration = (typeof SLOT_DURATIONS)[number]

export const SLOT_DURATION_LABELS: Record<number, string> = {
  15: '15 minutes',
  30: '30 minutes',
  45: '45 minutes',
  60: '60 minutes',
}

// Office-hours modes. `hybrid` lets the student pick a concrete mode when booking.
export const MEETING_TYPES = ['in_person', 'zoom', 'hybrid'] as const
export type MeetingType = (typeof MEETING_TYPES)[number]

export const MEETING_TYPE_LABELS: Record<MeetingType, string> = {
  in_person: 'In Person',
  zoom: 'Zoom',
  hybrid: 'Hybrid (In Person or Zoom)',
}

// A booking always resolves to a CONCRETE mode — a student can never book "hybrid".
export const BOOKING_MEETING_TYPES = ['in_person', 'zoom'] as const
export type BookingMeetingType = (typeof BOOKING_MEETING_TYPES)[number]

export const MEETING_PURPOSES = [
  'assignment_doubt',
  'exam_prep',
  'project_discussion',
  'career_guidance',
  'general_question',
] as const
export type MeetingPurpose = (typeof MEETING_PURPOSES)[number]

export const MEETING_PURPOSE_LABELS: Record<MeetingPurpose, string> = {
  assignment_doubt: 'Assignment Doubt',
  exam_prep: 'Exam Preparation',
  project_discussion: 'Project Discussion',
  career_guidance: 'Career Guidance',
  general_question: 'General Question',
}

export const SLOT_STATUSES = [
  'available', 'booked', 'completed', 'cancelled', 'no_show',
] as const
export type SlotStatus = (typeof SLOT_STATUSES)[number]

export const SLOT_STATUS_LABELS: Record<SlotStatus, string> = {
  available: 'Available',
  booked: 'Booked',
  completed: 'Completed',
  cancelled: 'Cancelled',
  no_show: 'No Show',
}

// One-off entries a professor places on their calendar. Originally these were only
// "unavailability" blocks; they now also cover scheduled events (lectures, exams,
// seminars, meetings). Every entry still occupies the professor's time and prevents
// students from booking office hours that overlap it. Listed events-first — the "Add
// event" dialog renders them in this order. Keep in sync with the DB CHECK constraint
// in 20260728120000_add_calendar_event_types.sql.
export const BLOCK_REASONS = [
  'lecture', 'seminar', 'exam', 'meeting', 'conference',
  'lunch', 'personal', 'other',
] as const
export type BlockReason = (typeof BLOCK_REASONS)[number]

export const BLOCK_REASON_LABELS: Record<BlockReason, string> = {
  lecture: 'Lecture',
  seminar: 'Seminar',
  exam: 'Exam',
  meeting: 'Meeting',
  conference: 'Conference',
  lunch: 'Lunch',
  personal: 'Personal',
  other: 'Other',
}

// Which reasons are scheduled "events" vs pure availability blocks — drives the calendar
// coloring (events read as real entries; blocks stay muted "unavailable").
export const EVENT_BLOCK_REASONS: readonly BlockReason[] = [
  'lecture', 'seminar', 'exam', 'meeting', 'conference',
]

// How a one-off calendar entry repeats. 'weekly' repeats on the weekday of its start date
// (e.g. a lecture every Monday) until an optional end date. Keep in sync with the DB CHECK
// in the recurrence migration.
export const RECURRENCES = ['none', 'weekly'] as const
export type Recurrence = (typeof RECURRENCES)[number]
export const RECURRENCE_LABELS: Record<Recurrence, string> = {
  none: 'Does not repeat',
  weekly: 'Weekly',
}

export const BUFFER_OPTIONS = [0, 5, 10, 15] as const

// ── Schemas ───────────────────────────────────────────────────

/** A recurring office hours template set by the professor */
export const officeHoursSchema = z.object({
  id: z.string().min(1),
  professorId: z.string().min(1),
  professorName: z.string().min(1),
  title: z.string().min(1).max(200),
  courseId: z.string().nullable().default(null),
  courseName: z.string().nullable().default(null),
  courseCode: z.string().nullable().default(null),
  dayOfWeek: z.enum(DAYS_OF_WEEK),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  endTime: z.string().regex(/^\d{2}:\d{2}$/),
  slotDuration: z.number().refine((v) => ([15, 30, 45, 60] as number[]).includes(v)),
  bufferMinutes: z.number().int().min(0).max(15).default(0),
  meetingType: z.enum(MEETING_TYPES),
  location: z.string().max(200).default(''),
  zoomLink: z.string().max(500).default(''),
  isActive: z.boolean().default(true),
  effectiveFrom: z.string(),
  effectiveUntil: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export type OfficeHours = z.infer<typeof officeHoursSchema>

/** A single time slot (generated from OfficeHours template for a specific date) */
export const slotSchema = z.object({
  id: z.string().min(1),
  officeHoursId: z.string().min(1),
  professorId: z.string().min(1),
  date: z.string(),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  endTime: z.string().regex(/^\d{2}:\d{2}$/),
  status: z.enum(SLOT_STATUSES),
  bookingId: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export type Slot = z.infer<typeof slotSchema>

/** A booking made by a student for a specific slot */
export const bookingSchema = z.object({
  id: z.string().min(1),
  slotId: z.string().min(1),
  officeHoursId: z.string().min(1),
  professorId: z.string().min(1),
  professorName: z.string().min(1),
  studentId: z.string().min(1),
  studentName: z.string().min(1),
  studentEmail: z.string().email(),
  date: z.string(),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  endTime: z.string().regex(/^\d{2}:\d{2}$/),
  title: z.string().min(1).max(200),
  courseId: z.string().nullable().default(null),
  courseName: z.string().nullable().default(null),
  courseCode: z.string().nullable().default(null),
  meetingType: z.enum(BOOKING_MEETING_TYPES),
  purpose: z.enum(MEETING_PURPOSES),
  studentNote: z.string().max(1000).default(''),
  professorNote: z.string().max(2000).default(''),
  location: z.string().max(200).default(''),
  zoomLink: z.string().max(500).default(''),
  // TODO: Zoom — zoomMeetingId field for auto-generated meetings
  status: z.enum(SLOT_STATUSES),
  cancelledBy: z.enum(['professor', 'student']).nullable().default(null),
  cancellationReason: z.string().max(500).default(''),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export type Booking = z.infer<typeof bookingSchema>

/** A one-off (or weekly-recurring) calendar entry set by the professor: lectures, exams,
 *  meetings, and availability blocks. For a weekly entry, `date` is the first occurrence
 *  (and its weekday is the repeat day); occurrences are expanded for the visible range. */
export const blockedTimeSchema = z.object({
  id: z.string().min(1),
  professorId: z.string().min(1),
  date: z.string(),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  endTime: z.string().regex(/^\d{2}:\d{2}$/),
  reason: z.enum(BLOCK_REASONS),
  note: z.string().max(200).default(''),
  // Course + meeting mode (mirrors office hours) — e.g. a lecture for CS 546, held in person
  // or over Zoom. meetingType null = no mode (a plain block).
  courseId: z.string().nullable().default(null),
  courseName: z.string().nullable().default(null),
  courseCode: z.string().nullable().default(null),
  meetingType: z.enum(MEETING_TYPES).nullable().default(null),
  location: z.string().max(200).default(''),
  zoomLink: z.string().max(500).default(''),
  recurrence: z.enum(RECURRENCES).default('none'),
  // For weekly recurrence: last date it repeats (inclusive). null = no end.
  recurrenceUntil: z.string().nullable().default(null),
  createdAt: z.string(),
})

export type BlockedTime = z.infer<typeof blockedTimeSchema>

// ── Form Schemas ──────────────────────────────────────────────

/** Student booking form */
export const createBookingFormSchema = z.object({
  title: z.string().min(1, 'Title is required').max(200),
  courseId: z.string().nullable(),
  meetingType: z.enum(BOOKING_MEETING_TYPES),
  purpose: z.enum(MEETING_PURPOSES, { message: 'Please select a purpose' }),
  studentNote: z.string().max(1000),
})

export type CreateBookingFormValues = z.infer<typeof createBookingFormSchema>

/** "HH:MM" (zero-padded, 24-hour) → minutes since midnight. */
const hhmmToMinutes = (t: string) => {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}

/** Professor office hours creation form */
export const createOfficeHoursFormSchema = z
  .object({
    title: z.string().min(1, 'Title is required').max(200),
    courseId: z.string().nullable(),
    dayOfWeek: z.enum(DAYS_OF_WEEK, { message: 'Please select a day' }),
    startTime: z.string().regex(/^\d{2}:\d{2}$/, 'Required'),
    endTime: z.string().regex(/^\d{2}:\d{2}$/, 'Required'),
    slotDuration: z.coerce.number().refine((v) => ([15, 30, 45, 60] as number[]).includes(v)),
    bufferMinutes: z.coerce.number().int().min(0).max(15),
    meetingType: z.enum(MEETING_TYPES),
    location: z.string().max(200),
    zoomLink: z.string().max(500),
    effectiveFrom: z.string().min(1, 'Start date is required'),
    effectiveUntil: z.string().nullable(),
  })
  // Reject illogical windows (e.g. 5pm→6am) that create an office hour generating zero
  // slots — it would report "created" but never appear on the calendar.
  .refine((d) => hhmmToMinutes(d.endTime) > hhmmToMinutes(d.startTime), {
    message: 'End time must be after the start time.',
    path: ['endTime'],
  })
  .refine((d) => hhmmToMinutes(d.endTime) - hhmmToMinutes(d.startTime) >= d.slotDuration, {
    message: 'The time window must be at least one slot long.',
    path: ['endTime'],
  })
  .refine((d) => !d.effectiveUntil || d.effectiveUntil >= d.effectiveFrom, {
    message: 'The end date must be on or after the start date.',
    path: ['effectiveUntil'],
  })
  // A mode without its detail is a broken meeting: in-person needs a location, online
  // needs a Zoom link, hybrid needs both.
  .refine((d) => d.meetingType === 'zoom' || d.location.trim().length > 0, {
    message: 'Add a location for in-person meetings.',
    path: ['location'],
  })
  .refine((d) => d.meetingType === 'in_person' || d.zoomLink.trim().length > 0, {
    message: 'Add a Zoom link for online meetings.',
    path: ['zoomLink'],
  })

export type CreateOfficeHoursFormValues = z.infer<typeof createOfficeHoursFormSchema>

/** Professor "Add event" / block-time form (lectures, exams, meetings, personal blocks) */
export const blockTimeFormSchema = z
  .object({
    date: z.string().min(1, 'Date is required'),
    startTime: z.string().regex(/^\d{2}:\d{2}$/, 'Required'),
    endTime: z.string().regex(/^\d{2}:\d{2}$/, 'Required'),
    reason: z.enum(BLOCK_REASONS),
    note: z.string().max(200),
    courseId: z.string().nullable().default(null),
    meetingType: z.enum(MEETING_TYPES).nullable().default(null),
    location: z.string().max(200).default(''),
    zoomLink: z.string().max(500).default(''),
    recurrence: z.enum(RECURRENCES).default('none'),
    recurrenceUntil: z.string().nullable().default(null),
  })
  .refine((d) => hhmmToMinutes(d.endTime) > hhmmToMinutes(d.startTime), {
    message: 'End time must be after the start time.',
    path: ['endTime'],
  })
  // A weekly repeat that ends before it starts would generate zero occurrences.
  .refine((d) => d.recurrence !== 'weekly' || !d.recurrenceUntil || d.recurrenceUntil >= d.date, {
    message: 'The repeat-until date must be on or after the start date.',
    path: ['recurrenceUntil'],
  })
  // If a meeting mode is chosen, its detail is required (no mode → neither is): an
  // in-person/hybrid entry needs a location; an online/hybrid entry needs a Zoom link.
  .refine((d) => !(d.meetingType === 'in_person' || d.meetingType === 'hybrid') || d.location.trim().length > 0, {
    message: 'Add a location for in-person meetings.',
    path: ['location'],
  })
  .refine((d) => !(d.meetingType === 'zoom' || d.meetingType === 'hybrid') || d.zoomLink.trim().length > 0, {
    message: 'Add a Zoom link for online meetings.',
    path: ['zoomLink'],
  })

export type BlockTimeFormValues = z.infer<typeof blockTimeFormSchema>

// ── Student personal calendar events ──────────────────────────────
// A student-authored event on /student/calendar (study block, reminder). Single
// events only in v1 — no recurrence (see the design doc's open questions).

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

export const personalEventSchema = z
  .object({
    title: z.string().trim().min(1, 'Give your event a title').max(120, 'Title must be 120 characters or fewer'),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a date'),
    allDay: z.boolean().default(false),
    startTime: z.string().regex(TIME_RE, 'Invalid time').optional().or(z.literal('')),
    endTime: z.string().regex(TIME_RE, 'Invalid time').optional().or(z.literal('')),
    note: z.string().trim().max(500, 'Note must be 500 characters or fewer').optional().or(z.literal('')),
    // Weekly recurrence (v1) — repeats on the event's start weekday until recurrenceUntil.
    recurrence: z.enum(['none', 'weekly']).default('none'),
    recurrenceUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date').optional().or(z.literal('')),
  })
  // A timed event needs both a start and an end; an all-day event needs neither.
  .refine((d) => d.allDay || (!!d.startTime && !!d.endTime), {
    message: 'Set a start and end time, or mark it all-day',
    path: ['startTime'],
  })
  // End must be after start for a timed event.
  .refine((d) => d.allDay || !d.startTime || !d.endTime || d.startTime < d.endTime, {
    message: 'End time must be after the start time',
    path: ['endTime'],
  })
  // A weekly "until" date, if set, can't precede the event's start date.
  .refine((d) => d.recurrence !== 'weekly' || !d.recurrenceUntil || d.recurrenceUntil >= d.date, {
    message: 'The repeat-until date must be on or after the event date',
    path: ['recurrenceUntil'],
  })

export type PersonalEventInput = z.infer<typeof personalEventSchema>

/** A stored personal event, as read for the calendar + editor. */
export interface PersonalEventRow {
  id: string
  title: string
  date: string
  start_time: string | null
  end_time: string | null
  all_day: boolean
  note: string | null
  recurrence: 'none' | 'weekly'
  recurrence_until: string | null
}
