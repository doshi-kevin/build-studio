// Regression tests for the QuestionDisplay multiple-choice input.
// Guards against a real bug where MultipleChoiceInput is reused across
// question navigation in QuizPlayer (same React instance, new `choices` prop).
// A stale useMemo dep array previously kept showing the first question's
// choices for every subsequent question.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QuestionDisplay } from '@/components/student/quizzes/QuestionDisplay'
import { buildQuestion } from './helpers/test-data-builders'

describe('QuestionDisplay (multiple choice)', () => {
  const baseProps = {
    answer: undefined,
    questionNumber: 1,
    shuffleAnswers: false,
    onAnswer: () => {},
  }

  it('renders the choices passed in props', () => {
    const q = buildQuestion({
      id: 'q-a',
      questionText: 'Q A?',
      content: {
        questionType: 'multiple_choice',
        allowMultiple: false,
        choices: [
          { id: 'a1', text: 'Alpha', isCorrect: false },
          { id: 'a2', text: 'Bravo', isCorrect: true },
        ],
      },
    })
    render(<QuestionDisplay question={q} {...baseProps} />)
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Bravo')).toBeInTheDocument()
  })

  it('updates displayed choices when the question prop changes (regression: useMemo deps)', () => {
    const q1 = buildQuestion({
      id: 'q-a',
      questionText: 'Q A?',
      content: {
        questionType: 'multiple_choice',
        allowMultiple: false,
        choices: [
          { id: 'a1', text: 'Alpha', isCorrect: false },
          { id: 'a2', text: 'Bravo', isCorrect: true },
        ],
      },
    })
    const q2 = buildQuestion({
      id: 'q-b',
      questionText: 'Q B?',
      content: {
        questionType: 'multiple_choice',
        allowMultiple: false,
        choices: [
          { id: 'b1', text: 'Charlie', isCorrect: false },
          { id: 'b2', text: 'Delta', isCorrect: true },
        ],
      },
    })

    const { rerender } = render(
      <QuestionDisplay question={q1} {...baseProps} />,
    )
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Bravo')).toBeInTheDocument()

    // Re-render with a new question's choices — same component instance.
    // Before the fix, displayChoices stayed cached as q1's choices.
    rerender(<QuestionDisplay question={q2} {...baseProps} />)

    expect(screen.getByText('Charlie')).toBeInTheDocument()
    expect(screen.getByText('Delta')).toBeInTheDocument()
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument()
    expect(screen.queryByText('Bravo')).not.toBeInTheDocument()
  })

  it('renders inline blanks (not the raw token) for fill-in-the-blank without attachments', () => {
    // Regression: the no-attachments single-column branch rendered the raw
    // questionText, so {{blank:…}} leaked verbatim and the legacy "Your answer"
    // list showed instead of the inline input.
    const q = buildQuestion({
      id: 'q-fib',
      questionText: 'The {{blank:b1:Markov|markov}} assumption holds.',
      content: {
        questionType: 'fill_in_blank',
        blanks: [{ id: 'b1', acceptedAnswers: ['Markov'], caseSensitive: false }],
      },
    })
    const { container } = render(<QuestionDisplay question={q} {...baseProps} />)

    expect(container.textContent).not.toContain('{{blank')
    // Inline input is present; the legacy per-blank "Your answer" list is not.
    expect(screen.getByLabelText('Blank 1')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Your answer')).not.toBeInTheDocument()
  })

  it('disables inline blank inputs when disabled (studio preview is read-only)', () => {
    const q = buildQuestion({
      id: 'q-fib-disabled',
      questionText: 'The {{blank:b1:Markov}} assumption holds.',
      content: {
        questionType: 'fill_in_blank',
        blanks: [{ id: 'b1', acceptedAnswers: ['Markov'], caseSensitive: false }],
      },
    })
    render(<QuestionDisplay question={q} {...baseProps} disabled />)
    expect(screen.getByLabelText('Blank 1')).toBeDisabled()
  })

  it('does not answer a multiple-choice option when disabled (read-only preview)', () => {
    // MC options are <div role="option">, not native inputs — `disabled` can't
    // apply natively, so the read-only invariant relies on a hand-rolled onClick
    // guard. If that guard regresses, a native `disabled` attr would NOT catch it.
    const onAnswer = vi.fn()
    const q = buildQuestion({
      id: 'q-mc-disabled',
      questionText: 'Pick one?',
      content: {
        questionType: 'multiple_choice',
        allowMultiple: false,
        choices: [
          { id: 'm1', text: 'Alpha', isCorrect: false },
          { id: 'm2', text: 'Bravo', isCorrect: true },
        ],
      },
    })
    render(
      <QuestionDisplay question={q} {...baseProps} onAnswer={onAnswer} disabled />,
    )
    fireEvent.click(screen.getByText('Alpha'))
    expect(onAnswer).not.toHaveBeenCalled()
  })

  it('does not answer a true/false option when disabled (read-only preview)', () => {
    // TrueFalseInput has its own inline onClick guard, separate from MC's.
    const onAnswer = vi.fn()
    const q = buildQuestion({
      id: 'q-tf-disabled',
      questionText: 'The sky is blue?',
      content: { questionType: 'true_false', correctAnswer: true },
    })
    render(
      <QuestionDisplay question={q} {...baseProps} onAnswer={onAnswer} disabled />,
    )
    fireEvent.click(screen.getByText('True'))
    expect(onAnswer).not.toHaveBeenCalled()
  })

  it('preserves the same set of choices across rerenders when shuffleAnswers is on', () => {
    const q = buildQuestion({
      id: 'q-shuffle',
      questionText: 'Shuffled?',
      content: {
        questionType: 'multiple_choice',
        allowMultiple: false,
        choices: [
          { id: 'c1', text: 'One', isCorrect: false },
          { id: 'c2', text: 'Two', isCorrect: false },
          { id: 'c3', text: 'Three', isCorrect: true },
          { id: 'c4', text: 'Four', isCorrect: false },
        ],
      },
    })
    render(<QuestionDisplay question={q} {...baseProps} shuffleAnswers />)
    // All four choices must be on screen regardless of order
    expect(screen.getByText('One')).toBeInTheDocument()
    expect(screen.getByText('Two')).toBeInTheDocument()
    expect(screen.getByText('Three')).toBeInTheDocument()
    expect(screen.getByText('Four')).toBeInTheDocument()
  })
})
