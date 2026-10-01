'use client'

// Shared calendar-event trigger: a link to the event's page that reveals the
// EventDetailCard popup on hover/focus. Used by both the full calendar
// (week/month grids) and the dashboard mini calendar so the interaction is
// identical everywhere. Click → event page; hover → detail popup.

import Link from 'next/link'
import type { CSSProperties, MouseEvent, ReactNode } from 'react'
import { HoverCard, HoverCardTrigger, HoverCardContent } from '@/components/ui/hover-card'
import { cn } from '@/lib/utils'
import type { StudentCalendarEvent } from '@/lib/calendar/student-events'
import { EventDetailCard } from './EventDetailCard'

interface EventHoverCardProps {
  event: StudentCalendarEvent
  className: string
  style?: CSSProperties
  children: ReactNode
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
  /**
   * Click handler for the trigger. Defaults to stopping propagation so the link
   * works inside a clickable background (e.g. the mini calendar, whose empty
   * space opens the full calendar). Navigation still happens via the link.
   */
  onClick?: (e: MouseEvent) => void
  /** For editable events (personal ones carry `editKey`): open the editor on click
   *  instead of navigating. Course items have no editKey and keep their link. */
  onSelectPersonal?: (editKey: string) => void
}

export function EventHoverCard({
  event, className, style, children, side = 'top', align = 'center', onClick, onSelectPersonal,
}: EventHoverCardProps) {
  return (
    <HoverCard openDelay={120} closeDelay={60}>
      <HoverCardTrigger asChild>
        <Link
          href={event.href}
          /* A personal event opens an editor instead of navigating (see the
             preventDefault below), so the global route progress bar must not
             arm for this click. */
          data-no-route-progress=""
          onClick={(e) => {
            if (event.editKey && onSelectPersonal) {
              e.preventDefault()
              onSelectPersonal(event.editKey)
              return
            }
            if (onClick) onClick(e)
            else e.stopPropagation()
          }}
          className={cn(
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
            className,
          )}
          style={style}
        >
          {children}
        </Link>
      </HoverCardTrigger>
      <HoverCardContent side={side} align={align} className="w-64">
        <EventDetailCard event={event} />
      </HoverCardContent>
    </HoverCard>
  )
}
