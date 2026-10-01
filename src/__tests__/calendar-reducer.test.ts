// Tests for calendarReducer — professor calendar/office hours state machine.
// Covers office hours CRUD, booking management, blocked time, slots, UI state, and bulk ops.

import { describe, it, expect, vi } from 'vitest'
import {
  calendarReducer,
  initialCalendarState,
  type CalendarState,
} from '@/components/professor/calendar/calendar-context/use-calendar-reducer'
import type { OfficeHours, Booking, BlockedTime, Slot } from '@/lib/validations/calendar'

// Mock nowISO to return deterministic timestamps
vi.mock('@/lib/quiz/utils', () => ({
  nowISO: () => '2026-04-13T12:00:00Z',
}))

// ── Helpers ──────────────────────────────────────────────────

function buildOH(overrides: Partial<OfficeHours> = {}): OfficeHours {
  return {
    id: 'oh-1',
    professorId: 'prof-1',
    professorName: 'Dr. Smith',
    title: 'Office Hours',
    courseId: null,
    courseName: null,
    courseCode: null,
    dayOfWeek: 'monday',
    startTime: '09:00',
    endTime: '11:00',
    slotDuration: 30,
    bufferMinutes: 0,
    meetingType: 'zoom',
    location: '',
    zoomLink: '',
    isActive: true,
    effectiveFrom: '2026-01-01',
    effectiveUntil: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function buildBooking(overrides: Partial<Booking> = {}): Booking {
  return {
    id: 'booking-1',
    slotId: 'slot-1',
    officeHoursId: 'oh-1',
    professorId: 'prof-1',
    professorName: 'Dr. Smith',
    studentId: 'student-1',
    studentName: 'Alice',
    studentEmail: 'alice@uni.edu',
    date: '2026-04-15',
    startTime: '10:00',
    endTime: '10:30',
    title: 'Assignment help',
    courseId: null,
    courseName: null,
    courseCode: null,
    meetingType: 'zoom',
    purpose: 'assignment_doubt',
    studentNote: '',
    professorNote: '',
    location: '',
    zoomLink: '',
    status: 'booked',
    cancelledBy: null,
    cancellationReason: '',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function buildSlot(overrides: Partial<Slot> = {}): Slot {
  return {
    id: 'slot-1',
    officeHoursId: 'oh-1',
    professorId: 'prof-1',
    date: '2026-04-15',
    startTime: '10:00',
    endTime: '10:30',
    status: 'available',
    bookingId: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function buildBT(overrides: Partial<BlockedTime> = {}): BlockedTime {
  return {
    id: 'bt-1',
    professorId: 'prof-1',
    date: '2026-04-15',
    startTime: '12:00',
    endTime: '13:00',
    reason: 'lunch',
    note: '',
    courseId: null,
    courseName: null,
    courseCode: null,
    meetingType: null,
    location: '',
    zoomLink: '',
    recurrence: 'none',
    recurrenceUntil: null,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function stateWith(overrides: Partial<CalendarState> = {}): CalendarState {
  return { ...initialCalendarState, ...overrides }
}

// ── Office Hours ─────────────────────────────────────────────

describe('ADD_OFFICE_HOURS', () => {
  it('adds office hours to state and sets isDirty', () => {
    const oh = buildOH({ id: 'oh-new' })
    const result = calendarReducer(initialCalendarState, {
      type: 'ADD_OFFICE_HOURS',
      payload: { officeHours: oh },
    })
    expect(result.officeHours['oh-new']).toEqual(oh)
    expect(result.isDirty).toBe(true)
  })
})

describe('UPDATE_OFFICE_HOURS', () => {
  it('replaces an existing office hours entry', () => {
    const state = stateWith({ officeHours: { 'oh-1': buildOH({ title: 'Old' }) } })
    const updated = buildOH({ title: 'New' })
    const result = calendarReducer(state, {
      type: 'UPDATE_OFFICE_HOURS',
      payload: { officeHours: updated },
    })
    expect(result.officeHours['oh-1'].title).toBe('New')
    expect(result.isDirty).toBe(true)
  })
})

describe('REMOVE_OFFICE_HOURS', () => {
  it('removes office hours by id', () => {
    const state = stateWith({
      officeHours: {
        'oh-1': buildOH({ id: 'oh-1' }),
        'oh-2': buildOH({ id: 'oh-2' }),
      },
    })
    const result = calendarReducer(state, {
      type: 'REMOVE_OFFICE_HOURS',
      payload: { id: 'oh-1' },
    })
    expect(result.officeHours['oh-1']).toBeUndefined()
    expect(result.officeHours['oh-2']).toBeDefined()
    expect(result.isDirty).toBe(true)
  })
})

describe('TOGGLE_OFFICE_HOURS_ACTIVE', () => {
  it('toggles isActive from true to false', () => {
    const state = stateWith({ officeHours: { 'oh-1': buildOH({ isActive: true }) } })
    const result = calendarReducer(state, {
      type: 'TOGGLE_OFFICE_HOURS_ACTIVE',
      payload: { id: 'oh-1' },
    })
    expect(result.officeHours['oh-1'].isActive).toBe(false)
    expect(result.officeHours['oh-1'].updatedAt).toBe('2026-04-13T12:00:00Z')
    expect(result.isDirty).toBe(true)
  })

  it('toggles isActive from false to true', () => {
    const state = stateWith({ officeHours: { 'oh-1': buildOH({ isActive: false }) } })
    const result = calendarReducer(state, {
      type: 'TOGGLE_OFFICE_HOURS_ACTIVE',
      payload: { id: 'oh-1' },
    })
    expect(result.officeHours['oh-1'].isActive).toBe(true)
  })

  it('returns state unchanged if office hours not found', () => {
    const state = stateWith()
    const result = calendarReducer(state, {
      type: 'TOGGLE_OFFICE_HOURS_ACTIVE',
      payload: { id: 'nonexistent' },
    })
    expect(result).toBe(state)
  })
})

// ── Bookings ─────────────────────────────────────────────────

describe('ADD_BOOKING', () => {
  it('adds booking and updates corresponding slot to booked', () => {
    const slot = buildSlot({ id: 'slot-1', status: 'available' })
    const state = stateWith({ slots: { 'slot-1': slot } })
    const booking = buildBooking({ id: 'b-1', slotId: 'slot-1' })

    const result = calendarReducer(state, {
      type: 'ADD_BOOKING',
      payload: { booking },
    })
    expect(result.bookings['b-1']).toEqual(booking)
    expect(result.slots['slot-1'].status).toBe('booked')
    expect(result.slots['slot-1'].bookingId).toBe('b-1')
    expect(result.isDirty).toBe(true)
  })

  it('adds booking even when slot does not exist in state', () => {
    const booking = buildBooking({ slotId: 'nonexistent' })
    const result = calendarReducer(initialCalendarState, {
      type: 'ADD_BOOKING',
      payload: { booking },
    })
    expect(result.bookings[booking.id]).toBeDefined()
  })
})

describe('CANCEL_BOOKING', () => {
  it('cancels booking, frees slot, and clears selectedBookingId', () => {
    const slot = buildSlot({ id: 'slot-1', status: 'booked', bookingId: 'b-1' })
    const booking = buildBooking({ id: 'b-1', slotId: 'slot-1' })
    const state = stateWith({
      bookings: { 'b-1': booking },
      slots: { 'slot-1': slot },
      selectedBookingId: 'b-1',
    })

    const result = calendarReducer(state, {
      type: 'CANCEL_BOOKING',
      payload: { bookingId: 'b-1', cancelledBy: 'professor', reason: 'Sick day' },
    })
    expect(result.bookings['b-1'].status).toBe('cancelled')
    expect(result.bookings['b-1'].cancelledBy).toBe('professor')
    expect(result.bookings['b-1'].cancellationReason).toBe('Sick day')
    expect(result.slots['slot-1'].status).toBe('available')
    expect(result.slots['slot-1'].bookingId).toBeNull()
    expect(result.selectedBookingId).toBeNull()
    expect(result.isDirty).toBe(true)
  })

  it('returns state unchanged if booking not found', () => {
    const state = stateWith()
    const result = calendarReducer(state, {
      type: 'CANCEL_BOOKING',
      payload: { bookingId: 'nonexistent', cancelledBy: 'professor', reason: '' },
    })
    expect(result).toBe(state)
  })
})

describe('MARK_BOOKING_STATUS', () => {
  it('updates booking and slot status', () => {
    const slot = buildSlot({ id: 'slot-1', status: 'booked' })
    const booking = buildBooking({ id: 'b-1', slotId: 'slot-1', status: 'booked' })
    const state = stateWith({
      bookings: { 'b-1': booking },
      slots: { 'slot-1': slot },
    })

    const result = calendarReducer(state, {
      type: 'MARK_BOOKING_STATUS',
      payload: { bookingId: 'b-1', status: 'completed' },
    })
    expect(result.bookings['b-1'].status).toBe('completed')
    expect(result.slots['slot-1'].status).toBe('completed')
    expect(result.isDirty).toBe(true)
  })

  it('returns state unchanged if booking not found', () => {
    const state = stateWith()
    const result = calendarReducer(state, {
      type: 'MARK_BOOKING_STATUS',
      payload: { bookingId: 'nonexistent', status: 'completed' },
    })
    expect(result).toBe(state)
  })
})

describe('UPDATE_PROFESSOR_NOTE', () => {
  it('sets professorNote on existing booking', () => {
    const booking = buildBooking({ id: 'b-1', professorNote: '' })
    const state = stateWith({ bookings: { 'b-1': booking } })

    const result = calendarReducer(state, {
      type: 'UPDATE_PROFESSOR_NOTE',
      payload: { bookingId: 'b-1', note: 'Good discussion' },
    })
    expect(result.bookings['b-1'].professorNote).toBe('Good discussion')
    expect(result.bookings['b-1'].updatedAt).toBe('2026-04-13T12:00:00Z')
    expect(result.isDirty).toBe(true)
  })

  it('returns state unchanged if booking not found', () => {
    const state = stateWith()
    const result = calendarReducer(state, {
      type: 'UPDATE_PROFESSOR_NOTE',
      payload: { bookingId: 'nonexistent', note: 'test' },
    })
    expect(result).toBe(state)
  })
})

// ── Blocked Time ─────────────────────────────────────────────

describe('ADD_BLOCKED_TIME', () => {
  it('adds blocked time and sets isDirty', () => {
    const bt = buildBT({ id: 'bt-new' })
    const result = calendarReducer(initialCalendarState, {
      type: 'ADD_BLOCKED_TIME',
      payload: { blockedTime: bt },
    })
    expect(result.blockedTimes['bt-new']).toEqual(bt)
    expect(result.isDirty).toBe(true)
  })
})

describe('REMOVE_BLOCKED_TIME', () => {
  it('removes blocked time by id', () => {
    const state = stateWith({ blockedTimes: { 'bt-1': buildBT() } })
    const result = calendarReducer(state, {
      type: 'REMOVE_BLOCKED_TIME',
      payload: { id: 'bt-1' },
    })
    expect(result.blockedTimes['bt-1']).toBeUndefined()
    expect(result.isDirty).toBe(true)
  })
})

// ── Slots ────────────────────────────────────────────────────

describe('UPDATE_SLOT_STATUS', () => {
  it('updates slot status and bookingId', () => {
    const slot = buildSlot({ id: 'slot-1', status: 'available' })
    const state = stateWith({ slots: { 'slot-1': slot } })

    const result = calendarReducer(state, {
      type: 'UPDATE_SLOT_STATUS',
      payload: { slotId: 'slot-1', status: 'booked', bookingId: 'b-1' },
    })
    expect(result.slots['slot-1'].status).toBe('booked')
    expect(result.slots['slot-1'].bookingId).toBe('b-1')
    expect(result.isDirty).toBe(true)
  })

  it('preserves existing bookingId when not provided', () => {
    const slot = buildSlot({ id: 'slot-1', status: 'booked', bookingId: 'b-1' })
    const state = stateWith({ slots: { 'slot-1': slot } })

    const result = calendarReducer(state, {
      type: 'UPDATE_SLOT_STATUS',
      payload: { slotId: 'slot-1', status: 'completed' },
    })
    expect(result.slots['slot-1'].bookingId).toBe('b-1')
  })

  it('returns state unchanged if slot not found', () => {
    const state = stateWith()
    const result = calendarReducer(state, {
      type: 'UPDATE_SLOT_STATUS',
      payload: { slotId: 'nonexistent', status: 'booked' },
    })
    expect(result).toBe(state)
  })
})

