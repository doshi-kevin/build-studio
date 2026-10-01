/**
 * Project Chat Validation Schemas — Zod schemas for discussion channels and messages.
 *
 * Used in server actions for input validation and client-side form validation.
 */

import { z } from 'zod'

// ── Channel Schemas ─────────────────────────────────────────────

export const MAX_CHANNELS_PER_TEAM = 10

export const createChannelSchema = z.object({
  name: z
    .string()
    .min(1, 'Channel name is required')
    .max(50, 'Channel name must be at most 50 characters')
    .trim()
    .transform((v) => v.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')),
})

export const renameChannelSchema = z.object({
  name: z
    .string()
    .min(1, 'Channel name is required')
    .max(50, 'Channel name must be at most 50 characters')
    .trim()
    .transform((v) => v.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')),
})

export type CreateChannelInput = z.infer<typeof createChannelSchema>
export type RenameChannelInput = z.infer<typeof renameChannelSchema>

// ── Message Schemas ─────────────────────────────────────────────

export const MAX_MENTIONS_PER_MESSAGE = 20

export const sendMessageSchema = z.object({
  content: z
    .string()
    .max(5000, 'Message must be at most 5,000 characters')
    .trim(),
  attachment_url: z.string().optional(),
  attachment_path: z.string().optional(),
  attachment_name: z.string().optional(),
  attachment_size: z.number().optional(),
  attachment_type: z.string().optional(),
  // @user mentions — client passes the UUID list extracted from the
  // textarea. Server re-verifies every id is a member of the same team
  // before trusting it (defense in depth).
  mentioned_user_ids: z
    .array(z.string().uuid())
    .max(MAX_MENTIONS_PER_MESSAGE, `Too many mentions (max ${MAX_MENTIONS_PER_MESSAGE})`)
    .default([]),
  // @phase mentions — client passes the UUID list of project_phases
  // mentioned via @phase. Server re-verifies each id belongs to the
  // channel's team before persisting.
  mentioned_phase_ids: z
    .array(z.string().uuid())
    .max(MAX_MENTIONS_PER_MESSAGE, `Too many mentions (max ${MAX_MENTIONS_PER_MESSAGE})`)
    .default([]),
  // @doc mentions — same shape as phase mentions but pointed at
  // project_docs. Server re-verifies each id belongs to the channel's
  // team before persisting.
  mentioned_doc_ids: z
    .array(z.string().uuid())
    .max(MAX_MENTIONS_PER_MESSAGE, `Too many mentions (max ${MAX_MENTIONS_PER_MESSAGE})`)
    .default([]),
}).refine(
  (data) => data.content.length > 0 || !!data.attachment_path || !!data.attachment_url,
  { message: 'Message must have text or an attachment' },
)

export type SendMessageInput = z.infer<typeof sendMessageSchema>
