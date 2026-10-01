// What an Athena answer renders as, for the two things she is told to emit:
// inline course visuals (`asset://…`) and LaTeX math. Both come from a
// non-deterministic model, so the renderer has to hold for the shapes it wrote
// as well as the ones the prompt asked for — an e2e run only samples one turn.
// Citation-chip numbering itself lives in athena-citation-chips.test.tsx.
import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { ChatMessage } from '@/components/student/athena/ChatMessage'

const ITEM = '3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f607'
const DOCS = [{ id: ITEM, title: 'Lecture 5: Sampling', fileType: 'pdf' }]

function answer(content: string) {
  return render(
    <ChatMessage role="assistant" content={content} documents={DOCS} onOpenPreview={vi.fn()} />,
  ).container
}

describe('inline course visuals', () => {
  it('points a well-formed asset ref at the authorized render endpoint', () => {
    const img = answer(`![Sampling grid](asset://${ITEM}:figure:12:0)`).querySelector('img')!
    expect(img.getAttribute('src')).toBe(`/api/extraction/page?item=${ITEM}&asset=figure:12:0`)
    expect(img.getAttribute('alt')).toBe('Sampling grid')
  })

  it('renders the image even when the model forgets the leading "!"', () => {
    // Without this, markdown makes it a link, defaultUrlTransform strips the
    // unknown protocol, and the student gets `href=""` — a click that reloads
    // the page and no visual at all.
    const container = answer(`See [the figure](asset://${ITEM}:figure:12:0).`)
    expect(container.querySelector('img')?.getAttribute('src')).toContain('asset=figure:12:0')
    expect([...container.querySelectorAll('a')].map((a) => a.getAttribute('href'))).not.toContain('')
  })

  it('drops a hallucinated ref rather than showing a broken image', () => {
    const container = answer('Look here.\n\n![Fig](asset://a3)\n\nDone.')
    expect(container.querySelectorAll('img')).toHaveLength(0)
    expect(container.textContent).not.toContain('asset://')
  })

  it('keeps react-markdown internals out of the DOM', () => {
    // The `node` prop is part of every custom renderer's props; spreading it
    // onto the element wrote node="[object Object]" into the markup.
    const container = answer(`![Fig](asset://${ITEM}:figure:1:0)\n\n[docs](https://example.com)`)
    expect(container.querySelector('img')?.hasAttribute('node')).toBe(false)
    expect(container.querySelector('a')?.hasAttribute('node')).toBe(false)
  })
})

describe('math in an answer', () => {
  const katex = (c: HTMLElement) => [...c.querySelectorAll('.katex')]

  it('renders $…$ inline math', () => {
    const container = answer('Nyquist needs $f_s > 2 f_{max}$.')
    expect(katex(container)).toHaveLength(1)
    expect(container.textContent).not.toContain('$f_s')
  })

  it('renders the \\( … \\) delimiters a model reaches for unprompted', () => {
    const container = answer('Then \\(E = mc^2\\) follows.')
    expect(katex(container)).toHaveLength(1)
    expect(container.textContent).not.toContain('\\(')
  })

  it('renders \\[ … \\] as centred display math', () => {
    const container = answer('Therefore:\n\n\\[ H(X) = -\\sum p(x) \\log p(x) \\]')
    expect(container.querySelectorAll('.katex-display')).toHaveLength(1)
  })

  it('renders a one-line $$…$$ as display math, not inline', () => {
    expect(answer('The bound:\n\n$$E = mc^2$$').querySelectorAll('.katex-display')).toHaveLength(1)
  })

  it('leaves two prices in a sentence as prices', () => {
    // Used to render as "40andthelabkitis15": the two dollar signs paired up.
    const container = answer('The textbook is $40 and the lab kit is $15.')
    expect(katex(container)).toHaveLength(0)
    expect(container.textContent).toContain('$40')
    expect(container.textContent).toContain('$15')
  })

  it('renders math and a citation chip in the same sentence', () => {
    const container = answer('Since $f_s > 2f_{max}$ [Lecture 5: Sampling, page 23], no aliasing.')
    expect(katex(container)).toHaveLength(1)
    expect(container.querySelectorAll('button.athena-cite')).toHaveLength(1)
  })

  it('keeps the rest of an answer when a formula is malformed', () => {
    const container = answer('Broken $\\frac{1}{$ but the words still show.')
    expect(container.textContent).toContain('the words still show')
  })
})

/* balanceStreamingBlocks arrived from main wired to the tutor this branch
   retired, so nothing rendered it any more — its own tests pass either way,
   which is exactly why the wiring needs a test of its own. */
describe('a half-arrived formula', () => {
  const arriving = (content: string) =>
    render(
      <ChatMessage role="assistant" content={content} documents={DOCS} onOpenPreview={vi.fn()} streaming />,
    ).container

  it('is withheld while the answer is still streaming', () => {
    const container = arriving('Bayes says:\n\n$$P(A \\mid B) = \\frac{P(B')
    expect(container.textContent).toContain('Bayes says')
    expect(container.textContent).not.toContain('\\mid')
    expect(container.textContent).not.toContain('$$')
  })

  it('is rendered, not withheld, once the turn has settled', () => {
    // The same withholding on a finished message would delete real content —
    // prose using "$$" as a separator loses everything after it.
    const container = answer('The cost model uses $$ as a separator.\n\nAnd the rest matters.')
    expect(container.textContent).toContain('And the rest matters')
  })
})
