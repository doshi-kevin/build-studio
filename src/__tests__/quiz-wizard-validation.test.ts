import { describe, it, expect } from 'vitest'
import {
  validateWizardQuestions,
  wizardQuestionInlineError,
  wizardQuestionUnsavable,
} from '@/lib/quiz/wizard-validation'
import type { WizardQuestion } from '@/components/professor/quizzes/wizard/QuestionEditorCard'

// Minimal valid base; override per test.
function base(overrides: Partial<WizardQuestion>): WizardQuestion {
  return {
    clientId: '11111111-1111-4111-8111-111111111111',
    questionText: 'A question?',
    questionType: 'multiple_choice',
    difficulty: 'medium',
    bloomsLevel: null,
    tags: '',
    points: 1,
    explanation: '',
    isBonus: false,
    isExtraCredit: false,
    choices: [
      { id: 'a', text: 'Right', isCorrect: true },
      { id: 'b', text: 'Wrong', isCorrect: false },
    ],
    allowMultiple: false,
    correctAnswer: true,
    acceptedAnswers: [{ value: 'answer' }],
    caseSensitive: false,
    blanks: [{ id: 'x', acceptedAnswers: 'foo, bar', caseSensitive: false }],
    rubric: [{ concept: 'links derivative and integral' }],
    ...overrides,
  } as WizardQuestion
}

describe('validateWizardQuestions', () => {
  it('passes a valid one-of-each set', () => {
    const qs = [
      base({ questionType: 'multiple_choice' }),
      base({ questionType: 'true_false' }),
      base({ questionType: 'short_answer' }),
      base({ questionType: 'fill_in_blank' }),
      base({ questionType: 'explanation' }),
      base({ questionType: 'walkthrough' }),
    ]
    expect(validateWizardQuestions(qs)).toEqual([])
  })

  it('flags an empty question text regardless of type', () => {
    const errs = validateWizardQuestions([base({ questionText: '   ' })])
    expect(errs).toHaveLength(1)
    expect(errs[0].message).toMatch(/missing its text/i)
  })

  it('flags an MCQ with fewer than 2 filled choices', () => {
    const errs = validateWizardQuestions([
      base({ choices: [{ id: 'a', text: 'Only one', isCorrect: true }, { id: 'b', text: '', isCorrect: false }] }),
    ])
    expect(errs[0].message).toMatch(/at least 2 answer choices/i)
  })

  it('flags an MCQ with no correct choice marked (the F-MAJ-1 case)', () => {
    const errs = validateWizardQuestions([
      base({ choices: [{ id: 'a', text: 'X', isCorrect: false }, { id: 'b', text: 'Y', isCorrect: false }] }),
    ])
    expect(errs[0].message).toMatch(/at least one correct answer/i)
  })

  it('flags a short answer with no accepted answers', () => {
    const errs = validateWizardQuestions([
      base({ questionType: 'short_answer', acceptedAnswers: [{ value: '  ' }] }),
    ])
    expect(errs[0].message).toMatch(/at least one accepted answer/i)
  })

  it('flags a fill-in-blank with a blank that has no accepted answers', () => {
    const errs = validateWizardQuestions([
      base({ questionType: 'fill_in_blank', blanks: [{ id: 'x', acceptedAnswers: '  ,  ', caseSensitive: false }] }),
    ])
    // Same sentence as the inline card hint (toast/inline copy is unified).
    expect(errs[0].message).toMatch(/every blank needs at least one accepted answer/i)
  })

  it('flags a fill-in-blank where marker count != blank count (the reported bug)', () => {
    const errs = validateWizardQuestions([
      base({
        questionType: 'fill_in_blank',
        questionText: 'The three vectors are the Query, the Key, and the _____.', // 1 marker
        blanks: [
          { id: 'a', acceptedAnswers: 'Value', caseSensitive: false },
          { id: 'b', acceptedAnswers: 'Softmax', caseSensitive: false }, // 2 blanks
        ],
      }),
    ])
    expect(errs).toHaveLength(1)
    expect(errs[0].message).toMatch(/2 blanks defined but 1 .*marker/i)
  })

  it('passes a fill-in-blank where markers line up with blanks', () => {
    const errs = validateWizardQuestions([
      base({
        questionType: 'fill_in_blank',
        questionText: '_____ and _____ are derived from the input.', // 2 markers
        blanks: [
          { id: 'a', acceptedAnswers: 'Query', caseSensitive: false },
          { id: 'b', acceptedAnswers: 'Key', caseSensitive: false }, // 2 blanks
        ],
      }),
    ])
    expect(errs).toEqual([])
  })

  it('allows a fill-in-blank with no markers (labeled-input style)', () => {
    const errs = validateWizardQuestions([
      base({
        questionType: 'fill_in_blank',
        questionText: 'List the two attention terms below.', // 0 markers
        blanks: [
          { id: 'a', acceptedAnswers: 'Query', caseSensitive: false },
          { id: 'b', acceptedAnswers: 'Key', caseSensitive: false },
        ],
      }),
    ])
    expect(errs).toEqual([])
  })

  it('does not require an answer key for AI-graded explanation/walkthrough — a rubric suffices', () => {
    const errs = validateWizardQuestions([
      base({ questionType: 'explanation', choices: [], acceptedAnswers: [], blanks: [] }),
      base({ questionType: 'walkthrough', choices: [], acceptedAnswers: [], blanks: [] }),
    ])
    expect(errs).toEqual([])
  })

  // Without a rubric the grader has nothing to check — every answer scores 0 —
  // so an AI-graded question must not publish without one.
  it('flags explanation/walkthrough with a missing or all-blank rubric', () => {
    for (const t of ['explanation', 'walkthrough'] as const) {
      for (const rubric of [null, [], [{ concept: '   ' }]]) {
        const errs = validateWizardQuestions([base({ questionType: t, rubric })])
        expect(errs).toHaveLength(1)
        expect(errs[0].message).toMatch(t === 'explanation' ? /rubric concept/i : /target insight/i)
      }
    }
  })

  it('reports 1-based positions and the offending clientId', () => {
    const errs = validateWizardQuestions([
      base({ questionType: 'true_false' }), // valid
      base({ clientId: '22222222-2222-4222-8222-222222222222', questionText: '' }), // invalid #2
    ])
    expect(errs).toHaveLength(1)
    expect(errs[0].position).toBe(2)
    expect(errs[0].clientId).toBe('22222222-2222-4222-8222-222222222222')
  })

  // Adaptive-only types (explanation/walkthrough) can only be graded by the
  // adaptive engine — a standard quiz must not publish them (studio slice ③).
  it('blocks explanation/walkthrough questions when adaptive is explicitly off', () => {
    for (const t of ['explanation', 'walkthrough'] as const) {
      const errs = validateWizardQuestions([base({ questionType: t })], { adaptive: false })
      expect(errs).toHaveLength(1)
      expect(errs[0].message).toMatch(/adaptive-only/i)
    }
  })

  it('allows explanation/walkthrough when adaptive is on — and when unspecified (legacy callers)', () => {
    for (const opts of [{ adaptive: true }, undefined]) {
      expect(
        validateWizardQuestions([base({ questionType: 'explanation' })], opts),
      ).toHaveLength(0)
    }
  })
})

describe('wizardQuestionInlineError (per-question inline hint)', () => {
  it('returns null for a publish-ready question of each type', () => {
    for (const t of [
      'multiple_choice', 'true_false', 'short_answer', 'fill_in_blank', 'explanation', 'walkthrough',
    ] as const) {
      expect(wizardQuestionInlineError(base({ questionType: t }))).toBeNull()
    }
  })

  it('explanation/walkthrough: flags a missing rubric', () => {
    expect(wizardQuestionInlineError(base({ questionType: 'explanation', rubric: null }))).toMatch(
      /rubric concept/i,
    )
    expect(wizardQuestionInlineError(base({ questionType: 'walkthrough', rubric: [] }))).toMatch(
      /target insight/i,
    )
  })

  it('fill-in-blank: flags an empty-answer blank with a text-box-friendly message', () => {
    const msg = wizardQuestionInlineError(
      base({ questionType: 'fill_in_blank', blanks: [{ id: 'x', acceptedAnswers: '  ', caseSensitive: false }] }),
    )
    expect(msg).toMatch(/every blank needs at least one accepted answer/i)
  })

  it('fill-in-blank: flags having no blanks at all', () => {
    const msg = wizardQuestionInlineError(base({ questionType: 'fill_in_blank', blanks: [] }))
    expect(msg).toMatch(/add at least one blank/i)
  })

  it('multiple_choice: flags missing correct answer and too-few choices', () => {
    expect(
      wizardQuestionInlineError(
        base({ choices: [{ id: 'a', text: 'x', isCorrect: false }, { id: 'b', text: 'y', isCorrect: false }] }),
      ),
    ).toMatch(/mark at least one choice/i)
    expect(
      wizardQuestionInlineError(base({ choices: [{ id: 'a', text: 'only', isCorrect: true }] })),
    ).toMatch(/at least 2 answer choices/i)
  })

  it('returns null (no nag) when the text is empty — the field itself is required', () => {
    expect(wizardQuestionInlineError(base({ questionText: '  ' }))).toBeNull()
  })
})

describe('wizardQuestionUnsavable (autosave hold-back / rail "Not saved" marker)', () => {
  it('holds back a question with empty text — the case the inline hint deliberately ignores', () => {
    expect(wizardQuestionUnsavable(base({ questionText: '   ' }))).toBe(true)
  })

  it('holds back any question with an inline error (MCQ with one choice)', () => {
    expect(
      wizardQuestionUnsavable(base({ choices: [{ id: 'a', text: 'only', isCorrect: true }] })),
    ).toBe(true)
  })

  it('lets a publish-ready question of each type save', () => {
    for (const t of [
      'multiple_choice', 'true_false', 'short_answer', 'fill_in_blank', 'explanation', 'walkthrough',
    ] as const) {
      expect(wizardQuestionUnsavable(base({ questionType: t }))).toBe(false)
    }
  })
})
