// The `modules.unlock_date` predicate — one rule shared by the student roadmap
// loader (which strips a locked week server-side), the student modules page, the
// pre-class-primer IDOR guard, and the professor's Modules board. If these two
// functions disagree with any of those callers, a module is visible on one
// surface and hidden on another.

import { describe, it, expect } from 'vitest'
import { isUnlockPending, unlockLabel } from '@/lib/modules/unlock'

const NOW = new Date('2026-08-01T12:00:00.000Z').getTime()
const at = (iso: string) => isUnlockPending(iso, NOW)

describe('isUnlockPending', () => {
  it('locks a future date and opens a past one', () => {
    expect(at('2026-08-08T00:00:00.000Z')).toBe(true)
    expect(at('2026-07-25T00:00:00.000Z')).toBe(false)
  })

  // No date is the common case (most modules): open the moment it's published.
  it('treats no date as open', () => {
    expect(isUnlockPending(null, NOW)).toBe(false)
    expect(isUnlockPending(undefined, NOW)).toBe(false)
    expect(isUnlockPending('', NOW)).toBe(false)
  })

  /* Fail OPEN, never closed. A bad value hiding real material would give the
     professor no way to see why their week vanished — whereas an over-visible
     module is at least legible on screen. */
  it('treats an unparseable date as open', () => {
    expect(at('next tuesday')).toBe(false)
    expect(at('2026-13-45')).toBe(false)
  })

  // The exact instant is open, not pending — otherwise a module sits locked for
  // one tick past the moment the professor chose.
  it('opens exactly at the date', () => {
    expect(isUnlockPending(new Date(NOW).toISOString(), NOW)).toBe(false)
  })
})

describe('unlockLabel', () => {
  it('reads as a release, not a deadline — day precision, no time', () => {
    const label = unlockLabel('2026-08-12T09:30:00.000Z')
    expect(label).toMatch(/^Opens /)
    expect(label).not.toMatch(/\d:\d/)
  })

  it('returns null when there is nothing to say', () => {
    expect(unlockLabel(null)).toBeNull()
    expect(unlockLabel('')).toBeNull()
    expect(unlockLabel('not-a-date')).toBeNull()
  })
})
