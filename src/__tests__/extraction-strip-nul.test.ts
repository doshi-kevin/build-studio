// Guards the NUL-sanitiser that keeps extraction results writable to jsonb.
// A single U+0000 in extracted PDF text makes Postgres reject the whole
// `content` UPDATE ("null character not permitted"); before this the failure
// was swallowed and the item sat at 'processing' forever. Pattern 4 (pure logic).

import { describe, it, expect } from 'vitest'
import { stripNul } from '@/lib/extraction/sanitize'

const NUL = '\u0000'

describe('stripNul', () => {
  it('removes NUL bytes from a plain string', () => {
    expect(stripNul(`a${NUL}b${NUL}c`)).toBe('abc')
  })

  it('leaves NUL-free strings (and other whitespace) untouched', () => {
    expect(stripNul('logistic regression\tGD\n')).toBe('logistic regression\tGD\n')
  })

  it('strips NULs deep inside nested arrays and objects', () => {
    const input = {
      status: 'completed',
      pages: [
        { pageNumber: 1, text: `intro${NUL} text`, headings: [`h${NUL}1`] },
        { pageNumber: 2, text: 'clean' },
      ],
      metadata: { pageCount: 2 },
    }
    const out = stripNul(input)
    expect(out.pages[0]?.text).toBe('intro text')
    expect(out.pages[0]?.headings?.[0]).toBe('h1')
    expect(out.pages[1]?.text).toBe('clean')
    // non-string values are preserved
    expect(out.metadata.pageCount).toBe(2)
    expect(out.pages[0]?.pageNumber).toBe(1)
  })

  it('preserves null / number / boolean values as-is', () => {
    const input = { a: null, b: 0, c: false, d: `x${NUL}` }
    expect(stripNul(input)).toEqual({ a: null, b: 0, c: false, d: 'x' })
  })
})
