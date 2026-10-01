// Tests for calculateSkillInsights — a pure function that aggregates
// quiz answer correctness by question tag into topic-level accuracy.

import { describe, it, expect } from 'vitest'
import { calculateSkillInsights } from '@/lib/quiz/analytics-utils'

describe('calculateSkillInsights', () => {
  it('returns empty results for empty answers', () => {
    const result = calculateSkillInsights([], {})
    expect(result.topics).toEqual([])
    expect(result.strengths).toEqual([])
    expect(result.weaknesses).toEqual([])
  })

  it('returns 100% accuracy for a single topic with all correct answers', () => {
    const answers = [
      { questionId: 'q1', isCorrect: true },
      { questionId: 'q2', isCorrect: true },
    ]
    const tags = { q1: ['algebra'], q2: ['algebra'] }
    const result = calculateSkillInsights(answers, tags)

    expect(result.topics).toHaveLength(1)
    expect(result.topics[0]).toEqual({
      tag: 'algebra',
      correctCount: 2,
      totalCount: 2,
      accuracy: 100,
      questionCount: 2,
    })
    expect(result.strengths).toContain('algebra')
    expect(result.weaknesses).not.toContain('algebra')
  })

  it('returns 0% accuracy for a single topic with all wrong answers', () => {
    const answers = [
      { questionId: 'q1', isCorrect: false },
      { questionId: 'q2', isCorrect: false },
    ]
    const tags = { q1: ['geometry'], q2: ['geometry'] }
    const result = calculateSkillInsights(answers, tags)

    expect(result.topics[0].accuracy).toBe(0)
    expect(result.topics[0].correctCount).toBe(0)
    expect(result.weaknesses).toContain('geometry')
    expect(result.strengths).not.toContain('geometry')
  })

  it('handles mixed topics with mixed results', () => {
    const answers = [
      { questionId: 'q1', isCorrect: true },
      { questionId: 'q2', isCorrect: false },
      { questionId: 'q3', isCorrect: true },
      { questionId: 'q4', isCorrect: true },
    ]
    const tags = {
      q1: ['algebra'],
      q2: ['algebra'],
      q3: ['calculus'],
      q4: ['calculus'],
    }
    const result = calculateSkillInsights(answers, tags)

    const algebra = result.topics.find((t) => t.tag === 'algebra')!
    const calculus = result.topics.find((t) => t.tag === 'calculus')!

    expect(algebra.accuracy).toBe(50)
    expect(algebra.correctCount).toBe(1)
    expect(algebra.totalCount).toBe(2)

    expect(calculus.accuracy).toBe(100)
    expect(calculus.correctCount).toBe(2)
    expect(calculus.totalCount).toBe(2)

    expect(result.strengths).toContain('calculus')
    expect(result.strengths).not.toContain('algebra')
  })

  it('classifies exactly 80% accuracy as a strength', () => {
    const answers = [
      { questionId: 'q1', isCorrect: true },
      { questionId: 'q2', isCorrect: true },
      { questionId: 'q3', isCorrect: true },
      { questionId: 'q4', isCorrect: true },
      { questionId: 'q5', isCorrect: false },
    ]
    const tags = {
      q1: ['stats'],
      q2: ['stats'],
      q3: ['stats'],
      q4: ['stats'],
      q5: ['stats'],
    }
    const result = calculateSkillInsights(answers, tags)

    expect(result.topics[0].accuracy).toBe(80)
    expect(result.strengths).toContain('stats')
  })

  it('does not classify 79% accuracy as a strength', () => {
    // 11/14 = 78.57 → rounds to 79
    const answers = Array.from({ length: 14 }, (_, i) => ({
      questionId: `q${i}`,
      isCorrect: i < 11,
    }))
    const tags: Record<string, string[]> = {}
    answers.forEach((a) => { tags[a.questionId] = ['topic-a'] })

    const result = calculateSkillInsights(answers, tags)
    expect(result.topics[0].accuracy).toBe(79)
    expect(result.strengths).not.toContain('topic-a')
  })

  it('does not classify exactly 50% accuracy as a weakness', () => {
    const answers = [
      { questionId: 'q1', isCorrect: true },
      { questionId: 'q2', isCorrect: false },
    ]
    const tags = { q1: ['logic'], q2: ['logic'] }
    const result = calculateSkillInsights(answers, tags)

    expect(result.topics[0].accuracy).toBe(50)
    expect(result.weaknesses).not.toContain('logic')
  })

  it('classifies 49% accuracy as a weakness', () => {
    // 34/70 = 48.57 → rounds to 49
    const answers = Array.from({ length: 70 }, (_, i) => ({
      questionId: `q${i}`,
      isCorrect: i < 34,
    }))
    const tags: Record<string, string[]> = {}
    answers.forEach((a) => { tags[a.questionId] = ['topic-b'] })

    const result = calculateSkillInsights(answers, tags)
    expect(result.topics[0].accuracy).toBe(49)
    expect(result.weaknesses).toContain('topic-b')
  })

  it('counts a question with multiple tags once per tag', () => {
    const answers = [{ questionId: 'q1', isCorrect: true }]
    const tags = { q1: ['algebra', 'equations', 'linear'] }
    const result = calculateSkillInsights(answers, tags)

    expect(result.topics).toHaveLength(3)
    result.topics.forEach((topic) => {
      expect(topic.correctCount).toBe(1)
      expect(topic.totalCount).toBe(1)
      expect(topic.accuracy).toBe(100)
      expect(topic.questionCount).toBe(1)
    })
  })

  it('ignores questions without tags in questionTags map', () => {
    const answers = [
      { questionId: 'q1', isCorrect: true },
      { questionId: 'q2', isCorrect: false },
      { questionId: 'q3', isCorrect: true },
    ]
    // Only q1 has tags; q2 and q3 are not in the map
    const tags = { q1: ['tagged-topic'] }
    const result = calculateSkillInsights(answers, tags)

    expect(result.topics).toHaveLength(1)
    expect(result.topics[0].tag).toBe('tagged-topic')
    expect(result.topics[0].totalCount).toBe(1)
  })

  it('ignores questions whose tags array is empty', () => {
    const answers = [
      { questionId: 'q1', isCorrect: true },
      { questionId: 'q2', isCorrect: true },
    ]
    const tags = { q1: [], q2: ['real-topic'] }
    const result = calculateSkillInsights(answers, tags)

    expect(result.topics).toHaveLength(1)
    expect(result.topics[0].tag).toBe('real-topic')
  })

  it('sorts topics by totalCount descending', () => {
    const answers = [
      { questionId: 'q1', isCorrect: true },
      { questionId: 'q2', isCorrect: true },
      { questionId: 'q3', isCorrect: true },
      { questionId: 'q4', isCorrect: false },
      { questionId: 'q5', isCorrect: true },
    ]
    const tags = {
      q1: ['rare-topic'],
      q2: ['common-topic'],
      q3: ['common-topic'],
      q4: ['common-topic'],
      q5: ['mid-topic'],
    }
    const result = calculateSkillInsights(answers, tags)

    expect(result.topics[0].tag).toBe('common-topic')
    expect(result.topics[0].totalCount).toBe(3)
    expect(result.topics[1].totalCount).toBeLessThanOrEqual(result.topics[0].totalCount)
    expect(result.topics[2].totalCount).toBeLessThanOrEqual(result.topics[1].totalCount)
  })

  it('counts the same question answered multiple times per answer entry', () => {
    // A question answered twice (e.g., across different quiz attempts)
    const answers = [
      { questionId: 'q1', isCorrect: true },
      { questionId: 'q1', isCorrect: false },
    ]
    const tags = { q1: ['repetition'] }
    const result = calculateSkillInsights(answers, tags)

    expect(result.topics[0].totalCount).toBe(2)
    expect(result.topics[0].correctCount).toBe(1)
    expect(result.topics[0].accuracy).toBe(50)
    // questionCount is unique question IDs, so still 1
    expect(result.topics[0].questionCount).toBe(1)
  })

  it('handles a realistic multi-tag multi-question scenario', () => {
    const answers = [
      { questionId: 'q1', isCorrect: true },
      { questionId: 'q2', isCorrect: false },
      { questionId: 'q3', isCorrect: true },
      { questionId: 'q4', isCorrect: true },
      { questionId: 'q5', isCorrect: false },
    ]
    const tags = {
      q1: ['algebra', 'linear'],
      q2: ['algebra', 'quadratic'],
      q3: ['linear'],
      q4: ['calculus'],
      q5: ['calculus'],
    }
    const result = calculateSkillInsights(answers, tags)

    const algebra = result.topics.find((t) => t.tag === 'algebra')!
    expect(algebra.correctCount).toBe(1)
    expect(algebra.totalCount).toBe(2)
    expect(algebra.accuracy).toBe(50)
    expect(algebra.questionCount).toBe(2)

    const linear = result.topics.find((t) => t.tag === 'linear')!
    expect(linear.correctCount).toBe(2)
    expect(linear.totalCount).toBe(2)
    expect(linear.accuracy).toBe(100)
    expect(linear.questionCount).toBe(2)

    const quadratic = result.topics.find((t) => t.tag === 'quadratic')!
    expect(quadratic.correctCount).toBe(0)
    expect(quadratic.totalCount).toBe(1)
    expect(quadratic.accuracy).toBe(0)
    expect(quadratic.questionCount).toBe(1)

    const calculus = result.topics.find((t) => t.tag === 'calculus')!
    expect(calculus.correctCount).toBe(1)
    expect(calculus.totalCount).toBe(2)
    expect(calculus.accuracy).toBe(50)
    expect(calculus.questionCount).toBe(2)

    expect(result.strengths).toContain('linear')
    expect(result.weaknesses).toContain('quadratic')
  })
})
