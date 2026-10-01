// expandBlockedTimes turns a weekly recurring calendar entry (e.g. a lecture) into concrete
// per-date occurrences for the visible range — the core of recurring-event support. A one-off
// passes through untouched; a weekly entry repeats on its start weekday, respects the
// until-date, and never predates its start.

import { describe, it, expect } from 'vitest'
import { expandBlockedTimes } from '@/lib/calendar/utils'
import type { BlockedTime } from '@/lib/validations/calendar'

const base: Omit<BlockedTime, 'recurrence' | 'recurrenceUntil'> = {
  id: 'series-1',
  professorId: 'prof-1',
  date: '2026-04-06',
  startTime: '10:00',
  endTime: '11:00',
  reason: 'lecture',
  note: 'CS 546 Lecture',
  courseId: null,
  courseName: null,
  courseCode: null,
  meetingType: null,
  location: '',
  zoomLink: '',
  createdAt: '2026-01-01T00:00:00Z',
}

const range = (from: string, to: string): [Date, Date] => [
  new Date(from + 'T00:00:00'),
  new Date(to + 'T23:59:59'),
]

describe('expandBlockedTimes', () => {
  it('passes a one-off entry through unchanged (same reference)', () => {
    const oneOff: BlockedTime = { ...base, recurrence: 'none', recurrenceUntil: null }
    const [s, e] = range('2026-04-01', '2026-04-30')
    const out = expandBlockedTimes([oneOff], s, e)
    expect(out).toHaveLength(1)
    expect(out[0]).toBe(oneOff)
  })

  it('expands a weekly entry onto its start weekday across the range', () => {
    const weekly: BlockedTime = { ...base, recurrence: 'weekly', recurrenceUntil: null }
    const [s, e] = range('2026-04-06', '2026-04-27')
    const out = expandBlockedTimes([weekly], s, e)
    expect(out.map((o) => o.date)).toEqual([
      '2026-04-06',
      '2026-04-13',
      '2026-04-20',
      '2026-04-27',
    ])
    // occurrences keep the series id (so a click/delete targets the series) but are marked
    // non-recurring so re-expansion is a no-op, and carry the series' time/type.
    expect(out.every((o) => o.id === 'series-1')).toBe(true)
    expect(out.every((o) => o.recurrence === 'none')).toBe(true)
    expect(out.every((o) => o.startTime === '10:00' && o.reason === 'lecture')).toBe(true)
  })

  it('stops at recurrenceUntil (inclusive)', () => {
    const weekly: BlockedTime = { ...base, recurrence: 'weekly', recurrenceUntil: '2026-04-13' }
    const [s, e] = range('2026-04-06', '2026-04-30')
    const out = expandBlockedTimes([weekly], s, e)
    expect(out.map((o) => o.date)).toEqual(['2026-04-06', '2026-04-13'])
  })

  it('never emits an occurrence before the entry start date', () => {
    const weekly: BlockedTime = { ...base, recurrence: 'weekly', recurrenceUntil: null }
    // Range opens two weeks BEFORE the anchor; nothing should predate 2026-04-06.
    const [s, e] = range('2026-03-23', '2026-04-13')
    const out = expandBlockedTimes([weekly], s, e)
    expect(out.map((o) => o.date)).toEqual(['2026-04-06', '2026-04-13'])
  })
})
