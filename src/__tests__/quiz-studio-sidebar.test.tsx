// The question-settings sidebar is a thin controlled component, but its
// difficulty control carries one non-obvious rule worth guarding: when the quiz
// is adaptive and the question has a stored IRT `b`, the highlighted pill is
// derived from `b` — NOT the stored `difficulty` category, which AI-seeded items
// can carry drifted from their `b`. The number is the source of truth; the pill
// must reflect it. A well-meaning refactor collapsing this back to
// `difficulty === d` would silently mislabel adaptive items, so it gets a test.
//
// Also locks the click contract: choosing a pill writes BOTH the category and
// the anchored `b` (−3 / 0 / +3) — the CCAT engine runs on `b`, so a click that
// set only the category would leave the engine on the old difficulty.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QuizStudioQuestionSidebar } from '@/components/professor/quizzes/wizard/QuizStudioQuestionSidebar'
import {
  createBlankQuestion,
  type WizardQuestion,
} from '@/components/professor/quizzes/wizard/QuestionEditorCard'

// jsdom has no scrollIntoView; the sidebar's Radix Select (Bloom's) touches it.
Element.prototype.scrollIntoView = vi.fn()

function renderSidebar(overrides: Partial<WizardQuestion>, adaptive: boolean) {
  const question: WizardQuestion = { ...createBlankQuestion('multiple_choice'), ...overrides }
  const onChange = vi.fn()
  render(
    <QuizStudioQuestionSidebar
      question={question}
      index={0}
      onChange={onChange}
      onRemove={vi.fn()}
      adaptive={adaptive}
    />,
  )
  return onChange
}

const pill = (name: 'Easy' | 'Medium' | 'Hard') => screen.getByRole('button', { name })

describe('QuizStudioQuestionSidebar — difficulty pills', () => {
  it('adaptive: highlights the pill for the stored b, not a drifted category', () => {
    // b = 2.5 → Hard (b > 1), even though the stored category says easy.
    renderSidebar({ difficulty: 'easy', irtB: 2.5 }, true)
    expect(pill('Hard')).toHaveAttribute('aria-pressed', 'true')
    expect(pill('Easy')).toHaveAttribute('aria-pressed', 'false')
  })

  it('adaptive with no stored b: falls back to the stored category', () => {
    renderSidebar({ difficulty: 'hard', irtB: null }, true)
    expect(pill('Hard')).toHaveAttribute('aria-pressed', 'true')
    expect(pill('Medium')).toHaveAttribute('aria-pressed', 'false')
  })

  it('standard (non-adaptive): highlights the stored category directly', () => {
    // No b is consulted when not adaptive — the stored category is all there is.
    renderSidebar({ difficulty: 'medium', irtB: 2.5 }, false)
    expect(pill('Medium')).toHaveAttribute('aria-pressed', 'true')
    expect(pill('Hard')).toHaveAttribute('aria-pressed', 'false')
  })

  it('clicking a pill sets the category AND snaps b to its anchor', () => {
    const onChange = renderSidebar({ difficulty: 'easy', irtB: -3 }, true)
    fireEvent.click(pill('Hard'))
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ difficulty: 'hard', irtB: 3 }),
    )
  })
})

// Generated explanations arrive full of markdown and LaTeX ("$2 \times 2$", "**bold**"),
// which reads as gibberish in the raw textarea — so a rendered "as students will see it"
// preview appears beneath it. The regression risk is the DETECTOR, not the renderer: fire
// it on any underscore or asterisk and every field grows a duplicate of itself, which is
// noise on the 99% of explanations that are plain prose.
describe('QuizStudioQuestionSidebar — explanation preview', () => {
  const preview = () => screen.queryByText('Rendered preview')

  it('renders the preview when the explanation contains LaTeX or markdown', () => {
    for (const explanation of [
      'The output is $2 \\times 2$ per channel.',
      'Use \\frac{1}{n} to average.',
      'This is **important** for pooling.',
      'Call `softmax()` on the logits.',
      'Inline \\(x^2\\) math.',
    ]) {
      const { unmount } = render(
        <QuizStudioQuestionSidebar
          question={{ ...createBlankQuestion('multiple_choice'), explanation }}
          index={0}
          onChange={vi.fn()}
          onRemove={vi.fn()}
          adaptive={false}
        />,
      )
      expect(preview(), explanation).toBeInTheDocument()
      unmount()
    }
  })

  it('stays hidden for plain prose, including lone _ and * characters', () => {
    for (const explanation of [
      '',
      'Pooling halves the spatial dimensions.',
      'The state_of_the_art model wins.',
      'Multiply 3 * 4 to get 12.',
      'A 50% dropout rate is typical.',
    ]) {
      const { unmount } = render(
        <QuizStudioQuestionSidebar
          question={{ ...createBlankQuestion('multiple_choice'), explanation }}
          index={0}
          onChange={vi.fn()}
          onRemove={vi.fn()}
          adaptive={false}
        />,
      )
      expect(preview(), explanation).not.toBeInTheDocument()
      unmount()
    }
  })
})
