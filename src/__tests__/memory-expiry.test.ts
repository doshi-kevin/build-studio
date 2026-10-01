/**
 * How long a remembered preference lasts.
 *
 * This is the half of the memory layer with no user-visible surface until it is
 * already wrong. A preference that outlives the circumstance behind it keeps
 * shaping every answer, and the only exit is the student remembering to open a
 * settings page — so "stored forever by default" is the failure mode, not the
 * safe default it looks like.
 *
 * Two corrections are pinned here, both found by driving the real app rather
 * than by reading the table. Preferences were being written with no expiry at
 * all, and where a horizon WAS recognised the first matching phrase won instead
 * of the nearest one.
 */

import { describe, it, expect } from 'vitest'
import { expiryFromPhrase, DEFAULT_TTL_DAYS } from '@/lib/ai/student-tutor/remember-preference'

/** Fixed clock, so a horizon is asserted as a number of days and not a date. */
const NOW = Date.UTC(2026, 0, 1)
const daysOut = (phrase: string | undefined): number =>
  Math.round((Date.parse(expiryFromPhrase(phrase, NOW)) - NOW) / 86_400_000)

describe('expiryFromPhrase', () => {
  it('never returns "forever", even with no time bound at all', () => {
    // The defect this replaced: five of six preferences in a stress-test pass
    // were stored as never-expiring, including one the student had said was
    // temporary. Every preference now lapses on its own.
    expect(daysOut(undefined)).toBe(DEFAULT_TTL_DAYS)
    expect(daysOut('')).toBe(DEFAULT_TTL_DAYS)
    expect(Date.parse(expiryFromPhrase(undefined, NOW))).toBeGreaterThan(NOW)
  })

  it('falls back to the term default for a phrase it does not recognise', () => {
    // Unparsed is not the same as unbounded. "Two weeks" is a real bound we
    // cannot read, and guessing a short one would delete something the student
    // still wants; the term boundary is the conservative end of that trade.
    expect(daysOut('for the next two weeks')).toBe(DEFAULT_TTL_DAYS)
    expect(daysOut('until I graduate')).toBe(DEFAULT_TTL_DAYS)
  })

  it.each([
    ['today', 1],
    ['tonight', 1],
    ['tomorrow', 2],
    ['this week', 7],
    ['this weekend', 7],
    ['next week', 10],
    ['this month', 30],
    ['this semester', DEFAULT_TTL_DAYS],
  ])('reads %s as %i days', (phrase, expected) => {
    expect(daysOut(phrase)).toBe(expected)
  })

  it('takes the NEAREST horizon when a phrase carries more than one', () => {
    // "until the midterm next week" contains both. Returning the first match
    // gave an exam-shaped horizon to something about a week away, so answers
    // stayed truncated for days after the exam with nothing to explain why.
    expect(daysOut('until the midterm next week')).toBe(10)
    expect(daysOut('until finals at the end of the semester')).toBe(21)
    expect(daysOut('just for today, before the exam')).toBe(1)
  })

  it('keeps every horizon inside the term default', () => {
    // A stated bound may shorten the default; nothing may extend past it, or
    // the fallback stops being a ceiling.
    const phrases = [
      undefined, 'today', 'tomorrow', 'this week', 'next week', 'this month',
      'this unit', 'this chapter', 'the midterm', 'the final', 'this quiz',
      'this test', 'this semester', 'rest of the term', 'something unparseable',
    ]
    for (const phrase of phrases) {
      expect(daysOut(phrase)).toBeGreaterThan(0)
      expect(daysOut(phrase)).toBeLessThanOrEqual(DEFAULT_TTL_DAYS)
    }
  })

  it('returns a parseable ISO timestamp', () => {
    const iso = expiryFromPhrase('tomorrow', NOW)
    expect(iso).toBe(new Date(NOW + 2 * 86_400_000).toISOString())
  })
})
