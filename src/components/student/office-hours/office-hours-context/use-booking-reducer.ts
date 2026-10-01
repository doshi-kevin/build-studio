/**
 * Student booking state + reducer.
 */

import type {
  OfficeHours,
  Booking,
  BlockedTime,
  Slot,
  SlotStatus,
} from '@/lib/validations/calendar'
import { nowISO } from '@/lib/quiz/utils'

// ── State ─────────────────────────────────────────────────────

export interface BookingState {
  officeHours: Record<string, OfficeHours>
  bookings: Record<string, Booking>
  blockedTimes: Record<string, BlockedTime>
  slots: Record<string, Slot>

  // UI
  selectedProfessorId: string | null
  selectedDate: string
  selectedSlotId: string | null
  viewMode: 'upcoming' | 'history'

  isDirty: boolean
}

export const initialBookingState: BookingState = {
  officeHours: {},
  bookings: {},
  blockedTimes: {},
  slots: {},
  selectedProfessorId: null,
  selectedDate: new Date().toISOString().split('T')[0],
  selectedSlotId: null,
  viewMode: 'upcoming',
  isDirty: false,
}

// ── Actions ───────────────────────────────────────────────────

export type BookingAction =
  | { type: 'SET_DATA'; payload: { officeHours: OfficeHours[]; bookings: Booking[]; blockedTimes: BlockedTime[]; slots: Slot[] } }
  | { type: 'SELECT_PROFESSOR'; payload: { professorId: string | null } }
  | { type: 'SELECT_DATE'; payload: { date: string } }
  | { type: 'SELECT_SLOT'; payload: { slotId: string | null } }
  | { type: 'ADD_BOOKING'; payload: { booking: Booking } }
  | { type: 'CANCEL_BOOKING'; payload: { bookingId: string; reason: string } }
  | { type: 'UPDATE_SLOT_STATUS'; payload: { slotId: string; status: SlotStatus; bookingId?: string } }
  | { type: 'SET_SLOTS'; payload: { slots: Slot[] } }
  | { type: 'SET_VIEW_MODE'; payload: { mode: 'upcoming' | 'history' } }
  | { type: 'MARK_SAVED' }

// ── Helpers ───────────────────────────────────────────────────

function toRecord<T extends { id: string }>(items: T[]): Record<string, T> {
  const record: Record<string, T> = {}
  for (const item of items) record[item.id] = item
  return record
}

// ── Reducer ───────────────────────────────────────────────────

export function bookingReducer(
  state: BookingState,
  action: BookingAction,
): BookingState {
  switch (action.type) {
    case 'SET_DATA':
      return {
        ...state,
        officeHours: toRecord(action.payload.officeHours),
        bookings: toRecord(action.payload.bookings),
        blockedTimes: toRecord(action.payload.blockedTimes),
        slots: toRecord(action.payload.slots),
      }

    case 'SELECT_PROFESSOR':
      return { ...state, selectedProfessorId: action.payload.professorId }

    case 'SELECT_DATE':
      return { ...state, selectedDate: action.payload.date }

    case 'SELECT_SLOT':
      return { ...state, selectedSlotId: action.payload.slotId }

    case 'ADD_BOOKING': {
      const booking = action.payload.booking
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
        selectedSlotId: null,
        isDirty: true,
      }
    }

    case 'CANCEL_BOOKING': {
      const existing = state.bookings[action.payload.bookingId]
      if (!existing) return state
      const updated: Booking = {
        ...existing,
        status: 'cancelled',
        cancelledBy: 'student',
        cancellationReason: action.payload.reason,
        updatedAt: nowISO(),
      }
      const slotsAfter = { ...state.slots }
      if (slotsAfter[existing.slotId]) {
        slotsAfter[existing.slotId] = {
          ...slotsAfter[existing.slotId],
          status: 'available',
          bookingId: null,
          updatedAt: nowISO(),
        }
      }
      return {
        ...state,
        bookings: { ...state.bookings, [updated.id]: updated },
        slots: slotsAfter,
        isDirty: true,
      }
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

    case 'SET_SLOTS':
      return { ...state, slots: toRecord(action.payload.slots) }

    case 'SET_VIEW_MODE':
      return { ...state, viewMode: action.payload.mode }

    case 'MARK_SAVED':
      return { ...state, isDirty: false }

    default:
      return state
  }
}
