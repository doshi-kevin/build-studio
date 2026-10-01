/**
 * Calendar state + reducer — manages office hours, bookings, blocked times, and UI state.
 */

import type {
  OfficeHours,
  Booking,
  BlockedTime,
  Slot,
  SlotStatus,
  MeetingPurpose,
} from '@/lib/validations/calendar'
import { nowISO } from '@/lib/quiz/utils'

// ── State ─────────────────────────────────────────────────────

export type CalendarViewMode = 'day' | 'week' | 'month'

export interface CalendarState {
  officeHours: Record<string, OfficeHours>
  bookings: Record<string, Booking>
  blockedTimes: Record<string, BlockedTime>
  slots: Record<string, Slot>

  // UI
  viewMode: CalendarViewMode
  currentDate: string // ISO date "YYYY-MM-DD"
  selectedBookingId: string | null
  filterCourseId: string | null
  filterPurpose: MeetingPurpose | null

  isDirty: boolean
}

export const initialCalendarState: CalendarState = {
  officeHours: {},
  bookings: {},
  blockedTimes: {},
  slots: {},
  viewMode: 'week',
  currentDate: new Date().toISOString().split('T')[0],
  selectedBookingId: null,
  filterCourseId: null,
  filterPurpose: null,
  isDirty: false,
}

// ── Actions ───────────────────────────────────────────────────

export type CalendarAction =
  // Office Hours
  | { type: 'ADD_OFFICE_HOURS'; payload: { officeHours: OfficeHours } }
  | { type: 'UPDATE_OFFICE_HOURS'; payload: { officeHours: OfficeHours } }
  | { type: 'REMOVE_OFFICE_HOURS'; payload: { id: string } }
  | { type: 'TOGGLE_OFFICE_HOURS_ACTIVE'; payload: { id: string } }

  // Bookings
  | { type: 'ADD_BOOKING'; payload: { booking: Booking } }
  | { type: 'CANCEL_BOOKING'; payload: { bookingId: string; cancelledBy: 'professor' | 'student'; reason: string } }
  | { type: 'MARK_BOOKING_STATUS'; payload: { bookingId: string; status: SlotStatus } }
  | { type: 'UPDATE_PROFESSOR_NOTE'; payload: { bookingId: string; note: string } }

  // Blocked Time
  | { type: 'ADD_BLOCKED_TIME'; payload: { blockedTime: BlockedTime } }
  | { type: 'REMOVE_BLOCKED_TIME'; payload: { id: string } }

  // Slots
  | { type: 'SET_SLOTS'; payload: { slots: Slot[] } }
  | { type: 'UPDATE_SLOT_STATUS'; payload: { slotId: string; status: SlotStatus; bookingId?: string } }

  // UI
  | { type: 'SET_VIEW_MODE'; payload: { mode: CalendarViewMode } }
  | { type: 'SET_CURRENT_DATE'; payload: { date: string } }
  | { type: 'SELECT_BOOKING'; payload: { bookingId: string | null } }
  | { type: 'SET_FILTER_COURSE'; payload: { courseId: string | null } }
  | { type: 'SET_FILTER_PURPOSE'; payload: { purpose: MeetingPurpose | null } }

  // Bulk
  | { type: 'SET_DATA'; payload: { officeHours: OfficeHours[]; bookings: Booking[]; blockedTimes: BlockedTime[]; slots: Slot[] } }
  | { type: 'MARK_SAVED' }

// ── Helpers ───────────────────────────────────────────────────

function toRecord<T extends { id: string }>(items: T[]): Record<string, T> {
  const record: Record<string, T> = {}
  for (const item of items) {
    record[item.id] = item
  }
  return record
}

// ── Reducer ───────────────────────────────────────────────────

export function calendarReducer(
  state: CalendarState,
  action: CalendarAction,
): CalendarState {
  switch (action.type) {
    // ── Office Hours ──────────────────────────────────────

    case 'ADD_OFFICE_HOURS':
      return {
        ...state,
        officeHours: { ...state.officeHours, [action.payload.officeHours.id]: action.payload.officeHours },
        isDirty: true,
      }

    case 'UPDATE_OFFICE_HOURS':
      return {
        ...state,
        officeHours: { ...state.officeHours, [action.payload.officeHours.id]: action.payload.officeHours },
        isDirty: true,
      }

    case 'REMOVE_OFFICE_HOURS': {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [action.payload.id]: _removed, ...rest } = state.officeHours
      return { ...state, officeHours: rest, isDirty: true }
    }

    case 'TOGGLE_OFFICE_HOURS_ACTIVE': {
      const oh = state.officeHours[action.payload.id]
      if (!oh) return state
      return {
        ...state,
        officeHours: {
          ...state.officeHours,
          [oh.id]: { ...oh, isActive: !oh.isActive, updatedAt: nowISO() },
        },
        isDirty: true,
      }
    }

    // ── Bookings ──────────────────────────────────────────

    case 'ADD_BOOKING': {
      const booking = action.payload.booking
      // Also update the corresponding slot
      const updatedSlots = { ...state.slots }
      if (updatedSlots[booking.slotId]) {
        updatedSlots[booking.slotId] = {
          ...updatedSlots[booking.slotId],
          status: 'booked',
          bookingId: booking.id,
          updatedAt: nowISO(),
        }
      }
      return {
        ...state,
        bookings: { ...state.bookings, [booking.id]: booking },
        slots: updatedSlots,
        isDirty: true,
      }
    }

    case 'CANCEL_BOOKING': {
      const existing = state.bookings[action.payload.bookingId]
      if (!existing) return state
      const updated: Booking = {
        ...existing,
        status: 'cancelled',
        cancelledBy: action.payload.cancelledBy,
        cancellationReason: action.payload.reason,
        updatedAt: nowISO(),
      }
      // Free the slot
      const slotsAfterCancel = { ...state.slots }
      if (slotsAfterCancel[existing.slotId]) {
        slotsAfterCancel[existing.slotId] = {
          ...slotsAfterCancel[existing.slotId],
          status: 'available',
          bookingId: null,
          updatedAt: nowISO(),
        }
      }
      return {
        ...state,
        bookings: { ...state.bookings, [updated.id]: updated },
        slots: slotsAfterCancel,
        selectedBookingId: null,
        isDirty: true,
      }
    }

    case 'MARK_BOOKING_STATUS': {
      const b = state.bookings[action.payload.bookingId]
      if (!b) return state
      const updatedBooking: Booking = {
        ...b,
        status: action.payload.status,
        updatedAt: nowISO(),
      }
      const slotsAfterMark = { ...state.slots }
      if (slotsAfterMark[b.slotId]) {
        slotsAfterMark[b.slotId] = {
          ...slotsAfterMark[b.slotId],
          status: action.payload.status,
          updatedAt: nowISO(),
        }
      }
      return {
        ...state,
        bookings: { ...state.bookings, [updatedBooking.id]: updatedBooking },
        slots: slotsAfterMark,
        isDirty: true,
      }
    }

    case 'UPDATE_PROFESSOR_NOTE': {
      const bn = state.bookings[action.payload.bookingId]
      if (!bn) return state
      return {
        ...state,
        bookings: {
          ...state.bookings,
          [bn.id]: { ...bn, professorNote: action.payload.note, updatedAt: nowISO() },
        },
        isDirty: true,
      }
    }

    // ── Blocked Time ──────────────────────────────────────

    case 'ADD_BLOCKED_TIME':
      return {
        ...state,
        blockedTimes: { ...state.blockedTimes, [action.payload.blockedTime.id]: action.payload.blockedTime },
        isDirty: true,
      }

    case 'REMOVE_BLOCKED_TIME': {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [action.payload.id]: _removed, ...restBt } = state.blockedTimes
      return { ...state, blockedTimes: restBt, isDirty: true }
    }

    // ── Slots ─────────────────────────────────────────────

    case 'SET_SLOTS':
      return {
        ...state,
        slots: toRecord(action.payload.slots),
      }

    case 'UPDATE_SLOT_STATUS': {
      const slot = state.slots[action.payload.slotId]
      if (!slot) return state
      return {
        ...state,
        slots: {
          ...state.slots,
          [slot.id]: {
            ...slot,
            status: action.payload.status,
            bookingId: action.payload.bookingId ?? slot.bookingId,
            updatedAt: nowISO(),
          },
        },
        isDirty: true,
      }
    }

    // ── UI ─────────────────────────────────────────────────

    case 'SET_VIEW_MODE':
      return { ...state, viewMode: action.payload.mode }

    case 'SET_CURRENT_DATE':
      return { ...state, currentDate: action.payload.date }

    case 'SELECT_BOOKING':
      return { ...state, selectedBookingId: action.payload.bookingId }

    case 'SET_FILTER_COURSE':
      return { ...state, filterCourseId: action.payload.courseId }

    case 'SET_FILTER_PURPOSE':
      return { ...state, filterPurpose: action.payload.purpose }

    // ── Bulk ──────────────────────────────────────────────

    case 'SET_DATA':
      return {
        ...state,
        officeHours: toRecord(action.payload.officeHours),
        bookings: toRecord(action.payload.bookings),
        blockedTimes: toRecord(action.payload.blockedTimes),
        slots: toRecord(action.payload.slots),
      }

    case 'MARK_SAVED':
      return { ...state, isDirty: false }

    default:
      return state
  }
}
