/**
 * Course Assignment Validation Schemas — Zod schemas for assigning professors to courses.
 *
 * Used in two places:
 * 1. Client-side: react-hook-form resolver for instant form validation
 * 2. Server-side: server actions validate input as defense in depth
 *
 * "Assigning a professor to a course" creates a course_section row in the DB.
 * The UI simplifies this: admin picks a course, professor, semester, and year.
 * The section_code is auto-generated if not provided.
 *
 * IMPORTANT: Semester values must be lowercase to match the DB CHECK constraint
 * (course_sections_semester_check). The SEMESTER_LABELS map provides display names.
 */

import { z } from 'zod'

/** Valid semester values — lowercase to match DB CHECK constraint */
export const SEMESTERS = ['fall', 'spring', 'summer', 'winter'] as const
export type Semester = (typeof SEMESTERS)[number]

/** Human-readable labels for semester values */
export const SEMESTER_LABELS: Record<Semester, string> = {
  fall: 'Fall',
  spring: 'Spring',
  summer: 'Summer',
  winter: 'Winter',
}

/** Valid modality values for course sections */
export const MODALITIES = ['in_person', 'online', 'hybrid'] as const
export type Modality = (typeof MODALITIES)[number]

/** Human-readable labels for modality values */
export const MODALITY_LABELS: Record<Modality, string> = {
  in_person: 'In Person',
  online: 'Online',
  hybrid: 'Hybrid',
}

/**
 * Schema for creating a new course assignment (course_section).
 * Required: course_id, professor_id, semester, year
 * Optional: section_code, max_students, location, modality
 */
export const createCourseAssignmentSchema = z.object({
  course_id: z.string().uuid('Invalid course ID'),
  professor_id: z.string().uuid('Invalid professor ID'),
  semester: z.enum(SEMESTERS, { message: 'Please select a semester' }),
  year: z
    .number()
    .int('Year must be a whole number')
    .min(2020, 'Year must be 2020 or later')
    .max(2050, 'Year must be 2050 or earlier'),
  section_code: z
    .string()
    .max(10, 'Section code must be at most 10 characters')
    .trim()
    .toUpperCase()
    .optional()
    .or(z.literal('')),
  max_students: z
    .number()
    .int('Must be a whole number')
    .min(1, 'Must be at least 1')
    .max(500, 'Must be at most 500')
    .optional(),
  location: z
    .string()
    .max(200, 'Location must be at most 200 characters')
    .trim()
    .optional()
    .or(z.literal('')),
  modality: z.enum(MODALITIES).optional(),
  status: z.enum(['draft', 'active', 'inactive', 'archived', 'cancelled']).optional(),
})

/** Valid section status values */
export const SECTION_STATUSES = ['draft', 'active', 'inactive', 'archived', 'cancelled'] as const
export type SectionStatus = (typeof SECTION_STATUSES)[number]

/** Human-readable labels for section statuses */
export const SECTION_STATUS_LABELS: Record<SectionStatus, string> = {
  draft: 'Draft',
  active: 'Active',
  inactive: 'Inactive',
  archived: 'Archived',
  cancelled: 'Cancelled',
}

/**
 * Schema for updating an existing course assignment.
 * All fields optional (partial update). Cannot change course_id or professor_id.
 */
export const updateCourseAssignmentSchema = z.object({
  /* professor_id was MISSING here (#716). EditSectionDialog renders a professor picker
     and sends the field, but Zod strips unknown keys — so safeParse silently dropped it
     and updateAssignment wrote every other column. Reassigning a section's professor was
     a no-op that reported success. The field being absent is why "the field is never
     sent" was the wrong diagnosis: it IS sent, and discarded by validation. */
  professor_id: z.string().uuid('Select a professor').optional(),
  /* Human messages on every bound, matching createCourseAssignmentSchema above (#717 part
     4). The bounds were always enforced correctly, but with no message Zod's own text
     ("Too small: expected number to be >=2020") is what reached the admin — the validator
     talking about itself instead of telling them what to type. Same family as #617 and
     #703 part 6. */
  semester: z.enum(SEMESTERS, { message: 'Please select a semester' }).optional(),
  year: z
    .number()
    .int('Year must be a whole number')
    .min(2020, 'Year must be 2020 or later')
    .max(2050, 'Year must be 2050 or earlier')
    .optional(),
  section_code: z
    .string()
    .max(10, 'Section code must be at most 10 characters')
    .trim()
    .toUpperCase()
    .optional()
    .or(z.literal('')),
  max_students: z
    .number()
    .int('Capacity must be a whole number')
    .min(1, 'Capacity must be at least 1 student')
    .max(500, 'Capacity must be 500 students or fewer')
    .optional(),
  location: z.string().max(200, 'Location must be at most 200 characters').trim().optional().or(z.literal('')),
  modality: z.enum(MODALITIES).optional(),
  status: z.enum(['draft', 'active', 'inactive', 'archived', 'cancelled']).optional(),
})

/** TypeScript types inferred from the schemas */
export type CreateCourseAssignmentInput = z.infer<typeof createCourseAssignmentSchema>
export type UpdateCourseAssignmentInput = z.infer<typeof updateCourseAssignmentSchema>
