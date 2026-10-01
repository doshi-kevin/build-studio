'use client'

import { useMemo, useState, useEffect, useRef } from 'react'
import { isSameDay, format } from 'date-fns'
import { TimeGutter } from './TimeGutter'
import { MeetingCard } from './MeetingCard'
import { ReadOnlyEventBlock, layoutReadOnlyDay } from './ReadOnlyEventBlock'
import {
  formatDateISO,
  calculateTopPx,
  calculateHeightPx,
  ROW_HEIGHT_PX,
  TOTAL_ROWS,
  GRID_START_HOUR,
} from '@/lib/calendar/utils'
import { buildEventColorMap } from './event-colors'
import type { Booking, BlockedTime, Slot, OfficeHours } from '@/lib/validations/calendar'
import type { StudentCalendarEvent } from '@/lib/calendar/student-events'

interface DayViewProps {
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

export function DayView({
  currentDate,
  bookings,
  officeHours,
  blockedTimes,
  slots,
  readOnlyEvents,
  onSelectBooking,
  onSelectOfficeHours,
  onSelectBlocked,
}: DayViewProps) {
  const [now, setNow] = useState(new Date())
  const scrollRef = useRef<HTMLDivElement>(null)
  const dateStr = formatDateISO(currentDate)

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (scrollRef.current) {
      const eightAM = ((8 - GRID_START_HOUR) * 60 / 30) * ROW_HEIGHT_PX
      scrollRef.current.scrollTop = eightAM - 20
    }
  }, [])

  const colorMap = useMemo(
    () => buildEventColorMap(officeHours.map((oh) => oh.courseId ?? oh.id)),
    [officeHours],
  )

  const ohMap = useMemo(() => {
    const m = new Map<string, OfficeHours>()
    for (const oh of officeHours) m.set(oh.id, oh)
    return m
  }, [officeHours])

  const dayBookings = useMemo(
    () => bookings.filter((b) => b.date === dateStr && b.status !== 'cancelled'),
    [bookings, dateStr],
  )
  const daySlots = useMemo(
    () => slots.filter((s) => s.date === dateStr && s.status === 'available'),
    [slots, dateStr],
  )
  const dayBlocked = useMemo(
    () => blockedTimes.filter((bt) => bt.date === dateStr),
    [blockedTimes, dateStr],
  )
  // Clamps into the grid window AND lane-packs those clamped spans in one
  // place, so a block's position and its lane can never disagree.
  const dayReadOnly = useMemo(
    () => layoutReadOnlyDay(readOnlyEvents.filter((ev) => formatDateISO(new Date(ev.start)) === dateStr)),
    [readOnlyEvents, dateStr],
  )

  const isToday = isSameDay(currentDate, now)
  const gridHeight = TOTAL_ROWS * ROW_HEIGHT_PX

  return (
    <div
      ref={scrollRef}
      className="overflow-auto border border-border rounded-xl bg-card"
      style={{ maxHeight: 'calc(100vh - 200px)' }}
    >
      <div className="flex min-w-[300px]">
        {/* Time gutter */}
        <div className="shrink-0 border-r border-border" style={{ width: 60 }}>
          <div className="h-[52px] border-b border-border" />
          <div className="relative" style={{ height: gridHeight }}>
            <TimeGutter />
          </div>
        </div>

        {/* Single day column */}
        <div className="flex-1">
          {/* Header */}
          <div className="text-center py-2 border-b border-border">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">
              {format(currentDate, 'EEEE')}
            </p>
            <p
              className={`text-sm font-semibold mt-0.5 tabular-nums ${
                isToday
                  ? 'bg-primary text-primary-foreground rounded-full w-7 h-7 flex items-center justify-center mx-auto'
                  : ''
              }`}
            >
              {format(currentDate, 'd')}
            </p>
          </div>

          {/* Time grid. overflow-hidden is defense-in-depth: every block below is
              clamped into [0, gridHeight], but nothing should ever be able to
              paint into the dead space above/below the grid. */}
          <div className="relative overflow-hidden" style={{ height: gridHeight }}>
            {Array.from({ length: TOTAL_ROWS }).map((_, rowIdx) => (
              <div
                key={rowIdx}
                className={`absolute inset-x-0 border-t ${
                  rowIdx % 2 === 0 ? 'border-border' : 'border-border/20'
                }`}
                style={{ top: rowIdx * ROW_HEIGHT_PX }}
              />
            ))}

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
      </div>
    </div>
  )
}
