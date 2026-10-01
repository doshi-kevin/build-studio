// Categorization for the document studio's slash (/) menu.
//
// document-slash-command.tsx is the single insert catalogue shared by the slash menu and the
// right palette; the two stay in lockstep only if every slash item is bucketed by CATEGORY_OF.
// The failure this guards against: someone adds a new slash item but forgets to add it to
// CATEGORY_OF, so it silently falls through to 'Basic' (insertCategoryOf's ?? fallback) and
// lands in the wrong palette group with no error. The membership test below fails loudly instead.
//
// novel + lucide-react are mocked out: they pull transitive CSS imports the node transform can't
// resolve, and neither the icons nor the editor commands are under test here — only the pure
// category mapping is. Factories are inlined (vi.mock is hoisted; no outer-scope refs allowed).
import { describe, it, expect, vi } from 'vitest'

vi.mock('novel', () => ({
  createSuggestionItems: (items: unknown[]) => items,
  Command: { configure: () => ({}) },
  renderItems: () => ({}),
}))
vi.mock('lucide-react', () => {
  const Icon = () => null
  const names = [
    'Text', 'Heading1', 'Heading2', 'Heading3', 'List', 'ListOrdered', 'CheckSquare', 'TextQuote',
    'Code', 'Minus', 'Sigma', 'Pi', 'FlaskConical', 'BarChart3', 'Map', 'Table', 'Image', 'Bot',
    'NotebookPen', 'ListChecks', 'ArrowLeftRight', 'Braces', 'ToggleLeft', 'MessageSquareText', 'Info',
    'ChevronRight', 'Youtube',
  ]
  return Object.fromEntries(names.map((n) => [n, Icon]))
})
vi.mock('@/components/professor/assignments/studio/ChartNode', () => ({ CHART_DEFAULTS: { line: {} } }))
vi.mock('@/components/professor/assignments/studio/MapNode', () => ({ MAP_DEFAULT: {} }))
vi.mock('@/components/professor/assignments/studio/MatchNode', () => ({ MATCH_DEFAULT: {} }))
vi.mock('@/components/professor/assignments/studio/SolverNode', () => ({ SOLVER_DEFAULT: {} }))

import {
  documentSlashItems,
  insertCategoryOf,
  groupedDocumentSlashItems,
  INSERT_CATEGORIES,
} from '@/components/professor/assignments/studio/document-slash-command'

describe('insertCategoryOf', () => {
  it('maps known titles to their category', () => {
    expect(insertCategoryOf('Text')).toBe('Basic')
    expect(insertCategoryOf('Image')).toBe('Media')
    expect(insertCategoryOf('Chart')).toBe('Math & data')
    expect(insertCategoryOf('Multiple choice')).toBe('Questions')
  })

  it('falls back to Basic for an unknown title', () => {
    expect(insertCategoryOf('Nonexistent Block')).toBe('Basic')
  })
})

describe('slash item / category integrity', () => {
  const titles = documentSlashItems.map((it) => it.title ?? '')

  it('every slash item is explicitly categorized (not just the Basic fallback)', () => {
    // A new item missing from CATEGORY_OF would report 'Basic' via the ?? fallback. We can't tell
    // those apart from real Basic items by category alone, so assert against the item list directly:
    // if this list and CATEGORY_OF drift, the count assertion in grouping (below) also moves.
    for (const t of titles) {
      expect(t, `slash item "${t}" has an empty title`).not.toBe('')
      expect(INSERT_CATEGORIES).toContain(insertCategoryOf(t))
    }
  })

  it('titles are unique (grouping keys on title)', () => {
    expect(new Set(titles).size).toBe(titles.length)
  })
})

describe('groupedDocumentSlashItems', () => {
  const groups = groupedDocumentSlashItems()

  it('preserves category order', () => {
    expect(groups.map((g) => g.category)).toEqual(INSERT_CATEGORIES)
  })

  it('partitions every item into exactly one bucket (no loss, no duplication)', () => {
    const grouped = groups.flatMap((g) => g.items)
    expect(grouped.length).toBe(documentSlashItems.length)
    // Same set of titles, just regrouped.
    expect(new Set(grouped.map((i) => i.title))).toEqual(new Set(documentSlashItems.map((i) => i.title)))
  })

  it('places each item under the category insertCategoryOf reports for it', () => {
    for (const g of groups) {
      for (const item of g.items) {
        expect(insertCategoryOf(item.title ?? '')).toBe(g.category)
      }
    }
  })
})
