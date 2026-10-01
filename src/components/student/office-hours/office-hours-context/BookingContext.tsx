'use client'

import { createContext, useContext, useReducer, useEffect, useRef, useMemo } from 'react'
import {
  bookingReducer,
  initialBookingState,
  type BookingState,
  type BookingAction,
} from './use-booking-reducer'
import { calendarStorage } from '@/lib/calendar/storage'

interface BookingContextValue {
  state: BookingState
  dispatch: React.Dispatch<BookingAction>
}

const BookingContext = createContext<BookingContextValue | null>(null)

interface BookingProviderProps {
  children: React.ReactNode
}

export function BookingProvider({ children }: BookingProviderProps) {
  const [state, dispatch] = useReducer(bookingReducer, initialBookingState)

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!state.isDirty) return

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      calendarStorage.saveAllBookings(Object.values(state.bookings))
      calendarStorage.saveAllSlots(Object.values(state.slots))
      dispatch({ type: 'MARK_SAVED' })
    }, 800)

    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [state.isDirty, state.bookings, state.slots])

  const value = useMemo(() => ({ state, dispatch }), [state, dispatch])

  return (
    <BookingContext.Provider value={value}>
      {children}
    </BookingContext.Provider>
  )
}

export function useBooking(): BookingContextValue {
  const ctx = useContext(BookingContext)
  if (!ctx) {
    throw new Error('useBooking must be used within a BookingProvider')
  }
  return ctx
}
