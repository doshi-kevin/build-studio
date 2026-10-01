// Hover-popup body for a single calendar event. Info only — plain text, no HTML
// injection. Shown inside a HoverCard; the trigger itself links to the event's
// page, so this card just adds context (course, day, time, status, description).

import { ArrowUpRight } from 'lucide-react'
import type { StudentCalendarEvent } from '@/lib/calendar/student-events'
import { cn } from '@/lib/utils'
import {
  EVENT_STYLE, STATUS_META, isDeadline, formatEventDay, formatEventTime, dotStyle, tintStyle,
} from './event-style'

export function EventDetailCard({ event }: { event: StudentCalendarEvent }) {
  const style = EVENT_STYLE[event.kind]
  const deadline = isDeadline(event)
  const day = formatEventDay(event.start)
  const time = deadline
    ? formatEventTime(event.start)
    : `${formatEventTime(event.start)}${event.end ? ` – ${formatEventTime(event.end)}` : ''}`

  return (
    <div className="flex flex-col gap-2">
      {/* Title + kind */}
      <div className="flex items-start gap-2">
        <span
          className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
          style={tintStyle(event.kind)}
        >
          <style.Icon className="h-3 w-3" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium leading-snug text-foreground">{event.title}</p>
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{style.label}</p>
        </div>
      </div>

      {/* Progress status (assignments / quizzes / project phases) */}
      {event.status && (
        <span className={cn(
          'inline-flex w-fit items-center rounded-full px-2 py-0.5 text-[11px] font-medium',
          STATUS_META[event.status].className,
        )}>
          {STATUS_META[event.status].label}
        </span>
      )}

      {/* Course · day · time */}
      <div className="flex flex-col gap-1 text-xs text-muted-foreground">
        {event.courseCode && (
          <span className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={dotStyle(event.kind)} />
            <span className="font-mono text-foreground">{event.courseCode}</span>
          </span>
        )}
        <span className="text-foreground">
          {deadline ? 'Due ' : ''}{day} · {time}
        </span>
        {event.location && <span className="truncate">{event.location}</span>}
      </div>

      {/* Description snippet */}
      {event.description && (
        <p className="text-xs leading-snug text-muted-foreground line-clamp-3">{event.description}</p>
      )}

      {/* Affordance: the whole trigger links through, this just labels it */}
      <span className="mt-0.5 flex items-center gap-0.5 text-[11px] font-medium text-foreground">
        Open <ArrowUpRight className="h-3 w-3" />
      </span>
    </div>
  )
}
