'use client'

import { useMemo } from 'react'
import {
  startOfMonth, endOfMonth, startOfWeek, endOfWeek, addDays, isSameMonth, isSameDay, format,
} from 'date-fns'
import { cn } from '@/lib/utils'
import { formatDateISO } from '@/lib/calendar/utils'
import type { StudentCalendarEvent } from '@/lib/calendar/student-events'
import { groupEventsByDay, dotStyle, tintStyle } from './event-style'
import { EventHoverCard } from './EventHoverCard'

interface StudentMonthViewProps {
  currentDate: Date
  events: StudentCalendarEvent[]
  onSelectDay: (date: Date) => void
  /** Open the editor for a personal event (course items navigate instead). */
  onSelectPersonal?: (editKey: string) => void
}

const DAY_HEADERS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const MAX_CHIPS = 3

export function StudentMonthView({ currentDate, events, onSelectDay, onSelectPersonal }: StudentMonthViewProps) {
  const today = new Date()

  const calendarDays = useMemo(() => {
    const calStart = startOfWeek(startOfMonth(currentDate), { weekStartsOn: 1 })
    const calEnd = endOfWeek(endOfMonth(currentDate), { weekStartsOn: 1 })
    const days: Date[] = []
    let day = calStart
    while (day <= calEnd) {
      days.push(day)
      day = addDays(day, 1)
    }
    return days
  }, [currentDate])

  const eventsByDay = useMemo(() => groupEventsByDay(events), [events])
  const numRows = calendarDays.length / 7

  return (
    <div className="flex flex-col h-full min-h-0 border border-border rounded-2xl bg-card overflow-hidden">
      <div className="grid grid-cols-7 border-b border-border shrink-0">
        {DAY_HEADERS.map((d) => (
          <div key={d} className="py-2 text-center text-xs font-medium text-muted-foreground uppercase tracking-wide">
            {d}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 flex-1 min-h-0" style={{ gridTemplateRows: `repeat(${numRows}, minmax(0, 1fr))` }}>
        {calendarDays.map((day, idx) => {
          const dayEvents = eventsByDay.get(formatDateISO(day)) ?? []
          const inMonth = isSameMonth(day, currentDate)
          const isToday = isSameDay(day, today)

          return (
            // The cell is a plain container — the day number is the "open this day"
            // control (a button), so event links aren't nested inside another
            // interactive element (invalid ARIA + confusing tab order).
            <div
              key={idx}
              className={cn(
                'flex flex-col min-h-0 border-b border-r border-border p-1.5',
                !inMonth && 'bg-muted/30',
              )}
            >
              <button
                type="button"
                onClick={() => onSelectDay(day)}
                aria-label={`View ${format(day, 'EEEE, MMMM d')}`}
                className={cn(
                  'mb-1 inline-flex h-6 w-6 shrink-0 self-start items-center justify-center rounded-full text-xs tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
                  isToday
                    ? 'bg-primary text-primary-foreground font-semibold'
                    : inMonth
                      ? 'text-foreground font-medium hover:bg-muted'
                      : 'text-muted-foreground hover:bg-muted',
                )}
              >
                {format(day, 'd')}
              </button>

              <div className="flex-1 min-h-0 overflow-hidden space-y-0.5">
                {dayEvents.slice(0, MAX_CHIPS).map((e) => (
                  <EventHoverCard
                    key={e.id}
                    event={e}
                    onSelectPersonal={onSelectPersonal}
                    className="flex items-center gap-1 text-[10px] truncate px-1 py-0.5 rounded-full hover:brightness-95 transition"
                    style={tintStyle(e.kind)}
                  >
                    <span className="h-1 w-1 shrink-0 rounded-full" style={dotStyle(e.kind)} />
                    <span className="truncate">{e.courseCode ? `${e.courseCode} · ` : ''}{e.title}</span>
                  </EventHoverCard>
                ))}
                {dayEvents.length > MAX_CHIPS && (
                  <span className="block text-[10px] text-muted-foreground pl-1">
                    +{dayEvents.length - MAX_CHIPS} more
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
