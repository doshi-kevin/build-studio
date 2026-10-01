'use client'

import { MapPin, Video, Clock } from 'lucide-react'
import { formatTimeDisplay } from '@/lib/calendar/utils'
import { blockedTimeStyle, type EventColor } from './event-colors'
import type { Booking, BlockedTime } from '@/lib/validations/calendar'
import { BLOCK_REASON_LABELS } from '@/lib/validations/calendar'

interface MeetingCardProps {
  type: 'booking' | 'available' | 'blocked'
  booking?: Booking
  blockedTime?: BlockedTime
  officeHoursTitle?: string
  color: EventColor
  topPx: number
  heightPx: number
  onClick?: () => void
}

export function MeetingCard({
  type,
  booking,
  blockedTime,
  officeHoursTitle,
  color,
  topPx,
  heightPx,
  onClick,
}: MeetingCardProps) {
  const isCompact = heightPx < 50

  if (type === 'blocked' && blockedTime) {
    const style = blockedTimeStyle(blockedTime.reason)
    const label = blockedTime.note?.trim() || BLOCK_REASON_LABELS[blockedTime.reason]
    const mode = blockedTime.meetingType
    const ModeIcon = mode === 'zoom' ? Video : MapPin
    const modeText =
      mode === 'zoom'
        ? 'Zoom'
        : blockedTime.location?.trim() || (mode === 'hybrid' ? 'Hybrid' : 'In person')
    return (
      <div
        className={`absolute inset-x-1 cursor-pointer rounded-xl px-2 py-1 text-xs transition-shadow duration-200 ease-out hover:shadow-sm ${style.card}`}
        style={{ top: topPx, height: heightPx }}
        onClick={onClick}
      >
        <p className="flex items-center gap-1.5 truncate font-medium">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${style.dot}`} />
          {label}
        </p>
        {/* When the entry has a title, show its type underneath; otherwise the label above
            is already the type. */}
        {!isCompact && blockedTime.note?.trim() && (
          <p className="truncate pl-3">{BLOCK_REASON_LABELS[blockedTime.reason]}</p>
        )}
        {!isCompact && mode && (
          <div className="mt-0.5 flex items-center gap-1 pl-3">
            <ModeIcon className="h-3 w-3 shrink-0" />
            <span className="truncate">{modeText}</span>
          </div>
        )}
        {!isCompact && blockedTime.courseCode && (
          <span className="ml-3 mt-0.5 inline-block rounded-full bg-background/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            {blockedTime.courseCode}
          </span>
        )}
      </div>
    )
  }

  if (type === 'available') {
    return (
      <div
        className={`absolute inset-x-1 cursor-pointer rounded-xl border border-dashed border-border px-2 py-1 text-xs transition-shadow duration-200 ease-out hover:shadow-sm ${color.bg} ${color.text}`}
        style={{ top: topPx, height: heightPx }}
        onClick={onClick}
      >
        <div className="flex items-center gap-1">
          {officeHoursTitle ? (
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${color.dot}`} />
          ) : (
            <Clock className="h-3 w-3 shrink-0" />
          )}
          <span className="truncate font-medium">{officeHoursTitle || 'Available'}</span>
        </div>
      </div>
    )
  }

  // Booked meeting
  if (!booking) return null

  return (
    <div
      className={`absolute inset-x-1 rounded-xl px-2 py-1 text-xs cursor-pointer overflow-hidden hover:shadow-sm transition-shadow duration-200 ease-out ${color.bg} ${color.text}`}
      style={{ top: topPx, height: heightPx }}
      onClick={onClick}
    >
      <p className="flex items-center gap-1.5 font-semibold truncate">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${color.dot}`} />
        {booking.title}
      </p>
      {!isCompact && (
        <>
          <p className="truncate pl-3 text-muted-foreground">{booking.studentName}</p>
          <div className="flex items-center gap-1 mt-0.5 pl-3 text-muted-foreground">
            {booking.meetingType === 'zoom' ? (
              <Video className="h-3 w-3 shrink-0" />
            ) : (
              <MapPin className="h-3 w-3 shrink-0" />
            )}
            <span className="truncate tabular-nums">
              {formatTimeDisplay(booking.startTime)} – {formatTimeDisplay(booking.endTime)}
            </span>
          </div>
          {booking.courseCode && (
            <span className="ml-3 inline-block mt-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-background/60 text-muted-foreground">
              {booking.courseCode}
            </span>
          )}
        </>
      )}
      {isCompact && (
        <p className="truncate pl-3 text-muted-foreground">
          {booking.studentName} · {officeHoursTitle}
        </p>
      )}
    </div>
  )
}
