// Zod validation schemas for the project_docs (multi-canvas) feature.
// Used by client forms (resolver) and server actions (safeParse) as
// defense-in-depth.

import { z } from 'zod'

export const DOC_TITLE_MAX = 200
export const DOC_CONTENT_MAX_CHARS = 50_000

// Content is stored as JSONB. We accept HTML strings during MVP, with
// a format discriminator to make migration to ProseMirror JSON easy.
export const docContentSchema = z.union([
  z.object({
    format: z.literal('html'),
    html: z.string().max(DOC_CONTENT_MAX_CHARS, 'Document exceeds character limit'),
  }),
  z.object({
    format: z.literal('json'),
    json: z.record(z.string(), z.unknown()),
  }),
])

export type DocContent = z.infer<typeof docContentSchema>

export const createDocSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, 'Title cannot be empty')
    .max(DOC_TITLE_MAX, `Title must be at most ${DOC_TITLE_MAX} characters`)
    .default('Untitled'),
})

export type CreateDocInput = z.infer<typeof createDocSchema>

export const updateDocTitleSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, 'Title cannot be empty')
    .max(DOC_TITLE_MAX, `Title must be at most ${DOC_TITLE_MAX} characters`),
})

export type UpdateDocTitleInput = z.infer<typeof updateDocTitleSchema>

export const updateDocContentSchema = z.object({
  content: docContentSchema,
})

export type UpdateDocContentInput = z.infer<typeof updateDocContentSchema>

// Helper: extract the HTML payload from a stored content blob. Returns
// an empty string for malformed / empty content so the editor still
// renders an empty paper.
export function docContentToHtml(content: unknown): string {
  if (!content || typeof content !== 'object') return ''
  const obj = content as Record<string, unknown>
  if (obj.format === 'html' && typeof obj.html === 'string') return obj.html
  // Future: ProseMirror JSON → HTML conversion. Not needed yet.
  return ''
}

export function htmlToDocContent(html: string): DocContent {
  return { format: 'html', html }
}
