/**
 * Enrollment Validation Schemas — Zod schemas and constants for enrollment management.
 *
 * Enrollments link students to course sections. Admin can enroll/unenroll students,
 * change enrollment status, and update grades.
 *
 * DB table: enrollments
 */

import { z } from 'zod'

/** Valid enrollment statuses matching the DB CHECK constraint */
export const ENROLLMENT_STATUSES = ['enrolled', 'completed', 'dropped', 'withdrawn'] as const
export type EnrollmentStatus = (typeof ENROLLMENT_STATUSES)[number]

/**
 * The statuses that mean "this student is on the course" — the read boundary.
 * `dropped` and `withdrawn` are terminal, so they're excluded.
 *
 * This is the same pair the enrollments RLS policy uses (base migration 11) and
 * the same pair `getStudentSectionDetail` gates the student course layout on, so
 * every reader agrees on who is on a roster.
 *
 * NOTE: `'active'` is NOT an enrollment status — it isn't in ENROLLMENT_STATUSES,
 * nothing writes it, and `updateEnrollmentStatusSchema` rejects it. Several
 * readers across the app still carry it in a hand-written status array where it
 * can never match a row. Don't copy that; use this constant.
 */
export const ON_ROSTER_STATUSES = ['enrolled', 'completed'] as const

export const ENROLLMENT_STATUS_LABELS: Record<EnrollmentStatus, string> = {
  enrolled: 'Enrolled',
  completed: 'Completed',
  dropped: 'Dropped',
  withdrawn: 'Withdrawn',
}

/** Schema for enrolling a student in a course section */
export const enrollStudentSchema = z.object({
  section_id: z.string().uuid('Invalid section'),
  student_id: z.string().uuid('Invalid student'),
})

/** Schema for updating enrollment status */
export const updateEnrollmentStatusSchema = z.object({
  status: z.enum(ENROLLMENT_STATUSES, { message: 'Please select a status' }),
})

/** Schema for updating enrollment grade */
export const updateGradeSchema = z.object({
  final_grade: z
    .string()
    .max(5, 'Grade must be at most 5 characters')
    .trim()
    .optional()
    .or(z.literal('')),
  final_score: z
    .number()
    .min(0, 'Score must be at least 0')
    .max(100, 'Score must be at most 100')
    .optional()
    .nullable(),
})

/** TypeScript types inferred from schemas */
export type EnrollStudentInput = z.infer<typeof enrollStudentSchema>
export type UpdateEnrollmentStatusInput = z.infer<typeof updateEnrollmentStatusSchema>
export type UpdateGradeInput = z.infer<typeof updateGradeSchema>
