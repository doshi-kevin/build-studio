/**
 * Program Validation Schemas — Zod schemas and constants for program management.
 *
 * Programs represent academic degree programs (e.g., BS Computer Science, MS Data Science).
 * Each program belongs to a department and optionally has a director (professor).
 *
 * DB table: programs
 * Fields validated: name, code, degree_type, department_id, director_id, description,
 *                   total_credits, duration_semesters, status
 */

import { z } from 'zod'

/** Valid degree types matching the DB CHECK constraint */
/* The DB CHECK constraint used an entirely different vocabulary — bs/ms/phd/certificate/
   minor — so only `certificate` overlapped and 4 of the 5 types here could never be
   saved (#714). The app's words win, because they are what the UI labels and what a
   reader recognises; `minor` is carried over so nothing the database previously allowed
   is quietly lost. Kept in lockstep with the constraint in
   20260821_align_degree_type_vocabulary.sql — changing one without the other is the bug. */
export const DEGREE_TYPES = ['bachelor', 'master', 'doctorate', 'certificate', 'diploma', 'minor'] as const
export type DegreeType = (typeof DEGREE_TYPES)[number]

export const DEGREE_TYPE_LABELS: Record<DegreeType, string> = {
  bachelor: 'Bachelor',
  master: 'Master',
  doctorate: 'Doctorate',
  certificate: 'Certificate',
  diploma: 'Diploma',
  minor: 'Minor',
}

/** Valid program statuses matching the DB CHECK constraint (verified: active/inactive/archived) */
export const PROGRAM_STATUSES = ['active', 'inactive', 'archived'] as const
export type ProgramStatus = (typeof PROGRAM_STATUSES)[number]

export const PROGRAM_STATUS_LABELS: Record<ProgramStatus, string> = {
  active: 'Active',
  inactive: 'Inactive',
  archived: 'Archived',
}

/**
 * Schema for creating a new program.
 * Required: name, code, degree_type, department_id
 * Optional: description, total_credits, duration_semesters, director_id, status
 */
export const createProgramSchema = z.object({
  name: z
    .string()
    .min(1, 'Program name is required')
    .max(200, 'Name must be at most 200 characters')
    .trim(),

  code: z
    .string()
    .min(2, 'Code must be at least 2 characters')
    .max(20, 'Code must be at most 20 characters')
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]+$/, 'Code may only contain letters, numbers, and hyphens'),

  degree_type: z.enum(DEGREE_TYPES, {
    message: 'Please select a degree type',
  }),

  department_id: z
    .string()
    .uuid('Invalid department'),

  director_id: z
    .string()
    .uuid('Invalid director')
    .optional()
    .or(z.literal('')),

  description: z
    .string()
    .max(2000, 'Description must be at most 2000 characters')
    .trim()
    .optional()
    .or(z.literal('')),

  total_credits: z
    .number()
    .int('Credits must be a whole number')
    .min(1, 'Credits must be at least 1')
    .max(500, 'Credits must be at most 500')
    .optional()
    .nullable(),

  duration_semesters: z
    .number()
    .int('Duration must be a whole number')
    .min(1, 'Duration must be at least 1 semester')
    .max(20, 'Duration must be at most 20 semesters')
    .optional()
    .nullable(),

  status: z.enum(PROGRAM_STATUSES).default('active'),
})

/** Schema for updating a program — all fields optional */
export const updateProgramSchema = createProgramSchema.partial()

/** TypeScript types inferred from schemas */
export type CreateProgramInput = z.infer<typeof createProgramSchema>
export type UpdateProgramInput = z.infer<typeof updateProgramSchema>
