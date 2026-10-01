// The RubricEditor's add/edit/remove handlers are index-based — the classic
// home of wrong-row bugs — and its labels branch on question type. Like the
// attach seam, it's jsdom-testable (plain Input + <button>, no Radix pointer
// APIs). Asserts:
//   1. explanation cards get "Grading Rubric"/concept wording, walkthrough
//      cards "Target Insights"/insight wording;
//   2. add appends one blank row; remove deletes exactly the clicked row;
//   3. editing row N rewrites only row N and drops that row's stale AI-seeded
//      `match` keywords (the keyword grader re-derives them from the new text).

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import {
  QuestionEditorCard,
  createBlankQuestion,
  type WizardQuestion,
} from '@/components/professor/quizzes/wizard/QuestionEditorCard'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}))
vi.mock('@/lib/supabase/storage', () => ({ uploadFile: vi.fn(), deleteFile: vi.fn() }))
vi.mock('@/app/(dashboard)/professor/courses/[sectionId]/quizzes/actions', () => ({
  getLibraryForSection: vi.fn().mockResolvedValue({ images: [], formulas: [] }),
}))

// jsdom has no scrollIntoView; Radix Select touches it on render.
Element.prototype.scrollIntoView = vi.fn()

const RUBRIC = [
  { concept: 'first', match: ['one'] },
  { concept: 'second', match: ['two'] },
  { concept: 'third', match: ['three'] },
]

function renderCard(type: 'explanation' | 'walkthrough', rubric = RUBRIC) {
  const q: WizardQuestion = { ...createBlankQuestion(type), rubric: [...rubric] }
  const onChange = vi.fn()
  render(<QuestionEditorCard question={q} onChange={onChange} sectionId="sec-1" />)
  return onChange
}

describe('RubricEditor (AI-graded types)', () => {
  it('explanation: shows Grading Rubric with concept wording', () => {
    renderCard('explanation')
    expect(screen.getByText('Grading Rubric')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /add concept/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /remove concept 2/i })).toBeInTheDocument()
  })

  it('walkthrough: same editor labeled Target Insights with insight wording', () => {
    renderCard('walkthrough')
    expect(screen.getByText('Target Insights')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /add insight/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /remove insight 1/i })).toBeInTheDocument()
  })

  it('add appends one blank row after the existing ones', () => {
    const onChange = renderCard('explanation')
    fireEvent.click(screen.getByRole('button', { name: /add concept/i }))
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ rubric: [...RUBRIC, { concept: '' }] }),
    )
  })

  it('editing row 2 rewrites only row 2 — and drops its stale match keywords', () => {
    const onChange = renderCard('explanation')
    fireEvent.change(screen.getByDisplayValue('second'), { target: { value: 'rewritten' } })
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ rubric: [RUBRIC[0], { concept: 'rewritten' }, RUBRIC[2]] }),
    )
  })

  it('remove deletes exactly the clicked row', () => {
    const onChange = renderCard('explanation')
    fireEvent.click(screen.getByRole('button', { name: /remove concept 2/i }))
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ rubric: [RUBRIC[0], RUBRIC[2]] }),
    )
  })

  // The missing-rubric error surfaces inside the rubric panel (not the generic
  // inline spot under the question text) — and only after a failed save attempt.
  it('shows the missing-rubric error in the panel only when showError is set', () => {
    const q: WizardQuestion = {
      ...createBlankQuestion('explanation'),
      questionText: 'Explain the derivative.',
      rubric: [],
    }
    const { rerender } = render(
      <QuestionEditorCard question={q} onChange={vi.fn()} sectionId="sec-1" />,
    )
    expect(screen.queryByText(/add at least one rubric concept/i)).not.toBeInTheDocument()

    rerender(<QuestionEditorCard question={q} onChange={vi.fn()} sectionId="sec-1" showError />)
    expect(screen.getByText(/add at least one rubric concept/i)).toBeInTheDocument()
  })

  // An AI-generation "needs a rubric" warning renders on the rubric panel (not
  // the card top), with the generation-batch position prefix stripped — that
  // index may not match the question's position in the quiz.
  it('moves an AI rubric warning into the panel without its position prefix', () => {
    const q: WizardQuestion = {
      ...createBlankQuestion('explanation'),
      questionText: 'Explain smoothing.',
      rubric: [],
      validationWarning: 'Question 3: explanation needs a rubric of at least 1 conceptual node',
    }
    render(<QuestionEditorCard question={q} onChange={vi.fn()} sectionId="sec-1" />)
    expect(
      screen.getByText(/^explanation needs a rubric of at least 1 conceptual node/i),
    ).toBeInTheDocument()
    expect(screen.queryByText(/Question 3:/)).not.toBeInTheDocument()
  })
})
