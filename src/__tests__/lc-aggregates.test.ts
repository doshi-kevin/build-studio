// Pure-function tests for the aggregate helpers.

import { describe, it, expect } from 'vitest'
import {
  computePollAggregate,
  computeQuizAggregate,
  scoreQuizResponse,
} from '@/lib/live-classroom/interactions/aggregates'

describe('computePollAggregate', () => {
  const choices = [
    { id: 'a', text: 'A' },
    { id: 'b', text: 'B' },
    { id: 'c', text: 'C' },
  ]

  it('zeroes all choices when no responses', () => {
    const agg = computePollAggregate(choices, [])
    expect(agg.counts).toEqual({ a: 0, b: 0, c: 0 })
    expect(agg.total).toBe(0)
  })

  it('counts single-choice responses', () => {
    const agg = computePollAggregate(choices, [
      { choiceIds: ['a'] },
      { choiceIds: ['a'] },
      { choiceIds: ['b'] },
    ])
    expect(agg.counts).toEqual({ a: 2, b: 1, c: 0 })
    expect(agg.total).toBe(3)
  })

  it('counts multiple-choice responses', () => {
    const agg = computePollAggregate(choices, [
      { choiceIds: ['a', 'b'] },
      { choiceIds: ['b', 'c'] },
    ])
    expect(agg.counts).toEqual({ a: 1, b: 2, c: 1 })
    expect(agg.total).toBe(2)
  })

  it('buckets word-cloud responses case-insensitively', () => {
    const agg = computePollAggregate([], [
      { text: 'JavaScript' },
      { text: 'javascript' },
      { text: 'TypeScript' },
    ])
    expect(agg.counts).toEqual({ javascript: 2, typescript: 1 })
    expect(agg.total).toBe(3)
  })
})

describe('computeQuizAggregate', () => {
  it('returns submission count', () => {
    expect(computeQuizAggregate([])).toEqual({ submissions: 0 })
    expect(computeQuizAggregate([{}, {}, {}])).toEqual({ submissions: 3 })
  })
})

describe('scoreQuizResponse', () => {
  const questions = [
    { id: 'q1', correctChoiceId: 'a' },
    { id: 'q2', correctChoiceId: 'b' },
    { id: 'q3', correctChoiceId: 'c' },
  ]

  it('returns 0 when answers empty', () => {
    expect(scoreQuizResponse(questions, {})).toBe(0)
  })

  it('returns 1 when all correct', () => {
    expect(scoreQuizResponse(questions, { q1: 'a', q2: 'b', q3: 'c' })).toBe(1)
  })

  it('returns partial when some correct', () => {
    expect(scoreQuizResponse(questions, { q1: 'a', q2: 'wrong', q3: 'c' })).toBeCloseTo(2 / 3)
  })

  it('returns 0 for empty questions', () => {
    expect(scoreQuizResponse([], { q1: 'a' })).toBe(0)
  })
})
