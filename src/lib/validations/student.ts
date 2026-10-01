/**
 * Student Validation Schemas — Zod schemas for student CRUD operations.
 *
 * Used in two places:
 * 1. Client-side: react-hook-form resolver for instant form validation
 * 2. Server-side: server actions validate input as defense in depth
 *
 * Creating a student populates the profiles table with role='student' and a
 * unique 8-digit CWID (Campus-Wide ID) that serves as their login identifier.
 *
 * The password is auto-generated on the server and shown to the admin once.
 * Students log in using their CWID + password.
 */

import { z } from 'zod'

/**
 * Generates a cryptographically secure random password.
 *
 * Uses `crypto.getRandomValues()` for randomness and an unambiguous character set
 * that excludes easily confused characters (0/O, 1/l/I) for readability.
 *
 * @param length - Password length (default: 12)
 * @returns A random password string
 */
export function generateSecurePassword(length = 12): string {
  const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%'
  const array = new Uint8Array(length)
  crypto.getRandomValues(array)
  return Array.from(array, (byte) => charset[byte % charset.length]).join('')
}

/**
 * Schema for creating a new student.
 * Required: email, first_name, last_name, cwid
 * Optional: department_id, phone, status
 *
 * CWID must be exactly 8 digits — this is the student's login identifier.
 */
export const createStudentSchema = z.object({
  email: z
    .string()
    .email('Must be a valid email address')
    .trim()
    .toLowerCase(),
  first_name: z
    .string()
    .min(1, 'First name is required')
    .max(50, 'First name must be at most 50 characters')
    .trim(),
  last_name: z
    .string()
    .min(1, 'Last name is required')
    .max(50, 'Last name must be at most 50 characters')
    .trim(),
  cwid: z
    .string()
    .regex(/^\d{8}$/, 'CWID must be exactly 8 digits'),
  department_id: z
    .string()
    .uuid('Invalid department ID')
    .optional()
    .or(z.literal('')),
  phone: z
    .string()
    .max(20, 'Phone must be at most 20 characters')
    .trim()
    .optional()
    .or(z.literal('')),
  status: z.enum(['active', 'inactive', 'suspended']).optional(),
})

/**
 * Schema for updating an existing student's profile.
 * All fields optional (partial update). CWID cannot be changed.
 */
export const updateStudentSchema = z.object({
  first_name: z.string().min(1).max(50).trim().optional(),
  last_name: z.string().min(1).max(50).trim().optional(),
  phone: z.string().max(20).trim().optional().or(z.literal('')),
  department_id: z.string().uuid().optional().or(z.literal('')),
  status: z.enum(['active', 'inactive', 'suspended']).optional(),
})

/** TypeScript types inferred from the schemas */
export type CreateStudentInput = z.infer<typeof createStudentSchema>
export type UpdateStudentInput = z.infer<typeof updateStudentSchema>
