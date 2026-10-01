// Logic tests for the live-quiz countdown math (quizTimeRemaining). The risky
// part is the clamp to [0, totalSeconds] that keeps a skewed client clock from
// showing negative time or MORE than the limit (the countdown is computed from
// the server-assigned opened_at, but ticks against the client's Date.now()).
import { describe, it, expect } from 'vitest'
import { quizTimeRemaining, formatTime } from '@/lib/quiz/utils'

const OPENED = '2026-06-09T01:00:00.000Z'
const T0 = new Date(OPENED).getTime()

describe('quizTimeRemaining', () => {
  it('returns the full limit when openedAt is null (not opened yet)', () => {
    expect(quizTimeRemaining(null, 60, T0)).toBe(60)
  })

  it('returns the full limit at the instant it opened', () => {
    expect(quizTimeRemaining(OPENED, 60, T0)).toBe(60)
  })

  it('counts down as time elapses', () => {
    expect(quizTimeRemaining(OPENED, 60, T0 + 30_000)).toBe(30)
    expect(quizTimeRemaining(OPENED, 120, T0 + 100_000)).toBe(20)
    expect(quizTimeRemaining(OPENED, 300, T0 + 1_000)).toBe(299)
  })

  it('clamps to 0 once the limit is reached or exceeded (time is up)', () => {
    expect(quizTimeRemaining(OPENED, 60, T0 + 60_000)).toBe(0) // exact boundary
    expect(quizTimeRemaining(OPENED, 60, T0 + 90_000)).toBe(0) // past the limit
  })

  it('clamps to the full limit when the client clock is BEHIND the server (negative elapsed)', () => {
    // openedAt is "in the future" relative to this client → must not show >limit
    expect(quizTimeRemaining(OPENED, 60, T0 - 30_000)).toBe(60)
  })

  it('floors elapsed — the shown second is stable within each 1s window, ticking on whole seconds', () => {
    expect(quizTimeRemaining(OPENED, 60, T0 + 30_000)).toBe(30)
    expect(quizTimeRemaining(OPENED, 60, T0 + 30_999)).toBe(30) // holds 30 until...
    expect(quizTimeRemaining(OPENED, 60, T0 + 31_000)).toBe(29) // ...the next whole second
  })
})

describe('formatTime (countdown display)', () => {
  it('formats remaining seconds as m:ss', () => {
    expect(formatTime(120)).toBe('2:00')
    expect(formatTime(59)).toBe('0:59')
    expect(formatTime(5)).toBe('0:05')
    expect(formatTime(0)).toBe('0:00')
  })
})
