/**
 * Template history: turn a professor's authored assignments into reusable "templates" shown under
 * the sub-template picker. No dedicated templates table — a past assignment IS the template, and
 * cloning it seeds a fresh draft. Rows are classified into the STEM vs plain-notebook groups so
 * each picker only shows its own history.
 */
import { NOTEBOOK_TEMPLATES, STEM_TEMPLATES } from './notebook-templates'

export const STEM_TEMPLATE_IDS = new Set(STEM_TEMPLATES.map((t) => t.id))
const TITLE_BY_ID = new Map([...NOTEBOOK_TEMPLATES, ...STEM_TEMPLATES].map((t) => [t.id, t.title]))

export interface TemplateHistoryItem {
  id: string
  title: string
  /** The template/subject it was built from, e.g. "Physics" or "Data Science". */
  subtitle: string
  createdAt: string
}

interface AssignmentRow {
  id: string
  title: string
  settings: unknown
  created_at: string
}

/** Derive a human-readable type label from settings for the main chooser. */
function typeLabel(settings: { kind?: string; studio?: { templateId?: string }; verbalAssessment?: unknown }): string {
  if (settings.kind === 'verbal' || settings.verbalAssessment) return 'Verbal'
  if (settings.kind === 'document') return 'Document'
  if (settings.kind === 'notebook') {
    const tid = settings.studio?.templateId
    return tid && STEM_TEMPLATE_IDS.has(tid) ? 'STEM' : 'Notebook'
  }
  return 'File Upload'
}

/** All authored assignments flattened into history items for the main entry page. */
export function toAllTemplateHistory(rows: AssignmentRow[], limit = 6): TemplateHistoryItem[] {
  return rows.slice(0, limit).map((row) => {
    const settings = (row.settings ?? {}) as { kind?: string; studio?: { templateId?: string }; verbalAssessment?: unknown }
    return {
      id: row.id,
      title: row.title,
      subtitle: typeLabel(settings),
      createdAt: row.created_at,
    }
  })
}

/** Map authored assignment rows to the history for one picker group. */
export function toTemplateHistory(rows: AssignmentRow[], group: 'stem' | 'notebook' | 'verbal', limit = 8): TemplateHistoryItem[] {
  const items: TemplateHistoryItem[] = []
  for (const row of rows) {
    const settings = (row.settings ?? {}) as {
      kind?: string
      studio?: { templateId?: string }
      verbalAssessment?: { topic?: string }
    }
    if (group === 'verbal') {
      const isVerbal = settings.kind === 'verbal' || !!settings.verbalAssessment
      if (!isVerbal) continue
      items.push({
        id: row.id,
        title: row.title,
        subtitle: settings.verbalAssessment?.topic?.trim() || 'Verbal assessment',
        createdAt: row.created_at,
      })
    } else {
      if (settings.kind !== 'notebook') continue
      const templateId = settings.studio?.templateId
      const isStem = templateId ? STEM_TEMPLATE_IDS.has(templateId) : false
      if ((group === 'stem') !== isStem) continue
      items.push({
        id: row.id,
        title: row.title,
        subtitle: (templateId && TITLE_BY_ID.get(templateId)) || 'Notebook',
        createdAt: row.created_at,
      })
    }
    if (items.length >= limit) break
  }
  return items
}
