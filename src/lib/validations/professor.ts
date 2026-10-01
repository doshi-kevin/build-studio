/**
 * Professor Validation Schemas — Zod schemas for professor CRUD operations.
 *
 * Used in two places:
 * 1. Client-side: react-hook-form resolver for instant form validation
 * 2. Server-side: server actions validate input as defense in depth
 *
 * Creating a professor populates two tables:
 * - profiles: email, name, phone, role (global identity)
 * - department_faculty: title, position, employment_type, office info, bio (per-department details)
 *
 * A professor can belong to multiple departments with different titles/positions.
 */

import { z } from 'zod'

/** Valid position values for department_faculty */
export const POSITIONS = [
  'head',
  'professor',
  'associate_professor',
  'assistant_professor',
  'adjunct',
  'lecturer',
  'visiting',
] as const

export type Position = (typeof POSITIONS)[number]

/** Human-readable position labels */
export const POSITION_LABELS: Record<Position, string> = {
  head: 'Department Head',
  professor: 'Professor',
  associate_professor: 'Associate Professor',
  assistant_professor: 'Assistant Professor',
  adjunct: 'Adjunct Professor',
  lecturer: 'Lecturer',
  visiting: 'Visiting Professor',
}

/** Valid employment type values */
export const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contract'] as const

export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number]

export const EMPLOYMENT_TYPE_LABELS: Record<EmploymentType, string> = {
  full_time: 'Full Time',
  part_time: 'Part Time',
  contract: 'Contract',
}

/* Invite-status labels/variants/tooltips moved to @/lib/validations/invite-status
   so Professor and Student admin views share one source of truth.  Re-exported
   here for backward compatibility — existing imports (ProfessorTable,
   ProfessorCardGrid, the detail page) keep working unchanged. */
export {
  INVITE_STATUS_LABELS,
  INVITE_STATUS_VARIANT,
  INVITE_STATUS_TOOLTIPS,
} from './invite-status'

/**
 * Schema for inviting a new professor (simplified — 6 fields only).
 * Professor fills in remaining details during onboarding.
 * Required: email, first_name, last_name, department_id, position, employment_type
 */
export const inviteProfessorSchema = z.object({
  /* --- Profile fields (profiles table) --- */
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

  /* --- Department faculty fields (department_faculty table) --- */
  department_id: z.string().uuid('Invalid department ID'),
  position: z.enum(POSITIONS, { message: 'Please select a position' }),
  employment_type: z.enum(EMPLOYMENT_TYPES, { message: 'Please select an employment type' }),
})

/** @deprecated Use inviteProfessorSchema instead */
export const createProfessorSchema = inviteProfessorSchema

/**
 * Schema for updating a professor's profile fields only.
 * All fields are optional (partial update).
 */
export const updateProfessorProfileSchema = z.object({
  first_name: z.string().min(1).max(50).trim().optional(),
  last_name: z.string().min(1).max(50).trim().optional(),
  phone: z.string().max(20).trim().optional().or(z.literal('')),
})

/**
 * Schema for updating department-specific faculty fields.
 * All fields are optional (partial update).
 */
export const updateDepartmentFacultySchema = z.object({
  title: z.string().max(50).trim().optional().or(z.literal('')),
  position: z.enum(POSITIONS).optional(),
  employment_type: z.enum(EMPLOYMENT_TYPES).optional(),
  office_location: z.string().max(200).trim().optional().or(z.literal('')),
  office_hours: z.string().max(200).trim().optional().or(z.literal('')),
  office_phone: z.string().max(20).trim().optional().or(z.literal('')),
  bio: z.string().max(2000).trim().optional().or(z.literal('')),
  research_interests: z.string().max(500).trim().optional().or(z.literal('')),
  website_url: z.string().url().optional().or(z.literal('')),
  linkedin_url: z.string().url().optional().or(z.literal('')),
  status: z.enum(['active', 'inactive', 'on_leave']).optional(),
})

/** TypeScript types inferred from the schemas */
export type InviteProfessorInput = z.infer<typeof inviteProfessorSchema>
/** @deprecated Use InviteProfessorInput instead */
export type CreateProfessorInput = InviteProfessorInput
export type UpdateProfessorProfileInput = z.infer<typeof updateProfessorProfileSchema>
export type UpdateDepartmentFacultyInput = z.infer<typeof updateDepartmentFacultySchema>
