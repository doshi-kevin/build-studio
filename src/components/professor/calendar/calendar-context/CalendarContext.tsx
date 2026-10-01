'use client'

/**
 * Calendar context provider — wraps useReducer with auto-save to localStorage.
 */

import { createContext, useContext, useReducer, useEffect, useRef, useMemo } from 'react'
import {
  calendarReducer,
  initialCalendarState,
  type CalendarState,
  type CalendarAction,
} from './use-calendar-reducer'
import { calendarStorage } from '@/lib/calendar/storage'

// ── Context ─────────────────────────────────────────────────

interface CalendarContextValue {
  state: CalendarState
  dispatch: React.Dispatch<CalendarAction>
}

const CalendarContext = createContext<CalendarContextValue | null>(null)

// ── Provider ────────────────────────────────────────────────

interface CalendarProviderProps {
  children: React.ReactNode
}

export function CalendarProvider({ children }: CalendarProviderProps) {
  const [state, dispatch] = useReducer(calendarReducer, initialCalendarState)

  // Auto-save to localStorage when isDirty (800ms debounce)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!state.isDirty) return

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      calendarStorage.saveAllOfficeHours(Object.values(state.officeHours))
      calendarStorage.saveAllBookings(Object.values(state.bookings))
      calendarStorage.saveAllBlockedTimes(Object.values(state.blockedTimes))
      calendarStorage.saveAllSlots(Object.values(state.slots))
      dispatch({ type: 'MARK_SAVED' })
    }, 800)

    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [state.isDirty, state.officeHours, state.bookings, state.blockedTimes, state.slots])

  const value = useMemo(() => ({ state, dispatch }), [state, dispatch])

  return (
    <CalendarContext.Provider value={value}>
      {children}
    </CalendarContext.Provider>
  )
}

// ── Hook ────────────────────────────────────────────────────

export function useCalendar(): CalendarContextValue {
  const ctx = useContext(CalendarContext)
  if (!ctx) {
    throw new Error('useCalendar must be used within a CalendarProvider')
  }
  return ctx
}
