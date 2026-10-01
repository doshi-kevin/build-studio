// expandOfficeHours turns a weekly office-hours template into concrete per-date
// occurrences inside a window, honouring the row's own effective_from/until.
//
// Why this is tested at the function level rather than through either caller:
// this expansion has TWO consumers — the professor dashboard's mini calendar
// (`getProfessorCalendarEvents`) and the subscribable iCal feed
// (`feed-builder.ts`, which previously carried its own copy). They now share one
// implementation precisely so the in-app calendar can't drift from what a
// professor sees in Apple/Google Calendar, so pinning the single function pins
// both surfaces at once.
//
// The boundaries below are the ones that silently duplicate or drop an office
// hour in a subscribed feed: the inclusive effective_until, the effective_from
// clamp, and Sunday (day index 0 — a falsy check instead of an
// `=== undefined` check would break Sundays and nothing else).

import { describe, it, expect } from 'vitest'
import { expandOfficeHours } from '@/lib/calendar/professor-events'

/** April 2026 — Mondays fall on the 6th, 13th, 20th, 27th; Sundays on the 5th, 12th, 19th, 26th. */
const window = (): [Date, Date] => [
  new Date('2026-04-01T00:00:00'),
  new Date('2026-04-30T23:59:59'),
]

const row = (overrides: Partial<Parameters<typeof expandOfficeHours>[0]> = {}) => ({
  day_of_week: 'monday',
  start_time: '10:00',
  end_time: '11:00',
  effective_from: null,
  effective_until: null,
  ...overrides,
})

const dates = (occurrences: ReturnType<typeof expandOfficeHours>) => occurrences.map((o) => o.date)

describe('expandOfficeHours', () => {
  it('expands a weekly template onto every matching weekday in the window', () => {
    expect(dates(expandOfficeHours(row(), ...window()))).toEqual([
      '2026-04-06',
      '2026-04-13',
      '2026-04-20',
      '2026-04-27',
    ])
  })

  it('treats effective_until as INCLUSIVE — the last occurrence lands on it', () => {
    const out = expandOfficeHours(row({ effective_until: '2026-04-13' }), ...window())
    // Apr 13 is itself a Monday: dropping it here would silently shorten every
    // professor's office-hours series by one week.
    expect(dates(out)).toEqual(['2026-04-06', '2026-04-13'])
  })

  it('never emits an occurrence before effective_from', () => {
    const out = expandOfficeHours(row({ effective_from: '2026-04-14' }), ...window())
    expect(dates(out)).toEqual(['2026-04-20', '2026-04-27'])
  })

  it('clamps an effective_until that runs past the window instead of overrunning it', () => {
    const out = expandOfficeHours(row({ effective_until: '2026-12-31' }), ...window())
    expect(dates(out)).toEqual(['2026-04-06', '2026-04-13', '2026-04-20', '2026-04-27'])
  })

  it('emits nothing when the effective range starts after the window ends', () => {
    expect(expandOfficeHours(row({ effective_from: '2026-06-01' }), ...window())).toEqual([])
  })

  it('handles sunday, whose day index is 0', () => {
    // Guarded with `dayIdx === undefined`, not a truthiness check — a falsy
    // check would return [] here and work for every other day of the week.
    const out = expandOfficeHours(row({ day_of_week: 'sunday' }), ...window())
    expect(dates(out)).toEqual(['2026-04-05', '2026-04-12', '2026-04-19', '2026-04-26'])
  })

  it('returns nothing for an unrecognised day_of_week rather than throwing', () => {
    expect(expandOfficeHours(row({ day_of_week: 'Monday' }), ...window())).toEqual([])
    expect(expandOfficeHours(row({ day_of_week: '' }), ...window())).toEqual([])
  })

  it('carries start_time and end_time through to every occurrence verbatim', () => {
    // The iCal feed builds DTSTART/DTEND straight from these, so a shifted or
    // reformatted time here becomes a wrong-time event in a subscribed calendar.
    const out = expandOfficeHours(
      row({ start_time: '14:00', end_time: '15:30', effective_until: '2026-04-13' }),
      ...window(),
    )
    expect(out).toEqual([
      { date: '2026-04-06', startTime: '14:00', endTime: '15:30' },
      { date: '2026-04-13', startTime: '14:00', endTime: '15:30' },
    ])
  })
})
