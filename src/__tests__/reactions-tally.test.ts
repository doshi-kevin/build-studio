// The professor's live reaction badges are driven by tallyReactions. It must
// (a) count DISTINCT students per kind (one student mashing a button = 1) and
// (b) drop reactions older than the window so the signal decays. A regression
// would either inflate the pacing signal or leave stale reactions on screen.
import { describe, it, expect } from 'vitest'
import { tallyReactions } from '@/lib/live-classroom/broadcast/use-reactions'

const WINDOW = 8000
const at = (kind: 'confused' | 'slow_down' | 'got_it' | 'speed_up', userId: string, t: number) =>
  ({ kind, userId, at: t })

describe('tallyReactions', () => {
  it('counts one per kind across distinct users', () => {
    const out = tallyReactions(
      [at('confused', 'a', 1000), at('confused', 'b', 1000), at('slow_down', 'c', 1000)],
      2000,
      WINDOW,
    )
    expect(out).toEqual({ confused: 2, slow_down: 1, got_it: 0, speed_up: 0 })
  })

  it('counts the same user twice on one kind as a single signal', () => {
    const out = tallyReactions(
      [at('confused', 'a', 1000), at('confused', 'a', 1500)],
      2000,
      WINDOW,
    )
    expect(out.confused).toBe(1)
  })

  it('excludes reactions older than the window (decay)', () => {
    const now = 20000
    const out = tallyReactions(
      [at('confused', 'a', 1000), at('got_it', 'b', now - 1000)],
      now,
      WINDOW,
    )
    // 'a' is 19s old → dropped; 'b' is 1s old → kept.
    expect(out).toEqual({ confused: 0, slow_down: 0, got_it: 1, speed_up: 0 })
  })

  it('returns all-zero for no events', () => {
    expect(tallyReactions([], 5000, WINDOW)).toEqual({
      confused: 0,
      slow_down: 0,
      got_it: 0,
      speed_up: 0,
    })
  })

  it('keeps a reaction exactly at the window boundary', () => {
    const out = tallyReactions([at('speed_up', 'a', 0)], WINDOW, WINDOW)
    expect(out.speed_up).toBe(1)
  })
})
