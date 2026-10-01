// isQuestionComplete drives the `is_complete` flag: incomplete questions persist
// as placeholders but are hidden from the bank picker and block publish. It must
// match the studio's inline-error rules — a blank stem, an MCQ without ≥2 real
// choices or without a correct answer, etc. are all "incomplete".
import { describe, it, expect } from 'vitest'
import { isQuestionComplete } from '@/lib/validations/quiz'

const mc = (choices: { id: string; text: string; isCorrect: boolean }[]) => ({
  questionType: 'multiple_choice' as const,
  choices,
  allowMultiple: false,
})
const twoGood = [
  { id: 'a', text: 'Right', isCorrect: true },
  { id: 'b', text: 'Wrong', isCorrect: false },
]

describe('isQuestionComplete', () => {
  it('is false for a blank / whitespace stem', () => {
    expect(isQuestionComplete('', mc(twoGood))).toBe(false)
    expect(isQuestionComplete('   ', mc(twoGood))).toBe(false)
  })

  it('is false for an MCQ with fewer than 2 choices', () => {
    expect(isQuestionComplete('Q?', mc([]))).toBe(false)
    expect(isQuestionComplete('Q?', mc([{ id: 'a', text: 'x', isCorrect: true }]))).toBe(false)
  })

  it('is false for an MCQ with no correct choice', () => {
    expect(
      isQuestionComplete('Q?', mc([
        { id: 'a', text: 'x', isCorrect: false },
        { id: 'b', text: 'y', isCorrect: false },
      ])),
    ).toBe(false)
  })

  it('is true for a complete MCQ', () => {
    expect(isQuestionComplete('What is 2+2?', mc(twoGood))).toBe(true)
  })

  it('is true for a true/false with an answer', () => {
    expect(isQuestionComplete('The sky is blue.', { questionType: 'true_false', correctAnswer: true })).toBe(true)
  })

  it('requires ≥1 accepted answer for short_answer', () => {
    expect(isQuestionComplete('Capital of France?', { questionType: 'short_answer', acceptedAnswers: [], caseSensitive: false })).toBe(false)
    expect(isQuestionComplete('Capital of France?', { questionType: 'short_answer', acceptedAnswers: ['Paris'], caseSensitive: false })).toBe(true)
  })

  it('requires ≥1 blank with an accepted answer for fill_in_blank', () => {
    expect(isQuestionComplete('The {{b}} of France.', { questionType: 'fill_in_blank', blanks: [] })).toBe(false)
    expect(
      isQuestionComplete('The {{b}} of France.', {
        questionType: 'fill_in_blank',
        blanks: [{ id: 'b', acceptedAnswers: ['capital'], caseSensitive: false }],
      }),
    ).toBe(true)
  })

  it('requires a rubric concept for AI-graded explanation/walkthrough (grader zeroes without one)', () => {
    // Rubric lives in a sibling field, not content — must be passed in.
    expect(isQuestionComplete('Explain gradient descent.', { questionType: 'explanation' })).toBe(false)
    expect(isQuestionComplete('Explain gradient descent.', { questionType: 'explanation' }, [])).toBe(false)
    expect(isQuestionComplete('Explain gradient descent.', { questionType: 'explanation' }, [{ concept: '   ' }])).toBe(false)
    expect(isQuestionComplete('Explain gradient descent.', { questionType: 'explanation' }, [{ concept: 'chain rule' }])).toBe(true)
    // walkthrough (opening/maxTurns default in) — same rubric gate
    expect(isQuestionComplete('Walk me through it.', { questionType: 'walkthrough' })).toBe(false)
    expect(isQuestionComplete('Walk me through it.', { questionType: 'walkthrough' }, [{ concept: 'step 1' }])).toBe(true)
  })

  it('is false for malformed / unknown content', () => {
    expect(isQuestionComplete('Q?', { questionType: 'nonsense' })).toBe(false)
    expect(isQuestionComplete('Q?', null)).toBe(false)
  })
})
