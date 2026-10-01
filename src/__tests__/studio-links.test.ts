import { describe, it, expect } from 'vitest'
import { extractNotebookLinks } from '@/lib/assignments/studio/links'
import { emptyNotebook, type StudioCell, type StudioNotebook } from '@/lib/assignments/studio/notebook-model'

let n = 0
function cell(cell_type: StudioCell['cell_type'], source: string): StudioCell {
  return { id: `c${n++}`, cell_type, source, metadata: {}, outputs: [], execution_count: null }
}
function nb(cells: StudioCell[]): StudioNotebook {
  return { ...emptyNotebook(), cells }
}

describe('extractNotebookLinks', () => {
  it('extracts markdown links with their label', () => {
    expect(extractNotebookLinks(nb([cell('markdown', 'See [Docs](https://example.com/docs) here.')])))
      .toEqual([{ label: 'Docs', url: 'https://example.com/docs' }])
  })

  it('extracts bare URLs and trims trailing punctuation', () => {
    const links = extractNotebookLinks(nb([cell('markdown', 'Visit https://a.com/page, now.')]))
    expect(links[0].url).toBe('https://a.com/page')
  })

  it('dedupes repeats and ignores code cells', () => {
    const links = extractNotebookLinks(nb([
      cell('markdown', '[x](https://x.com) and again [x2](https://x.com)'),
      cell('code', 'requests.get("https://code.com")'),
    ]))
    expect(links).toHaveLength(1)
    expect(links[0].url).toBe('https://x.com')
  })

  it('reflects removal: no links in cells means empty Resources', () => {
    expect(extractNotebookLinks(nb([cell('markdown', 'no links here')]))).toEqual([])
  })
})
