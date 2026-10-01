/**
 * #637 part 2 — a recurring schedule that would exceed MAX_SCHEDULE_OCCURRENCES was
 * silently reduced to exactly the cap. The dialog held a "that's over the limit"
 * error, but it was UNREACHABLE: expandWeeklyOccurrences caps the array it returns,
 * so `occurrences.length > MAX` is never true. The professor asked for a year of
 * classes, got 50, and the only signal was a count they had no reason to question.
 *
 * The dialog now expands to ONE OVER the cap to make truncation detectable, then
 * slices. This pins that arithmetic, because it is the whole mechanism: asserting
 * `length === 50` would pass against the old silent behaviour.
 */

import { describe, it, expect } from 'vitest'
import { expandWeeklyOccurrences, MAX_SCHEDULE_OCCURRENCES } from '@/lib/live-classroom/recurrence'

/** The dialog's derivation, kept in step with ScheduleSessionDialog's useMemo. */
function expandForPreview(start: Date, weekdays: number[], until: Date) {
  const raw = expandWeeklyOccurrences(start, weekdays, until, MAX_SCHEDULE_OCCURRENCES + 1)
  return raw.length > MAX_SCHEDULE_OCCURRENCES
    ? { occurrences: raw.slice(0, MAX_SCHEDULE_OCCURRENCES), truncated: true }
    : { occurrences: raw, truncated: false }
}

const START = new Date('2026-09-01T10:00:00')

describe('#637 part 2 — the 50-session cap must be reported, not just applied', () => {
  it('flags truncation when the range would produce more than the cap', () => {
    // Every weekday for a year — far beyond 50.
    const { occurrences, truncated } = expandForPreview(
      START,
      [1, 2, 3, 4, 5],
      new Date('2027-08-31T00:00:00'),
    )

    expect(truncated).toBe(true)
    // Still capped — the cap itself is correct and must not regress.
    expect(occurrences).toHaveLength(MAX_SCHEDULE_OCCURRENCES)
  })

  it('does NOT flag truncation for a range that fits', () => {
    // Mondays over ~6 weeks.
    const { occurrences, truncated } = expandForPreview(START, [1], new Date('2026-10-13T00:00:00'))

    expect(truncated).toBe(false)
    expect(occurrences.length).toBeGreaterThan(0)
    expect(occurrences.length).toBeLessThan(MAX_SCHEDULE_OCCURRENCES)
  })

  it('does NOT flag truncation when the range produces exactly the cap', () => {
    // The case a bare `length === MAX` check gets wrong: legitimately exactly 50.
    // Walk forward day by day until precisely MAX weekly occurrences fit.
    let until = new Date(START)
    let found: ReturnType<typeof expandForPreview> | null = null
    for (let i = 0; i < 800; i++) {
      until = new Date(START)
      until.setDate(START.getDate() + i)
      const r = expandForPreview(START, [1], until)
      if (r.occurrences.length === MAX_SCHEDULE_OCCURRENCES && !r.truncated) {
        found = r
        break
      }
      if (r.truncated) break
    }

    expect(found).not.toBeNull()
    expect(found?.occurrences).toHaveLength(MAX_SCHEDULE_OCCURRENCES)
    expect(found?.truncated).toBe(false)
  })

  it('the builder itself still honours an explicit cap', () => {
    const capped = expandWeeklyOccurrences(START, [1, 2, 3, 4, 5], new Date('2027-08-31T00:00:00'), 7)
    expect(capped).toHaveLength(7)
  })
})
