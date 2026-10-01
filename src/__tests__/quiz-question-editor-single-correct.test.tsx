// The "Allow multiple correct answers" switch is a promise about grading, and the
// editor wasn't keeping it. With the switch OFF the correct-answer marks behaved like
// checkboxes: marking a second choice correct left the first one correct too, and the
// question saved with two right answers.
//
// The consequence is worse than "grading accepts either" — it accepts NEITHER. The
// single-answer branch of gradeAnswer (src/lib/quiz/scoring.ts) requires
// `correctIds.length === 1`, so with two correct ids nothing can ever match: every
// student is marked wrong whatever they pick, and with negative marking they are docked
// for it. The student UI renders a radio in this mode, so they cannot even select both.
// Silent, total, looks fine in the editor. If you are ever triaging "the whole class
// got Q4 wrong", start here.
//
// These pin the radio semantics at both seams:
//   1. marking a choice correct with the switch OFF clears the others;
//   2. with the switch ON it does not (that's the whole point of the switch);
//   3. turning the switch OFF reconciles what is ALREADY marked — otherwise the
//      question sits in exactly the state the switch claims is impossible.
//
// Unchecking is deliberately untouched here: it can reach zero correct answers.
// That was justified as "wizard-validation already blocks it at save" — true of
// the Quiz Studio, which calls wizard-validation, but NOT of the Question Bank
// dialog, which called neither it nor any equivalent and happily persisted an
// ungradeable question. The zero-correct rule now lives in the shared schema
// (multipleChoiceContentSchema), so every strict writer is covered at one
// chokepoint; see schema-quiz-zero-correct.test.ts.

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

Element.prototype.scrollIntoView = vi.fn()

/** A 4-choice MC question; `correct` lists the indices marked correct. */
function mcQuestion(correct: number[], allowMultiple: boolean): WizardQuestion {
  const base = createBlankQuestion('multiple_choice')
  return {
    ...base,
    allowMultiple,
    choices: ['A', 'B', 'C', 'D'].map((text, i) => ({
      id: `c${i}`,
      text,
      isCorrect: correct.includes(i),
    })),
  }
}

const renderCard = (q: WizardQuestion) => {
  const onChange = vi.fn()
  render(<QuestionEditorCard question={q} onChange={onChange} sectionId="sec-1" />)
  return onChange
}

/** The isCorrect flags from the question handed back to the parent. */
const marksFrom = (onChange: ReturnType<typeof vi.fn>) =>
  (onChange.mock.calls[0][0] as WizardQuestion).choices.map((c) => c.isCorrect)

describe('QuestionEditorCard — single-correct enforcement', () => {
  it('marking a second choice correct clears the first when multiple answers are off', () => {
    const onChange = renderCard(mcQuestion([0], false))

    fireEvent.click(screen.getByLabelText('Choice 2 is correct'))

    // Exactly one correct, and it's the one just clicked.
    expect(marksFrom(onChange)).toEqual([false, true, false, false])
  })

  it('leaves the other choices alone when multiple answers are allowed', () => {
    const onChange = renderCard(mcQuestion([0], true))

    fireEvent.click(screen.getByLabelText('Choice 2 is correct'))

    expect(marksFrom(onChange)).toEqual([true, true, false, false])
  })

  it('turning multiple answers off collapses an already-multi-marked question', () => {
    // The state you can only reach by marking several, then flipping the switch back.
    const onChange = renderCard(mcQuestion([1, 2, 3], true))

    fireEvent.click(screen.getByRole('switch', { name: /allow multiple correct answers/i }))

    const updated = onChange.mock.calls[0][0] as WizardQuestion
    expect(updated.allowMultiple).toBe(false)
    // Keeps the FIRST correct choice, drops the rest.
    expect(updated.choices.map((c) => c.isCorrect)).toEqual([false, true, false, false])
  })

  it('does not invent a correct answer when turning the switch off with none marked', () => {
    const onChange = renderCard(mcQuestion([], true))

    fireEvent.click(screen.getByRole('switch', { name: /allow multiple correct answers/i }))

    const updated = onChange.mock.calls[0][0] as WizardQuestion
    expect(updated.choices.map((c) => c.isCorrect)).toEqual([false, false, false, false])
  })
})
