/**
 * Course Validation Schemas — Zod schemas for course CRUD operations.
 *
 * Used in two places:
 * 1. Client-side: react-hook-form resolver for instant form validation
 * 2. Server-side: server actions validate input as defense in depth
 *
 * Courses belong to a department and represent individual classes
 * (e.g. CS-556 NLP, CS-678 Deep Learning).
 *
 * The code field is unique within a department (enforced by DB constraint).
 */

import { z } from 'zod'

/**
 * Credits a course gets when the admin leaves the field blank.
 *
 * The form has always shown "3" as a placeholder, but an empty field used to
 * store NULL — so the hint quietly lied and the course rendered its credits as
 * "—". The create form pre-fills this value and `createCourse` falls back to it,
 * so the hint and the stored row agree.
 */
export const DEFAULT_COURSE_CREDITS = 3

/**
 * Schema for creating a new course.
 * Required fields: department_id, code, title, status
 * Optional fields: description, credits, prerequisites
 */
export const createCourseSchema = z.object({
  department_id: z.string().uuid('Invalid department ID'),
  code: z
    .string()
    .min(2, 'Code must be at least 2 characters')
    .max(20, 'Code must be at most 20 characters')
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]+$/, 'Code can only contain letters, numbers, and hyphens'),
  title: z
    .string()
    .min(2, 'Title must be at least 2 characters')
    .max(200, 'Title must be at most 200 characters')
    .trim(),
  description: z
    .string()
    .max(1000, 'Description must be at most 1000 characters')
    .trim()
    .optional()
    .or(z.literal('')),
  credits: z
    .number()
    .int('Credits must be a whole number')
    .min(0, 'Credits must be at least 0')
    .max(12, 'Credits must be at most 12')
    .optional(),
  prerequisites: z
    .string()
    .max(500, 'Prerequisites must be at most 500 characters')
    .trim()
    .optional()
    .or(z.literal('')),
  status: z.enum(['active', 'inactive', 'archived']),
})

/**
 * Schema for updating an existing course.
 * All fields are optional (partial update).
 */
export const updateCourseSchema = createCourseSchema.partial()

/** TypeScript types inferred from the schemas */
export type CreateCourseInput = z.infer<typeof createCourseSchema>
export type UpdateCourseInput = z.infer<typeof updateCourseSchema>
