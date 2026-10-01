// Tests for project validation schemas — business defaults, status/visibility enums,
// phase status default, and member role default. Trivial Zod built-in tests
// (min/max/required/partial/happy-path) removed.

import { describe, it, expect } from 'vitest'
import {
  createProjectSchema,
  createPhaseSchema,
  addMemberSchema,
} from '@/lib/validations/project'

// ── createProjectSchema ──────────────────────────────────────

describe('createProjectSchema', () => {
  const parse = (data: unknown) => createProjectSchema.safeParse(data)

  it('accepts valid project with defaults', () => {
    const result = parse({ title: 'My Project' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.status).toBe('active')
      expect(result.data.visibility).toBe('course')
      expect(result.data.max_team_size).toBe(5)
    }
  })

  it('accepts all valid statuses', () => {
    for (const status of ['draft', 'active', 'completed', 'archived']) {
      expect(parse({ title: 'Test', status }).success).toBe(true)
    }
  })

  it('accepts all valid visibilities', () => {
    for (const visibility of ['private', 'course', 'public']) {
      expect(parse({ title: 'Test', visibility }).success).toBe(true)
    }
  })
})

// ── createPhaseSchema ────────────────────────────────────────

describe('createPhaseSchema', () => {
  const parse = (data: unknown) => createPhaseSchema.safeParse(data)

  it('defaults status to not_started', () => {
    const result = parse({ title: 'Test' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.status).toBe('not_started')
  })
})

// ── addMemberSchema ──────────────────────────────────────────

describe('addMemberSchema', () => {
  const parse = (data: unknown) => addMemberSchema.safeParse(data)

  it('defaults role to member', () => {
    const result = parse({ user_id: 'user-1' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.role).toBe('member')
  })
})
