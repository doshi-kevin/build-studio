'use client'

import { useMemo } from 'react'
import {
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  addDays,
  isSameMonth,
  isSameDay,
  format,
} from 'date-fns'
import { Clock } from 'lucide-react'
import { formatDateISO } from '@/lib/calendar/utils'
import { buildEventColorMap } from './event-colors'
import { EVENT_STYLE, tintStyle, isoToHHMM, groupEventsByDay } from '@/components/student/calendar/event-style'
import type { Booking, OfficeHours } from '@/lib/validations/calendar'
import type { StudentCalendarEvent } from '@/lib/calendar/student-events'
import type { OfficeHoursChip } from '@/lib/calendar/professor-events'

interface MonthViewProps {
  currentDate: Date
  bookings: Booking[]
  officeHours: OfficeHours[]
  /** Class sessions + assignment/quiz due dates — read-only, no edit dialog. */
  readOnlyEvents: StudentCalendarEvent[]
  /** Expanded office-hours occurrences. Month has no time grid, so unlike Week/Day
   *  it can't derive these from bookable slots — they arrive pre-expanded. */
  officeHoursOccurrences: OfficeHoursChip[]
  onSelectDate: (date: string) => void
}

/** Total chips (all sources) shown inline before "+N more". */
const MAX_MONTH_CHIPS = 3

/** A day cell's chip candidates, unified so they can be sorted by time regardless of source. */
type DayItem =
  | { type: 'booking'; time: string; booking: Booking }
  | { type: 'readonly'; time: string; event: StudentCalendarEvent }
  | { type: 'officeHours'; time: string; chip: OfficeHoursChip }

export function MonthView({
  currentDate,
  bookings,
  officeHours,
  readOnlyEvents,
  officeHoursOccurrences,
  onSelectDate,
}: MonthViewProps) {
  const today = new Date()

  const courseColorMap = useMemo(() => {
    const courseIds = officeHours
      .map((oh) => oh.courseId)
      .filter((id): id is string => id !== null)
    return buildEventColorMap(courseIds)
  }, [officeHours])

  // Build calendar grid dates
  const calendarDays = useMemo(() => {
    const monthStart = startOfMonth(currentDate)
    const monthEnd = endOfMonth(currentDate)
    const calStart = startOfWeek(monthStart, { weekStartsOn: 1 })
    const calEnd = endOfWeek(monthEnd, { weekStartsOn: 1 })

    const days: Date[] = []
    let day = calStart
    while (day <= calEnd) {
      days.push(day)
      day = addDays(day, 1)
    }
    return days
  }, [currentDate])

  // Group bookings by date
  const bookingsByDate = useMemo(() => {
    const map = new Map<string, Booking[]>()
    for (const b of bookings) {
      if (b.status === 'cancelled') continue
      const arr = map.get(b.date) ?? []
      arr.push(b)
      map.set(b.date, arr)
    }
    return map
  }, [bookings])

  const readOnlyByDate = useMemo(() => groupEventsByDay(readOnlyEvents), [readOnlyEvents])

  const officeHoursByDate = useMemo(() => {
    const map = new Map<string, OfficeHoursChip[]>()
    for (const chip of officeHoursOccurrences) {
      const arr = map.get(chip.date) ?? []
      arr.push(chip)
      map.set(chip.date, arr)
    }
    return map
  }, [officeHoursOccurrences])

  const dayHeaders = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

  return (
    <div className="border border-border rounded-xl bg-card overflow-hidden">
      {/* Day headers */}
      <div className="grid grid-cols-7 border-b border-border">
        {dayHeaders.map((d) => (
          <div
            key={d}
            className="py-2 text-center text-xs font-medium text-muted-foreground uppercase tracking-wide"
          >
            {d}
          </div>
        ))}
      </div>

      {/* Calendar grid */}
      <div className="grid grid-cols-7">
        {calendarDays.map((day, idx) => {
          const dateStr = formatDateISO(day)
          const dayBookings = bookingsByDate.get(dateStr) ?? []
          const dayReadOnly = readOnlyByDate.get(dateStr) ?? []
          const dayOfficeHours = officeHoursByDate.get(dateStr) ?? []
          const inMonth = isSameMonth(day, currentDate)
          const isToday = isSameDay(day, today)

          // One combined cap across all three sources, interleaved by time so
          // the chips shown are the day's earliest events regardless of source —
          // a booking at 4 PM shouldn't outrank a 9 AM class just because
          // bookings happen to be listed first.
          const dayItems: DayItem[] = [
            ...dayBookings.map((b): DayItem => ({ type: 'booking', time: b.startTime, booking: b })),
            ...dayReadOnly.map((ev): DayItem => ({ type: 'readonly', time: isoToHHMM(ev.start), event: ev })),
            ...dayOfficeHours.map((c): DayItem => ({ type: 'officeHours', time: c.startTime, chip: c })),
          ].sort((a, b) => a.time.localeCompare(b.time))
          const shownItems = dayItems.slice(0, MAX_MONTH_CHIPS)
          const hiddenCount = dayItems.length - shownItems.length

          return (
            <div
              key={idx}
              className={`min-h-24 border-b border-r border-border p-1.5 cursor-pointer hover:bg-muted/40 transition-colors duration-200 ease-out ${
                !inMonth ? 'bg-muted/30' : ''
              }`}
              onClick={() => onSelectDate(dateStr)}
            >
              <p
                className={`text-xs mb-1 tabular-nums ${
                  isToday
                    ? 'bg-primary text-primary-foreground rounded-full w-6 h-6 flex items-center justify-center font-semibold'
                    : inMonth
                      ? 'text-foreground font-medium'
                      : 'text-muted-foreground'
                }`}
              >
                {format(day, 'd')}
              </p>

              {/* Booking chips + read-only class/deadline chips, interleaved by time, one combined cap */}
              <div className="space-y-0.5">
                {shownItems.map((item) => {
                  if (item.type === 'booking') {
                    const b = item.booking
                    const color = courseColorMap[b.courseId ?? '__general__'] ?? courseColorMap['__general__']
                    return (
                      <div
                        key={`booking-${b.id}`}
                        className={`flex items-center gap-1 text-[10px] truncate px-1 py-0.5 rounded-full ${color.bg} ${color.text}`}
                      >
                        <span className={`h-1 w-1 shrink-0 rounded-full ${color.dot}`} />
                        <span className="truncate">{b.title}</span>
                      </div>
                    )
                  }
                  if (item.type === 'officeHours') {
                    const c = item.chip
                    const color = courseColorMap[c.courseId ?? '__general__'] ?? courseColorMap['__general__']
                    return (
                      <div
                        key={c.id}
                        className={`flex items-center gap-1 text-[10px] truncate px-1 py-0.5 rounded-full ${color.bg} ${color.text}`}
                      >
                        <Clock className="h-2.5 w-2.5 shrink-0" />
                        <span className="truncate">{c.title}</span>
                      </div>
                    )
                  }
                  const ev = item.event
                  const style = EVENT_STYLE[ev.kind]
                  return (
                    <div
                      key={`readonly-${ev.id}`}
                      className="flex items-center gap-1 text-[10px] truncate px-1 py-0.5 rounded-full"
                      style={tintStyle(ev.kind)}
                    >
                      {/* An icon, not just a color dot, is the required second
                          signal — two chips both reading the same course code
                          (a class + a quiz due the same day) must stay
                          distinguishable without relying on a 4px color alone. */}
                      <style.Icon className="h-2.5 w-2.5 shrink-0" />
                      <span className="truncate">{ev.courseCode || style.label}</span>
                    </div>
                  )
                })}
                {hiddenCount > 0 && (
                  <p className="text-[10px] text-muted-foreground pl-1">
                    +{hiddenCount} more
                  </p>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
