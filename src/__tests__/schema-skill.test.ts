// Tests for Skill Mastery validation schemas.
// Per repo convention, only non-trivial behavior is tested: the shared
// trim+bounds name rule, parentId's null/absent/uuid tri-state, the subtopics
// default, and the applySkillSuggestions array bounds. Trivial uuid/required
// checks are not restated.

import { describe, it, expect } from 'vitest'
import {
  addSkillSchema,
  suggestedSkillSchema,
  applySkillSuggestionsSchema,
  TOPIC_NAME_MAX,
} from '@/lib/validations/skill'

const UUID = '550e8400-e29b-41d4-a716-446655440000'

// ── skill name rule (shared via addSkillSchema.name) ─────────

describe('skill name rule', () => {
  const parse = (name: unknown) =>
    addSkillSchema.safeParse({ sectionId: UUID, name })

  it('trims surrounding whitespace', () => {
    const result = parse('  Algebra  ')
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.name).toBe('Algebra')
  })

  it('rejects a name that is only whitespace (empty after trim)', () => {
    expect(parse('   ').success).toBe(false)
  })

  it(`accepts a name at the ${TOPIC_NAME_MAX}-char limit`, () => {
    expect(parse('a'.repeat(TOPIC_NAME_MAX)).success).toBe(true)
  })

  it('rejects a name over the limit', () => {
    expect(parse('a'.repeat(TOPIC_NAME_MAX + 1)).success).toBe(false)
  })
})

// ── addSkillSchema.parentId tri-state ────────────────────────

describe('addSkillSchema parentId', () => {
  const parse = (parentId: unknown) =>
    addSkillSchema.safeParse({ sectionId: UUID, name: 'X', parentId })

  it('accepts an absent parentId (main skill)', () => {
    expect(addSkillSchema.safeParse({ sectionId: UUID, name: 'X' }).success).toBe(true)
  })

  it('accepts an explicit null parentId (main skill)', () => {
    expect(parse(null).success).toBe(true)
  })

  it('accepts a uuid parentId (subtopic)', () => {
    expect(parse(UUID).success).toBe(true)
  })

  it('rejects a non-uuid parentId', () => {
    expect(parse('not-a-uuid').success).toBe(false)
  })
})

// ── suggestedSkillSchema ─────────────────────────────────────

describe('suggestedSkillSchema', () => {
  it('defaults subtopics to an empty array when absent', () => {
    const result = suggestedSkillSchema.safeParse({ name: 'Algebra' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.subtopics).toEqual([])
  })

  it('rejects info longer than 500 chars', () => {
    const result = suggestedSkillSchema.safeParse({
      name: 'Algebra',
      info: 'a'.repeat(501),
    })
    expect(result.success).toBe(false)
  })
})

// ── applySkillSuggestionsSchema array bounds ─────────────────

describe('applySkillSuggestionsSchema', () => {
  const parse = (count: number) =>
    applySkillSuggestionsSchema.safeParse({
      sectionId: UUID,
      skills: Array.from({ length: count }, (_, i) => ({ name: `T${i}` })),
    })

  it('rejects an empty skills array', () => {
    expect(parse(0).success).toBe(false)
  })

  it('accepts a single skill', () => {
    expect(parse(1).success).toBe(true)
  })

  it('accepts the max of 60 skills', () => {
    expect(parse(60).success).toBe(true)
  })

  it('rejects more than 60 skills', () => {
    expect(parse(61).success).toBe(false)
  })
})
