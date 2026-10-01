/**
 * Certificate Validation Schemas — professor-defined certificate templates.
 *
 * A certificate is a named set of challenges; completing ALL of them issues a
 * shareable credential to the student (all-of rule, per Gate 2). Kept dead
 * simple: title, optional description, and the challenges that count.
 */

import { z } from 'zod'

export const createCertificateSchema = z.object({
  title: z.string().min(1, 'Title is required').max(200, 'Title must be at most 200 characters').trim(),
  description: z.string().max(2000, 'Description must be at most 2,000 characters').trim().optional().default(''),
  // The challenges that must ALL be completed to earn this certificate.
  challenge_ids: z.array(z.string().uuid()).min(1, 'Pick at least one challenge').max(50),
})

export const updateCertificateSchema = z.object({
  title: z.string().min(1).max(200).trim().optional(),
  description: z.string().max(2000).trim().optional(),
  challenge_ids: z.array(z.string().uuid()).min(1).max(50).optional(),
  is_active: z.boolean().optional(),
})

export type CreateCertificateInput = z.infer<typeof createCertificateSchema>
export type UpdateCertificateInput = z.infer<typeof updateCertificateSchema>
