// Pilot #25: streamed answers showed raw "$$P(A \mid B)$$" / "```python" markup
// while the closing delimiter was still in flight. These pin the balancing that
// makes a half-arrived block render AS a block.
import { describe, it, expect } from 'vitest'
import { balanceStreamingBlocks } from '@/lib/ai/streaming-blocks'

describe('balanceStreamingBlocks', () => {
  it('leaves complete text untouched (idempotent, so callers need no isStreaming flag)', () => {
    const complete = 'Bayes says $$P(A \\mid B) = \\frac{P(B \\mid A)P(A)}{P(B)}$$ which means…'
    expect(balanceStreamingBlocks(complete)).toBe(complete)
    expect(balanceStreamingBlocks(balanceStreamingBlocks(complete))).toBe(complete)
  })

  it('WITHHOLDS a display-maths block that is still streaming', () => {
    /* Not closed: KaTeX renders invalid LaTeX as its source in RED, so closing a
       half-written formula swaps a grey markup flash for a red error flash. Showing
       nothing for the ~150ms until the closer lands is the lesser evil. */
    expect(balanceStreamingBlocks('Bayes says $$P(A \\mid B')).toBe('Bayes says')
  })

  it('closes a code fence that is still streaming', () => {
    expect(balanceStreamingBlocks('```python\ndef f(x):')).toBe('```python\ndef f(x):\n```')
  })

  it('withholds an unterminated \\[ display block too', () => {
    expect(balanceStreamingBlocks('so \\[x^2 + y^2')).toBe('so')
  })

  it('treats maths delimiters inside an open code fence as literal', () => {
    // the $$ here belongs to the code sample, so the fence is what needs closing
    const partial = '```text\ncost is $$5 and $$'
    expect(balanceStreamingBlocks(partial)).toBe(partial + '\n```')
  })

  it('does not touch a lone dollar sign in prose', () => {
    // currency, not maths — guessing here would corrupt ordinary sentences
    const prose = 'The textbook costs $40 and the reader costs $12.'
    expect(balanceStreamingBlocks(prose)).toBe(prose)
  })

  it('keeps completed blocks and withholds only the open one', () => {
    const t = '$$a$$ then ```js\nx\n``` and finally $$b'
    expect(balanceStreamingBlocks(t)).toBe('$$a$$ then ```js\nx\n``` and finally')
  })

  it('is safe on empty and delimiter-only input', () => {
    expect(balanceStreamingBlocks('')).toBe('')
    // a bare opener withholds down to nothing rather than emitting empty maths
    expect(balanceStreamingBlocks('$$')).toBe('')
  })

  it('still CLOSES an open code fence — partial code renders fine as text', () => {
    // the asymmetry with maths is the point: a <pre> grows line by line, KaTeX errors
    expect(balanceStreamingBlocks('```python\ndef f(x):\n  return')).toBe(
      '```python\ndef f(x):\n  return\n```',
    )
  })
})

/* Why the caller must gate this on "still streaming". Withholding is lossy by
   design, so on a SETTLED message an innocent odd `$$` in prose would silently eat
   the rest of the answer. These document that the loss is real — the protection
   lives at the call site (AthenaChat passes `streaming` only for the message
   currently arriving), not in here. */
describe('balanceStreamingBlocks — lossy by design, hence the call-site gate', () => {
  it('drops everything after an unmatched $$ in ordinary prose', () => {
    const prose = 'The cost model uses $$ as a separator.\n\nAnd here is the rest of the explanation that matters.'
    const out = balanceStreamingBlocks(prose)
    expect(out).toBe('The cost model uses')
    expect(out.length).toBeLessThan(prose.length / 2)
  })

  it('is only safe to apply to balanced text', () => {
    const balanced = 'Two blocks: $$a$$ and $$b$$ — both closed.'
    expect(balanceStreamingBlocks(balanced)).toBe(balanced)
  })
})
