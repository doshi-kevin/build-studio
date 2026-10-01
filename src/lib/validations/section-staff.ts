// Zod schemas for section staff (TA/grader) onboarding workflow.
// Used in two places: client forms (react-hook-form resolver) and server
// actions (schema.safeParse as defense in depth).

import { z } from 'zod'

/** The per-assignment role — NOT the profile identity role. */
export const STAFF_ROLES = ['ta', 'grader'] as const
export type StaffRole = (typeof STAFF_ROLES)[number]

export const STAFF_ROLE_LABELS: Record<StaffRole, string> = {
  ta: 'Teaching Assistant',
  grader: 'Grader',
}

export const STAFF_ROLE_DESCRIPTIONS: Record<StaffRole, string> = {
  ta: 'Full course support — post announcements, grade, moderate discussions, attend office hours.',
  grader: 'Grading only — views and grades submissions; no announcement or classroom access.',
}

export const STAFF_REQUEST_STATUSES = ['pending', 'approved', 'rejected'] as const
export type StaffRequestStatus = (typeof STAFF_REQUEST_STATUSES)[number]

export const STAFF_STATUSES = ['active', 'ended', 'removed'] as const
export type StaffStatus = (typeof STAFF_STATUSES)[number]

/**
 * Schema for a professor submitting a candidate for approval.
 * `ends_at` defaults to the section's end_date server-side if not provided.
 */
/**
 * A date the staff-request forms can carry: either a date-input value
 * (`yyyy-mm-dd`) or the ISO datetime the client converts it to before sending.
 *
 * These were bare `z.string().optional()`, so any string passed — and both dialogs
 * feed the value straight into `new Date(value + 'T23:59:59').toISOString()`, which
 * throws RangeError on an unparseable date. Uncaught, that reached the error
 * boundary and turned the whole dashboard into "Dashboard Error" (#748).
 *
 * BOTH shapes have to be accepted, because this schema does double duty: it is the
 * react-hook-form resolver (seeing the raw `yyyy-mm-dd` field value) AND the server
 * action's validator (seeing the converted ISO datetime). Accepting only one breaks
 * the other — narrowing it to date-only would reject every real submission.
 *
 * Being the form resolver is also what fixes the crash: an unparseable value now
 * fails validation, so `onSubmit` never runs and the conversion is never reached.
 * The server rejects it too, where `ends_at: "banana"` was accepted before.
 *
 * The check round-trips the date part rather than trusting Date.parse, because
 * Date.parse('2026-02-31') does NOT fail — it silently rolls forward to March 3rd.
 * Re-formatting and comparing is what actually rejects a day that doesn't exist.
 */
/** Shared so the textarea's maxLength, the counter and the schema can't drift. */
export const STAFF_REQUEST_MESSAGE_MAX = 500

/**
 * `yyyy-mm-dd` → end-of-day ISO, without the RangeError (#748).
 *
 * Both dialogs had their own copy of `new Date(v + 'T23:59:59').toISOString()`, which
 * threw on an unparseable value and, uncaught, took the whole dashboard down through
 * the error boundary. The schema above now rejects junk before submit, so this is the
 * second line of defence rather than the only one — and it no longer mangles a value
 * that is already a full datetime.
 */
export function toEndOfDayIso(value: string): string | undefined {
  if (!value) return undefined
  const withTime = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59` : value
  const parsed = new Date(withTime)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString()
}

const staffRequestDate = z
  .string()
  .refine((v) => {
    if (!/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(v)) return false
    const datePart = v.slice(0, 10)
    const parsed = new Date(`${datePart}T00:00:00Z`)
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === datePart
  }, 'Enter a valid date')
  .optional()
  .or(z.literal(''))

export const submitStaffRequestSchema = z.object({
  section_id: z.string().uuid('Invalid section ID'),
  candidate_email: z
    .string()
    .email('Must be a valid email address')
    .trim()
    .toLowerCase(),
  candidate_first_name: z
    .string()
    .min(1, 'First name is required')
    .max(50, 'First name must be at most 50 characters')
    .trim(),
  candidate_last_name: z
    .string()
    .min(1, 'Last name is required')
    .max(50, 'Last name must be at most 50 characters')
    .trim(),
  requested_role: z.enum(STAFF_ROLES, { message: 'Select a role' }),
  starts_at: staffRequestDate,
  ends_at: staffRequestDate,
  message: z
    .string()
    .max(STAFF_REQUEST_MESSAGE_MAX, `Message must be at most ${STAFF_REQUEST_MESSAGE_MAX} characters`)
    .trim()
    .optional()
    .or(z.literal('')),
})

/** Schema for admin approve action (optional override of dates + note).
 * `promote_existing_student` opts into flipping a student's primary role to
 * staff when their email matches an existing student profile — a deliberate
 * second confirmation because the student loses access to their student
 * dashboard. See approveStaffRequest for the conflict signal. */
export const approveStaffRequestSchema = z.object({
  request_id: z.string().uuid(),
  /* Same fields, same reason — these were `z.string().optional()` too, and
     StaffRequestQueue has its own copy of the unguarded conversion. */
  starts_at: staffRequestDate,
  ends_at: staffRequestDate,
  note: z.string().max(500).trim().optional().or(z.literal('')),
  promote_existing_student: z.boolean().optional(),
})

/** Schema for admin re-sending an invite whose original link expired. */
export const resendStaffInviteSchema = z.object({
  profile_id: z.string().uuid(),
})

/** Schema for admin reject action. */
export const rejectStaffRequestSchema = z.object({
  request_id: z.string().uuid(),
  note: z
    .string()
    .min(1, 'Rejection reason is required')
    .max(500, 'Reason must be at most 500 characters')
    .trim(),
})

/** Schema for revoking an already-active staff assignment. */
export const revokeStaffSchema = z.object({
  staff_id: z.string().uuid(),
  reason: z.string().max(500).trim().optional().or(z.literal('')),
})

export type SubmitStaffRequestInput = z.infer<typeof submitStaffRequestSchema>
export type ApproveStaffRequestInput = z.infer<typeof approveStaffRequestSchema>
export type RejectStaffRequestInput = z.infer<typeof rejectStaffRequestSchema>
export type RevokeStaffInput = z.infer<typeof revokeStaffSchema>
export type ResendStaffInviteInput = z.infer<typeof resendStaffInviteSchema>
