// @vitest-environment node
//
// `.txt` is an accepted lecture upload that no extractor handled, so the file
// was stored and then ignored: no text, no topics, no reference rail, nothing
// in the retrieval index. The whole rest of the pipeline is built around a page
// number, so the job of this extractor is to invent sensible pages without
// splitting a sentence down the middle.
import { describe, it, expect } from 'vitest'
import { extractPlainText } from '@/lib/document-parser/plain-text'

const buf = (s: string) => Buffer.from(s, 'utf8')

describe('extractPlainText', () => {
  it('reads a short file as one page', () => {
    const out = extractPlainText(buf('Gradient clipping bounds the update norm.'))

    expect(out.status).toBe('completed')
    expect(out.pages).toHaveLength(1)
    expect(out.pages[0].text).toContain('Gradient clipping')
    expect(out.pages[0].pageNumber).toBe(1)
  })

  it('titles each page with its first line, for the citation breadcrumb', () => {
    const out = extractPlainText(buf('Week 3 notes\n\nN-gram models estimate the next word.'))
    expect(out.pages[0].headings).toEqual(['Week 3 notes'])
  })

  it('breaks pages between paragraphs, never mid-sentence', () => {
    // Two paragraphs that cannot share a page: the split must fall on the
    // blank line, so neither page starts or ends part-way through a thought.
    const a = 'A'.repeat(3_000)
    const b = 'B'.repeat(3_000)
    const out = extractPlainText(buf(`${a}\n\n${b}`))

    expect(out.pages).toHaveLength(2)
    expect(out.pages[0].text).toBe(a)
    expect(out.pages[1].text).toBe(b)
  })

  it('hard-splits a single paragraph too long to fit', () => {
    const out = extractPlainText(buf('X'.repeat(10_000)))

    expect(out.pages.length).toBeGreaterThan(1)
    // No page may exceed the embedder's input window, or it is truncated
    // silently on the way into a vector.
    for (const p of out.pages) expect(p.text.length).toBeLessThanOrEqual(4_000)
  })

  it('counts words for the metadata the UI shows', () => {
    const out = extractPlainText(buf('one two three four five'))
    expect(out.metadata.wordCount).toBe(5)
    expect(out.metadata.pageCount).toBe(1)
  })

  it('completes with no pages on an empty file rather than failing', () => {
    // An empty notes file is a real thing a professor uploads; it is not an
    // extraction failure, and marking it failed would show them an error.
    const out = extractPlainText(buf('   \n\n  '))
    expect(out.status).toBe('completed')
    expect(out.pages).toEqual([])
  })

  it('strips NUL bytes, which Postgres refuses in jsonb', () => {
    const out = extractPlainText(buf('before\u0000after'))
    expect(out.pages[0].text).toBe('beforeafter')
  })

  it('normalises Windows line endings', () => {
    const out = extractPlainText(buf('line one\r\nline two'))
    expect(out.pages[0].text).not.toContain('\r')
  })
})
