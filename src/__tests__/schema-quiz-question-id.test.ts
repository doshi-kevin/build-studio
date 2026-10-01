import { describe, it, expect } from 'vitest'
import { createQuestionServerSchema } from '@/lib/validations/quiz'

// The optional `id` on createQuestionServerSchema is load-bearing: when present
// it becomes the quiz_questions row PK, which the wizard relies on to correlate
// created rows back to client questions. If this validation ever loosens, a
// non-UUID could poison the insert — so pin the contract.
const base = {
  questionText: 'Is the sky blue?',
  difficulty: 'medium' as const,
  content: { questionType: 'true_false' as const, correctAnswer: true },
}

describe('createQuestionServerSchema.id', () => {
  it('accepts a valid UUID', () => {
    const parsed = createQuestionServerSchema.safeParse({
      ...base,
      id: '11111111-1111-4111-8111-111111111111',
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.id).toBe('11111111-1111-4111-8111-111111111111')
  })

  it('accepts an omitted id (falls back to the DB column default)', () => {
    const parsed = createQuestionServerSchema.safeParse(base)
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.id).toBeUndefined()
  })

  it('rejects a non-UUID id', () => {
    const parsed = createQuestionServerSchema.safeParse({ ...base, id: 'not-a-uuid' })
    expect(parsed.success).toBe(false)
  })
})
