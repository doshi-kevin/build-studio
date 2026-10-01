'use client'

// Applies the student's saved calendar category colors (localStorage) to the
// document root on load, so every surface (calendar, dashboard) reflects them.
// Renders nothing.

import { useEffect } from 'react'
import { applyCalendarColors } from '@/lib/calendar/category-colors'

export function CalendarColorsInit() {
  useEffect(() => { applyCalendarColors() }, [])
  return null
}
