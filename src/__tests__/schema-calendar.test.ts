// Tests for calendar validation schemas — custom refinements, regex patterns, and business enums only.
// Trivial Zod built-in tests (min/max/required/optional/happy-path) have been removed.

import { describe, it, expect } from 'vitest'
import {
  officeHoursSchema,
  createBookingFormSchema,
  createOfficeHoursFormSchema,
} from '@/lib/validations/calendar'

// ── officeHoursSchema ────────────────────────────────────────

describe('officeHoursSchema', () => {
  const parse = (data: unknown) => officeHoursSchema.safeParse(data)

  const validOH = {
    id: 'oh-1',
    professorId: 'prof-1',
    professorName: 'Dr. Smith',
    title: 'Office Hours',
    dayOfWeek: 'monday',
    startTime: '09:00',
    endTime: '11:00',
    slotDuration: 30,
    meetingType: 'zoom',
    isActive: true,
    effectiveFrom: '2026-01-01',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }

  it('rejects invalid dayOfWeek', () => {
    expect(parse({ ...validOH, dayOfWeek: 'funday' }).success).toBe(false)
  })

  it('rejects invalid time format', () => {
    expect(parse({ ...validOH, startTime: '9am' }).success).toBe(false)
    expect(parse({ ...validOH, endTime: '1100' }).success).toBe(false)
  })

  it('accepts valid time format (HH:MM)', () => {
    expect(parse({ ...validOH, startTime: '09:00', endTime: '17:30' }).success).toBe(true)
  })

  it('accepts valid slot durations', () => {
    for (const duration of [15, 30, 45, 60]) {
      expect(parse({ ...validOH, slotDuration: duration }).success).toBe(true)
    }
  })

  it('rejects invalid slot duration', () => {
    expect(parse({ ...validOH, slotDuration: 20 }).success).toBe(false)
  })
})

// ── createBookingFormSchema ──────────────────────────────────

describe('createBookingFormSchema', () => {
  const parse = (data: unknown) => createBookingFormSchema.safeParse(data)

  it('accepts all valid purposes', () => {
    for (const purpose of ['assignment_doubt', 'exam_prep', 'project_discussion', 'career_guidance', 'general_question']) {
      expect(parse({
        title: 'Test',
        courseId: null,
        meetingType: 'in_person',
        purpose,
        studentNote: '',
      }).success).toBe(true)
    }
  })
})

// ── createOfficeHoursFormSchema ──────────────────────────────

describe('createOfficeHoursFormSchema', () => {
  const parse = (data: unknown) => createOfficeHoursFormSchema.safeParse(data)

  const validForm = {
    title: 'Weekly OH',
    courseId: null,
    dayOfWeek: 'wednesday',
    startTime: '14:00',
    endTime: '16:00',
    slotDuration: 30,
    bufferMinutes: 5,
    meetingType: 'in_person',
    location: 'Room 301',
    zoomLink: '',
    effectiveFrom: '2026-01-15',
    effectiveUntil: null,
  }

  it('rejects invalid time format', () => {
    expect(parse({ ...validForm, startTime: '2pm' }).success).toBe(false)
  })
})
