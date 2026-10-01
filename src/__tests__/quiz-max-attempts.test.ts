// Max Attempts semantics (issue #43): null = no limit, and there is no ceiling.
// The gate lives in one helper because five surfaces read it — the two server-side
// start guards and the student card/detail — and disagreement between them is either
// a student locked out of a retake or one handed an extra attempt.

import { describe, it, expect } from 'vitest'
import {
  attemptsExhausted,
  quizSchema,
  updateQuizServerSchema,
  MAX_ATTEMPTS_CEILING,
} from '@/lib/validations/quiz'

describe('attemptsExhausted', () => {
  it('never exhausts when maxAttempts is null (no limit)', () => {
    expect(attemptsExhausted(null, 0)).toBe(false)
    expect(attemptsExhausted(null, 1)).toBe(false)
    expect(attemptsExhausted(null, 500)).toBe(false)
  })

  it('fails CLOSED when the value is missing entirely', () => {
    // Callers read max_attempts off a DB row. If one ever narrows its select and drops the
    // column, the gate must lock rather than silently uncap the quiz.
    expect(attemptsExhausted(undefined, 0)).toBe(true)
  })

  it('exhausts at the cap, not before', () => {
    expect(attemptsExhausted(1, 0)).toBe(false)
    expect(attemptsExhausted(1, 1)).toBe(true)
    expect(attemptsExhausted(3, 2)).toBe(false)
    expect(attemptsExhausted(3, 3)).toBe(true)
    // a count past the cap (attempt rows added out of band) still reads as exhausted
    expect(attemptsExhausted(3, 4)).toBe(true)
  })
})

describe('maxAttempts validation', () => {
  const base = {
    id: 'q1',
    sectionId: 's1',
    title: 'Quiz',
    createdAt: '2026-08-05T00:00:00Z',
    updatedAt: '2026-08-05T00:00:00Z',
  }

  it('accepts high values — the old .max(10) rejected the 99 professors asked for', () => {
    expect(quizSchema.parse({ ...base, maxAttempts: 99 }).maxAttempts).toBe(99)
    expect(updateQuizServerSchema.safeParse({ maxAttempts: 99 }).success).toBe(true)
  })

  it('takes null as no limit, but defaults to 1 — unlimited is chosen, not inherited', () => {
    expect(quizSchema.parse({ ...base, maxAttempts: null }).maxAttempts).toBeNull()
    expect(quizSchema.parse(base).maxAttempts).toBe(1)
    expect(updateQuizServerSchema.safeParse({ maxAttempts: null }).success).toBe(true)
  })

  it('still rejects zero and negative attempt counts', () => {
    expect(quizSchema.safeParse({ ...base, maxAttempts: 0 }).success).toBe(false)
    expect(updateQuizServerSchema.safeParse({ maxAttempts: -1 }).success).toBe(false)
  })

  it('rejects a value that would overflow the int4 column', () => {
    // Not the old cap coming back: past this you want "no limit" (null), and an
    // unbounded schema turned a fat-fingered number into an opaque Postgres save error.
    expect(quizSchema.safeParse({ ...base, maxAttempts: MAX_ATTEMPTS_CEILING }).success).toBe(true)
    expect(quizSchema.safeParse({ ...base, maxAttempts: 3_000_000_000 }).success).toBe(false)
    expect(updateQuizServerSchema.safeParse({ maxAttempts: 3_000_000_000 }).success).toBe(false)
  })
})
