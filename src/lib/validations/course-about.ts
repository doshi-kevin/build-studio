/**
 * Course About Content — Block-based content builder types and validation.
 *
 * Content is stored in `course_sections.settings.about` as JSONB.
 * Supports v2 block format, v1 Tiptap format, and legacy structured format.
 * All formats are auto-migrated to v2 on read.
 */

import { z } from 'zod'

// ─── Tiptap JSON types (used inside rich text blocks) ───────────────────────

export interface TiptapNode {
  type: string
  attrs?: Record<string, unknown>
  content?: TiptapNode[]
  marks?: { type: string; attrs?: Record<string, unknown> }[]
  text?: string
}

export interface TiptapDoc {
  type: 'doc'
  content: TiptapNode[]
}

const tiptapDocSchema = z.object({
  type: z.literal('doc'),
  content: z.array(z.any()).optional().default([]),
})

// ─── Block type definitions ─────────────────────────────────────────────────

export type BlockType =
  | 'hero'
  | 'text'
  | 'image'
  | 'table'
  | 'video'
  | 'syllabus'
  | 'learning-outcomes'
  | 'faq'
  | 'callout'
  | 'divider'
  | 'quote'
  | 'highlight-box'
  | 'contact'

interface BaseBlock {
  id: string
  type: BlockType
  collapsed?: boolean
}

export interface HeroBlock extends BaseBlock {
  type: 'hero'
  data: {
    /** Public URL of the banner image (Supabase Storage) — also tolerates legacy
     *  base64 data: URIs from before storage upload was wired in. */
    bannerSrc: string
    /** Storage path of the banner so we can delete it on replace/remove. */
    bannerPath?: string
    bannerAlt: string
    title: string
    subtitle: string
    instructor: string
    semester: string
    credits: string
    introVideoUrl: string
    ctaText: string
    ctaUrl: string
    /** Storage path of a file uploaded FOR the action button, when the professor
     *  uploaded one instead of pasting a link. Present = ctaUrl points at our own
     *  storage, so replacing or clearing the button should clean the old object up.
     *  Absent = ctaUrl is an external link we don't own. */
    ctaFilePath?: string
    /** Original filename, so the editor can show "syllabus.pdf" rather than a
     *  signed URL the professor can't read. */
    ctaFileName?: string
  }
}

export interface TextBlock extends BaseBlock {
  type: 'text'
  data: { content: TiptapDoc }
}

export interface ImageBlock extends BaseBlock {
  type: 'image'
  data: {
    /** Public URL of the image (Supabase Storage) — tolerates legacy base64 too. */
    src: string
    /** Storage path so we can delete on replace/remove. */
    srcPath?: string
    alt: string
    caption: string
    alignment: 'left' | 'center' | 'right'
  }
}

export interface TableBlock extends BaseBlock {
  type: 'table'
  data: {
    /** Heading above the grid. Optional, and empty on every table saved before
     *  this field existed — a grading breakdown used to render as an unlabelled
     *  slab between two titled sections. */
    title: string
    hasHeaderRow: boolean
    rows: string[][]
  }
}

export interface VideoBlock extends BaseBlock {
  type: 'video'
  data: { url: string; caption: string }
}

export interface SyllabusWeek {
  id: string
  week: number
  topic: string
  description: string
  readings: string
}

export interface SyllabusBlock extends BaseBlock {
  type: 'syllabus'
  data: {
    title: string
    weeks: SyllabusWeek[]
    /** When true, the student preview shows a "Schedule coming soon" stub
     *  instead of the week list — useful when the prof hasn't finalised it yet
     *  but wants students to know one is in the works. */
    tba?: boolean
  }
}

export interface LearningOutcome {
  id: string
  text: string
  isCore: boolean
}

export interface LearningOutcomesBlock extends BaseBlock {
  type: 'learning-outcomes'
  data: {
    title: string
    outcomes: LearningOutcome[]
    /** When true, the student preview shows an "Outcomes coming soon" stub
     *  instead of the outcomes list. */
    tba?: boolean
  }
}

export interface FaqItem {
  id: string
  question: string
  answer: TiptapDoc
}

export interface FaqBlock extends BaseBlock {
  type: 'faq'
  data: { title: string; items: FaqItem[] }
}

export type CalloutVariant = 'info' | 'warning' | 'success' | 'alert'

export interface CalloutBlock extends BaseBlock {
  type: 'callout'
  data: { variant: CalloutVariant; title: string; content: TiptapDoc }
}

export interface DividerBlock extends BaseBlock {
  type: 'divider'
  data: Record<string, never>
}

export interface QuoteBlock extends BaseBlock {
  type: 'quote'
  data: { text: string; attribution: string }
}

export type HighlightVariant = 'feature' | 'tip' | 'important'

export interface HighlightBoxBlock extends BaseBlock {
  type: 'highlight-box'
  data: { variant: HighlightVariant; title: string; content: TiptapDoc }
}

export interface ContactBlock extends BaseBlock {
  type: 'contact'
  data: {
    /** What students should call the instructor — defaults to courseInfo.instructor at insert time */
    name: string
    /** e.g. "Associate Professor of Computer Science" */
    title: string
    email: string
    officeLocation: string
    /** Free-form, e.g. "Tue/Thu 2–4 PM" or "By appointment" */
    officeHours: string
    /** Optional Zoom or virtual office link */
    zoomUrl: string
    /** e.g. "Within 24 hours on weekdays" */
    responseTime: string
  }
}

export type AboutBlock =
  | HeroBlock
  | TextBlock
  | ImageBlock
  | TableBlock
  | VideoBlock
  | SyllabusBlock
  | LearningOutcomesBlock
  | FaqBlock
  | CalloutBlock
  | DividerBlock
  | QuoteBlock
  | HighlightBoxBlock
  | ContactBlock

// ─── V2 document container ──────────────────────────────────────────────────

export interface AboutContentV2 {
  version: 2
  blocks: AboutBlock[]
}

export const EMPTY_ABOUT: AboutContentV2 = { version: 2, blocks: [] }

// ─── Zod schemas ────────────────────────────────────────────────────────────

const baseBlockFields = {
  id: z.string(),
  collapsed: z.boolean().optional(),
}

const heroBlockSchema = z.object({
  ...baseBlockFields,
  type: z.literal('hero'),
  data: z.object({
    bannerSrc: z.string().default(''),
    bannerPath: z.string().optional(),
    bannerAlt: z.string().default(''),
    title: z.string().default(''),
    subtitle: z.string().default(''),
    instructor: z.string().default(''),
    semester: z.string().default(''),
    credits: z.string().default(''),
    introVideoUrl: z.string().default(''),
    ctaText: z.string().default(''),
    ctaUrl: z.string().default(''),
    ctaFilePath: z.string().optional(),
    ctaFileName: z.string().optional(),
  }),
})

const textBlockSchema = z.object({
  ...baseBlockFields,
  type: z.literal('text'),
  data: z.object({ content: tiptapDocSchema }),
})

const imageBlockSchema = z.object({
  ...baseBlockFields,
  type: z.literal('image'),
  data: z.object({
    src: z.string(),
    srcPath: z.string().optional(),
    alt: z.string().default(''),
    caption: z.string().default(''),
    alignment: z.enum(['left', 'center', 'right']).default('center'),
  }),
})

const tableBlockSchema = z.object({
  ...baseBlockFields,
  type: z.literal('table'),
  data: z.object({
    // .default('') keeps every already-stored table parsing unchanged.
    title: z.string().default(''),
    hasHeaderRow: z.boolean().default(true),
    rows: z.array(z.array(z.string())),
  }),
})

const videoBlockSchema = z.object({
  ...baseBlockFields,
  type: z.literal('video'),
  data: z.object({ url: z.string(), caption: z.string().default('') }),
})

const syllabusBlockSchema = z.object({
  ...baseBlockFields,
  type: z.literal('syllabus'),
  data: z.object({
    title: z.string().default('Weekly Schedule'),
    weeks: z.array(z.object({
      id: z.string(),
      week: z.number(),
      topic: z.string(),
      description: z.string().default(''),
      readings: z.string().default(''),
    })),
    tba: z.boolean().optional(),
  }),
})

const learningOutcomesBlockSchema = z.object({
  ...baseBlockFields,
  type: z.literal('learning-outcomes'),
  data: z.object({
    title: z.string().default('Learning Outcomes'),
    outcomes: z.array(z.object({
      id: z.string(),
      text: z.string(),
      isCore: z.boolean().default(true),
    })),
    tba: z.boolean().optional(),
  }),
})

const faqBlockSchema = z.object({
  ...baseBlockFields,
  type: z.literal('faq'),
  data: z.object({
    title: z.string().default('Frequently Asked Questions'),
    items: z.array(z.object({
      id: z.string(),
      question: z.string(),
      answer: tiptapDocSchema,
    })),
  }),
})

const calloutBlockSchema = z.object({
  ...baseBlockFields,
  type: z.literal('callout'),
  data: z.object({
    variant: z.enum(['info', 'warning', 'success', 'alert']).default('info'),
    title: z.string().default(''),
    content: tiptapDocSchema,
  }),
})

const dividerBlockSchema = z.object({
  ...baseBlockFields,
  type: z.literal('divider'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: z.object({}).passthrough() as any,
})

const quoteBlockSchema = z.object({
  ...baseBlockFields,
  type: z.literal('quote'),
  data: z.object({
    text: z.string().default(''),
    attribution: z.string().default(''),
  }),
})

const highlightBoxBlockSchema = z.object({
  ...baseBlockFields,
  type: z.literal('highlight-box'),
  data: z.object({
    variant: z.enum(['feature', 'tip', 'important']).default('feature'),
    title: z.string().default(''),
    content: tiptapDocSchema,
  }),
})

const contactBlockSchema = z.object({
  ...baseBlockFields,
  type: z.literal('contact'),
  data: z.object({
    name: z.string().default(''),
    title: z.string().default(''),
    email: z.string().default(''),
    officeLocation: z.string().default(''),
    officeHours: z.string().default(''),
    zoomUrl: z.string().default(''),
    responseTime: z.string().default(''),
  }),
})

const aboutBlockSchema = z.discriminatedUnion('type', [
  heroBlockSchema,
  textBlockSchema,
  imageBlockSchema,
  tableBlockSchema,
  videoBlockSchema,
  syllabusBlockSchema,
  learningOutcomesBlockSchema,
  faqBlockSchema,
  calloutBlockSchema,
  dividerBlockSchema,
  quoteBlockSchema,
  highlightBoxBlockSchema,
  contactBlockSchema,
])

/* Legacy keys in stored JSONB (theme.accentColor, hero overlayOpacity — from a
   customization option that was removed) are silently stripped on parse: zod
   object schemas drop unknown keys by default. */
export const aboutContentV2Schema = z.object({
  version: z.literal(2),
  blocks: z.array(aboutBlockSchema).default([]),
})

/** Legacy v1 schema for backward compat detection */
export const aboutContentSchema = aboutContentV2Schema

// ─── Parse & migrate ────────────────────────────────────────────────────────

/**
 * Parse about content from JSONB settings.
 * Handles v2 block format, v1 Tiptap doc, and legacy structured format.
 */
export function parseAboutContent(settings: unknown): AboutContentV2 {
  if (!settings || typeof settings !== 'object') return { ...EMPTY_ABOUT, blocks: [] }

  const raw = (settings as Record<string, unknown>).about
  if (!raw || typeof raw !== 'object') return { ...EMPTY_ABOUT, blocks: [] }

  const obj = raw as Record<string, unknown>

  // v2 block format
  if (obj.version === 2) {
    const result = aboutContentV2Schema.safeParse(raw)
    if (result.success) return result.data as AboutContentV2
    return { ...EMPTY_ABOUT, blocks: [] }
  }

  // v1 Tiptap doc format — wrap as single text block
  if (obj.type === 'doc') {
    const content = Array.isArray(obj.content) ? obj.content : []
    if (content.length === 0) return { ...EMPTY_ABOUT, blocks: [] }
    return {
      version: 2,
      blocks: [{
        id: crypto.randomUUID(),
        type: 'text',
        data: { content: { type: 'doc', content } },
      }],
    }
  }

  // Legacy structured format — convert to typed blocks
  return convertLegacyToV2(obj)
}

/** Convert old structured about content to v2 block format */
function convertLegacyToV2(legacy: Record<string, unknown>): AboutContentV2 {
  const blocks: AboutBlock[] = []

  // Description → text block
  if (typeof legacy.description === 'string' && legacy.description.trim()) {
    const nodes: TiptapNode[] = []
    nodes.push({
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Course Description' }],
    })
    for (const line of (legacy.description as string).split('\n').filter((l) => l.trim())) {
      nodes.push({ type: 'paragraph', content: [{ type: 'text', text: line }] })
    }
    blocks.push({
      id: crypto.randomUUID(),
      type: 'text',
      data: { content: { type: 'doc', content: nodes } },
    })
  }

  // Learning outcomes → outcomes block
  if (Array.isArray(legacy.learning_outcomes) && legacy.learning_outcomes.length > 0) {
    const outcomes = legacy.learning_outcomes
      .filter((o: unknown) => typeof o === 'string' && o.trim())
      .map((o: string) => ({
        id: crypto.randomUUID(),
        text: o,
        isCore: true,
      }))
    if (outcomes.length > 0) {
      blocks.push({
        id: crypto.randomUUID(),
        type: 'learning-outcomes',
        data: { title: 'Learning Outcomes', outcomes },
      })
    }
  }

  // Syllabus → syllabus block
  if (Array.isArray(legacy.syllabus) && legacy.syllabus.length > 0) {
    const weeks = legacy.syllabus.map((s: Record<string, unknown>, i: number) => ({
      id: crypto.randomUUID(),
      week: Number(s.week) || i + 1,
      topic: String(s.topic || ''),
      description: String(s.description || ''),
      readings: '',
    }))
    blocks.push({
      id: crypto.randomUUID(),
      type: 'syllabus',
      data: { title: 'Weekly Schedule', weeks },
    })
  }

  // Grading → table block
  if (Array.isArray(legacy.grading) && legacy.grading.length > 0) {
    const rows = [
      ['Item', 'Weight'],
      ...legacy.grading.map((g: Record<string, unknown>) => [
        String(g.item || ''),
        `${g.weight || 0}%`,
      ]),
    ]
    blocks.push({
      id: crypto.randomUUID(),
      type: 'table',
      data: { title: 'Grading', hasHeaderRow: true, rows },
    })
  }

  // Contact info → callout block
  const contactParts: string[] = []
  if (typeof legacy.office_hours === 'string' && legacy.office_hours.trim()) {
    contactParts.push(`Office Hours: ${legacy.office_hours}`)
  }
  if (typeof legacy.contact_email === 'string' && legacy.contact_email.trim()) {
    contactParts.push(`Email: ${legacy.contact_email}`)
  }
  if (contactParts.length > 0) {
    blocks.push({
      id: crypto.randomUUID(),
      type: 'callout',
      data: {
        variant: 'info',
        title: 'Office Hours & Contact',
        content: {
          type: 'doc',
          content: contactParts.map((t) => ({
            type: 'paragraph',
            content: [{ type: 'text', text: t }],
          })),
        },
      },
    })
  }

  // Policies → text block
  const policies = legacy.policies as Record<string, unknown> | undefined
  if (policies && typeof policies === 'object') {
    const policyNodes: TiptapNode[] = []
    const entries = [
      { key: 'attendance', label: 'Attendance Policy' },
      { key: 'late_work', label: 'Late Work Policy' },
      { key: 'academic_integrity', label: 'Academic Integrity' },
    ]
    for (const { key, label } of entries) {
      const val = policies[key]
      if (typeof val === 'string' && val.trim()) {
        policyNodes.push({
          type: 'heading',
          attrs: { level: 3 },
          content: [{ type: 'text', text: label }],
        })
        policyNodes.push({ type: 'paragraph', content: [{ type: 'text', text: val }] })
      }
    }
    if (policyNodes.length > 0) {
      blocks.push({
        id: crypto.randomUUID(),
        type: 'text',
        data: { content: { type: 'doc', content: policyNodes } },
      })
    }
  }

  if (blocks.length === 0) return { ...EMPTY_ABOUT, blocks: [] }
  return { version: 2, blocks }
}
