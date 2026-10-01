// Zod schemas for DM server actions. Keep the message shape aligned
// with discussion/project chat so a single ChatInput/MessageBubble can
// serve all three surfaces.

import { z } from 'zod'

export const sendDmMessageSchema = z
  .object({
    content: z.string().max(10000).default(''),
    attachment_url: z.string().url().optional(),
    attachment_path: z.string().optional(),
    attachment_name: z.string().optional(),
    attachment_size: z.number().int().nonnegative().optional(),
    attachment_type: z.string().optional(),
  })
  .refine(
    (v) => (v.content ?? '').trim().length > 0 || !!v.attachment_path || !!v.attachment_url,
    { message: 'Message must have text or an attachment' },
  )

export type SendDmMessageInput = z.infer<typeof sendDmMessageSchema>
