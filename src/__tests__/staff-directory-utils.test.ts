// Tests for the pure display-status helpers used by the admin TA/Grader
// directory. Focus is on the derivedStatus() branch that collapses
// "active but past ends_at" into "ended" — the bug class we specifically
// want to catch is an expired assignment still showing as active.

import { describe, it, expect } from 'vitest'
import { derivedStatus, isExpired } from '@/lib/section-staff/directory-utils'

// Fixed clock so tests are deterministic regardless of when they run.
const NOW = new Date('2026-04-14T12:00:00Z')
const PAST = '2026-01-01T00:00:00Z'
const FUTURE = '2027-01-01T00:00:00Z'

describe('isExpired', () => {
  it('returns false when ends_at is null or undefined', () => {
    expect(isExpired(null, NOW)).toBe(false)
    expect(isExpired(undefined, NOW)).toBe(false)
  })

  it('returns true when ends_at is in the past', () => {
    expect(isExpired(PAST, NOW)).toBe(true)
  })

  it('returns false when ends_at is in the future', () => {
    expect(isExpired(FUTURE, NOW)).toBe(false)
  })

  it('treats ends_at exactly equal to now as expired (<=)', () => {
    expect(isExpired(NOW.toISOString(), NOW)).toBe(true)
  })

  it('returns false for an unparseable date string', () => {
    expect(isExpired('not-a-date', NOW)).toBe(false)
  })
})

describe('derivedStatus', () => {
  it('returns "removed" when raw status is removed, regardless of ends_at', () => {
    expect(derivedStatus({ status: 'removed', ends_at: FUTURE }, NOW)).toBe('removed')
    expect(derivedStatus({ status: 'removed', ends_at: PAST }, NOW)).toBe('removed')
    expect(derivedStatus({ status: 'removed', ends_at: null }, NOW)).toBe('removed')
  })

  it('returns "active" when status is active and ends_at is in the future', () => {
    expect(derivedStatus({ status: 'active', ends_at: FUTURE }, NOW)).toBe('active')
  })

  it('returns "active" when status is active and ends_at is null (open-ended)', () => {
    expect(derivedStatus({ status: 'active', ends_at: null }, NOW)).toBe('active')
    expect(derivedStatus({ status: 'active', ends_at: undefined }, NOW)).toBe('active')
  })

  // The load-bearing branch: the DB row still says "active" but the
  // assignment's window has closed. The directory must NOT show this as
  // still-active, otherwise admins think stale TAs still have access.
  it('returns "ended" when status is active but ends_at is in the past', () => {
    expect(derivedStatus({ status: 'active', ends_at: PAST }, NOW)).toBe('ended')
  })

  it('returns "ended" when status is ended regardless of ends_at', () => {
    expect(derivedStatus({ status: 'ended', ends_at: FUTURE }, NOW)).toBe('ended')
    expect(derivedStatus({ status: 'ended', ends_at: null }, NOW)).toBe('ended')
  })

  it('falls back to "ended" for unexpected status values (defensive default)', () => {
    expect(derivedStatus({ status: 'unknown', ends_at: FUTURE }, NOW)).toBe('ended')
    expect(derivedStatus({ status: null, ends_at: FUTURE }, NOW)).toBe('ended')
  })
})
