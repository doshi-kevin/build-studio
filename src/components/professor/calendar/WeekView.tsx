'use client'

import { useMemo, useState, useEffect, useRef } from 'react'
import { isSameDay } from 'date-fns'
import { DayColumnHeader } from './DayColumnHeader'
import { TimeGutter } from './TimeGutter'
import { MeetingCard } from './MeetingCard'
import { ReadOnlyEventBlock, layoutReadOnlyDay } from './ReadOnlyEventBlock'
import {
  getWeekDays,
  formatDateISO,
  calculateTopPx,
  calculateHeightPx,
  ROW_HEIGHT_PX,
  TOTAL_ROWS,
  GRID_START_HOUR,
} from '@/lib/calendar/utils'
import { groupEventsByDay } from '@/components/student/calendar/event-style'
import { buildEventColorMap } from './event-colors'
import type { Booking, BlockedTime, Slot, OfficeHours } from '@/lib/validations/calendar'
import type { StudentCalendarEvent } from '@/lib/calendar/student-events'

interface WeekViewProps {
  currentDate: Date
  bookings: Booking[]
  officeHours: OfficeHours[]
  blockedTimes: BlockedTime[]
  slots: Slot[]
  /** Class sessions + assignment/quiz due dates — read-only, no edit dialog. */
  readOnlyEvents: StudentCalendarEvent[]
  onSelectBooking: (bookingId: string) => void
  onSelectOfficeHours: (officeHoursId: string) => void
  onSelectBlocked: (blockedTimeId: string) => void
}

export function WeekView({
  currentDate,
  bookings,
  officeHours,
  blockedTimes,
  slots,
  readOnlyEvents,
  onSelectBooking,
  onSelectOfficeHours,
  onSelectBlocked,
}: WeekViewProps) {
  const weekDays = useMemo(() => getWeekDays(currentDate), [currentDate])
  const [now, setNow] = useState(new Date())
  const scrollRef = useRef<HTMLDivElement>(null)

  // Update "now" indicator every minute
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(timer)
  }, [])

  // Scroll to ~8 AM on mount
  useEffect(() => {
    if (scrollRef.current) {
      const eightAM = ((8 - GRID_START_HOUR) * 60 / 30) * ROW_HEIGHT_PX
      scrollRef.current.scrollTop = eightAM - 20
    }
  }, [])

  // Color per office-hour: key by course when set, else the office-hour id, so every
  // office hour gets a distinct color (shared when they share a course).
  const colorMap = useMemo(
    () => buildEventColorMap(officeHours.map((oh) => oh.courseId ?? oh.id)),
    [officeHours],
  )

  // Group data by date
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

  const slotsByDate = useMemo(() => {
    const map = new Map<string, Slot[]>()
    for (const s of slots) {
      if (s.status !== 'available') continue
      const arr = map.get(s.date) ?? []
      arr.push(s)
      map.set(s.date, arr)
    }
    return map
  }, [slots])

  const blockedByDate = useMemo(() => {
    const map = new Map<string, BlockedTime[]>()
    for (const bt of blockedTimes) {
      const arr = map.get(bt.date) ?? []
      arr.push(bt)
      map.set(bt.date, arr)
    }
    return map
  }, [blockedTimes])

  // Office hours lookup
  const ohMap = useMemo(() => {
    const m = new Map<string, OfficeHours>()
    for (const oh of officeHours) m.set(oh.id, oh)
    return m
  }, [officeHours])

  const gridHeight = TOTAL_ROWS * ROW_HEIGHT_PX
  const readOnlyByDate = useMemo(() => groupEventsByDay(readOnlyEvents), [readOnlyEvents])

  return (
    <div
      ref={scrollRef}
      className="overflow-auto border border-border rounded-xl bg-card"
      style={{ maxHeight: 'calc(100vh - 200px)' }}
    >
      <div className="flex min-w-[700px]">
        {/* Time gutter */}
        <div className="shrink-0 border-r border-border" style={{ width: 60 }}>
          <div className="h-[52px] border-b border-border" />
          <div className="relative" style={{ height: gridHeight }}>
            <TimeGutter />
          </div>
        </div>

        {/* Day columns */}
        <div className="flex-1 grid grid-cols-7">
          {weekDays.map((day, dayIdx) => {
            const dateStr = formatDateISO(day)
            const dayBookings = bookingsByDate.get(dateStr) ?? []
            const daySlots = slotsByDate.get(dateStr) ?? []
            const dayBlocked = blockedByDate.get(dateStr) ?? []
            // Clamps into the grid window AND lane-packs those clamped spans in
            // one place, so a block's position and its lane can never disagree.
            const dayReadOnly = layoutReadOnlyDay(readOnlyByDate.get(dateStr) ?? [])
            const isToday = isSameDay(day, now)

            return (
              <div key={dayIdx} className="border-r last:border-r-0 border-border">
                {/* Day header */}
                <DayColumnHeader date={day} today={now} />

                {/* Time grid cells. overflow-hidden is defense-in-depth: every block
                    below is clamped into [0, gridHeight], but nothing should ever
                    be able to paint into the dead space above/below the grid. */}
                <div className="relative overflow-hidden" style={{ height: gridHeight }}>
                  {/* Grid lines */}
                  {Array.from({ length: TOTAL_ROWS }).map((_, rowIdx) => (
                    <div
                      key={rowIdx}
                      className={`absolute inset-x-0 border-t ${
                        rowIdx % 2 === 0 ? 'border-border' : 'border-border/20'
                      }`}
                      style={{ top: rowIdx * ROW_HEIGHT_PX }}
                    />
                  ))}

                  {/* Now indicator */}
                  {isToday && (() => {
                    const nowMins = now.getHours() * 60 + now.getMinutes()
                    const startMins = GRID_START_HOUR * 60
                    const offset = ((nowMins - startMins) / 30) * ROW_HEIGHT_PX
                    if (offset < 0 || offset > gridHeight) return null
                    return (
                      <div
                        className="absolute inset-x-0 z-20 pointer-events-none"
                        style={{ top: offset }}
                      >
                        <div className="h-0.5 bg-destructive" />
                        <div className="absolute -left-1 -top-1 w-2.5 h-2.5 rounded-full bg-destructive" />
                      </div>
                    )
                  })()}

                  {/* Class sessions + assignment/quiz due dates — read-only, rendered
                      first so editable meetings sit visually on top if they overlap. */}
                  {dayReadOnly.map((p) => (
                    <ReadOnlyEventBlock
                      key={p.event.id}
                      event={p.event}
                      startMin={p.startMin}
                      endMin={p.endMin}
                      clampedFromMin={p.clampedFromMin}
                      leftPct={p.leftPct}
                      widthPct={p.widthPct}
                    />
                  ))}

                  {/* Available slots — click to edit the office hour */}
                  {daySlots.map((slot) => {
                    const oh = ohMap.get(slot.officeHoursId)
                    const key = oh ? oh.courseId ?? oh.id : '__general__'
                    return (
                      <MeetingCard
                        key={slot.id}
                        type="available"
                        color={colorMap[key] ?? colorMap['__general__']}
                        officeHoursTitle={oh?.title}
                        topPx={calculateTopPx(slot.startTime)}
                        heightPx={calculateHeightPx(slot.startTime, slot.endTime)}
                        onClick={() => oh && onSelectOfficeHours(oh.id)}
                      />
                    )
                  })}

                  {/* Booked meetings */}
                  {dayBookings.map((booking) => (
                    <MeetingCard
                      key={booking.id}
                      type="booking"
                      booking={booking}
                      officeHoursTitle={ohMap.get(booking.officeHoursId)?.title}
                      color={colorMap[booking.courseId ?? booking.officeHoursId] ?? colorMap['__general__']}
                      topPx={calculateTopPx(booking.startTime)}
                      heightPx={calculateHeightPx(booking.startTime, booking.endTime)}
                      onClick={() => onSelectBooking(booking.id)}
                    />
                  ))}

                  {/* Blocked times / events — click to delete. Key by id+date: a recurring
                      series shares one id across its per-date occurrences. */}
                  {dayBlocked.map((bt) => (
                    <MeetingCard
                      key={`${bt.id}-${bt.date}`}
                      type="blocked"
                      blockedTime={bt}
                      color={colorMap['__general__']}
                      topPx={calculateTopPx(bt.startTime)}
                      heightPx={calculateHeightPx(bt.startTime, bt.endTime)}
                      onClick={() => onSelectBlocked(bt.id)}
                    />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
