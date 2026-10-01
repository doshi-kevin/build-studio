// Tests for the unified quiz-result normalizer (toUnifiedResult + resolveQuestionOrder).
// Covers: standard attempts, adaptive IRT, adaptive Elo fallback, empty-served
// fallback to the fixed list, the no-questions-recorded edge, topic insights,
// and the rule that ability is never produced for standard quizzes.

import { describe, it, expect } from 'vitest'
import {
  toUnifiedResult,
  resolveQuestionOrder,
  type UnifiedAttemptInput,
  type UnifiedAnswerInput,
  type UnifiedQuestionInput,
} from '@/lib/quiz/unified-result'

// ── Builders (the normalizer's own decoupled input shapes) ──────────

function buildAttempt(overrides: Partial<UnifiedAttemptInput> = {}): UnifiedAttemptInput {
  return {
    score: 80,
    totalPoints: 10,
    earnedPoints: 8,
    resolvedQuestionIds: [],
    cohort: null,
    theta: null,
    se: null,
    stopReason: null,
    finalRating: null,
    ...overrides,
  }
}

function buildAnswer(overrides: Partial<UnifiedAnswerInput> = {}): UnifiedAnswerInput {
  return {
    questionId: 'q1',
    isCorrect: true,
    earnedPoints: 1,
    softScore: null,
    textAnswer: null,
    rationale: null,
    nodesMet: null,
    nodesTotal: null,
    isFormative: false,
    ...overrides,
  }
}

function buildQuestion(overrides: Partial<UnifiedQuestionInput> = {}): UnifiedQuestionInput {
  return {
    id: 'q1',
    questionText: 'What is 2 + 2?',
    type: 'multiple_choice',
    points: 1,
    tags: ['arithmetic'],
    ...overrides,
  }
}

// ── resolveQuestionOrder ─────────────────────────────────────────────

describe('resolveQuestionOrder', () => {
  it('uses the served list when present', () => {
    expect(resolveQuestionOrder(['a', 'b'], ['x', 'y', 'z'])).toEqual(['a', 'b'])
  })

  it('falls back to the fixed list when served is empty', () => {
    expect(resolveQuestionOrder([], ['x', 'y'])).toEqual(['x', 'y'])
  })

  it('returns empty when neither list has questions', () => {
    expect(resolveQuestionOrder([], [])).toEqual([])
  })

  it('preserves served order exactly (does not reorder against the fixed list)', () => {
    expect(resolveQuestionOrder(['b', 'a'], ['a', 'b'])).toEqual(['b', 'a'])
  })
})

// ── toUnifiedResult: standard ────────────────────────────────────────

describe('toUnifiedResult — standard quiz', () => {
  const questions = [
    buildQuestion({ id: 'q1', tags: ['algebra'] }),
    buildQuestion({ id: 'q2', tags: ['algebra'] }),
  ]
  const answers = [
    buildAnswer({ questionId: 'q1', isCorrect: true }),
    buildAnswer({ questionId: 'q2', isCorrect: false, earnedPoints: 0 }),
  ]

  it('produces a grade, pass flag, and per-question review with no ability block', () => {
    const result = toUnifiedResult({
      isAdaptive: false,
      passThreshold: 60,
      attempt: buildAttempt({ score: 80, resolvedQuestionIds: ['q1', 'q2'] }),
      answers,
      questions,
      fixedQuestionIds: ['q1', 'q2'],
    })

    expect(result.grade).toBe(80)
    expect(result.pass).toBe(true)
    expect(result.ability).toBeNull()
    expect(result.isAdaptive).toBe(false)
    expect(result.noQuestionsRecorded).toBe(false)
    expect(result.questionReview).toHaveLength(2)
    expect(result.questionReview[0]).toMatchObject({ questionId: 'q1', isCorrect: true })
    // Adaptive-only detail is omitted for standard reviews.
    expect(result.questionReview[0].softScore).toBeUndefined()
    expect(result.questionReview[0].rationale).toBeUndefined()
  })

  it('marks pass=false when grade is below threshold', () => {
    const result = toUnifiedResult({
      isAdaptive: false,
      passThreshold: 60,
      attempt: buildAttempt({ score: 50, resolvedQuestionIds: ['q1', 'q2'] }),
      answers,
      questions,
      fixedQuestionIds: ['q1', 'q2'],
    })
    expect(result.pass).toBe(false)
  })

  it('uses the boundary rule grade >= threshold', () => {
    const result = toUnifiedResult({
      isAdaptive: false,
      passThreshold: 60,
      attempt: buildAttempt({ score: 60, resolvedQuestionIds: ['q1'] }),
      answers: [buildAnswer({ questionId: 'q1' })],
      questions: [buildQuestion({ id: 'q1' })],
      fixedQuestionIds: ['q1'],
    })
    expect(result.pass).toBe(true)
  })

  it('computes topic insights from answers + question tags', () => {
    const result = toUnifiedResult({
      isAdaptive: false,
      passThreshold: 60,
      attempt: buildAttempt({ resolvedQuestionIds: ['q1', 'q2'] }),
      answers,
      questions,
      fixedQuestionIds: ['q1', 'q2'],
    })
    const algebra = result.topics.topics.find((t) => t.tag === 'algebra')
    expect(algebra).toMatchObject({ correctCount: 1, totalCount: 2, accuracy: 50 })
  })

  it('counts casing and whitespace variants of one tag as a single topic', () => {
    // Tags are free text, and the two things that write them disagree: a
    // professor types "Backprop", the AI generator emits "backprop". Counted
    // literally that is two rows, one at 100% and one at 0%, and the student
    // reads it as two topics they half know. The first spelling seen wins the
    // label, so the row is named the way the student's own first question was.
    const result = toUnifiedResult({
      isAdaptive: false,
      passThreshold: 60,
      attempt: buildAttempt({ resolvedQuestionIds: ['q1', 'q2', 'q3'] }),
      answers: [
        buildAnswer({ questionId: 'q1', isCorrect: true }),
        buildAnswer({ questionId: 'q2', isCorrect: false, earnedPoints: 0 }),
        buildAnswer({ questionId: 'q3', isCorrect: false, earnedPoints: 0 }),
      ],
      questions: [
        buildQuestion({ id: 'q1', tags: ['Backprop'] }),
        buildQuestion({ id: 'q2', tags: ['backprop'] }),
        buildQuestion({ id: 'q3', tags: ['  BACKPROP '] }),
      ],
      fixedQuestionIds: ['q1', 'q2', 'q3'],
    })
    expect(result.topics.topics).toHaveLength(1)
    expect(result.topics.topics[0]).toMatchObject({
      tag: 'Backprop',
      correctCount: 1,
      totalCount: 3,
      accuracy: 33,
    })
  })

  it('keeps two tags that differ by more than casing apart', () => {
    // The fold is deliberately narrower than the skill pool's de-dup key, which
    // strips all punctuation and would merge "C++", "C#" and "C" into one row.
    // On a programming course that mislabels a topic the student cannot correct.
    const result = toUnifiedResult({
      isAdaptive: false,
      passThreshold: 60,
      attempt: buildAttempt({ resolvedQuestionIds: ['q1', 'q2'] }),
      answers: [
        buildAnswer({ questionId: 'q1', isCorrect: true }),
        buildAnswer({ questionId: 'q2', isCorrect: false, earnedPoints: 0 }),
      ],
      questions: [
        buildQuestion({ id: 'q1', tags: ['C++'] }),
        buildQuestion({ id: 'q2', tags: ['C#'] }),
      ],
      fixedQuestionIds: ['q1', 'q2'],
    })
    expect(result.topics.topics.map((t) => t.tag).sort()).toEqual(['C#', 'C++'])
  })
})

// ── toUnifiedResult: adaptive (IRT v2) ───────────────────────────────

describe('toUnifiedResult — adaptive IRT', () => {
  it('exposes θ̂/SE as a separate IRT ability block (never the grade)', () => {
    const result = toUnifiedResult({
      isAdaptive: true,
      passThreshold: 60,
      attempt: buildAttempt({
        score: 72,
        resolvedQuestionIds: ['a1', 'a2', 'a3'],
        cohort: 'adaptive',
        theta: 1.2,
        se: 0.3,
        stopReason: 'precision_reached',
        finalRating: 1450, // present, but IRT θ̂ must win
      }),
      answers: [
        buildAnswer({ questionId: 'a1', isCorrect: null, softScore: 0.9, rationale: 'Strong reasoning', nodesMet: 2, nodesTotal: 3 }),
        buildAnswer({ questionId: 'a2', isCorrect: null, softScore: 0.4 }),
        buildAnswer({ questionId: 'a3', isCorrect: true }),
      ],
      questions: [
        buildQuestion({ id: 'a1', tags: ['nlp'] }),
        buildQuestion({ id: 'a2', tags: ['nlp'] }),
        buildQuestion({ id: 'a3', tags: ['nlp'] }),
      ],
      fixedQuestionIds: [],
    })

    expect(result.grade).toBe(72) // grade is the score, NOT theta
    expect(result.ability).toEqual({
      engine: 'irt',
      theta: 1.2,
      se: 0.3,
      itemsServed: 3,
      stopReason: 'precision_reached',
    })
    // Adaptive per-question detail flows through.
    expect(result.questionReview[0]).toMatchObject({ softScore: 0.9, rationale: 'Strong reasoning', nodesMet: 2, nodesTotal: 3 })
  })

  it('defaults SE to 1 when θ̂ is present but SE is missing', () => {
    const result = toUnifiedResult({
      isAdaptive: true,
      passThreshold: 60,
      attempt: buildAttempt({ resolvedQuestionIds: ['a1'], theta: 0.5, se: null }),
      answers: [buildAnswer({ questionId: 'a1' })],
      questions: [buildQuestion({ id: 'a1' })],
      fixedQuestionIds: [],
    })
    expect(result.ability).toMatchObject({ engine: 'irt', theta: 0.5, se: 1 })
  })

  it('treats soft-score ≥ 0.5 as correct for topic insights, excludes formative items', () => {
    const result = toUnifiedResult({
      isAdaptive: true,
      passThreshold: 60,
      attempt: buildAttempt({ resolvedQuestionIds: ['a1', 'a2', 'a3'], theta: 0.1 }),
      answers: [
        buildAnswer({ questionId: 'a1', isCorrect: null, softScore: 0.8 }), // correct
        buildAnswer({ questionId: 'a2', isCorrect: null, softScore: 0.3 }), // incorrect
        buildAnswer({ questionId: 'a3', isCorrect: false, isFormative: true }), // excluded
      ],
      questions: [
        buildQuestion({ id: 'a1', tags: ['topic'] }),
        buildQuestion({ id: 'a2', tags: ['topic'] }),
        buildQuestion({ id: 'a3', tags: ['topic'] }),
      ],
      fixedQuestionIds: [],
    })
    const topic = result.topics.topics.find((t) => t.tag === 'topic')
    expect(topic).toMatchObject({ correctCount: 1, totalCount: 2 }) // a3 excluded
  })
})

// ── toUnifiedResult: adaptive Elo fallback (v1) ──────────────────────

describe('toUnifiedResult — adaptive Elo fallback', () => {
  it('uses final_rating as an Elo ability block when no IRT θ̂ exists', () => {
    const result = toUnifiedResult({
      isAdaptive: true,
      passThreshold: 60,
      attempt: buildAttempt({ score: 65, resolvedQuestionIds: ['a1'], theta: null, finalRating: 1380, stopReason: 'max_items' }),
      answers: [buildAnswer({ questionId: 'a1' })],
      questions: [buildQuestion({ id: 'a1' })],
      fixedQuestionIds: [],
    })
    expect(result.ability).toEqual({ engine: 'elo', rating: 1380, itemsServed: 1, stopReason: 'max_items' })
  })

  it('omits the ability block when neither θ̂ nor final_rating exists', () => {
    const result = toUnifiedResult({
      isAdaptive: true,
      passThreshold: 60,
      attempt: buildAttempt({ resolvedQuestionIds: ['a1'], theta: null, finalRating: null }),
      answers: [buildAnswer({ questionId: 'a1' })],
      questions: [buildQuestion({ id: 'a1' })],
      fixedQuestionIds: [],
    })
    expect(result.ability).toBeNull()
  })
})

// ── toUnifiedResult: edge cases ──────────────────────────────────────

describe('toUnifiedResult — edge cases', () => {
  it('falls back to the fixed list when the served list is empty (legacy attempt)', () => {
    const result = toUnifiedResult({
      isAdaptive: false,
      passThreshold: 60,
      attempt: buildAttempt({ resolvedQuestionIds: [] }), // no served IDs recorded
      answers: [buildAnswer({ questionId: 'q1' }), buildAnswer({ questionId: 'q2' })],
      questions: [buildQuestion({ id: 'q1' }), buildQuestion({ id: 'q2' })],
      fixedQuestionIds: ['q1', 'q2'],
    })
    expect(result.questionReview.map((r) => r.questionId)).toEqual(['q1', 'q2'])
    expect(result.noQuestionsRecorded).toBe(false)
  })

  it('flags noQuestionsRecorded when neither served nor fixed list resolves anything', () => {
    const result = toUnifiedResult({
      isAdaptive: true,
      passThreshold: 60,
      attempt: buildAttempt({ score: 0, resolvedQuestionIds: [], theta: 0.2 }),
      answers: [],
      questions: [],
      fixedQuestionIds: [],
    })
    expect(result.questionReview).toEqual([])
    expect(result.noQuestionsRecorded).toBe(true)
    // The ability block still renders even with no question review.
    expect(result.ability).toMatchObject({ engine: 'irt' })
  })

  it('skips resolved IDs whose question could not be loaded (e.g. deleted)', () => {
    const result = toUnifiedResult({
      isAdaptive: false,
      passThreshold: 60,
      attempt: buildAttempt({ resolvedQuestionIds: ['q1', 'gone', 'q2'] }),
      answers: [buildAnswer({ questionId: 'q1' }), buildAnswer({ questionId: 'q2' })],
      questions: [buildQuestion({ id: 'q1' }), buildQuestion({ id: 'q2' })],
      fixedQuestionIds: [],
    })
    expect(result.questionReview.map((r) => r.questionId)).toEqual(['q1', 'q2'])
  })

  it('treats a null score as grade 0', () => {
    const result = toUnifiedResult({
      isAdaptive: false,
      passThreshold: 60,
      attempt: buildAttempt({ score: null, resolvedQuestionIds: ['q1'] }),
      answers: [buildAnswer({ questionId: 'q1' })],
      questions: [buildQuestion({ id: 'q1' })],
      fixedQuestionIds: ['q1'],
    })
    expect(result.grade).toBe(0)
    expect(result.pass).toBe(false)
  })
})
