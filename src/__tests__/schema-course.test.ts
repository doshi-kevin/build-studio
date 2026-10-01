// Tests for course validation schemas — custom transform, business-critical integer constraint,
// and status enum. Trivial Zod built-in tests (min/max/uuid/partial) removed.

import { describe, it, expect } from 'vitest'
import { createCourseSchema } from '@/lib/validations/course'

describe('createCourseSchema', () => {
  const parse = (data: unknown) => createCourseSchema.safeParse(data)

  const validCourse = {
    department_id: '550e8400-e29b-41d4-a716-446655440000',
    code: 'CS201',
    title: 'Data Structures',
    status: 'active',
  }

  it('uppercases course code', () => {
    const result = parse({ ...validCourse, code: 'cs201' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.code).toBe('CS201')
  })

  it('rejects fractional credits', () => {
    expect(parse({ ...validCourse, credits: 3.5 }).success).toBe(false)
  })

  it('accepts all valid statuses', () => {
    for (const status of ['active', 'inactive', 'archived']) {
      expect(parse({ ...validCourse, status }).success).toBe(true)
    }
  })
})
