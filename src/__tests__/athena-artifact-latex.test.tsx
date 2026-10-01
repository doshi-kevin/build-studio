// Athena writes a study artifact with the same voice she writes chat answers in,
// so a flashcard about a formula arrives as LaTeX. The widget bodies used to
// interpolate those strings raw, printing "$2 f_{max}$" at the student.
import { describe, it, expect } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { AthenaArtifactBody } from '@/components/student/athena/ArtifactWidgets'
import type { AthenaArtifactView } from '@/lib/athena/artifact-kinds'

const base = { id: 'a1', moduleId: 'm1', state: {}, createdAt: '2026-08-05T00:00:00Z' }
const view = (kind: string, payload: unknown) =>
  ({ ...base, kind, title: 'Sampling', payload }) as AthenaArtifactView

describe('LaTeX in study artifacts', () => {
  it('renders math on a flashcard back', () => {
    const { container } = render(
      <AthenaArtifactBody
        artifact={view('flashcards', { cards: [{ front: 'Nyquist rate?', back: 'Sample above $2 f_{max}$.' }] })}
      />,
    )
    fireEvent.click(container.querySelector('.aw-card')!)
    expect(container.querySelector('.katex')).not.toBeNull()
    expect(container.querySelector('.aw-face')!.textContent).not.toContain('$2 f')
  })

  it('renders math in a practice question, its options and its explanation', () => {
    const { container } = render(
      <AthenaArtifactBody
        artifact={view('practice', {
          questions: [
            {
              prompt: 'Which satisfies $f_s > 2f_{max}$?',
              options: [{ text: '$f_s = 3f_{max}$', correct: true }, { text: '$f_s = f_{max}$' }],
              explanation: 'Because $3 > 2$.',
            },
          ],
        })}
      />,
    )
    fireEvent.click(container.querySelectorAll('.aw-opt')[0])
    // prompt + two options + explanation
    expect(container.querySelectorAll('.katex')).toHaveLength(4)
  })

  it('renders math in a study-guide point', () => {
    const { container } = render(
      <AthenaArtifactBody
        artifact={view('study_guide', {
          sections: [{ heading: 'Entropy', points: [{ text: 'Defined as $H(X) = -\\sum p \\log p$.' }] }],
        })}
      />,
    )
    expect(container.querySelector('.katex')).not.toBeNull()
    expect(container.textContent).not.toContain('$H(X)')
  })

  it('renders math in a checklist step', () => {
    const { container } = render(
      <AthenaArtifactBody artifact={view('checklist', { steps: [{ label: 'Redo the $\\nabla f$ derivation' }] })} />,
    )
    expect(container.querySelector('.katex')).not.toBeNull()
  })

  it('keeps the flashcard face inside the button (no invalid nesting)', () => {
    // The face renders through MarkdownLatex; a <div> wrapper there would be
    // invalid content for a <button> and could break the flip target.
    const { container } = render(
      <AthenaArtifactBody artifact={view('flashcards', { cards: [{ front: 'Term', back: 'Answer' }] })} />,
    )
    expect(container.querySelector('.aw-card div')).toBeNull()
  })
})
