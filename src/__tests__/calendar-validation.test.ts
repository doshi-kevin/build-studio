// Office-hours / block-time forms must reject illogical time windows. An end-before-start
// office hour (e.g. 5pm→6am) generates zero slots, so it would report "created" yet never
// appear on the calendar — the schema now blocks it on both the form and the server action.

import { describe, it, expect } from 'vitest'
import {
  createOfficeHoursFormSchema,
  blockTimeFormSchema,
  createBookingFormSchema,
} from '@/lib/validations/calendar'

const baseOH = {
  title: 'OH',
  courseId: null,
  dayOfWeek: 'monday' as const,
  slotDuration: 30,
  bufferMinutes: 0,
  meetingType: 'in_person' as const,
  location: 'Room 101',
  zoomLink: '',
  effectiveFrom: '2026-01-01',
  effectiveUntil: null,
}

describe('createOfficeHoursFormSchema — time window', () => {
  it('rejects end before start (5pm → 6am)', () => {
    const r = createOfficeHoursFormSchema.safeParse({ ...baseOH, startTime: '17:00', endTime: '06:00' })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues[0].message).toMatch(/after the start/i)
  })

  it('rejects equal start/end', () => {
    expect(createOfficeHoursFormSchema.safeParse({ ...baseOH, startTime: '10:00', endTime: '10:00' }).success).toBe(false)
  })

  it('rejects a window shorter than one slot', () => {
    expect(
      createOfficeHoursFormSchema.safeParse({ ...baseOH, startTime: '10:00', endTime: '10:15', slotDuration: 30 }).success,
    ).toBe(false)
  })

  it('rejects effectiveUntil before effectiveFrom', () => {
    expect(
      createOfficeHoursFormSchema.safeParse({
        ...baseOH,
        startTime: '10:00',
        endTime: '12:00',
        effectiveFrom: '2026-02-01',
        effectiveUntil: '2026-01-01',
      }).success,
    ).toBe(false)
  })

  it('accepts a valid window', () => {
    expect(createOfficeHoursFormSchema.safeParse({ ...baseOH, startTime: '10:00', endTime: '12:00' }).success).toBe(true)
  })
})

describe('blockTimeFormSchema — time window', () => {
  it('rejects end before start', () => {
    expect(
      blockTimeFormSchema.safeParse({ date: '2026-01-01', startTime: '14:00', endTime: '09:00', reason: 'meeting', note: '' }).success,
    ).toBe(false)
  })

  it('accepts a valid window', () => {
    expect(
      blockTimeFormSchema.safeParse({ date: '2026-01-01', startTime: '09:00', endTime: '10:00', reason: 'meeting', note: '' }).success,
    ).toBe(true)
  })

  // The "Add event" flow reuses this schema for lectures/exams/etc., so the new event
  // types must validate (and an unknown type must still be rejected).
  it('accepts the new event types (lecture / exam / seminar)', () => {
    for (const reason of ['lecture', 'exam', 'seminar'] as const) {
      expect(
        blockTimeFormSchema.safeParse({ date: '2026-01-01', startTime: '09:00', endTime: '10:00', reason, note: 'CS 546 Lecture' }).success,
      ).toBe(true)
    }
  })

  it('rejects an unknown type', () => {
    expect(
      blockTimeFormSchema.safeParse({ date: '2026-01-01', startTime: '09:00', endTime: '10:00', reason: 'party', note: '' }).success,
    ).toBe(false)
  })
})

describe('createOfficeHoursFormSchema — mode requirements', () => {
  const valid = { ...baseOH, startTime: '10:00', endTime: '12:00' }

  it('requires a location for in-person', () => {
    expect(createOfficeHoursFormSchema.safeParse({ ...valid, meetingType: 'in_person', location: '' }).success).toBe(false)
  })

  it('requires a Zoom link for zoom (location optional)', () => {
    expect(createOfficeHoursFormSchema.safeParse({ ...valid, meetingType: 'zoom', zoomLink: '' }).success).toBe(false)
    expect(
      createOfficeHoursFormSchema.safeParse({ ...valid, meetingType: 'zoom', location: '', zoomLink: 'https://zoom.us/j/1' }).success,
    ).toBe(true)
  })

  it('requires both a location and a Zoom link for hybrid', () => {
    expect(createOfficeHoursFormSchema.safeParse({ ...valid, meetingType: 'hybrid', zoomLink: '' }).success).toBe(false)
    expect(
      createOfficeHoursFormSchema.safeParse({ ...valid, meetingType: 'hybrid', zoomLink: 'https://zoom.us/j/1' }).success,
    ).toBe(true)
  })
})

describe('createBookingFormSchema — a booking is a concrete mode', () => {
  const base = { title: 'x', courseId: null, purpose: 'general_question' as const, studentNote: '' }

  it('rejects "hybrid" as a booking mode', () => {
    expect(createBookingFormSchema.safeParse({ ...base, meetingType: 'hybrid' }).success).toBe(false)
  })

  it('accepts a concrete mode', () => {
    expect(createBookingFormSchema.safeParse({ ...base, meetingType: 'zoom' }).success).toBe(true)
  })
})
