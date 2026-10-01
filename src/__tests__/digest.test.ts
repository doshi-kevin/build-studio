// Tests for the digest's timezone gating — the load-bearing correctness of "send at
// 7 AM in the institution's local time." localHour drives which institutions fire on a
// given cron tick; localDate is the per-day dedup key. Both must respect the IANA zone
// (incl. DST) or digests go out at the wrong time or double-send across a date boundary.
import { describe, it, expect, vi } from 'vitest'

// digest.ts imports from '@/lib/email' (which loads the Resend SDK + logger at module
// scope); stub both so importing the pure helpers has no side effects.
vi.mock('resend', () => ({ Resend: class { emails = { send: vi.fn() } } }))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

import { localHour, localDate, safeTimeZone, DIGEST_HOUR, DIGEST_ELIGIBLE_TYPES } from '@/lib/notifications/digest'

describe('digest timezone gating', () => {
  it('falls back to America/New_York on an IANA-invalid timezone (never throws)', () => {
    const when = new Date('2026-01-15T11:00:00Z')
    expect(safeTimeZone('Not/AZone')).toBe('America/New_York') // genuinely malformed → fallback
    expect(safeTimeZone('total garbage')).toBe('America/New_York')
    expect(safeTimeZone('America/Chicago')).toBe('America/Chicago') // valid → unchanged
    // A malformed tz must never throw — that would take the whole digest sweep down for everyone.
    expect(() => localHour('Not/AZone', when)).not.toThrow()
    expect(() => localDate('still-garbage', when)).not.toThrow()
  })

  // 2026-07-07 is summer → New York is EDT (UTC-4), LA is PDT (UTC-7).
  const at11Utc = new Date('2026-07-07T11:00:00Z')

  it('localHour returns the institution-local hour (DST-aware)', () => {
    expect(localHour('America/New_York', at11Utc)).toBe(7) // 11:00Z − 4 = 07:00 EDT
    expect(localHour('UTC', at11Utc)).toBe(11)
    expect(localHour('America/Los_Angeles', at11Utc)).toBe(4) // 11:00Z − 7 = 04:00 PDT
  })

  it('an East-coast institution fires at the digest hour when it is 11:00 UTC', () => {
    expect(localHour('America/New_York', at11Utc)).toBe(DIGEST_HOUR)
    // …and a UTC institution does NOT (it's 11:00 there, not 07:00).
    expect(localHour('UTC', at11Utc)).not.toBe(DIGEST_HOUR)
  })

  it('localDate is the local calendar date, not the UTC date, across a boundary', () => {
    // 02:00 UTC is still the previous evening in New York.
    expect(localDate('America/New_York', new Date('2026-07-07T02:00:00Z'))).toBe('2026-07-06')
    expect(localDate('UTC', new Date('2026-07-07T02:00:00Z'))).toBe('2026-07-07')
  })

  it('excludes ephemeral classroom_started but includes durable events', () => {
    const types = DIGEST_ELIGIBLE_TYPES as readonly string[]
    expect(types).not.toContain('classroom_started')
    expect(types).toContain('assignment_published')
    expect(types).toContain('assignment_graded')
    expect(types).toContain('announcement_posted')
  })
})
