// Pure-helper tests for the re-engagement copy library: tier bucketing, deterministic
// rotation, and token fill (own-data only, graceful when a field is missing).
import { describe, it, expect } from 'vitest'
import {
  tierForDays,
  seedFromId,
  pickReengagementCopy,
  REENGAGEMENT_TIERS,
} from '@/lib/notifications/re-engagement-copy'

describe('tierForDays', () => {
  it('returns null below the smallest tier', () => {
    expect(tierForDays(0)).toBeNull()
    expect(tierForDays(2)).toBeNull()
  })

  it('returns the highest tier crossed', () => {
    expect(tierForDays(3)).toBe(3)
    expect(tierForDays(6)).toBe(3)
    expect(tierForDays(7)).toBe(7)
    expect(tierForDays(13)).toBe(7)
    expect(tierForDays(14)).toBe(14)
    expect(tierForDays(29)).toBe(14)
    expect(tierForDays(30)).toBe(30)
    expect(tierForDays(90)).toBe(30)
  })
})

describe('seedFromId', () => {
  it('is deterministic, non-negative, and varies by id', () => {
    expect(seedFromId('abc')).toBe(seedFromId('abc'))
    expect(seedFromId('abc')).toBeGreaterThanOrEqual(0)
    expect(seedFromId('a')).not.toBe(seedFromId('b'))
  })
})

describe('pickReengagementCopy', () => {
  it('fills own-data tokens and leaves no placeholders', () => {
    const copy = pickReengagementCopy(
      7,
      { name: 'Priya Kumar', courseLabel: 'CS 546', daysDormant: 9 },
      0,
    )
    const all = `${copy.title} ${copy.body}`
    expect(all).not.toMatch(/\{(name|course|days)\}/) // no leftover tokens
    expect(all).toContain('CS 546') // own course rendered
    expect(all).toContain('Priya') // first name only, not the full name
    expect(all).not.toContain('Kumar')
  })

  it('degrades gracefully for every tier when name/course are missing', () => {
    for (const tier of REENGAGEMENT_TIERS) {
      const copy = pickReengagementCopy(tier, { name: null, courseLabel: null, daysDormant: tier }, 0)
      const all = `${copy.title} ${copy.body}`
      expect(all).not.toMatch(/undefined|\{|\}/) // no leaked nulls or braces
      expect(copy.title.length).toBeGreaterThan(0)
      expect(copy.body.length).toBeGreaterThan(0)
    }
  })

  it('is deterministic for a given seed', () => {
    const ctx = { name: 'A', courseLabel: 'X', daysDormant: 3 }
    expect(pickReengagementCopy(3, ctx, 5)).toEqual(pickReengagementCopy(3, ctx, 5))
  })
})
