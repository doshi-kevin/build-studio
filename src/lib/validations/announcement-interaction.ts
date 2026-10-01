/**
 * Announcement Interaction Schemas — Zod schemas for reactions and comments.
 *
 * Used in student-side server actions for validating reaction and comment input.
 */

import { z } from 'zod'

export const reactionSchema = z.object({
  emoji: z.string().min(1).max(4),
})

export type ReactionInput = z.infer<typeof reactionSchema>

export const commentSchema = z.object({
  content: z
    .string()
    .min(1, 'Comment cannot be empty')
    .max(2000, 'Comment must be at most 2,000 characters')
    .trim(),
})

export type CommentInput = z.infer<typeof commentSchema>
