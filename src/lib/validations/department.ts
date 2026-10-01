/**
 * Department Validation Schemas — Zod schemas for department CRUD operations.
 *
 * Used in two places:
 * 1. Client-side: react-hook-form resolver for instant form validation
 * 2. Server-side: server actions validate input as defense in depth
 *
 * The code field is auto-uppercased and restricted to alphanumeric + hyphens
 * to match real university department codes (e.g. "CS", "FIN", "ME-E").
 */

import { z } from 'zod'

/**
 * Schema for creating a new department.
 * Required fields: name, code
 * Optional fields: description, office_location, contact_email, contact_phone
 * Default: status = 'active'
 */
export const createDepartmentSchema = z.object({
  name: z
    .string()
    .min(2, 'Department name must be at least 2 characters')
    .max(100, 'Department name must be at most 100 characters')
    .trim(),
  code: z
    .string()
    .min(2, 'Code must be at least 2 characters')
    .max(10, 'Code must be at most 10 characters')
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]+$/, 'Code can only contain letters, numbers, and hyphens'),
  description: z
    .string()
    .max(500, 'Description must be at most 500 characters')
    .trim()
    .optional()
    .or(z.literal('')),
  office_location: z
    .string()
    .max(200, 'Office location must be at most 200 characters')
    .trim()
    .optional()
    .or(z.literal('')),
  contact_email: z
    .string()
    .email('Must be a valid email address')
    .optional()
    .or(z.literal('')),
  contact_phone: z
    .string()
    .max(20, 'Phone number must be at most 20 characters')
    .trim()
    .optional()
    .or(z.literal('')),
  status: z.enum(['active', 'inactive']),
})

/**
 * Schema for updating an existing department.
 * All fields are optional (partial update).
 */
export const updateDepartmentSchema = createDepartmentSchema.partial()

/** TypeScript types inferred from the schemas */
export type CreateDepartmentInput = z.infer<typeof createDepartmentSchema>
export type UpdateDepartmentInput = z.infer<typeof updateDepartmentSchema>
