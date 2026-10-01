/**
 * Tests for the shared Modules display logic.
 *
 * These assert the decisions the redesign actually depends on: that colour
 * only ever means "what kind of material is this", that the row shows a time
 * estimate instead of extraction telemetry, that extraction state appears
 * only when the professor can act on it, and that a collapsed section can
 * describe its own contents.
 */

import { describe, it, expect } from 'vitest'
import {
  itemFileType,
  itemVisual,
  itemTimeEstimate,
  itemExtractionDisplay,
  sectionContentsSummary,
  itemMatches,
  isFiltering,
  toDownloadUrl,
  safeExternalUrl,
} from '@/components/shared/modules/module-item-display'

describe('itemFileType', () => {
  it('uses the declared lecture fileType', () => {
    expect(itemFileType('lecture', { fileType: 'pdf' })).toBe('pdf')
    expect(itemFileType('lecture', { fileType: 'ppt' })).toBe('ppt')
    expect(itemFileType('lecture', { fileType: 'xlsx' })).toBe('doc')
  })

  it('falls back to the filename extension when fileType is missing', () => {
    expect(itemFileType('lecture', { fileName: 'week3.pptx' })).toBe('ppt')
    expect(itemFileType('lecture', { fileName: 'syllabus.PDF' })).toBe('pdf')
  })

  it('resolves to neutral grey for items that are not files', () => {
    expect(itemFileType('note', { body: 'hello' })).toBe('other')
    expect(itemFileType('link', { url: 'https://example.com' })).toBe('other')
    expect(itemFileType('assignment', { points: 10 })).toBe('other')
  })

  it('survives a content blob with none of the expected keys', () => {
    expect(itemFileType('lecture', {})).toBe('other')
    expect(itemFileType('lecture', { fileType: 42, fileName: null })).toBe('other')
  })
})

describe('itemVisual', () => {
  it('gives each material type a distinct tint so a long list is scannable', () => {
    const pdf = itemVisual('lecture', { fileType: 'pdf' })
    const deck = itemVisual('lecture', { fileType: 'ppt' })
    const video = itemVisual('video', {})
    expect(new Set([pdf.chip, deck.chip, video.chip]).size).toBe(3)
  })

  it('keeps non-file items on the neutral chip, so colour only marks materials', () => {
    expect(itemVisual('note', {}).chip).toBe(itemVisual('link', {}).chip)
    expect(itemVisual('note', {}).chip).toContain('bg-muted')
  })

  it('uses the item-type glyph for non-files and the format glyph for files', () => {
    expect(itemVisual('note', {}).Icon).not.toBe(itemVisual('lecture', { fileType: 'pdf' }).Icon)
    expect(itemVisual('link', {}).Icon).not.toBe(itemVisual('note', {}).Icon)
  })

  it('emits only semantic token classes, never raw Tailwind colours', () => {
    for (const type of ['lecture', 'video', 'note', 'link'] as const) {
      expect(itemVisual(type, { fileType: 'pdf' }).chip).not.toMatch(
        /\b(?:gray|slate|blue|emerald|amber|rose|zinc)-\d{2,3}\b/,
      )
    }
  })
})

describe('itemTimeEstimate', () => {
  it('reports video length in minutes', () => {
    expect(itemTimeEstimate('video', { duration: 18 })).toBe('18 min')
  })

  it('reports page count from the extraction metadata', () => {
    const content = { extraction: { metadata: { pageCount: 158 } } }
    expect(itemTimeEstimate('lecture', content)).toBe('158 pages')
  })

  it('singularises a one-page document', () => {
    expect(itemTimeEstimate('lecture', { extraction: { metadata: { pageCount: 1 } } })).toBe('1 page')
  })

  it('returns null rather than guessing when nothing is known', () => {
    expect(itemTimeEstimate('lecture', {})).toBeNull()
    expect(itemTimeEstimate('lecture', { extraction: { metadata: { pageCount: 0 } } })).toBeNull()
    expect(itemTimeEstimate('video', { duration: null })).toBeNull()
    expect(itemTimeEstimate('note', { body: 'x' })).toBeNull()
  })
})

describe('itemExtractionDisplay', () => {
  it('shows nothing for a completed extraction — the page count is the useful output', () => {
    const content = { extraction: { status: 'completed', metadata: { pageCount: 12, imageCount: 26 } } }
    expect(itemExtractionDisplay('lecture', content)).toBeNull()
  })

  it('surfaces only the states a professor can act on', () => {
    expect(itemExtractionDisplay('lecture', { extraction: { status: 'processing' } })).toBe('processing')
    expect(itemExtractionDisplay('lecture', { extraction: { status: 'failed' } })).toBe('failed')
    expect(itemExtractionDisplay('lecture', { extraction: { status: 'partial' } })).toBe('failed')
  })

  it('never applies to non-lecture items or items that were never extracted', () => {
    expect(itemExtractionDisplay('video', { extraction: { status: 'failed' } })).toBeNull()
    expect(itemExtractionDisplay('lecture', {})).toBeNull()
  })
})

describe('sectionContentsSummary', () => {
  const item = (item_type: string, content: unknown = {}) => ({ item_type, content })

  it('describes a mixed section so it can stay collapsed', () => {
    const items = [
      item('lecture', { fileType: 'pdf' }),
      item('lecture', { fileType: 'pdf' }),
      item('lecture', { fileType: 'ppt' }),
      item('video', {}),
    ]
    expect(sectionContentsSummary(items)).toBe('2 readings, 1 deck, 1 video')
  })

  it('excludes dividers, which are structure rather than content', () => {
    expect(sectionContentsSummary([item('section_divider', { label: 'Part 2' }), item('note')])).toBe('1 note')
  })

  it('returns an empty string for a section with nothing in it', () => {
    expect(sectionContentsSummary([])).toBe('')
    expect(sectionContentsSummary([item('section_divider')])).toBe('')
  })

  it('orders buckets consistently regardless of item order', () => {
    const a = sectionContentsSummary([item('video'), item('lecture', { fileType: 'pdf' })])
    const b = sectionContentsSummary([item('lecture', { fileType: 'pdf' }), item('video')])
    expect(a).toBe(b)
    expect(a).toBe('1 reading, 1 video')
  })
})

describe('itemMatches', () => {
  const lecture = {
    item_type: 'lecture',
    title: 'Attention For RNN',
    description: 'Self-attention basics',
    content: { fileType: 'pdf', fileName: 'lecture10.pdf' },
  }

  it('matches on title, description and filename', () => {
    expect(itemMatches(lecture, 'attention', 'all')).toBe(true)
    expect(itemMatches(lecture, 'basics', 'all')).toBe(true)
    expect(itemMatches(lecture, 'lecture10', 'all')).toBe(true)
  })

  it('is case-insensitive and ignores surrounding whitespace', () => {
    expect(itemMatches(lecture, '  ATTENTION  ', 'all')).toBe(true)
  })

  it('rejects a non-match', () => {
    expect(itemMatches(lecture, 'kubernetes', 'all')).toBe(false)
  })

  it('applies the type facet', () => {
    expect(itemMatches(lecture, '', 'reading')).toBe(true)
    expect(itemMatches(lecture, '', 'video')).toBe(false)
    expect(itemMatches({ ...lecture, content: { fileType: 'ppt' } }, '', 'deck')).toBe(true)
  })

  it('never matches a divider — it is structure, not a result', () => {
    const divider = { item_type: 'section_divider', title: '', description: '', content: { label: 'Part 2' } }
    expect(itemMatches(divider, '', 'all')).toBe(false)
    expect(itemMatches(divider, 'part', 'all')).toBe(false)
  })

  it('an empty query with the all facet keeps everything', () => {
    expect(itemMatches(lecture, '', 'all')).toBe(true)
  })
})

describe('safeExternalUrl', () => {
  it('lets ordinary http(s) links through untouched', () => {
    expect(safeExternalUrl('https://arxiv.org/abs/1706.03762')).toBe('https://arxiv.org/abs/1706.03762')
    expect(safeExternalUrl('http://example.edu/notes.pdf')).toBe('http://example.edu/notes.pdf')
  })

  it('blocks script-bearing schemes — content JSONB is professor-supplied and unvalidated', () => {
    expect(safeExternalUrl('javascript:alert(document.cookie)')).toBeUndefined()
    expect(safeExternalUrl('JaVaScRiPt:alert(1)')).toBeUndefined()
    expect(safeExternalUrl('data:text/html,<script>alert(1)</script>')).toBeUndefined()
    expect(safeExternalUrl('vbscript:msgbox(1)')).toBeUndefined()
  })

  it('treats an unparseable or empty value as absent', () => {
    expect(safeExternalUrl(undefined)).toBeUndefined()
    expect(safeExternalUrl('')).toBeUndefined()
  })
})

describe('toDownloadUrl', () => {
  const signed = 'https://x.supabase.co/storage/v1/object/sign/course-materials/a/b.pdf?token=abc'

  it('asks the storage layer for an attachment, so the browser saves instead of rendering', () => {
    // Without this the cross-origin `download` attribute is ignored and the PDF
    // just opens in a new tab.
    expect(toDownloadUrl(signed, 'lecture 10.pdf')).toBe(`${signed}&download=lecture%2010.pdf`)
  })

  it('keeps the existing query string intact', () => {
    expect(toDownloadUrl(signed, 'a.pdf')).toContain('token=abc')
  })

  it('starts a query string when the url has none', () => {
    expect(toDownloadUrl('https://x/f.pdf', 'f.pdf')).toBe('https://x/f.pdf?download=f.pdf')
  })

  it('escapes characters that would otherwise break the query string', () => {
    expect(toDownloadUrl(signed, 'a&b?c.pdf')).toContain('download=a%26b%3Fc.pdf')
  })
})

describe('isFiltering', () => {
  it('is false only when nothing is narrowing the list', () => {
    expect(isFiltering('', 'all')).toBe(false)
    expect(isFiltering('   ', 'all')).toBe(false)
    expect(isFiltering('rnn', 'all')).toBe(true)
    expect(isFiltering('', 'video')).toBe(true)
  })
})
