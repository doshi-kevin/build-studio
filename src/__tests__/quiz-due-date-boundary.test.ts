// Due-date boundary handling (#311). A quiz due date is picked with a
// `type="date"` input, so it is stored date-only / at UTC midnight and carries no
// time. Reading that instant literally made "due Dec 31" both DISPLAY as Dec 30
// and STOP ACCEPTING WORK on the evening of Dec 30 for every timezone behind UTC.
import { describe, it, expect } from 'vitest'
import { formatDate, dueDeadlineMs, isPastDue } from '@/lib/quiz/utils'

const DEC_31_UTC_MIDNIGHT = '2026-12-31T00:00:00.000Z'
const DAY_MS = 24 * 60 * 60 * 1000

describe('due-date boundary (#311)', () => {
  it('displays a date-only due date on its stored day, not the day before', () => {
    // The reported symptom: this rendered "Dec 30, 2026" for any US timezone.
    expect(formatDate(DEC_31_UTC_MIDNIGHT)).toBe('Dec 31, 2026')
    expect(formatDate('2026-12-31')).toBe('Dec 31, 2026')
  })

  it('expires a date-only due date at the END of that day', () => {
    const deadline = dueDeadlineMs(DEC_31_UTC_MIDNIGHT)
    expect(deadline).toBe(Date.parse('2026-12-31T23:59:59.999Z'))
    // The whole point: the last instant of Dec 31 is still on time. Before the
    // fix the deadline was the FIRST instant of Dec 31, so this was late.
    expect(isPastDue(DEC_31_UTC_MIDNIGHT, deadline)).toBe(false)
    expect(isPastDue(DEC_31_UTC_MIDNIGHT, deadline + 1)).toBe(true)
  })

  it('no longer locks the deadline a day early for US students', () => {
    // The reported bite: work done during the due date's own US afternoon used to
    // be late, because the deadline was UTC midnight — 7pm Eastern the day BEFORE.
    const twoPmEasternDec31 = Date.parse('2026-12-31T19:00:00.000Z')
    expect(twoPmEasternDec31).toBeGreaterThan(Date.parse(DEC_31_UTC_MIDNIGHT)) // was late
    expect(isPastDue(DEC_31_UTC_MIDNIGHT, twoPmEasternDec31)).toBe(false)      // now on time
  })

  it('documents the residual gap: end-of-day is UTC, not the local zone', () => {
    // KNOWN LIMITATION, pinned deliberately rather than hidden. 8pm Eastern on
    // Dec 31 is 01:00Z on Jan 1, past the UTC end-of-day, so it still counts late.
    // Closing this needs institutions.timezone threaded through the server check
    // AND the client badges — a follow-up, not a hardcoded zone here. If someone
    // does that work, this expectation should flip to false.
    const eightPmEasternDec31 = Date.parse('2027-01-01T01:00:00.000Z')
    expect(isPastDue(DEC_31_UTC_MIDNIGHT, eightPmEasternDec31)).toBe(true)
  })

  it('leaves a due date that carries a real time exactly where it is', () => {
    // Only date-only values get the end-of-day treatment — a timestamp with a
    // meaningful clock time must not silently gain 24 hours.
    const withTime = '2026-12-31T14:30:00.000Z'
    expect(dueDeadlineMs(withTime)).toBe(Date.parse(withTime))
    expect(dueDeadlineMs(withTime)).not.toBe(Date.parse(withTime) + DAY_MS - 1)
  })

  it('treats a missing or unparseable due date as never past due', () => {
    expect(isPastDue(null)).toBe(false)
    expect(isPastDue(undefined)).toBe(false)
    expect(isPastDue('not a date')).toBe(false)
  })
})
