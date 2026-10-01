// Athena chat citation rendering: the half of multi-page citation support that
// lives in the component (parseCitations itself is covered in citation.test.ts).
//
// Worth testing directly because the model's output is non-deterministic — an
// e2e run only exercises the multi-page path if the model happens to emit
// "[Deck, page 44, 51]" that turn. The mapping from the Nth chip to the right
// page is the part that would silently break: an off-by-one there sends the
// reader to the wrong page with no visible symptom.
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ChatMessage } from '@/components/student/athena/ChatMessage'

const DOCS = [{ id: 'd1', title: 'Lecture 2: Language Modeling', fileType: 'pdf' }]

/** Inline prose chips only — the Sources list uses a <span>, and its rows are
 *  unmounted while the disclosure is collapsed. */
const chips = (c: HTMLElement) => [...c.querySelectorAll('button.athena-cite')]

describe('ChatMessage citation chips', () => {
  it('expands a multi-page citation into one chip per page', () => {
    const { container } = render(
      <ChatMessage
        role="assistant"
        content="Smoothing steals probability mass [Lecture 2: Language Modeling, page 44, 51]."
        documents={DOCS}
        onOpenPreview={() => {}}
      />,
    )
    expect(chips(container).map((b) => b.textContent)).toEqual(['1', '2'])
    // The raw marker must be gone from the prose, not merely supplemented.
    expect(container.textContent).not.toContain('page 44')
    // Two pages of ONE lecture is one source — the trigger must not read "2 sources".
    expect(screen.getByRole('button', { name: '1 source · 2 pages' })).toBeInTheDocument()
  })

  it('maps each chip to its own page', () => {
    const onOpenPreview = vi.fn()
    const { container } = render(
      <ChatMessage
        role="assistant"
        content="See [Lecture 2: Language Modeling, page 44, 51]."
        documents={DOCS}
        onOpenPreview={onOpenPreview}
      />,
    )
    const [first, second] = chips(container)
    fireEvent.click(first)
    fireEvent.click(second)
    expect(onOpenPreview.mock.calls.map((c) => c[0].page)).toEqual([44, 51])
    expect(onOpenPreview.mock.calls.every((c) => c[0].itemId === 'd1')).toBe(true)
  })

  it('reuses a page number when the same page is cited again later', () => {
    // The off-by-one this file exists to catch is cross-marker: numbering is
    // keyed by title#page globally, so page 7 stays "2" in the second marker.
    // Per-marker numbering would give 1,2,1,1 — chips pointing at wrong pages.
    const onOpenPreview = vi.fn()
    const { container } = render(
      <ChatMessage
        role="assistant"
        content="a [Lecture 2: Language Modeling, pages 3, 7]. b [Lecture 2: Language Modeling, page 7]. c [Lecture 2: Language Modeling, page 2]."
        documents={DOCS}
        onOpenPreview={onOpenPreview}
      />,
    )
    const all = chips(container)
    expect(all.map((b) => b.textContent)).toEqual(['1', '2', '2', '3'])
    fireEvent.click(all[2]) // the re-cited page 7
    expect(onOpenPreview.mock.calls[0][0].page).toBe(7)
    expect(screen.getByRole('button', { name: '1 source · 3 pages' })).toBeInTheDocument()
  })

  it('counts documents, not citations, in the disclosure label', () => {
    // The one case that distinguishes the two counts: pages spread over two docs.
    render(
      <ChatMessage
        role="assistant"
        content="a [Lecture 2: Language Modeling, pages 3, 7]. b [Lecture 1: Introduction, page 4]."
        documents={[...DOCS, { id: 'd2', title: 'Lecture 1: Introduction', fileType: 'pdf' }]}
        onOpenPreview={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: '2 sources · 3 pages' })).toBeInTheDocument()
  })

  it('renders a page cited twice in one marker as a single chip', () => {
    // "[Deck, page 44, 44]" used to emit two chips both numbered 1, which read
    // as the number eleven beside a Sources list claiming one source.
    const { container } = render(
      <ChatMessage
        role="assistant"
        content="Twice [Lecture 2: Language Modeling, page 44, 44]."
        documents={DOCS}
        onOpenPreview={() => {}}
      />,
    )
    expect(chips(container).map((b) => b.textContent)).toEqual(['1'])
    expect(screen.getByRole('button', { name: /1 source$/ })).toBeInTheDocument()
  })

  it('still renders a single-page citation as one chip', () => {
    const { container } = render(
      <ChatMessage
        role="assistant"
        content="Attention sums to one [Lecture 2: Language Modeling, page 14]."
        documents={DOCS}
        onOpenPreview={() => {}}
      />,
    )
    expect(chips(container).map((b) => b.textContent)).toEqual(['1'])
    expect(screen.getByRole('button', { name: /1 source$/ })).toBeInTheDocument()
  })

  it('leaves a citation for an unknown document as an unclickable chip', () => {
    const onOpenPreview = vi.fn()
    const { container } = render(
      <ChatMessage
        role="assistant"
        content="Elsewhere [Some Other Deck, page 3]."
        documents={DOCS}
        onOpenPreview={onOpenPreview}
      />,
    )
    const [only] = chips(container)
    expect(only).toBeDisabled()
    fireEvent.click(only)
    expect(onOpenPreview).not.toHaveBeenCalled()
  })

  it('collapses the Sources list by default so long titles cannot crowd the answer', () => {
    render(
      <ChatMessage
        role="assistant"
        content="A [Lecture 2: Language Modeling, page 44, 51]."
        documents={DOCS}
        onOpenPreview={() => {}}
      />,
    )
    expect(screen.queryByTitle('Open the cited page')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '1 source · 2 pages' }))
    expect(screen.getAllByTitle('Open the cited page')).toHaveLength(2)
  })
})
