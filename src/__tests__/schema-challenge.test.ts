// Tests for challenge validation schemas — business defaults, enum sets, and non-obvious defaults only.
// Trivial Zod built-in tests (min/max/required/optional/happy-path) were removed.

import { describe, it, expect } from 'vitest'
import {
  createChallengeSchema,
  proposeChallengeSchema,
  createBadgeSchema,
  submitSolutionSchema,
} from '@/lib/validations/challenge'

// ── createChallengeSchema ────────────────────────────────────

describe('createChallengeSchema', () => {
  const parse = (data: unknown) => createChallengeSchema.safeParse(data)

  it('accepts valid challenge with defaults', () => {
    const result = parse({ title: 'Build a REST API' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.type).toBe('general')
      expect(result.data.difficulty).toBe('medium')
      expect(result.data.points).toBe(10)
      expect(result.data.bonus_points).toBe(0)
      // skill_ids must default to [] (the actions spread it into inserts).
      expect(result.data.skill_ids).toEqual([])
    }
  })

  it('accepts all challenge types', () => {
    for (const type of ['general', 'coding', 'puzzle', 'research', 'creative', 'discussion']) {
      expect(parse({ title: 'Test', type }).success).toBe(true)
    }
  })

  it('accepts all difficulty levels', () => {
    for (const difficulty of ['easy', 'medium', 'hard', 'expert']) {
      expect(parse({ title: 'Test', difficulty }).success).toBe(true)
    }
  })
})

// ── proposeChallengeSchema ───────────────────────────────────

describe('proposeChallengeSchema', () => {
  const parse = (data: unknown) => proposeChallengeSchema.safeParse(data)

  it('defaults to general type and medium difficulty', () => {
    const result = parse({ title: 'Test' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.type).toBe('general')
      expect(result.data.difficulty).toBe('medium')
    }
  })
})

// ── createBadgeSchema ────────────────────────────────────────

describe('createBadgeSchema', () => {
  const parse = (data: unknown) => createBadgeSchema.safeParse(data)

  it('defaults icon to trophy emoji', () => {
    const result = parse({ name: 'Test Badge' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.icon).toBe('🏆')
  })
})

/**
 * A solution Link accepted `javascript:alert(1)` (#700).
 *
 * `z.string().url()` was the only check, and that URL is SYNTACTICALLY VALID — Zod has no
 * opinion about schemes. So it was stored and rendered as a real anchor on both the
 * student's My Claims board and the professor's review panel, and the only thing stopping
 * execution was React 19's own href guard: a framework behaviour the app doesn't own and
 * wouldn't keep on any other render path (an export, an email, a PDF, a server-rendered
 * link).
 *
 * The direction that matters is student → professor, since the professor opens submissions
 * in order to grade them.
 *
 * Asserting the SCHEME rather than the message, so rewording the copy doesn't fail the
 * test but weakening the check does.
 */
describe('submitSolutionSchema — link scheme (#700)', () => {
  const parse = (url: string) =>
    submitSolutionSchema.safeParse({ submission_type: 'link', url })

  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',   // case must not be a bypass
    '  javascript:alert(1)', // nor leading whitespace
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
  ])('rejects %s', (url) => {
    expect(parse(url).success).toBe(false)
  })

  it.each([
    'https://github.com/example/repo',
    'http://localhost:3000/x',
    'HTTPS://SHOUTING.EXAMPLE/ok',
  ])('still accepts %s', (url) => {
    expect(parse(url).success).toBe(true)
  })

  it('still accepts an empty url, since Link is one of several submission types', () => {
    expect(submitSolutionSchema.safeParse({ submission_type: 'text', content: 'hi', url: '' }).success).toBe(true)
  })
})
