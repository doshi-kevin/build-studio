// Tests for seededShuffle — must be deterministic per seed and produce
// a different order for different seeds.

import { describe, it, expect } from 'vitest'
import { seededShuffle } from '@/lib/live-classroom/shuffle'

describe('seededShuffle', () => {
  const choices = ['A', 'B', 'C', 'D', 'E']

  it('returns the same items', () => {
    const result = seededShuffle(choices, 'seed-1')
    expect([...result].sort()).toEqual([...choices].sort())
  })

  it('is deterministic for the same seed', () => {
    const a = seededShuffle(choices, 'student-42:int-7')
    const b = seededShuffle(choices, 'student-42:int-7')
    expect(a).toEqual(b)
  })

  it('produces different orders for different seeds', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 50; i++) {
      seen.add(seededShuffle(choices, `seed-${i}`).join(''))
    }
    // With 5! = 120 possible permutations and 50 seeds, we should see at
    // least a few distinct orders.
    expect(seen.size).toBeGreaterThan(5)
  })

  it('handles empty and single-element arrays', () => {
    expect(seededShuffle([], 'x')).toEqual([])
    expect(seededShuffle(['only'], 'x')).toEqual(['only'])
  })

  it('does not mutate the input', () => {
    const input = ['A', 'B', 'C']
    seededShuffle(input, 'x')
    expect(input).toEqual(['A', 'B', 'C'])
  })
})
