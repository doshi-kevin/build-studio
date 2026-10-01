/**
 * Discussion Validation Schemas — Zod schemas for course-level discussion
 * channels and messages. Used in server actions and client-side forms.
 */

import { z } from 'zod'

// ── Constants ───────────────────────────────────────────────────

export const MAX_TEAM_CHANNELS = 10
export const MAX_COURSE_CHANNELS = 5

// ── Channel Schemas ─────────────────────────────────────────────

export const createDiscussionChannelSchema = z.object({
  name: z
    .string()
    .min(1, 'Channel name is required')
    .max(50, 'Channel name must be at most 50 characters')
    .trim()
    .refine((v) => v.length > 0, 'Channel name is required')
    .transform((v) =>
      /* ORDER MATTERS (#674). Converting whitespace to hyphens BEFORE stripping punctuation
         left the stripped characters' own gap behind, so "hey!! @#$ there" became
         "hey--there". Strip first, then collapse runs of whitespace, then collapse repeated
         hyphens, then trim them off the ends. */
      v
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^-+|-+$/g, ''),
    )
    /* Validate AFTER the transform (#674). Both refines above see the RAW input, so a
       name made only of stripped characters — `!!!` — passed every check and produced a
       channel with an EMPTY display name: a bare `#` row with no label, permanently
       consuming one of the 5 MAX_COURSE_CHANNELS slots and awkward to identify in order to
       delete. Also rejects a name that reduces to only hyphens ("- - -"), which is
       unlabelled in the same way. */
    .refine((v) => v.replace(/-/g, '').length > 0, 'Channel name needs at least one letter or number'),
})

export const renameDiscussionChannelSchema = z.object({
  name: z
    .string()
    .min(1, 'Channel name is required')
    .max(50, 'Channel name must be at most 50 characters')
    .trim()
    .refine((v) => v.length > 0, 'Channel name is required')
    .transform((v) =>
      /* ORDER MATTERS (#674). Converting whitespace to hyphens BEFORE stripping punctuation
         left the stripped characters' own gap behind, so "hey!! @#$ there" became
         "hey--there". Strip first, then collapse runs of whitespace, then collapse repeated
         hyphens, then trim them off the ends. */
      v
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^-+|-+$/g, ''),
    )
    /* Validate AFTER the transform (#674). Both refines above see the RAW input, so a
       name made only of stripped characters — `!!!` — passed every check and produced a
       channel with an EMPTY display name: a bare `#` row with no label, permanently
       consuming one of the 5 MAX_COURSE_CHANNELS slots and awkward to identify in order to
       delete. Also rejects a name that reduces to only hyphens ("- - -"), which is
       unlabelled in the same way. */
    .refine((v) => v.replace(/-/g, '').length > 0, 'Channel name needs at least one letter or number'),
})

export type CreateDiscussionChannelInput = z.infer<typeof createDiscussionChannelSchema>
export type RenameDiscussionChannelInput = z.infer<typeof renameDiscussionChannelSchema>

// ── Message Schemas ─────────────────────────────────────────────

export const sendDiscussionMessageSchema = z.object({
  content: z
    .string()
    .max(5000, 'Message must be at most 5,000 characters')
    .trim(),
  attachment_url: z.string().optional(),
  attachment_path: z.string().optional(),
  attachment_name: z.string().optional(),
  attachment_size: z.number().optional(),
  attachment_type: z.string().optional(),
}).refine(
  (data) => data.content.length > 0 || !!data.attachment_path || !!data.attachment_url,
  { message: 'Message must have text or an attachment' },
)

export type SendDiscussionMessageInput = z.infer<typeof sendDiscussionMessageSchema>
