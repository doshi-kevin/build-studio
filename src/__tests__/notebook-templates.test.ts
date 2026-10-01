/**
 * Notebook template presets. Mirrors the verbal-templates coverage: the create action
 * trusts a built-in template's output and persists it WITHOUT re-validating (only the
 * .ipynb upload path runs studioDocSchema). So the schema guard here is the only thing
 * stopping a malformed/oversized preset from being stored — assert every preset builds
 * a doc that passes the same bound checks the upload path enforces.
 */
import { describe, it, expect } from 'vitest'
import { NOTEBOOK_TEMPLATES, getNotebookTemplate } from '@/lib/assignments/studio/notebook-templates'
import { studioDocSchema } from '@/lib/validations/studio'

describe('notebook templates', () => {
  it('exposes Blank, ML and Data Science presets in that order', () => {
    expect(NOTEBOOK_TEMPLATES.map((t) => t.id)).toEqual(['blank', 'ml-assignment', 'data-science'])
  })

  it('every preset builds a notebook that passes studioDocSchema with at least one cell', () => {
    for (const t of NOTEBOOK_TEMPLATES) {
      const notebook = t.build()
      const check = studioDocSchema.safeParse({ version: 1, templateId: t.id, notebook })
      expect(check.success, `${t.id} failed schema`).toBe(true)
      expect(notebook.cells.length, `${t.id} has no cells`).toBeGreaterThan(0)
    }
  })

  it('getNotebookTemplate resolves a known id and returns undefined otherwise', () => {
    expect(getNotebookTemplate('blank')?.id).toBe('blank')
    expect(getNotebookTemplate('nope')).toBeUndefined()
  })
})
