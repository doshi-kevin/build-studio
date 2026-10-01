// C11's draft goes into a form the student sends to their professor under
// their own name, so the properties that matter are about what it will NOT say:
// nothing they didn't actually get wrong, and nothing they'd be embarrassed to
// have published.

import { describe, it, expect } from 'vitest'
import { draftClassQuestion, mostRecentMiss } from '@/lib/ai/student-tutor/class-question'
import type { ReviewedQuiz } from '@/lib/ai/student-tutor/quiz-history'

const q = (question: string, correct: boolean) => ({
  question,
  correct,
  earnedPoints: correct ? 1 : 0,
  points: 1,
  yourAnswer: 'Speed',
  correctAnswer: 'Need',
})

const quiz = (title: string, questions: ReturnType<typeof q>[]): ReviewedQuiz => ({
  quiz: title,
  scorePercent: 50,
  submittedAt: '2026-07-30',
  questions,
})

describe('mostRecentMiss', () => {
  it('takes the freshest wrong answer — attempts arrive most-recent-first', () => {
    const miss = mostRecentMiss([
      quiz('Quiz 2', [q('All correct here', true), q('Which paper title?', false)]),
      quiz('Quiz 1', [q('An older miss', false)]),
    ])
    expect(miss).toMatchObject({ quiz: 'Quiz 2', question: 'Which paper title?' })
  })

  it('returns null when nothing was missed, rather than reaching for a right answer', () => {
    expect(mostRecentMiss([quiz('Quiz 2', [q('Got it', true)])])).toBeNull()
    expect(mostRecentMiss([])).toBeNull()
  })

  it('skips a question with no text — an empty quote is not a question', () => {
    const miss = mostRecentMiss([quiz('Quiz 2', [q('   ', false), q('Real one?', false)])])
    expect(miss?.question).toBe('Real one?')
  })
})

describe('draftClassQuestion', () => {
  it('quotes the prompt and never the wrong answer they gave', () => {
    const draft = draftClassQuestion({
      quiz: 'Transformers Quiz 2',
      question: 'Which paper title?',
      yourAnswer: 'Speed',
      correctAnswer: 'Need',
    })

    expect(draft.text).toContain('Transformers Quiz 2')
    expect(draft.text).toContain('Which paper title?')
    // Publishing "I answered Speed" to the whole class costs the student
    // something and buys the question nothing.
    expect(draft.text).not.toContain('Speed')
    expect(draft.text).not.toContain('Need')
  })

  it('truncates a long prompt so the question stays askable out loud', () => {
    const draft = draftClassQuestion({
      quiz: 'Quiz 2',
      question: 'word '.repeat(80).trim(),
      yourAnswer: 'a',
      correctAnswer: 'b',
    })
    expect(draft.text).toContain('…')
    expect(draft.text.length).toBeLessThan(250)
  })
})
