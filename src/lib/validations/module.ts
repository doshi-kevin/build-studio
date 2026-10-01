/**
 * Module Validation Schemas — Zod schemas for modules and module items.
 *
 * Module items use a discriminated union on `item_type` for type-specific
 * content validation. Content is stored as JSONB in the database.
 */

import { z } from 'zod'
import { extractionResultSchema } from './document-extraction'

// ── Module Schemas ───────────────────────────────────────────────

export const createModuleSchema = z.object({
  // .trim() FIRST, for the same reason moduleDividerSchema documents below: with a
  // trailing .trim(), '   ' satisfies min(1) and is only then reduced to '' — so a
  // whitespace-only title passed validation and saved an untitled module instead of
  // reporting 'Title is required'.
  title: z
    .string()
    .trim()
    .min(1, 'Title is required')
    .max(200, 'Title must be at most 200 characters'),
  description: z
    .string()
    .max(2000, 'Description must be at most 2,000 characters')
    .trim()
    .optional()
    .or(z.literal('')),
  // Messages spelled out: the defaults ("Too small: expected number to be >=1") are
  // what renders under the field, so they have to read as instructions.
  week_number: z
    .number()
    .int('Week must be a whole number')
    .min(1, 'Week must be between 1 and 52')
    .max(52, 'Week must be between 1 and 52')
    .nullable()
    .optional(),
  is_published: z.boolean(),
  /* When this module opens to students (null/'' = as soon as it's published).
     Validated as a real instant, not just a string: it reaches a `timestamptz`
     column, and a server action is callable with anything — an unparseable value
     would surface as a bare "Failed to update module" with nothing to fix. */
  unlock_date: z
    .string()
    .nullable()
    .optional()
    .refine((v) => !v || !Number.isNaN(new Date(v).getTime()), 'Enter a valid open date'),
  // Roadmap delivery coverage (docs/designs/roadmap-mastery/roadmap-engine.md §13.3). 'skipped'
  // drops the module from BOTH sides of the delivery percentage, so a week the
  // class never meant to teach can't hold the course below 100%. Deliberately
  // distinct from is_published: a skipped module may still be up as optional reading.
  coverage_state: z.enum(['active', 'skipped']).optional(),
  instructor_note: z
    .string()
    .max(5000, 'Note must be at most 5,000 characters')
    .trim()
    .optional()
    .or(z.literal('')),
  // Transient publish control — NOT a column. Whether publishing this module notifies
  // enrolled students. Undefined is treated as true (notify); the professor publishes
  // silently by sending false. Stripped before the DB write. (No .default() — it would
  // desync Zod's input/output types and break the react-hook-form resolver generic.)
  notify: z.boolean().optional(),
})

export const updateModuleSchema = createModuleSchema.partial()

export type CreateModuleInput = z.infer<typeof createModuleSchema>
export type UpdateModuleInput = z.infer<typeof updateModuleSchema>

// A module-level divider — a labelled break BETWEEN modules (the sibling of the
// in-module 'section_divider' item). Title only; it holds no content.
export const moduleDividerSchema = z.object({
  // .trim() FIRST: Zod runs checks in chain order, so a trailing .trim() would let
  // '   ' clear min(1) and then reduce it to '', storing a divider whose pen line
  // carries no label at all.
  // Capped at 40, not 80: on the roadmap an in-module divider draws inside the
  // materials lane (300px), where ~40 italic characters fit before the label
  // ellipsises — and the node is pointer-events:none, so no tooltip can ever
  // reveal the rest. Better to bound the input than to truncate unreadably.
  title: z
    .string()
    .trim()
    .min(1, 'Label is required')
    .max(40, 'Label must be at most 40 characters'),
})

export type ModuleDividerInput = z.infer<typeof moduleDividerSchema>

// The id an undone delete restores a divider under, so the row comes back with
// its original identity instead of a lookalike. Validated because it reaches an
// INSERT as the PK — see createModuleDivider's `restoreId`.
export const dividerRestoreIdSchema = z.string().uuid()

// The Modules page list order, as sent by the drag handler. Capped because each
// entry becomes its own UPDATE: without a bound, one request fans out into as
// many round trips as the caller cares to ask for. 200 is far above any real
// course (the biggest sections run ~15 modules).
export const reorderModuleListSchema = z
  .array(z.object({ id: z.string().uuid(), kind: z.enum(['module', 'divider']) }))
  .max(200, 'Too many rows to reorder at once')

// ── Module Item Types ────────────────────────────────────────────

export const MODULE_ITEM_TYPES = [
  'lecture',
  'video',
  'image',
  'reference',
  'assignment',
  'note',
  'link',
  'section_divider',
] as const
export type ModuleItemType = (typeof MODULE_ITEM_TYPES)[number]

// ── Content Schemas by Type ──────────────────────────────────────

export const lectureContentSchema = z.object({
  fileType: z.enum(['ppt', 'pdf', 'docx', 'xlsx', 'notes', 'image']).default('pdf'),
  fileName: z.string().optional().or(z.literal('')),
  fileSize: z.string().optional().or(z.literal('')),
  fileUrl: z.string().optional().or(z.literal('')),
  filePath: z.string().optional().or(z.literal('')),
  extraction: extractionResultSchema.optional(),
})

export const imageContentSchema = z.object({
  fileUrl: z.string().optional().or(z.literal('')),
  filePath: z.string().optional().or(z.literal('')),
  fileName: z.string().optional().or(z.literal('')),
  fileSize: z.string().optional().or(z.literal('')),
  // Natural pixel dimensions, read from the file on upload.
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  // Alt text — accessible description read by screen readers.
  alt: z.string().max(500).optional().or(z.literal('')),
})

export const videoContentSchema = z.object({
  videoUrl: z.string().optional().or(z.literal('')),
  duration: z.number().min(0).nullable().optional(),
  provider: z.enum(['youtube', 'vimeo', 'upload']).optional(),
  fileUrl: z.string().optional().or(z.literal('')),
  filePath: z.string().optional().or(z.literal('')),
})

export const referenceContentSchema = z.object({
  url: z.string().optional().or(z.literal('')),
  referenceType: z.enum(['link', 'paper', 'reading']).default('link'),
  // Classified from the URL (papers only): a display venue ("arXiv", "DOI",
  // "IEEE"…) and, when parseable, its identifier (arXiv id / DOI).
  venue: z.string().optional().or(z.literal('')),
  venueId: z.string().optional().or(z.literal('')),
  fileUrl: z.string().optional().or(z.literal('')),
  filePath: z.string().optional().or(z.literal('')),
})

export const assignmentContentSchema = z.object({
  dueDate: z.string().optional().or(z.literal('')),
  points: z.number().min(0).nullable().optional(),
})

export const noteContentSchema = z.object({
  body: z.string().max(10000).optional().or(z.literal('')),
})

export const linkContentSchema = z.object({
  url: z.string().optional().or(z.literal('')),
})

export const sectionDividerContentSchema = z.object({
  label: z.string().max(100).optional().or(z.literal('')),
})

export const contentSchemaMap = {
  lecture: lectureContentSchema,
  video: videoContentSchema,
  image: imageContentSchema,
  reference: referenceContentSchema,
  assignment: assignmentContentSchema,
  note: noteContentSchema,
  link: linkContentSchema,
  section_divider: sectionDividerContentSchema,
} as const

// ── Module Item Schemas ──────────────────────────────────────────

export const createModuleItemSchema = z.object({
  item_type: z.enum(MODULE_ITEM_TYPES),
  title: z
    .string()
    .max(200, 'Title must be at most 200 characters')
    .trim()
    .optional()
    .or(z.literal('')),
  description: z
    .string()
    .max(2000, 'Description must be at most 2,000 characters')
    .trim()
    .optional()
    .or(z.literal('')),
  content: z.record(z.string(), z.unknown()),
  is_visible: z.boolean(),
  instructor_note: z
    .string()
    .max(5000, 'Note must be at most 5,000 characters')
    .trim()
    .optional()
    .or(z.literal('')),
})

export const updateModuleItemSchema = createModuleItemSchema.partial()

export type CreateModuleItemInput = z.infer<typeof createModuleItemSchema>
export type UpdateModuleItemInput = z.infer<typeof updateModuleItemSchema>

// ── Item Type Registry (for UI) ──────────────────────────────────

export interface ModuleItemTypeInfo {
  key: ModuleItemType
  label: string
  description: string
  category: 'content' | 'media' | 'structure'
}

// 'assignment' and 'link' remain valid ModuleItemTypes in MODULE_ITEM_TYPES above so
// existing items keep rendering/editing, but they're intentionally absent from the
// picker — assignments live in the dedicated Assignments tab, and an external link is
// just a Reference (a link is a subset of it), so Reference covers that case.
export const MODULE_ITEM_TYPE_INFO: ModuleItemTypeInfo[] = [
  { key: 'lecture', label: 'Lecture Material', description: 'PPT, PDF, or TXT', category: 'content' },
  { key: 'video', label: 'Video', description: 'YouTube, Vimeo, or uploaded recording', category: 'media' },
  { key: 'image', label: 'Image', description: 'PNG, JPG, or other image file', category: 'media' },
  { key: 'reference', label: 'Reference', description: 'Links, papers, or reading material', category: 'content' },
  { key: 'note', label: 'Note', description: 'Text note visible to students', category: 'content' },
  { key: 'section_divider', label: 'Section Divider', description: 'Organize items into sections', category: 'structure' },
]
