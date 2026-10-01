/**
 * Client and server must answer "has this slot passed?" identically (#711).
 *
 * The bug was one of the nastier kinds: not a crash, but the client and the server
 * disagreeing about the same slot. The client filtered past slots with the BROWSER's clock
 * (`h * 60 + m` compared against `today.getHours()`), while `createBooking` checks
 * `new Date(etWallClockToIso(date, startTime)).getTime() <= Date.now()` in Eastern. Those
 * agree only for a viewer who happens to be in Eastern. Everyone else was shown slots the
 * server would refuse — an action guaranteed to fail, presented as available — and had
 * genuinely bookable slots hidden from them in the other direction.
 *
 * Testing the shared helper rather than the component: the helper is the thing that has to
 * match the server, and a component test would assert whatever the render happens to do.
 *
 * The second block pins the navigation-date fix. `toISOString()` yields the UTC date, so
 * the professor's "Today" button and every week/month step landed a viewer on the wrong
 * day for several hours each evening west of UTC. `formatDateISO` reads the local calendar
 * date, which is what a calendar grid means by a day.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { etWallClockToIso, formatDateISO, isoToEtWallClock } from '@/lib/calendar/utils'

/** The client-side predicate, byte for byte as AvailableSlotsList and the server use it. */
const hasPassed = (date: string, startTime: string) =>
  new Date(etWallClockToIso(date, startTime)).getTime() <= Date.now()

afterEach(() => {
  vi.useRealTimers()
})

describe('slot past-check agrees with the server in every timezone (#711)', () => {
  /* 2026-07-15 18:00 UTC is 14:00 Eastern (EDT). A 15:00 ET slot is still in the future.
     Under the old browser-clock comparison a viewer in Tokyo (03:00 next day local) would
     have had every one of that day's slots filtered away as "past". */
  it('a slot later the same Eastern day has not passed', () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-07-15T18:00:00Z'))

    expect(hasPassed('2026-07-15', '15:00')).toBe(false)
  })

  it('a slot earlier the same Eastern day has passed', () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-07-15T18:00:00Z'))

    expect(hasPassed('2026-07-15', '13:00')).toBe(true)
  })

  /* The decisive case. 2026-07-15T23:30Z is 19:30 Eastern on the 15th, but already the
     16th in Tokyo. A local-calendar comparison would call a 16th slot "today or past";
     resolving in Eastern correctly reports it as future. */
  it('resolves in Eastern, not in whatever day it is for the viewer', () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-07-15T23:30:00Z'))

    expect(hasPassed('2026-07-16', '09:00')).toBe(false)
    expect(hasPassed('2026-07-15', '19:00')).toBe(true)
  })

  /* DST was verified correct in the original report and must stay that way: the offset is
     resolved per date, never a fixed -05:00. 2026-01-15 is EST (-5), 2026-07-15 is EDT (-4),
     so the same wall-clock time is a different instant. */
  it('honours EST and EDT rather than a fixed offset', () => {
    expect(etWallClockToIso('2026-01-15', '12:00')).toBe('2026-01-15T17:00:00.000Z')
    expect(etWallClockToIso('2026-07-15', '12:00')).toBe('2026-07-15T16:00:00.000Z')
  })
})

describe('calendar navigation uses the local calendar date (#711)', () => {
  it('formatDateISO keeps the local day where toISOString would roll over', () => {
    /* A Date built from local parts late in the evening. West of UTC its ISO string is
       already tomorrow, which is exactly how the professor's "Today" button landed on the
       wrong day. formatDateISO reads the local fields instead. */
    const lateEvening = new Date(2026, 6, 15, 23, 30, 0)

    expect(formatDateISO(lateEvening)).toBe('2026-07-15')

    /* Non-vacuous only where the two actually differ, so assert the contract directly
       rather than depending on the machine's zone: whatever the zone, formatDateISO must
       agree with the LOCAL calendar fields. */
    const expected = `${lateEvening.getFullYear()}-${String(lateEvening.getMonth() + 1).padStart(2, '0')}-${String(lateEvening.getDate()).padStart(2, '0')}`
    expect(formatDateISO(lateEvening)).toBe(expected)
  })
})

describe('a bare due date renders as the day it was typed (#703 part 4)', () => {
  it('reads a date-only timestamptz in UTC, not the viewer zone', () => {
    /* `<Input type="date">` gives "2020-01-01", stored into a timestamptz as midnight UTC.
       Rendered in local time that is "Dec 31, 2019" anywhere west of UTC — the professor's
       own date handed back to them a day early. */
    const stored = new Date('2020-01-01T00:00:00Z')

    expect(
      stored.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }),
    ).toBe('Jan 1, 2020')

    /* The old behaviour, pinned so the difference is visible rather than asserted from
       memory: forcing an Eastern render reproduces the reported off-by-one. */
    expect(
      stored.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' }),
    ).toBe('Dec 31, 2019')
  })
})

/**
 * The availability grid puts BOTH time representations on one minute number line,
 * so they have to agree about what hour it is.
 *
 * `/professor/students/[studentId]` builds its busy blocks from two sources that
 * arrive in different shapes. Calendar events are stored instants, bucketed with
 * `isoToEtWallClock`. The professor's blocked times are stored as bare Eastern wall
 * clock (`start_time`/`end_time`) and go straight through `timeToMinutes` — the same
 * wall clock `etWallClockToIso` consumes elsewhere. Both then land as `startMin` on
 * the same day's number line and are merged against each other.
 *
 * If the two disagree by an hour, a class and a blocked time at the same real moment
 * sit an hour apart on the grid, and the free slot between them is invented. So the
 * inverse relationship is not just a docstring claim here; it is what makes the merge
 * meaningful.
 *
 * Scoped to the 7 AM - 9 PM window the feature searches (GRID_START_HOUR..GRID_END_HOUR).
 * That is deliberate, not laziness: `etWallClockToIso` resolves the offset from a
 * guessed instant, which is inexact in the 1-4 AM band on the two DST transition days.
 * Those hours are outside every surface that uses it, and the round trip below covers
 * the transition days at the hours the app actually reads.
 */
describe('the ISO and wall-clock representations agree on the same number line', () => {
  const WINDOW_HOURS = ['07:00', '09:30', '12:00', '17:45', '21:00']

  it.each([
    ['midwinter (EST)', '2026-01-15'],
    ['midsummer (EDT)', '2026-07-15'],
    ['the spring-forward day', '2026-03-08'],
    ['the fall-back day', '2026-11-01'],
  ])('round-trips every window hour on %s', (_label, date) => {
    for (const time of WINDOW_HOURS) {
      const back = isoToEtWallClock(etWallClockToIso(date, time))

      expect(back).toEqual({ date, time })
    }
  })

  it('reads a stored instant as the Eastern hour a person on campus would call it', () => {
    /* Absolute anchors, so the round trip above cannot pass by both functions being
       wrong in the same direction. 16:00Z is noon EDT in July and 11:00 EST in January. */
    expect(isoToEtWallClock('2026-07-15T16:00:00.000Z')).toEqual({ date: '2026-07-15', time: '12:00' })
    expect(isoToEtWallClock('2026-01-15T16:00:00.000Z')).toEqual({ date: '2026-01-15', time: '11:00' })

    /* The Cloud Run case: 8 PM Eastern is already tomorrow in UTC. Bucketing with the
       runtime's own accessors files this class on the 16th and a 7-9 PM search loses it. */
    expect(isoToEtWallClock('2026-07-16T00:30:00.000Z')).toEqual({ date: '2026-07-15', time: '20:30' })
  })
})
