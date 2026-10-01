// Validation schema for the professor onboarding form.
// Professors fill this in after accepting an admin invite to complete their profile.
// Password is set earlier via SetPasswordDialog (gated by requires_password_set
// in auth metadata) before the wizard ever loads, so it's not part of this schema.

import { z } from 'zod'

/**
 * Schema for professor onboarding — collects profile and department details
 * that the admin didn't provide during the simplified invite.
 * All fields are optional so professors can skip what they don't have yet.
 */
export const professorOnboardingSchema = z.object({
  /* --- Profile fields (profiles table) --- */
  phone: z
    .string()
    .max(20, 'Phone must be at most 20 characters')
    .trim()
    .optional()
    .or(z.literal('')),

  /* --- Department faculty fields (department_faculty table) --- */
  title: z
    .string()
    .max(50, 'Title must be at most 50 characters')
    .trim()
    .optional()
    .or(z.literal('')),
  office_location: z
    .string()
    .max(200, 'Office location must be at most 200 characters')
    .trim()
    .optional()
    .or(z.literal('')),
  office_hours: z
    .string()
    .max(200, 'Office hours must be at most 200 characters')
    .trim()
    .optional()
    .or(z.literal('')),
  office_phone: z
    .string()
    .max(20, 'Office phone must be at most 20 characters')
    .trim()
    .optional()
    .or(z.literal('')),
  bio: z
    .string()
    .max(2000, 'Bio must be at most 2000 characters')
    .trim()
    .optional()
    .or(z.literal('')),
  research_interests: z
    .string()
    .max(500, 'Research interests must be at most 500 characters')
    .trim()
    .optional()
    .or(z.literal('')),
  website_url: z
    .string()
    .url('Must be a valid URL')
    .optional()
    .or(z.literal('')),
  linkedin_url: z
    .string()
    .url('Must be a valid URL')
    .optional()
    .or(z.literal('')),
})

export type ProfessorOnboardingInput = z.infer<typeof professorOnboardingSchema>
