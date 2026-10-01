// normalizeMathDelimiters is the guard between what an LLM writes and what
// remark-math understands. Both directions matter: math the model wrote in the
// wrong delimiters must start rendering, and text that only LOOKS like math
// (two prices in a sentence) must stop being rendered as math.
import { describe, it, expect } from 'vitest'
import { normalizeMathDelimiters } from '@/lib/markdown/math'

describe('normalizeMathDelimiters', () => {
  it('converts \\( … \\) into inline dollars', () => {
    expect(normalizeMathDelimiters('Then \\(E = mc^2\\) follows.')).toBe('Then $E = mc^2$ follows.')
  })

  it('converts \\[ … \\] into a display block on its own lines', () => {
    // remark-math only renders display math when the fence owns its lines.
    expect(normalizeMathDelimiters('Result:\n\\[ x = 1 \\]')).toContain('$$\nx = 1\n$$')
  })

  it('leaves escaped brackets that are not math alone', () => {
    // `\[1\]` is how markdown prose shows a literal "[1]" — converting it would
    // turn a footnote marker into a formula.
    expect(normalizeMathDelimiters('See note \\[1\\] below.')).toBe('See note \\[1\\] below.')
  })

  it('puts a one-line $$…$$ onto its own lines so it renders as display', () => {
    expect(normalizeMathDelimiters('$$E = mc^2$$')).toBe('$$\nE = mc^2\n$$')
  })

  it('escapes two dollar amounts in a sentence instead of pairing them as math', () => {
    expect(normalizeMathDelimiters('The textbook is $40 and the kit is $15.')).toBe(
      'The textbook is \\$40 and the kit is \\$15.',
    )
  })

  it('leaves real inline math alone, including math that opens with a digit', () => {
    expect(normalizeMathDelimiters('Sample above $2 f_{max}$ to be safe.')).toBe(
      'Sample above $2 f_{max}$ to be safe.',
    )
  })

  it('keeps padded math that carries a LaTeX signal', () => {
    // "$ \frac{a}{b} $" is unambiguously math despite the padding; escaping it
    // would replace a formula with literal dollar signs.
    expect(normalizeMathDelimiters('Take $ \\frac{a}{b} $ next.')).toBe('Take $ \\frac{a}{b} $ next.')
  })

  it('does not touch dollars or delimiters inside code', () => {
    const src = 'Write `$40` or:\n\n```\nprice = $40 and $15\n\\(x\\)\n```\n'
    expect(normalizeMathDelimiters(src)).toBe(src)
  })

  it('leaves an already-escaped dollar as it is', () => {
    expect(normalizeMathDelimiters('It costs \\$40 total.')).toBe('It costs \\$40 total.')
  })

  it('escapes a lone unpaired dollar', () => {
    expect(normalizeMathDelimiters('Around $40.')).toBe('Around \\$40.')
  })

  it('returns text with no math markers untouched', () => {
    expect(normalizeMathDelimiters('Plain sentence, nothing to do.')).toBe('Plain sentence, nothing to do.')
  })
})
