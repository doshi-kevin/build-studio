/**
 * Announcement Validation Schemas — Zod schemas for announcement CRUD.
 *
 * Used in:
 * 1. Client-side: react-hook-form resolver for instant form validation
 * 2. Server-side: server actions validate input as defense in depth
 */

import { z } from 'zod'

export const attachmentSchema = z.object({
  fileName: z.string(),
  fileSize: z.number(),
  fileUrl: z.string(),
  filePath: z.string(),
  mimeType: z.string().optional().or(z.literal('')),
})

export type AnnouncementAttachment = z.infer<typeof attachmentSchema>

export const linkSchema = z.object({
  // Scheme-restricted because this value is rendered straight into an `<a href>`
  // for every reader: without it, `javascript:…` typed here executes in their
  // session (professor/TA → student stored XSS). Mirrors team-meeting.ts.
  url: z.string()
    .min(1, 'URL is required')
    .refine((u) => /^https?:\/\//i.test(u), 'Link must start with http:// or https://'),
  label: z.string().optional().or(z.literal('')),
})

export type AnnouncementLink = z.infer<typeof linkSchema>

export const linkedItemSchema = z.object({
  id: z.string(),
  type: z.enum(['quiz', 'module_item', 'project']),
  label: z.string().min(1).max(200),
})

export type LinkedItem = z.infer<typeof linkedItemSchema>

export const createAnnouncementSchema = z.object({
  title: z
    .string()
    .min(1, 'Title is required')
    .max(200, 'Title must be at most 200 characters')
    .trim(),
  content: z
    .string()
    .max(10000, 'Content must be at most 10,000 characters')
    .trim()
    .optional()
    .or(z.literal('')),
  rich_content: z.any().optional(),
  is_pinned: z.boolean(),
  is_important: z.boolean().default(false),
  requires_acknowledgement: z.boolean().default(false),
  status: z.enum(['draft', 'published', 'scheduled']),
  /* Must be an absolute instant, not the offset-less local wall-clock a
     datetime-local input produces — the client converts via
     fromLocalDateTimeInput before submitting. Validating it here pins that
     contract server-side, so a raw local string is rejected with a readable
     message instead of being silently stored as UTC and published hours early. */
  scheduled_at: z.string().datetime({ offset: true }).optional().nullable(),
  visibility: z.enum(['all', 'mentioned_only']).default('all'),
  allow_reactions: z.boolean().default(false),
  allow_comments: z.boolean().default(false),
  attachments: z.array(attachmentSchema).optional(),
  links: z.array(linkSchema).optional(),
  mentioned_student_ids: z.array(z.string()).optional(),
  // Multi-section posting (create only): additional sections to also publish
  // this announcement into. Each is access-checked server-side per section.
  additional_section_ids: z.array(z.string().uuid()).optional(),
})

export const updateAnnouncementSchema = createAnnouncementSchema.partial().extend({
  // Edit sync scope for multi-section groups: 'all' updates every section copy's
  // content, 'this' (default) only the row being edited.
  sync_scope: z.enum(['this', 'all']).optional(),
})

export type CreateAnnouncementInput = z.infer<typeof createAnnouncementSchema>
export type UpdateAnnouncementInput = z.infer<typeof updateAnnouncementSchema>
