'use client'

import { useMemo } from 'react'
import { addDays, startOfWeek, format, isSameDay } from 'date-fns'
import { Clock, MapPin, Video } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { formatTimeDisplay, formatDateISO, etWallClockToIso } from '@/lib/calendar/utils'
import { MEETING_TYPE_LABELS } from '@/lib/validations/calendar'
import type { Slot, OfficeHours } from '@/lib/validations/calendar'

/**
 * Has this slot's start time already passed?
 *
 * Resolved in EASTERN, matching the server's own check byte for byte:
 *   new Date(etWallClockToIso(date, startTime)).getTime() <= Date.now()
 *
 * It used to compare the slot's wall-clock time against the BROWSER's clock
 * (`h * 60 + m` vs `today.getHours()`), which only agrees with the server for a
 * viewer who happens to be in Eastern. Everyone else was shown slots the server
 * would refuse — a guaranteed-to-fail click presented as available — and, in the
 * other direction, had bookable slots hidden from them (#711).
 *
 * Slot times are stored as a bare local date plus `HH:MM`, so the Eastern offset for
 * that specific date is what makes this exact across EST/EDT.
 */
const hasPassed = (date: string, startTime: string) =>
  new Date(etWallClockToIso(date, startTime)).getTime() <= Date.now()

interface AvailableSlotListProps {
  slots: Slot[]
  officeHours: OfficeHours[]
  professorId: string
  selectedDate: string
  onSelectDate: (date: string) => void
  onSelectSlot: (slotId: string) => void
}

export function AvailableSlotsList({
  slots,
  officeHours,
  professorId,
  selectedDate,
  onSelectDate,
  onSelectSlot,
}: AvailableSlotListProps) {
  const today = new Date()

  // Generate 14 date buttons (current week + next week)
  const monday = startOfWeek(today, { weekStartsOn: 1 })
  const dateButtons = Array.from({ length: 14 }, (_, i) => addDays(monday, i))

  // Office hours lookup
  const ohMap = useMemo(() => {
    const m = new Map<string, OfficeHours>()
    for (const oh of officeHours) m.set(oh.id, oh)
    return m
  }, [officeHours])

  // Available slots for the selected professor and date
  // Not memoized: the past-slot filter depends on the current time, which changes anyway.
  const availableSlots = slots
    .filter(
      (s) =>
        s.professorId === professorId &&
        s.date === selectedDate &&
        s.status === 'available' &&
        // Any slot already past, not just today's — the server refuses all of them.
        !hasPassed(s.date, s.startTime),
    )
    .sort((a, b) => a.startTime.localeCompare(b.startTime))

  // Count available (still-future) slots per date for the dot indicators.
  const slotCountByDate = new Map<string, number>()
  for (const s of slots) {
    if (s.professorId !== professorId || s.status !== 'available') continue
    if (hasPassed(s.date, s.startTime)) continue
    slotCountByDate.set(s.date, (slotCountByDate.get(s.date) ?? 0) + 1)
  }

  return (
    <div className="space-y-4">
      {/* Date selector */}
      <div>
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
          Select Date
        </h3>
        <div className="flex gap-1.5 overflow-x-auto pb-2">
          {dateButtons.map((date) => {
            const dateStr = formatDateISO(date)
            const isSelected = dateStr === selectedDate
            const isToday = isSameDay(date, today)
            const count = slotCountByDate.get(dateStr) ?? 0
            const isPast = date < today && !isToday

            return (
              <button
                key={dateStr}
                onClick={() => onSelectDate(dateStr)}
                disabled={isPast}
                className={cn(
                  'flex flex-col items-center min-w-[52px] px-2 py-2 rounded-xl border text-xs transition duration-200 ease-out shrink-0',
                  isSelected
                    ? 'border-primary bg-primary text-primary-foreground'
                    : isPast
                      ? 'border-border/50 text-muted-foreground/50 cursor-not-allowed'
                      : 'border-border hover:border-ring/40 hover:bg-muted/50 cursor-pointer',
                )}
              >
                <span className="font-medium">{format(date, 'EEE')}</span>
                <span className={cn('text-lg font-bold tabular-nums', isToday && !isSelected && 'text-primary')}>
                  {format(date, 'd')}
                </span>
                {count > 0 && (
                  <span className={cn('text-[10px] tabular-nums', isSelected ? 'text-primary-foreground/80' : 'text-success-muted-foreground')}>
                    {/* "1 slots" read wrong on the very number this fix is about (#712). */}
                    {count} {count === 1 ? 'slot' : 'slots'}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </div>

      {/* Slots grid */}
      <div>
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
          Available Slots
        </h3>

        {availableSlots.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-muted/20 py-8 text-center text-sm text-muted-foreground">
            No available slots for this date.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {availableSlots.map((slot) => {
              const oh = ohMap.get(slot.officeHoursId)
              if (!oh) return null

              return (
                <div
                  key={slot.id}
                  className="rounded-xl border border-border bg-card p-3 transition duration-200 ease-out hover:border-ring/40 hover:shadow-sm"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 text-sm font-medium tabular-nums">
                        <Clock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        {formatTimeDisplay(slot.startTime)} – {formatTimeDisplay(slot.endTime)}
                      </div>
                      <div className="flex items-center gap-2 mt-1">
                        {oh.courseCode && (
                          <Badge variant="secondary" className="text-[10px]">
                            {oh.courseCode}
                          </Badge>
                        )}
                        <span className="text-xs text-muted-foreground flex items-center gap-0.5">
                          {oh.meetingType === 'zoom' ? (
                            <Video className="h-3 w-3" />
                          ) : oh.meetingType === 'in_person' ? (
                            <MapPin className="h-3 w-3" />
                          ) : (
                            <>
                              <MapPin className="h-3 w-3" />
                              <Video className="h-3 w-3" />
                            </>
                          )}
                          {MEETING_TYPE_LABELS[oh.meetingType]}
                        </span>
                      </div>
                    </div>
                    <Button size="sm" onClick={() => onSelectSlot(slot.id)}>
                      Book
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
