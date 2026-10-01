/**
 * Zod schema for the notebook studio document persisted in `assignments.settings.studio`.
 * Validated at the server-action boundary before any write (the .ipynb model is otherwise
 * attacker-shaped JSON). Bounds keep a hostile/huge notebook from being stored.
 */
import { z } from 'zod'

const MAX_CELLS = 1000
const MAX_SOURCE_CHARS = 200_000
const MAX_OUTPUTS_PER_CELL = 1000
// Per-count bounds don't cap the byte size of individual metadata values or outputs (a cell
// count of 1 can still carry megabytes of nested metadata/output JSON). Cap the whole document.
const MAX_DOC_BYTES = 5 * 1024 * 1024

const studioCellSchema = z.object({
  id: z.string().min(1).max(64),
  cell_type: z.enum(['code', 'markdown', 'raw']),
  source: z.string().max(MAX_SOURCE_CHARS),
  metadata: z.record(z.string(), z.unknown()).default({}),
  outputs: z.array(z.unknown()).max(MAX_OUTPUTS_PER_CELL).default([]),
  execution_count: z.number().int().nullable().default(null),
})

const studioNotebookSchema = z.object({
  cells: z.array(studioCellSchema).max(MAX_CELLS),
  metadata: z.record(z.string(), z.unknown()).default({}),
  nbformat: z.number().int().default(4),
  nbformat_minor: z.number().int().default(5),
})

const linkSchema = z.object({ label: z.string().max(200).default(''), url: z.string().max(2000).default('') })

const studioResourcesSchema = z.object({
  links: z.array(linkSchema).max(50).default([]),
  moduleTags: z.array(z.string().max(100)).max(50).default([]),
  // AI-suggested links derived from the concept tags (populated by the Athena seam).
  generatedLinks: z.array(linkSchema).max(50).default([]),
})

export const studioDocSchema = z
  .object({
    version: z.number().int().default(1),
    templateId: z.string().max(64).nullable().default(null),
    notebook: studioNotebookSchema,
    resources: studioResourcesSchema.optional(),
  })
  // Total-size guard: rejects a document whose serialized JSON exceeds the byte cap, closing the
  // per-value gap the count bounds leave open (e.g. an oversized metadata.language_info.name).
  .refine((doc) => JSON.stringify(doc).length <= MAX_DOC_BYTES, {
    message: 'This notebook is too large to save.',
  })

export type StudioDocInput = z.input<typeof studioDocSchema>
export type StudioDoc = z.output<typeof studioDocSchema>

/** Assignment-level resources: reference links + module/concept tags + AI-suggested links. */
export interface StudioResources {
  links: { label: string; url: string }[]
  moduleTags: string[]
  generatedLinks: { label: string; url: string }[]
}

/**
 * Notion-style document assignment (the "Blank" template) persisted at `assignments.settings.document`.
 * Holds a TipTap/ProseMirror JSON doc — arbitrary nested JSON, so we validate the top-level shape
 * and cap the serialized size (same 5MB guard as the notebook studio) rather than the full tree.
 */
const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024

const tiptapDocSchema = z
  .object({
    type: z.literal('doc'),
    content: z.array(z.unknown()).optional(),
  })
  .loose() // keep TipTap's other top-level keys (attrs, marks config) verbatim

export const assignmentDocumentSchema = z
  .object({
    version: z.number().int().default(1),
    doc: tiptapDocSchema,
  })
  .refine((d) => JSON.stringify(d).length <= MAX_DOCUMENT_BYTES, {
    message: 'This document is too large to save.',
  })

export type AssignmentDocumentInput = z.input<typeof assignmentDocumentSchema>
export type AssignmentDocument = z.output<typeof assignmentDocumentSchema>

/** An empty document — a doc with no blocks so the editor opens on its placeholder. */
export function emptyAssignmentDocument(): AssignmentDocument {
  return { version: 1, doc: { type: 'doc', content: [] } }
}

interface DocNode { type?: string; attrs?: Record<string, unknown>; content?: DocNode[] }

function shuffle<T>(arr: T[]): T[] {
  const r = [...arr]
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[r[i], r[j]] = [r[j], r[i]]
  }
  return r
}

/**
 * Strip answer keys from a studio document before it reaches a student. The Match block stores the
 * correct term↔definition pairing by index in its `data` JSON; we shuffle the `right` (definition)
 * values across pairs so the correspondence isn't recoverable from the delivered payload, while the
 * worksheet still shows every term and every definition option. Call this on the student render/
 * download path only — the professor editor and preview keep the real pairing. Returns a new doc
 * (does not mutate the input).
 */
export function stripStudioAnswerKeys<T>(doc: T): T {
  const walk = (node: DocNode): DocNode => {
    let next = node
    if (node.type === 'match' && typeof node.attrs?.data === 'string') {
      try {
        const cfg = JSON.parse(node.attrs.data) as { pairs?: { right?: unknown }[] }
        if (Array.isArray(cfg.pairs) && cfg.pairs.length > 1) {
          const rights = shuffle(cfg.pairs.map((p) => p.right))
          cfg.pairs = cfg.pairs.map((p, i) => ({ ...p, right: rights[i] }))
          next = { ...node, attrs: { ...node.attrs, data: JSON.stringify(cfg) } }
        }
      } catch {
        // Unparseable match data — leave it (renders as an empty worksheet, no key to leak).
      }
    }
    if (Array.isArray(next.content)) next = { ...next, content: next.content.map(walk) }
    return next
  }
  return walk(doc as DocNode) as T
}

/**
 * Strip the professor-only answer key out of a studio NOTEBOOK before it reaches a
 * student. The sibling of stripStudioAnswerKeys() above, for the notebook branch of
 * the same assignment page.
 *
 * Each cell's `metadata.studio` is AuthoringMeta, and `answerKey` there is documented
 * professor-only. The student view already hides it visually (PedagogyCorner is passed
 * showAnswerKey={false}) — but the notebook is handed whole to a `'use client'`
 * component, so the key was serialized into the RSC payload and readable in DevTools
 * before the student ever submitted. Hiding is not withholding.
 *
 * Only `answerKey` is removed: hints, explanation, points, difficulty and the rest of
 * AuthoringMeta are deliberately rendered to students by PedagogyCorner, so stripping
 * `metadata.studio` wholesale would silently remove working features.
 */
export function stripNotebookAnswerKeys<T extends { cells: unknown[] }>(notebook: T): T {
  if (!Array.isArray(notebook?.cells)) return notebook
  return {
    ...notebook,
    cells: notebook.cells.map((cell) => {
      const c = cell as { metadata?: Record<string, unknown> }
      const studio = c?.metadata?.studio
      if (!studio || typeof studio !== 'object') return cell
      if (!('answerKey' in (studio as Record<string, unknown>))) return cell
      const nextStudio = { ...(studio as Record<string, unknown>) }
      delete nextStudio.answerKey
      return { ...c, metadata: { ...c.metadata, studio: nextStudio } }
    }),
  }
}

/** Read a document off an assignment's `settings` JSON, or null if absent/malformed. */
export function parseAssignmentDocument(settings: unknown): AssignmentDocument | null {
  if (!settings || typeof settings !== 'object') return null
  const raw = (settings as Record<string, unknown>).document
  if (!raw) return null
  const parsed = assignmentDocumentSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}
