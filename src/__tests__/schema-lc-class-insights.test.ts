// Schema tests for Class Insights AI-output validation — these schemas are the
// trust boundary between raw Gemini output and the stored student blob, so the
// rails (caps, enums, and the choice-type options rule) must actually fire.

import { describe, it, expect } from 'vitest'
import {
  flashcardsOutputSchema,
  practiceQuizOutputSchema,
  practiceQuestionSchema,
} from '@/lib/validations/lc-class-insights'

describe('flashcardsOutputSchema', () => {
  it('accepts a valid deck', () => {
    const r = flashcardsOutputSchema.safeParse({ cards: [{ front: 'Q', back: 'A', concept: 'X' }] })
    expect(r.success).toBe(true)
  })

  it('rejects an empty deck and an over-cap deck', () => {
    expect(flashcardsOutputSchema.safeParse({ cards: [] }).success).toBe(false)
    const tooMany = { cards: Array.from({ length: 21 }, () => ({ front: 'Q', back: 'A', concept: 'X' })) }
    expect(flashcardsOutputSchema.safeParse(tooMany).success).toBe(false)
  })
})

describe('practiceQuestionSchema', () => {
  it('accepts a valid multiple_choice with the answer among the options', () => {
    const r = practiceQuestionSchema.safeParse({
      type: 'multiple_choice',
      prompt: 'Pick one',
      options: ['a', 'b', 'c', 'd'],
      correctAnswer: 'b',
      explanation: 'because b',
      concept: 'X',
    })
    expect(r.success).toBe(true)
  })

  it('rejects a multiple_choice with no options (the choice-less-question bug)', () => {
    const r = practiceQuestionSchema.safeParse({
      type: 'multiple_choice',
      prompt: 'Pick one',
      options: [],
      correctAnswer: 'b',
      explanation: 'x',
      concept: 'X',
    })
    expect(r.success).toBe(false)
  })

  it('rejects a multiple_choice whose correctAnswer is not one of the options', () => {
    const r = practiceQuestionSchema.safeParse({
      type: 'multiple_choice',
      prompt: 'Pick one',
      options: ['a', 'b'],
      correctAnswer: 'zzz',
      explanation: 'x',
      concept: 'X',
    })
    expect(r.success).toBe(false)
  })

  it('requires true_false to carry its two options including the answer', () => {
    expect(
      practiceQuestionSchema.safeParse({
        type: 'true_false', prompt: 'T or F', options: ['True', 'False'], correctAnswer: 'True', explanation: 'x', concept: 'X',
      }).success,
    ).toBe(true)
    expect(
      practiceQuestionSchema.safeParse({
        type: 'true_false', prompt: 'T or F', options: [], correctAnswer: 'True', explanation: 'x', concept: 'X',
      }).success,
    ).toBe(false)
  })

  it('accepts free-text types with empty options (reveal-only)', () => {
    for (const type of ['fill_in_blank', 'short_answer', 'explanation'] as const) {
      const r = practiceQuestionSchema.safeParse({
        type, prompt: 'Explain X', options: [], correctAnswer: 'the model answer', explanation: 'x', concept: 'X',
      })
      expect(r.success, type).toBe(true)
    }
  })
})

describe('practiceQuizOutputSchema', () => {
  it('rejects an empty quiz and an over-cap quiz', () => {
    expect(practiceQuizOutputSchema.safeParse({ questions: [] }).success).toBe(false)
    const q = { type: 'short_answer' as const, prompt: 'p', options: [], correctAnswer: 'a', explanation: 'e', concept: 'c' }
    expect(practiceQuizOutputSchema.safeParse({ questions: Array.from({ length: 16 }, () => q) }).success).toBe(false)
  })
})
