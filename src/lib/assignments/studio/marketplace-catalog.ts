/**
 * Marketplace catalog: the built-in, ready-made templates surfaced in the Template
 * Marketplace, each tagged with a subject so the modal can group them. Reuses the scaffolds
 * defined in ./notebook-templates for id/title/description — this file only adds the subject
 * taxonomy and the filter helpers. Pure + server-safe (no React/lucide), like notebook-templates.
 */
import { NOTEBOOK_TEMPLATES, STEM_TEMPLATES } from './notebook-templates'

export type Subject = 'cs' | 'maths' | 'physics' | 'chemistry' | 'biology'

/** Ordered subject categories shown in the marketplace rail. */
export const SUBJECTS: { key: Subject; label: string }[] = [
  { key: 'cs', label: 'Computer Science' },
  { key: 'maths', label: 'Mathematics' },
  { key: 'physics', label: 'Physics' },
  { key: 'chemistry', label: 'Chemistry' },
  { key: 'biology', label: 'Biology' },
]

/** Default number of question blocks seeded for a STEM template (mirrors StemCompose). */
export const DEFAULT_STEM_QUESTIONS = 3

/**
 * Built-in template id → subject. Ids absent here are hidden from the marketplace on
 * purpose (e.g. 'stem-blank' — redundant with picking a subject and clearing its questions).
 */
const SUBJECT_BY_ID: Record<string, Subject> = {
  blank: 'cs',
  'ml-assignment': 'cs',
  'data-science': 'cs',
  'stem-maths': 'maths',
  'stem-physics': 'physics',
  'stem-chemistry': 'chemistry',
  'stem-biology': 'biology',
}

export interface MarketplaceTemplate {
  id: string
  title: string
  description: string
  kind: 'notebook' | 'stem'
  subject: Subject
  /**
   * Optional path to a preview screenshot (relative to /public).
   * When set, TemplateMarketplace renders it in the card's thumb strip.
   * When absent, the faux-preview bars are shown as the fallback.
   * See public/template-previews/README.md for naming conventions.
   */
  previewSrc?: string
}

/** All built-in templates that appear in the marketplace, derived from the scaffolds. */
export const MARKETPLACE_TEMPLATES: MarketplaceTemplate[] = [
  ...NOTEBOOK_TEMPLATES.map((t) => ({ t, kind: 'notebook' as const })),
  ...STEM_TEMPLATES.map((t) => ({ t, kind: 'stem' as const })),
]
  .filter(({ t }) => t.id in SUBJECT_BY_ID)
  .map(({ t, kind }) => ({
    id: t.id,
    title: t.title,
    description: t.description,
    kind,
    subject: SUBJECT_BY_ID[t.id],
  }))

export function subjectLabel(key: Subject): string {
  return SUBJECTS.find((s) => s.key === key)?.label ?? key
}

/** Case-insensitive, whitespace-trimmed substring match against any of the given fields. */
export function matchesQuery(haystack: string[], query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return haystack.some((h) => h.toLowerCase().includes(q))
}

/** Filter built-in templates by subject ('all' keeps every subject) and a search query. */
export function filterTemplates(
  items: MarketplaceTemplate[],
  { subject, query }: { subject: Subject | 'all'; query: string },
): MarketplaceTemplate[] {
  return items.filter(
    (t) =>
      (subject === 'all' || t.subject === subject) &&
      matchesQuery([t.title, t.description, subjectLabel(t.subject)], query),
  )
}
