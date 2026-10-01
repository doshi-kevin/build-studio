// Tests for the overrideAnswerScoreSchema Zod validation
import { describe, it, expect } from 'vitest'
import { overrideAnswerScoreSchema } from '@/lib/validations/quiz'

describe('overrideAnswerScoreSchema', () => {
  it('accepts valid override with points and reason', () => {
    const result = overrideAnswerScoreSchema.safeParse({
      overridePoints: 5,
      overrideReason: 'Accepted alternate phrasing',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.overridePoints).toBe(5)
      expect(result.data.overrideReason).toBe('Accepted alternate phrasing')
    }
  })

  it('accepts zero points (full deduction)', () => {
    const result = overrideAnswerScoreSchema.safeParse({
      overridePoints: 0,
      overrideReason: '',
    })
    expect(result.success).toBe(true)
  })

  it('accepts override with no reason (defaults to empty string)', () => {
    const result = overrideAnswerScoreSchema.safeParse({
      overridePoints: 3,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.overrideReason).toBe('')
    }
  })

  it('rejects negative points', () => {
    const result = overrideAnswerScoreSchema.safeParse({
      overridePoints: -1,
      overrideReason: '',
    })
    expect(result.success).toBe(false)
  })

  it('rejects points exceeding 100', () => {
    const result = overrideAnswerScoreSchema.safeParse({
      overridePoints: 101,
      overrideReason: '',
    })
    expect(result.success).toBe(false)
  })

  it('rejects non-numeric points', () => {
    const result = overrideAnswerScoreSchema.safeParse({
      overridePoints: 'five',
      overrideReason: '',
    })
    expect(result.success).toBe(false)
  })

  it('rejects reason longer than 500 characters', () => {
    const result = overrideAnswerScoreSchema.safeParse({
      overridePoints: 5,
      overrideReason: 'x'.repeat(501),
    })
    expect(result.success).toBe(false)
  })

  it('accepts fractional points (partial credit)', () => {
    const result = overrideAnswerScoreSchema.safeParse({
      overridePoints: 2.5,
      overrideReason: 'Partial credit for approach',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.overridePoints).toBe(2.5)
    }
  })

  it('accepts exactly 100 points (boundary)', () => {
    const result = overrideAnswerScoreSchema.safeParse({
      overridePoints: 100,
      overrideReason: '',
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing overridePoints', () => {
    const result = overrideAnswerScoreSchema.safeParse({
      overrideReason: 'No points provided',
    })
    expect(result.success).toBe(false)
  })
})
