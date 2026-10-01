import { describe, it, expect } from 'vitest'
import {
  MARKETPLACE_TEMPLATES, SUBJECTS,
  filterTemplates, matchesQuery, subjectLabel,
} from '@/lib/assignments/studio/marketplace-catalog'

const SUBJECT_KEYS = new Set(SUBJECTS.map((s) => s.key))

describe('marketplace catalog', () => {
  it('tags every template with a known subject', () => {
    expect(MARKETPLACE_TEMPLATES.length).toBeGreaterThan(0)
    for (const t of MARKETPLACE_TEMPLATES) {
      expect(SUBJECT_KEYS.has(t.subject)).toBe(true)
      expect(t.kind === 'notebook' || t.kind === 'stem').toBe(true)
    }
  })

  it('includes the curated built-ins but excludes the redundant blank STEM scaffold', () => {
    const ids = MARKETPLACE_TEMPLATES.map((t) => t.id)
    expect(ids).toEqual(expect.arrayContaining(['ml-assignment', 'stem-maths', 'stem-biology']))
    expect(ids).not.toContain('stem-blank')
  })

  it('maps STEM subjects to their own categories', () => {
    const maths = MARKETPLACE_TEMPLATES.find((t) => t.id === 'stem-maths')
    expect(maths?.subject).toBe('maths')
    expect(maths?.kind).toBe('stem')
  })
})

describe('filterTemplates', () => {
  it('returns everything for subject "all" with an empty query', () => {
    expect(filterTemplates(MARKETPLACE_TEMPLATES, { subject: 'all', query: '' }))
      .toHaveLength(MARKETPLACE_TEMPLATES.length)
  })

  it('narrows to a single subject', () => {
    const result = filterTemplates(MARKETPLACE_TEMPLATES, { subject: 'physics', query: '' })
    expect(result.length).toBeGreaterThan(0)
    expect(result.every((t) => t.subject === 'physics')).toBe(true)
  })

  it('matches the query against title, description and subject label', () => {
    // "mathematics" is the subject label, not the raw title ("Maths") — still matches.
    const byLabel = filterTemplates(MARKETPLACE_TEMPLATES, { subject: 'all', query: 'mathematics' })
    expect(byLabel.some((t) => t.subject === 'maths')).toBe(true)

    const byTitle = filterTemplates(MARKETPLACE_TEMPLATES, { subject: 'all', query: 'ML Assignment' })
    expect(byTitle.map((t) => t.id)).toContain('ml-assignment')
  })

  it('returns nothing for a non-matching query', () => {
    expect(filterTemplates(MARKETPLACE_TEMPLATES, { subject: 'all', query: 'zzzznope' })).toHaveLength(0)
  })
})

describe('matchesQuery / subjectLabel', () => {
  it('is case-insensitive and trims whitespace', () => {
    expect(matchesQuery(['Data Science'], '  data ')).toBe(true)
    expect(matchesQuery(['Data Science'], 'physics')).toBe(false)
  })

  it('treats an empty query as a match-all', () => {
    expect(matchesQuery([], '')).toBe(true)
  })

  it('resolves subject labels', () => {
    expect(subjectLabel('cs')).toBe('Computer Science')
  })
})
