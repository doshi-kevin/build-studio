import { describe, it, expect } from 'vitest'
import { levelRank, maxLevel, capLevel } from '@/lib/jobs/pipelines/outcome-alignment/types'

// The level algebra encodes two load-bearing invariants the whole pipeline
// rests on: "highest justified level wins" (maxLevel) and "lectures cap at
// Reinforced" (capLevel). A silent comparison flip here would corrupt every
// alignment row without failing an integration test — so guard them directly.

describe('outcome-alignment level algebra', () => {
  it('ranks I < R < M', () => {
    expect(levelRank('I')).toBeLessThan(levelRank('R'))
    expect(levelRank('R')).toBeLessThan(levelRank('M'))
  })

  it('maxLevel returns the higher level, order-independent', () => {
    expect(maxLevel('R', 'M')).toBe('M')
    expect(maxLevel('M', 'R')).toBe('M')
    expect(maxLevel('I', 'R')).toBe('R')
    expect(maxLevel('R', 'R')).toBe('R')
  })

  it('capLevel clamps down but never promotes', () => {
    expect(capLevel('M', 'R')).toBe('R') // the lecture-caps-at-Reinforced invariant
    expect(capLevel('I', 'R')).toBe('I') // below cap → untouched
    expect(capLevel('R', 'R')).toBe('R') // at cap
    expect(capLevel('I', 'M')).toBe('I') // never promotes toward the cap
  })
})
