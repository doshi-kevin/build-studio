// Tests for bookingReducer — student office hours booking state machine.
// Covers booking CRUD, slot status sync, UI selections, and data loading.

import { describe, it, expect, vi } from 'vitest'
import {
  bookingReducer,
  initialBookingState,
  type BookingState,
} from '@/components/student/office-hours/office-hours-context/use-booking-reducer'
import type { Booking, Slot, OfficeHours, BlockedTime } from '@/lib/validations/calendar'

// Mock nowISO to return deterministic timestamps
vi.mock('@/lib/quiz/utils', () => ({
  nowISO: () => '2026-04-13T12:00:00Z',
}))

// ── Helpers ──────────────────────────────────────────────────

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
    zoomLink: 'https://zoom.us/j/123',
    status: 'booked',
    cancelledBy: null,
    cancellationReason: '',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

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

function stateWith(overrides: Partial<BookingState> = {}): BookingState {
  return { ...initialBookingState, ...overrides }
}

// ── SET_DATA ─────────────────────────────────────────────────

describe('SET_DATA', () => {
  it('converts arrays to records keyed by id', () => {
    const oh = buildOH({ id: 'oh-1' })
    const booking = buildBooking({ id: 'booking-1' })
    const bt = buildBT({ id: 'bt-1' })
    const slot = buildSlot({ id: 'slot-1' })

    const result = bookingReducer(initialBookingState, {
      type: 'SET_DATA',
      payload: {
        officeHours: [oh],
        bookings: [booking],
        blockedTimes: [bt],
        slots: [slot],
      },
    })
    expect(result.officeHours['oh-1']).toEqual(oh)
    expect(result.bookings['booking-1']).toEqual(booking)
    expect(result.blockedTimes['bt-1']).toEqual(bt)
    expect(result.slots['slot-1']).toEqual(slot)
  })

})

// ── UI Selections ────────────────────────────────────────────

describe('SELECT_PROFESSOR', () => {
  it('sets selectedProfessorId', () => {
    const result = bookingReducer(initialBookingState, {
      type: 'SELECT_PROFESSOR',
      payload: { professorId: 'prof-1' },
    })
    expect(result.selectedProfessorId).toBe('prof-1')
  })

  it('clears selectedProfessorId with null', () => {
    const state = stateWith({ selectedProfessorId: 'prof-1' })
    const result = bookingReducer(state, {
      type: 'SELECT_PROFESSOR',
      payload: { professorId: null },
    })
    expect(result.selectedProfessorId).toBeNull()
  })
})

// ── ADD_BOOKING ──────────────────────────────────────────────

describe('ADD_BOOKING', () => {
  it('adds booking and updates slot to booked', () => {
    const slot = buildSlot({ id: 'slot-1', status: 'available' })
    const state = stateWith({ slots: { 'slot-1': slot } })
    const booking = buildBooking({ id: 'booking-1', slotId: 'slot-1' })

    const result = bookingReducer(state, {
      type: 'ADD_BOOKING',
      payload: { booking },
    })
    expect(result.bookings['booking-1']).toEqual(booking)
    expect(result.slots['slot-1'].status).toBe('booked')
    expect(result.slots['slot-1'].bookingId).toBe('booking-1')
    expect(result.selectedSlotId).toBeNull()
    expect(result.isDirty).toBe(true)
  })

  it('still adds booking when slot does not exist', () => {
    const booking = buildBooking({ slotId: 'nonexistent-slot' })
    const result = bookingReducer(initialBookingState, {
      type: 'ADD_BOOKING',
      payload: { booking },
    })
    expect(result.bookings[booking.id]).toBeDefined()
  })
})

// ── CANCEL_BOOKING ───────────────────────────────────────────

describe('CANCEL_BOOKING', () => {
  it('cancels booking and frees the slot', () => {
    const slot = buildSlot({ id: 'slot-1', status: 'booked', bookingId: 'booking-1' })
    const booking = buildBooking({ id: 'booking-1', slotId: 'slot-1' })
    const state = stateWith({
      bookings: { 'booking-1': booking },
      slots: { 'slot-1': slot },
    })

    const result = bookingReducer(state, {
      type: 'CANCEL_BOOKING',
      payload: { bookingId: 'booking-1', reason: 'Changed my mind' },
    })
    expect(result.bookings['booking-1'].status).toBe('cancelled')
    expect(result.bookings['booking-1'].cancelledBy).toBe('student')
    expect(result.bookings['booking-1'].cancellationReason).toBe('Changed my mind')
    expect(result.slots['slot-1'].status).toBe('available')
    expect(result.slots['slot-1'].bookingId).toBeNull()
    expect(result.isDirty).toBe(true)
  })

  it('returns state unchanged if booking not found', () => {
    const state = stateWith()
    const result = bookingReducer(state, {
      type: 'CANCEL_BOOKING',
      payload: { bookingId: 'nonexistent', reason: 'test' },
    })
    expect(result).toBe(state)
  })
})

// ── UPDATE_SLOT_STATUS ───────────────────────────────────────

describe('UPDATE_SLOT_STATUS', () => {
  it('updates slot status and sets isDirty', () => {
    const slot = buildSlot({ id: 'slot-1', status: 'available' })
    const state = stateWith({ slots: { 'slot-1': slot } })

    const result = bookingReducer(state, {
      type: 'UPDATE_SLOT_STATUS',
      payload: { slotId: 'slot-1', status: 'booked', bookingId: 'booking-1' },
    })
    expect(result.slots['slot-1'].status).toBe('booked')
    expect(result.slots['slot-1'].bookingId).toBe('booking-1')
    expect(result.isDirty).toBe(true)
  })

  it('preserves existing bookingId when not provided', () => {
    const slot = buildSlot({ id: 'slot-1', status: 'booked', bookingId: 'booking-1' })
    const state = stateWith({ slots: { 'slot-1': slot } })

    const result = bookingReducer(state, {
      type: 'UPDATE_SLOT_STATUS',
      payload: { slotId: 'slot-1', status: 'completed' },
    })
    expect(result.slots['slot-1'].bookingId).toBe('booking-1')
  })

  it('returns state unchanged if slot not found', () => {
    const state = stateWith()
    const result = bookingReducer(state, {
      type: 'UPDATE_SLOT_STATUS',
      payload: { slotId: 'nonexistent', status: 'booked' },
    })
    expect(result).toBe(state)
  })
})

