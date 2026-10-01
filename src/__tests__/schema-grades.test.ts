// Tests for grades validation schema — letter grade enum set, nullable grade clearing,
// and invalid grade rejection. Trivial Zod built-in tests (min/max/boundary) removed.

import { describe, it, expect } from 'vitest'
import { updateGradeSchema } from '@/lib/validations/grades'

describe('updateGradeSchema (grades)', () => {
  const parse = (data: unknown) => updateGradeSchema.safeParse(data)

  const validGrades = ['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'F']

  it.each(validGrades)('accepts letter grade "%s"', (grade) => {
    expect(parse({ finalGrade: grade, finalScore: 50 }).success).toBe(true)
  })

  it('accepts null grade (clearing)', () => {
    expect(parse({ finalGrade: null, finalScore: 80 }).success).toBe(true)
  })

  it('rejects invalid letter grade', () => {
    expect(parse({ finalGrade: 'E', finalScore: 50 }).success).toBe(false)
  })
})
