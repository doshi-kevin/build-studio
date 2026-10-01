'use client'

import { Calendar, Clock, User, MapPin, Video, XCircle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatTimeDisplay } from '@/lib/calendar/utils'
import {
  MEETING_PURPOSE_LABELS,
  MEETING_TYPE_LABELS,
  SLOT_STATUS_LABELS,
  type SlotStatus,
} from '@/lib/validations/calendar'
import type { Booking } from '@/lib/validations/calendar'

// Semantic status styles (replaces raw-color SLOT_STATUS_COLORS from the shared
// calendar util, which the professor side still uses).
const STATUS_BADGE: Record<SlotStatus, string> = {
  available: 'bg-success-muted text-success-muted-foreground border-success/30',
  booked: 'bg-info-muted text-info-muted-foreground border-info/30',
  completed: 'bg-muted text-muted-foreground border-border',
  cancelled: 'bg-destructive-muted text-destructive-muted-foreground border-destructive/30',
  no_show: 'bg-warning-muted text-warning-muted-foreground border-warning/30',
}

interface BookingCardProps {
  booking: Booking
  onCancel?: () => void
}

export function BookingCard({ booking, onCancel }: BookingCardProps) {
  const canCancel = booking.status === 'booked'

  return (
    <div className="rounded-xl border border-border bg-card p-4 transition duration-200 ease-out hover:border-ring/40 hover:shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <h4 className="text-sm font-semibold truncate">{booking.title}</h4>
            <Badge variant="outline" className={`shrink-0 text-[10px] ${STATUS_BADGE[booking.status]}`}>
              {SLOT_STATUS_LABELS[booking.status]}
            </Badge>
          </div>

          <div className="space-y-1 text-xs text-muted-foreground">
            <div className="flex items-center gap-1.5">
              <User className="h-3 w-3 shrink-0" />
              <span>{booking.professorName}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <Calendar className="h-3 w-3 shrink-0" />
              <span className="tabular-nums">{booking.date}</span>
              <Clock className="h-3 w-3 shrink-0 ml-1" />
              <span className="tabular-nums">
                {formatTimeDisplay(booking.startTime)} – {formatTimeDisplay(booking.endTime)}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              {booking.meetingType === 'zoom' ? (
                <Video className="h-3 w-3 shrink-0" />
              ) : (
                <MapPin className="h-3 w-3 shrink-0" />
              )}
              <span>{MEETING_TYPE_LABELS[booking.meetingType]}</span>
              {booking.location && <span>· {booking.location}</span>}
            </div>
            {booking.zoomLink && booking.status === 'booked' && (
              <div className="flex items-center gap-1.5">
                <Video className="h-3 w-3 shrink-0" />
                <a
                  href={booking.zoomLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="truncate text-primary underline underline-offset-2 hover:no-underline"
                >
                  Join Zoom
                </a>
              </div>
            )}
          </div>

          <div className="flex gap-1.5 mt-2">
            <Badge variant="secondary" className="text-[10px]">
              {MEETING_PURPOSE_LABELS[booking.purpose]}
            </Badge>
            {booking.courseCode && (
              <Badge variant="outline" className="text-[10px]">
                {booking.courseCode}
              </Badge>
            )}
          </div>

          {booking.cancellationReason && (
            <p className="text-xs text-destructive mt-2 italic">
              Cancelled: {booking.cancellationReason}
            </p>
          )}
        </div>

        {canCancel && onCancel && (
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive shrink-0"
            onClick={onCancel}
          >
            <XCircle className="h-3.5 w-3.5 mr-1" />
            Cancel
          </Button>
        )}
      </div>
    </div>
  )
}
