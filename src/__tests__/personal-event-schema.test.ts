import { describe, it, expect } from 'vitest'
import { personalEventSchema } from '@/lib/validations/calendar'

const base = {
  title: 'Study block',
  date: '2026-07-10',
  allDay: false,
  startTime: '09:00',
  endTime: '10:00',
  note: '',
  recurrence: 'none' as const,
  recurrenceUntil: '',
}

describe('personalEventSchema', () => {
  it('accepts a valid timed event', () => {
    expect(personalEventSchema.safeParse(base).success).toBe(true)
  })

  it('rejects an out-of-range time (e.g. 29:99)', () => {
    expect(personalEventSchema.safeParse({ ...base, startTime: '29:99' }).success).toBe(false)
  })

  it('rejects end-before-start for a timed event', () => {
    expect(personalEventSchema.safeParse({ ...base, startTime: '10:00', endTime: '09:00' }).success).toBe(false)
  })

  it('accepts an all-day event with no times', () => {
    expect(personalEventSchema.safeParse({ ...base, allDay: true, startTime: '', endTime: '' }).success).toBe(true)
  })

  it('rejects a weekly until-date before the event date', () => {
    expect(
      personalEventSchema.safeParse({ ...base, recurrence: 'weekly', recurrenceUntil: '2026-07-01' }).success,
    ).toBe(false)
  })

  it('accepts a valid weekly recurrence', () => {
    expect(
      personalEventSchema.safeParse({ ...base, recurrence: 'weekly', recurrenceUntil: '2026-08-01' }).success,
    ).toBe(true)
  })
})
