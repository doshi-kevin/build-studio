// Tests for student validation schemas — email transform, CWID regex, and status enum only.
// Trivial Zod built-in tests (min/max/required/optional/happy-path) were removed.

import { describe, it, expect } from 'vitest'
import {
  createStudentSchema,
} from '@/lib/validations/student'

// ── createStudentSchema ──────────────────────────────────────

describe('createStudentSchema', () => {
  const parse = (data: unknown) => createStudentSchema.safeParse(data)

  const validStudent = {
    email: 'Alice@University.EDU',
    first_name: 'Alice',
    last_name: 'Johnson',
    cwid: '12345678',
  }

  it('lowercases and trims email', () => {
    const result = parse(validStudent)
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.email).toBe('alice@university.edu')
  })

  it('requires exactly 8-digit CWID', () => {
    expect(parse({ ...validStudent, cwid: '12345678' }).success).toBe(true)
    expect(parse({ ...validStudent, cwid: '1234567' }).success).toBe(false) // too short
    expect(parse({ ...validStudent, cwid: '123456789' }).success).toBe(false) // too long
    expect(parse({ ...validStudent, cwid: 'abcdefgh' }).success).toBe(false) // not digits
  })

  it('accepts valid status values', () => {
    for (const status of ['active', 'inactive', 'suspended']) {
      expect(parse({ ...validStudent, status }).success).toBe(true)
    }
  })

  it('rejects invalid status', () => {
    expect(parse({ ...validStudent, status: 'expelled' }).success).toBe(false)
  })
})
