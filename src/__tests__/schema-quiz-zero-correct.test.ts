// A single-answer multiple-choice question with ZERO correct answers is exactly
// as ungradeable as one with two: gradeAnswer's single-answer branch requires
// `correctIds.length === 1`, so nothing can ever match and every student is
// marked wrong — and docked, under negative marking.
//
// The schema rejected only the >1 case. quiz-question-editor-single-correct
// records the assumption that made that look safe: "it can reach zero correct
// answers, which wizard-validation already blocks at save." True in the Quiz
// Studio, which calls wizard-validation. NOT true in the Question Bank dialog,
// which calls neither — browser QA saved a zero-correct MCQ there and got a
// "Question created" toast with no validation anywhere.
//
// It got worse downstream: quiz_questions.is_complete is `NOT NULL DEFAULT true`
// and createQuestion never set it, so the bad row was stored as COMPLETE. That
// is the field publishQuiz trusts for its documented "an incomplete placeholder
// must never reach students" gate, and the bank's picker filters on it too — so
// the mislabel both offered the question and neutralised the last line of
// defense.
//
// Guarding at the shared content schema covers every strict writer at once
// (createQuestion, updateQuestion, bulkCreateQuestions, the studio save paths).
// The final test is the one that matters most on the other side: draft autosave
// must STILL persist blank placeholders, which is a deliberate feature.

import { describe, it, expect } from 'vitest'
import {
  multipleChoiceContentSchema,
  createQuestionServerSchema,
  draftQuestionServerSchema,
} from '@/lib/validations/quiz'

const choices = (flags: boolean[]) =>
  flags.map((isCorrect, i) => ({ id: `c${i}`, text: `Choice ${i + 1}`, isCorrect }))

const content = (flags: boolean[], allowMultiple = false) => ({
  questionType: 'multiple_choice' as const,
  choices: choices(flags),
  allowMultiple,
})

const question = (flags: boolean[], allowMultiple = false) => ({
  questionText: 'Which of these is a compiled language?',
  content: content(flags, allowMultiple),
  difficulty: 'medium' as const,
  points: 1,
})

describe('multipleChoiceContentSchema — zero correct answers', () => {
  it('rejects a single-answer question with no correct choice', () => {
    const result = multipleChoiceContentSchema.safeParse(content([false, false]))
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toBe('Mark at least one choice as correct.')
  })

  it('rejects zero correct even when multiple answers are allowed', () => {
    // Ungradeable either way — allowMultiple widens how many may be right, not
    // whether any need to be.
    const result = multipleChoiceContentSchema.safeParse(content([false, false], true))
    expect(result.success).toBe(false)
  })

  it('still accepts exactly one correct choice', () => {
    expect(multipleChoiceContentSchema.safeParse(content([true, false])).success).toBe(true)
  })

  it('still rejects two correct choices when multiple answers are NOT allowed', () => {
    const result = multipleChoiceContentSchema.safeParse(content([true, true]))
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toBe(
      'Only one choice can be correct unless you allow multiple correct answers.',
    )
  })

  it('still accepts two correct choices when multiple answers ARE allowed', () => {
    expect(multipleChoiceContentSchema.safeParse(content([true, true], true)).success).toBe(true)
  })
})

describe('the strict server schema inherits the rule', () => {
  it('rejects a zero-correct question — the Question Bank path', () => {
    // createQuestion / updateQuestion validate with this schema, so the bank
    // dialog can no longer persist the ungradeable state.
    expect(createQuestionServerSchema.safeParse(question([false, false])).success).toBe(false)
  })

  it('accepts a well-formed question', () => {
    expect(createQuestionServerSchema.safeParse(question([true, false])).success).toBe(true)
  })
})

describe('draft autosave is deliberately NOT affected', () => {
  it('still persists a placeholder with no correct choice', () => {
    // Professors lay out blank questions and fill them in later; those rows are
    // tagged is_complete=false and excluded from the picker / blocked at publish.
    // Tightening the strict schema must not take that away.
    expect(draftQuestionServerSchema.safeParse(question([false, false])).success).toBe(true)
  })

  it('still persists a completely blank placeholder', () => {
    const blank = {
      questionText: '',
      content: { questionType: 'multiple_choice' as const, choices: [], allowMultiple: false },
      difficulty: 'medium' as const,
      points: 1,
    }
    expect(draftQuestionServerSchema.safeParse(blank).success).toBe(true)
  })
})
