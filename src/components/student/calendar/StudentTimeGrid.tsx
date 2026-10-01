'use client'

// Shared Week (7 days) / Day (1 day) grid. Spans the full 24h day; the grid is
// sized so exactly VISIBLE_HOURS fit the viewport and the rest scrolls. Events
// are laid out in side-by-side lanes so overlapping items never cover each other.
// Timed events (classes, booked office hours) render as blocks; deadlines render
// as a marker pill at their actual due time. Day headers stay fixed above scroll.

import { useMemo, useRef, useState, useEffect } from 'react'
import { isSameDay, format } from 'date-fns'
import { cn } from '@/lib/utils'
import { formatDateISO } from '@/lib/calendar/utils'
import type { StudentCalendarEvent } from '@/lib/calendar/student-events'
import {
  EVENT_STYLE, groupEventsByDay, layoutDayEvents, formatEventTime, formatHourLabel,
  tintStyle, accentStyle, type PositionedEvent,
} from './event-style'
import { EventHoverCard } from './EventHoverCard'

interface StudentTimeGridProps {
  days: Date[]
  events: StudentCalendarEvent[]
  /** Open the editor for a personal event (course items navigate instead). */
  onSelectPersonal?: (editKey: string) => void
}

const HOURS = Array.from({ length: 24 }, (_, h) => h)
const VISIBLE_HOURS = 9
/** Grid is this % of the visible body height, so VISIBLE_HOURS fit and the rest scrolls. */
const GRID_HEIGHT_PCT = (24 / VISIBLE_HOURS) * 100
const SCROLL_TO_HOUR = 7

export function StudentTimeGrid({ days, events, onSelectPersonal }: StudentTimeGridProps) {
  const [now, setNow] = useState(() => new Date())
  const [scrollbarW, setScrollbarW] = useState(0)
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(t)
  }, [])

  // Start scrolled to the morning rather than midnight.
  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = (SCROLL_TO_HOUR / 24) * el.scrollHeight
  }, [])

  // The scrollable body reserves a scrollbar; the fixed header doesn't. Pad the
  // header by the scrollbar width so its column lines line up with the grid.
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const measure = () => setScrollbarW(el.offsetWidth - el.clientWidth)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const positionedByDay = useMemo(() => {
    const m = new Map<string, PositionedEvent[]>()
    for (const [key, evs] of groupEventsByDay(events)) m.set(key, layoutDayEvents(evs))
    return m
  }, [events])

  const cols = `56px repeat(${days.length}, minmax(0, 1fr))`

  return (
    <div className="flex flex-col h-full min-h-0 border border-border rounded-2xl bg-card overflow-hidden">
      {/* Fixed day headers — padded by the scrollbar width so columns align with the grid */}
      <div className="grid shrink-0 border-b border-border" style={{ gridTemplateColumns: cols, paddingRight: scrollbarW }}>
        <div className="border-r border-border" />
        {days.map((day, i) => {
          const isToday = isSameDay(day, now)
          return (
            <div key={i} className="border-r border-border last:border-r-0 py-2 text-center">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{format(day, 'EEE')}</p>
              <p className={cn('text-sm tabular-nums mt-0.5 inline-flex items-center justify-center w-7 h-7',
                isToday ? 'bg-primary text-primary-foreground rounded-full font-semibold' : 'text-foreground')}>
                {format(day, 'd')}
              </p>
            </div>
          )
        })}
      </div>

      {/* Scrollable body — 9 hours visible, rest scrolls */}
      <div ref={bodyRef} className="flex-1 min-h-0 overflow-y-auto">
        <div className="grid relative" style={{ gridTemplateColumns: cols, height: `${GRID_HEIGHT_PCT}%` }}>
          {/* Time gutter */}
          <div className="relative border-r border-border">
            {HOURS.map((h) => (
              <span
                key={h}
                className="absolute right-1 -translate-y-1/2 text-[10px] text-muted-foreground tabular-nums"
                style={{ top: `${(h / 24) * 100}%` }}
              >
                {h === 0 ? '' : formatHourLabel(h)}
              </span>
            ))}
          </div>

          {/* Day columns */}
          {days.map((day, dayIdx) => {
            const positioned = positionedByDay.get(formatDateISO(day)) ?? []
            const isToday = isSameDay(day, now)
            return (
              <div key={dayIdx} className="relative border-r border-border last:border-r-0">
                {/* Hour lines */}
                {HOURS.map((h) => (
                  <div key={h} className="absolute inset-x-0 border-t border-border/40" style={{ top: `${(h / 24) * 100}%` }} />
                ))}

                {/* Now indicator */}
                {isToday && (
                  <div
                    className="absolute inset-x-0 z-30 pointer-events-none"
                    style={{ top: `${((now.getHours() * 60 + now.getMinutes()) / 1440) * 100}%` }}
                  >
                    <div className="h-0.5 bg-destructive" />
                    <div className="absolute -left-1 -top-1 h-2 w-2 rounded-full bg-destructive" />
                  </div>
                )}

                {/* Events (laned side-by-side) */}
                {positioned.map((p) => {
                  const e = p.event
                  const style = EVENT_STYLE[e.kind]
                  const left = `calc(${p.leftPct}% + 1px)`
                  const width = `calc(${p.widthPct}% - 2px)`

                  if (p.heightPct === null) {
                    return (
                      <EventHoverCard
                        key={e.id}
                        event={e}
                        onSelectPersonal={onSelectPersonal}
                        className="absolute z-20 flex items-center gap-1 rounded-full border-l-2 px-1.5 py-0.5 overflow-hidden hover:brightness-95 transition"
                        style={{ top: `${p.topPct}%`, left, width, transform: 'translateY(-50%)', ...tintStyle(e.kind), ...accentStyle(e.kind) }}
                      >
                        <style.Icon className="h-2.5 w-2.5 shrink-0" />
                        <span className="truncate text-[10px] leading-tight">{e.title}</span>
                      </EventHoverCard>
                    )
                  }

                  return (
                    <EventHoverCard
                      key={e.id}
                      event={e}
                      onSelectPersonal={onSelectPersonal}
                      className="absolute z-10 block rounded-xl border-l-2 px-1.5 py-0.5 overflow-hidden hover:brightness-95 transition"
                      style={{ top: `${p.topPct}%`, height: `${p.heightPct}%`, left, width, ...tintStyle(e.kind), ...accentStyle(e.kind) }}
                    >
                      <p className="text-[10px] font-medium leading-tight truncate">{e.title}</p>
                      <p className="text-[9px] opacity-80 truncate">
                        {e.courseCode ? `${e.courseCode} · ` : ''}{formatEventTime(e.start)}
                      </p>
                    </EventHoverCard>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
