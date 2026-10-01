// Pure per-question review summarizer (get_my_quiz_review tool).
import { describe, it, expect } from 'vitest'
import { reviewAnswer } from '@/lib/ai/student-tutor/quiz-review'

describe('reviewAnswer', () => {
  it('multiple_choice: maps selected + correct choice ids to their texts', () => {
    const q = {
      question_type: 'multiple_choice',
      content: {
        choices: [
          { id: 'a', text: 'Query, Key, Value', isCorrect: true },
          { id: 'b', text: 'Encoder, Decoder, Embedding', isCorrect: false },
        ],
      },
    }
    expect(reviewAnswer(q, { selected_choice_ids: ['b'] })).toEqual({
      yourAnswer: 'Encoder, Decoder, Embedding',
      correctAnswer: 'Query, Key, Value',
    })
    expect(reviewAnswer(q, { selected_choice_ids: ['a'] }).yourAnswer).toBe('Query, Key, Value')
  })

  it('true_false: renders booleans as True/False and flags a missing answer', () => {
    const q = { question_type: 'true_false', content: { correctAnswer: false } }
    expect(reviewAnswer(q, { boolean_answer: true })).toEqual({ yourAnswer: 'True', correctAnswer: 'False' })
    expect(reviewAnswer(q, { boolean_answer: null }).yourAnswer).toMatch(/no answer/i)
  })

  it('true_false: an absent/null correctAnswer is (unknown), not a confident False', () => {
    // A bare `c.correctAnswer ? …` would print 'False' here — a definite wrong
    // answer the data never stated. Every other type says '(unknown)' when the
    // key is missing; true_false must too.
    expect(reviewAnswer({ question_type: 'true_false', content: {} }, { boolean_answer: true }).correctAnswer).toBe('(unknown)')
    expect(reviewAnswer({ question_type: 'true_false', content: { correctAnswer: null } }, {}).correctAnswer).toBe('(unknown)')
  })

  it('true_false: reads a JSONB value stored as the STRING "false" as False', () => {
    // The bug the fix exists for: the string 'false' is truthy, so `ca ? …` prints
    // 'True' — telling the student the opposite of the key. Resolve by value.
    expect(reviewAnswer({ question_type: 'true_false', content: { correctAnswer: 'false' } }, {}).correctAnswer).toBe('False')
    expect(reviewAnswer({ question_type: 'true_false', content: { correctAnswer: 'True' } }, {}).correctAnswer).toBe('True')
  })

  it('short_answer: shows the text answer vs the accepted answers', () => {
    const q = { question_type: 'short_answer', content: { acceptedAnswers: ['d_k', 'the key dimension'] } }
    expect(reviewAnswer(q, { text_answer: 'd_k' })).toEqual({ yourAnswer: 'd_k', correctAnswer: 'd_k / the key dimension' })
  })

  it('fill_in_blank: joins blank values vs accepted answers', () => {
    const q = { question_type: 'fill_in_blank', content: { blanks: [{ id: 'x', acceptedAnswers: ['Need'] }] } }
    expect(reviewAnswer(q, { blank_answers: { x: 'Need' } })).toEqual({ yourAnswer: 'Need', correctAnswer: 'Need' })
  })

  it('is robust to malformed/missing content', () => {
    expect(reviewAnswer({ question_type: 'multiple_choice', content: null }, {}).yourAnswer).toMatch(/no answer/i)
    expect(reviewAnswer({ question_type: 'weird', content: {} }, { text_answer: 'hi' }).yourAnswer).toBe('hi')
  })
})
