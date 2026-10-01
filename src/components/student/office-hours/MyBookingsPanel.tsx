'use client'

import { useMemo } from 'react'
import { CalendarCheck } from 'lucide-react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { EmptyState } from '@/components/ui/empty-state'
import { AnimatedList, AnimatedItem } from '@/components/ui/animated-list'
import { BookingCard } from './BookingCard'
import { formatDateISO } from '@/lib/calendar/utils'
import type { Booking } from '@/lib/validations/calendar'

interface MyBookingsPanelProps {
  bookings: Booking[]
  viewMode: 'upcoming' | 'history'
  onViewModeChange: (mode: 'upcoming' | 'history') => void
  onCancelBooking: (bookingId: string) => void
}

export function MyBookingsPanel({
  bookings,
  viewMode,
  onViewModeChange,
  onCancelBooking,
}: MyBookingsPanelProps) {
  // Local calendar date (not UTC) — otherwise an evening booking flips to History early.
  const today = formatDateISO(new Date())

  const filtered = useMemo(() => {
    if (viewMode === 'upcoming') {
      return bookings
        .filter(
          (b) =>
            b.status === 'booked' &&
            b.date >= today,
        )
        .sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime))
    }
    return bookings
      .filter(
        (b) =>
          b.status !== 'booked' || b.date < today,
      )
      .sort((a, b) => b.date.localeCompare(a.date) || b.startTime.localeCompare(a.startTime))
  }, [bookings, viewMode, today])

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          My Bookings
        </h3>
        <ToggleGroup
          type="single"
          value={viewMode}
          onValueChange={(v) => {
            if (v) onViewModeChange(v as 'upcoming' | 'history')
          }}
          className="h-7"
        >
          <ToggleGroupItem value="upcoming" className="h-7 px-2.5 text-xs">
            Upcoming
          </ToggleGroupItem>
          <ToggleGroupItem value="history" className="h-7 px-2.5 text-xs">
            History
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          variant="teaching"
          icon={CalendarCheck}
          title={viewMode === 'upcoming' ? 'No upcoming bookings' : 'No past bookings'}
          description={
            viewMode === 'upcoming'
              ? 'Book a slot to meet with your professor.'
              : 'Your past meetings will appear here.'
          }
        />
      ) : (
        <AnimatedList className="space-y-2">
          {filtered.map((b) => (
            <AnimatedItem key={b.id}>
              <BookingCard
                booking={b}
                onCancel={
                  b.status === 'booked' ? () => onCancelBooking(b.id) : undefined
                }
              />
            </AnimatedItem>
          ))}
        </AnimatedList>
      )}
    </div>
  )
}
