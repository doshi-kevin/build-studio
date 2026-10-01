// Tests for department validation schemas — code transform and regex only.
// Trivial Zod built-in tests (min/max/required/optional/happy-path) were removed.

import { describe, it, expect } from 'vitest'
import {
  createDepartmentSchema,
} from '@/lib/validations/department'

// ── createDepartmentSchema ───────────────────────────────────

describe('createDepartmentSchema', () => {
  const parse = (data: unknown) => createDepartmentSchema.safeParse(data)

  const validDept = {
    name: 'Computer Science',
    code: 'CS',
    status: 'active',
  }

  it('uppercases department code', () => {
    const result = parse({ ...validDept, code: 'cs-101' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.code).toBe('CS-101')
  })

  it('rejects code with special characters', () => {
    expect(parse({ ...validDept, code: 'CS@101' }).success).toBe(false)
    expect(parse({ ...validDept, code: 'CS 101' }).success).toBe(false)
  })

  it('accepts code with hyphens', () => {
    expect(parse({ ...validDept, code: 'CS-EE' }).success).toBe(true)
  })
})
