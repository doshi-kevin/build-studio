import { describe, it, expect } from 'vitest'
import { buildQuizReview, type QuizReviewPayload } from '@/lib/live-classroom/quiz-review'

const q = (
  id: string,
  correctChoiceId: string,
  extra: Partial<{ explanation: string }> = {},
) => ({
  id,
  prompt: `Prompt ${id}`,
  choices: [
    { id: 'c1', text: 'A' },
    { id: 'c2', text: 'B' },
    { id: 'c3', text: 'C' },
  ],
  correctChoiceId,
  ...extra,
})

describe('buildQuizReview', () => {
  it('single question answered correctly → 100% and flags the picked/correct choice', () => {
    const payload: QuizReviewPayload = { title: 'T', questions: [q('q1', 'c1')] }
    const r = buildQuizReview(payload, { q1: 'c1' })
    expect(r.correctCount).toBe(1)
    expect(r.totalCount).toBe(1)
    expect(r.scorePct).toBe(100)
    const rq = r.questions[0]
    expect(rq.isCorrect).toBe(true)
    expect(rq.answered).toBe(true)
    expect(rq.pickedChoiceId).toBe('c1')
    expect(rq.choices.find((c) => c.id === 'c1')).toMatchObject({ isCorrect: true, isPicked: true })
  })

  it('single question answered wrong → 0%, marks pick and the correct answer separately', () => {
    const r = buildQuizReview({ questions: [q('q1', 'c1')] }, { q1: 'c2' })
    expect(r.scorePct).toBe(0)
    const rq = r.questions[0]
    expect(rq.isCorrect).toBe(false)
    expect(rq.pickedChoiceId).toBe('c2')
    expect(rq.choices.find((c) => c.id === 'c2')).toMatchObject({ isCorrect: false, isPicked: true })
    expect(rq.choices.find((c) => c.id === 'c1')).toMatchObject({ isCorrect: true, isPicked: false })
  })

  it('multi-question mix computes correctCount and rounded score', () => {
    const payload: QuizReviewPayload = {
      questions: [q('q1', 'c1'), q('q2', 'c2'), q('q3', 'c3')],
    }
    // 2 of 3 correct → 67%
    const r = buildQuizReview(payload, { q1: 'c1', q2: 'c1', q3: 'c3' })
    expect(r.correctCount).toBe(2)
    expect(r.totalCount).toBe(3)
    expect(r.scorePct).toBe(67)
  })

  it('a question absent from answers is "not answered" and counts wrong', () => {
    const r = buildQuizReview({ questions: [q('q1', 'c1'), q('q2', 'c2')] }, { q1: 'c1' })
    const q2 = r.questions[1]
    expect(q2.answered).toBe(false)
    expect(q2.pickedChoiceId).toBeNull()
    expect(q2.isCorrect).toBe(false)
    expect(r.correctCount).toBe(1)
    expect(r.scorePct).toBe(50)
  })

  it('empty answers → all unanswered, score 0', () => {
    const r = buildQuizReview({ questions: [q('q1', 'c1'), q('q2', 'c2')] }, {})
    expect(r.correctCount).toBe(0)
    expect(r.scorePct).toBe(0)
    expect(r.questions.every((x) => !x.answered)).toBe(true)
  })

  it('passes explanation through when present, leaves it undefined otherwise', () => {
    const r = buildQuizReview(
      { questions: [q('q1', 'c1', { explanation: 'because A' }), q('q2', 'c2')] },
      { q1: 'c1', q2: 'c2' },
    )
    expect(r.questions[0].explanation).toBe('because A')
    expect(r.questions[1].explanation).toBeUndefined()
  })

  it('keeps choices in authored order regardless of which one was picked', () => {
    const r = buildQuizReview({ questions: [q('q1', 'c3')] }, { q1: 'c3' })
    expect(r.questions[0].choices.map((c) => c.id)).toEqual(['c1', 'c2', 'c3'])
  })

  it('rounds the score (1/3 → 33)', () => {
    const r = buildQuizReview(
      { questions: [q('q1', 'c1'), q('q2', 'c2'), q('q3', 'c3')] },
      { q1: 'c1', q2: 'c1', q3: 'c1' },
    )
    expect(r.scorePct).toBe(33)
  })

  it('handles a quiz with no questions without dividing by zero', () => {
    const r = buildQuizReview({ questions: [] }, {})
    expect(r.totalCount).toBe(0)
    expect(r.scorePct).toBe(0)
  })

  it('treats a present-but-empty-string answer as unanswered (not a blank pick)', () => {
    const r = buildQuizReview({ questions: [q('q1', 'c1')] }, { q1: '' })
    const rq = r.questions[0]
    expect(rq.answered).toBe(false)
    expect(rq.pickedChoiceId).toBeNull()
    expect(rq.isCorrect).toBe(false)
    expect(rq.choices.every((c) => !c.isPicked)).toBe(true)
    expect(r.correctCount).toBe(0)
  })

  it('null studentAnswers behaves like no answers', () => {
    const r = buildQuizReview({ questions: [q('q1', 'c1')] }, null)
    expect(r.questions[0].answered).toBe(false)
    expect(r.scorePct).toBe(0)
  })
})
