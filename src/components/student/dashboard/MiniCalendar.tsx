'use client'

// Compact dashboard calendar for the student right rail. Two modes:
//   • Week  — a scrollable 24h time grid: each item is positioned vertically by
//             its time of day (reuses the full calendar's lane-packing), opened
//             scrolled to the current hour.
//   • Month — a compact month grid listing each day's items.
// Prev/next page within the loaded semester window. Hovering an item shows a
// detail popup; clicking it opens that item's page; the header link opens the
// full /student/calendar.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import Link from 'next/link'
import {
  format, isSameDay, isSameMonth, addDays, subDays,
  addWeeks, subWeeks, addMonths, subMonths,
  startOfMonth, endOfMonth, startOfWeek, endOfWeek,
} from 'date-fns'
import { ChevronLeft, ChevronRight, ArrowUpRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { getWeekDays, formatDateISO, WINDOW_DAYS } from '@/lib/calendar/utils'
import type { StudentCalendarEvent } from '@/lib/calendar/student-events'
import {
  EVENT_STYLE, groupEventsByDay, layoutDayEvents, formatHourLabel,
  tintStyle, accentStyle, dotStyle, type PositionedEvent,
} from '@/components/student/calendar/event-style'
import { EventHoverCard } from '@/components/student/calendar/EventHoverCard'

type ViewMode = 'week' | 'month'

interface MiniCalendarProps {
  /** All events within the loaded semester window (±WINDOW_DAYS). */
  events: StudentCalendarEvent[]
  /** True when the calendar fetch failed — shows an error state, not an empty grid. */
  loadError?: boolean
  /**
   * Where the expand arrow goes. Defaults to the student calendar; the professor
   * dashboard passes its own so the grid can be shared between both roles
   * (the event shape and styling are identical — only the sources differ).
   */
  fullCalendarHref?: string
  /** Chips shown per day in month view before "+N more". See DEFAULT_maxChips. */
  monthMaxChips?: number
}

const FULL_CALENDAR = '/student/calendar'
const DAY_HEADERS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const GUTTER = 34 // px, time-label column in week view
const HOUR_PX = 40 // px per hour row in the (scrollable) week grid
// Default chips shown per day before "+N more". At the professor rail's
// default height a day cell only reliably fits one chip before a 2nd silently
// clips under `overflow-hidden` with no affordance to reach it — the professor
// dashboard passes 1. The student rail doesn't have that constraint, so it
// keeps the original 2.
const DEFAULT_maxChips = 2
const DAY_END = 24 * 60 // minutes in a day
const EDGE_PAD = 30 // minutes of padding above 00:00 and below 24:00 so edge items aren't clipped

/* Stable arguments for the mount check below, matching SetupSpotlight's existing pattern. */
const subscribeNoop = () => () => {}
const snapshotTrue = () => true
const snapshotFalse = () => false

/**
 * Reserves the calendar's box before any date exists (#765).
 *
 * Rendered on the server and on the first client pass, so both agree. It deliberately draws the
 * chrome and an empty grid rather than nothing: returning null would collapse the card and the page
 * would jump when the real calendar mounts.
 */
function MiniCalendarSkeleton() {
  return (
    <section
      aria-busy="true"
      className="flex flex-col h-full min-h-0 rounded-2xl border border-border bg-card overflow-hidden"
    >
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-border shrink-0">
        <div className="h-6 w-14 rounded-full bg-muted/60" />
        <div className="h-4 flex-1 min-w-0 rounded bg-muted/50" />
        <div className="h-6 w-14 rounded-full bg-muted/60" />
      </div>
      <div className="flex-1 min-h-0 p-3">
        <div className="grid h-full grid-cols-7 gap-1.5">
          {Array.from({ length: 21 }).map((_, i) => (
            <div key={i} className="rounded-xl bg-muted/30" />
          ))}
        </div>
      </div>
    </section>
  )
}

/**
 * Hydration boundary for everything date-dependent (#765).
 *
 * This is a client component, but client components are still SERVER-rendered in the App Router, so
 * `new Date()` inside the body ran once in the server's timezone and again in the browser's. When
 * the two landed on different calendar dates the markup disagreed, React logged error #418, and
 * React does NOT repair a mismatch of this kind: the student was left looking at the SERVER's date
 * on the surface they use to work out what is due. Confirmed live on two routes.
 *
 * Deliberately NOT solved by threading a date down from a server component: the server's date is
 * the bug, so making it authoritative just entrenches it. And NOT by `suppressHydrationWarning`,
 * which silences the warning and keeps the wrong date on screen.
 */
export function MiniCalendar(props: MiniCalendarProps) {
  const mounted = useSyncExternalStore(subscribeNoop, snapshotTrue, snapshotFalse)
  if (!mounted) return <MiniCalendarSkeleton />
  return <MiniCalendarBody {...props} />
}

function MiniCalendarBody({
  events,
  loadError = false,
  fullCalendarHref = FULL_CALENDAR,
  monthMaxChips = DEFAULT_maxChips,
}: MiniCalendarProps) {
  const [view, setView] = useState<ViewMode>('week')
  const [currentDate, setCurrentDate] = useState(() => new Date())
  const today = useMemo(() => new Date(), [])

  const byDay = useMemo(() => groupEventsByDay(events), [events])
  const eventsOn = (day: Date) => byDay.get(formatDateISO(day)) ?? []

  const weekDays = useMemo(() => getWeekDays(currentDate), [currentDate])

  const monthDays = useMemo(() => {
    const start = startOfWeek(startOfMonth(currentDate), { weekStartsOn: 1 })
    const end = endOfWeek(endOfMonth(currentDate), { weekStartsOn: 1 })
    const days: Date[] = []
    for (let d = start; d <= end; d = addDays(d, 1)) days.push(d)
    return days
  }, [currentDate])

  // Navigation is bounded to the loaded window so an empty grid never implies
  // "nothing due" when we simply haven't fetched that far.
  const windowStart = useMemo(() => subDays(today, WINDOW_DAYS), [today])
  const windowEnd = useMemo(() => addDays(today, WINDOW_DAYS), [today])
  const rangeStart = view === 'week' ? weekDays[0] : monthDays[0]
  const rangeEnd = view === 'week' ? weekDays[6] : monthDays[monthDays.length - 1]
  const canPrev = rangeStart > windowStart
  const canNext = rangeEnd < windowEnd

  const periodLabel = useMemo(() => {
    if (view === 'month') return format(currentDate, 'MMMM yyyy')
    const [start, end] = [weekDays[0], weekDays[6]]
    return start.getMonth() === end.getMonth()
      ? `${format(start, 'MMM d')} – ${format(end, 'd')}`
      : `${format(start, 'MMM d')} – ${format(end, 'MMM d')}`
  }, [view, currentDate, weekDays])

  const shift = (dir: 1 | -1) => {
    setCurrentDate((d) => {
      if (view === 'month') return dir === 1 ? addMonths(d, 1) : subMonths(d, 1)
      return dir === 1 ? addWeeks(d, 1) : subWeeks(d, 1)
    })
  }

  return (
    <section className="flex flex-col h-full min-h-0 rounded-2xl border border-border bg-card overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-border shrink-0">
        <div className="flex items-center">
          <NavButton label="Previous" disabled={!canPrev} onClick={() => shift(-1)}>
            <ChevronLeft className="h-4 w-4" />
          </NavButton>
          <NavButton label="Next" disabled={!canNext} onClick={() => shift(1)}>
            <ChevronRight className="h-4 w-4" />
          </NavButton>
        </div>

        <h2 className="flex-1 min-w-0 truncate text-sm font-semibold tracking-tight text-foreground">
          {periodLabel}
        </h2>

        <button
          type="button"
          onClick={() => setCurrentDate(new Date())}
          className="rounded-full px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        >
          Today
        </button>

        {/* View toggle */}
        <div className="flex items-center rounded-xl border border-border p-0.5">
          {(['week', 'month'] as ViewMode[]).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={cn(
                'px-2 py-0.5 text-[11px] font-medium rounded-xl capitalize transition-colors',
                view === v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {v}
            </button>
          ))}
        </div>

        <Link
          href={fullCalendarHref}
          aria-label="Open full calendar"
          className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
        >
          <ArrowUpRight className="h-4 w-4" />
        </Link>
      </div>

      {loadError ? (
        <div className="flex flex-1 min-h-0 items-center justify-center p-4 text-center">
          <p className="text-xs text-muted-foreground">
            Couldn&apos;t load your calendar. Refresh to try again.
          </p>
        </div>
      ) : view === 'week' ? (
        <WeekBody weekDays={weekDays} today={today} eventsOn={eventsOn} />
      ) : (
        <MonthBody monthDays={monthDays} currentDate={currentDate} today={today} eventsOn={eventsOn} maxChips={monthMaxChips} />
      )}
    </section>
  )
}

// ── Week view: scrollable time grid ─────────────────────────────────────────

function WeekBody({
  weekDays, today, eventsOn,
}: {
  weekDays: Date[]
  today: Date
  eventsOn: (day: Date) => StudentCalendarEvent[]
}) {
  // Span the full 24h day, with a little padding above midnight and below the last
  // minute so items due first thing in the morning or right at midnight aren't
  // clipped at the grid's top/bottom edges.
  const winStart = -EDGE_PAD
  const winEnd = DAY_END + EDGE_PAD
  const span = winEnd - winStart
  const hours = Array.from({ length: 24 }, (_, h) => h) // 0:00 … 23:00 lines + labels
  const cols = `${GUTTER}px repeat(7, minmax(0, 1fr))`
  const gridHeight = (span / 60) * HOUR_PX

  const positionAt = (min: number) => `${((min - winStart) / span) * 100}%`

  const positionedByDay = useMemo(() => {
    const m = new Map<string, PositionedEvent[]>()
    for (const day of weekDays) {
      m.set(formatDateISO(day), layoutDayEvents(eventsOn(day), winStart, winEnd))
    }
    return m
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekDays, winStart, winEnd])

  const nowMin = today.getHours() * 60 + today.getMinutes()

  // Open scrolled so the current time sits near the top, keeping "now → tonight" in view.
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = Math.max(0, ((nowMin - winStart) / span) * gridHeight - HOUR_PX)
  }, [winStart, span, gridHeight, nowMin])

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
        {/* Day headers — sticky so they stay while the grid scrolls */}
        <div className="grid sticky top-0 z-40 bg-card border-b border-border" style={{ gridTemplateColumns: cols }}>
          <div className="border-r border-border" />
          {weekDays.map((day, i) => {
            const isToday = isSameDay(day, today)
            return (
              <div key={i} className="border-r border-border last:border-r-0 py-1 text-center">
                <p className="text-[9px] uppercase tracking-wide text-muted-foreground leading-none">{format(day, 'EEE')}</p>
                <p className={cn(
                  'text-xs tabular-nums mt-0.5 inline-flex items-center justify-center w-5 h-5',
                  isToday ? 'bg-primary text-primary-foreground rounded-full font-semibold' : 'text-foreground',
                )}>
                  {format(day, 'd')}
                </p>
              </div>
            )
          })}
        </div>

        {/* Time grid — fixed hour height, scrolls within the rail */}
        <div className="grid relative" style={{ gridTemplateColumns: cols, height: `${gridHeight}px` }}>
        {/* Gutter */}
        <div className="relative border-r border-border">
          {hours.map((h) => (
            <span
              key={h}
              className="absolute right-1 -translate-y-1/2 text-[9px] text-muted-foreground tabular-nums"
              style={{ top: positionAt(h * 60) }}
            >
              {h === 0 ? '' : formatHourLabel(h)}
            </span>
          ))}
        </div>

        {/* Day columns */}
        {weekDays.map((day, dayIdx) => {
          const positioned = positionedByDay.get(formatDateISO(day)) ?? []
          const isToday = isSameDay(day, today)
          return (
            <div key={dayIdx} className="relative border-r border-border last:border-r-0">
              {hours.map((h) => (
                <div
                  key={h}
                  className="absolute inset-x-0 border-t border-border/40"
                  style={{ top: positionAt(h * 60) }}
                />
              ))}

              {isToday && (
                <div
                  className="absolute inset-x-0 z-30 pointer-events-none"
                  style={{ top: positionAt(nowMin) }}
                >
                  <div className="h-px bg-destructive" />
                </div>
              )}

              {positioned.map((p) => {
                const ev = p.event
                const style = EVENT_STYLE[ev.kind]
                const left = `calc(${p.leftPct}% + 1px)`
                const width = `calc(${p.widthPct}% - 2px)`
                const label = ev.courseCode || style.label

                if (p.heightPct === null) {
                  // Deadline — marker pill at the due time.
                  return (
                    <EventHoverCard side="left" align="start"
                      key={ev.id}
                      event={ev}
                      className="absolute z-20 flex items-center gap-0.5 rounded-full border-l-2 px-1 py-px overflow-hidden hover:brightness-95 transition"
                      style={{ top: `${p.topPct}%`, left, width, transform: 'translateY(-50%)', ...tintStyle(ev.kind), ...accentStyle(ev.kind) }}
                    >
                      <style.Icon className="h-2.5 w-2.5 shrink-0" />
                      <span className="truncate text-[9px] leading-none">{label}</span>
                    </EventHoverCard>
                  )
                }

                // Timed block.
                return (
                  <EventHoverCard side="left" align="start"
                    key={ev.id}
                    event={ev}
                    className="absolute z-10 flex items-center gap-0.5 rounded-xl border-l-2 px-1 py-px overflow-hidden hover:brightness-95 transition"
                    style={{ top: `${p.topPct}%`, height: `${p.heightPct}%`, left, width, ...tintStyle(ev.kind), ...accentStyle(ev.kind) }}
                  >
                    <style.Icon className="h-2.5 w-2.5 shrink-0" />
                    <span className="truncate text-[9px] leading-tight">{label}</span>
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

// ── Month view: compact grid, items listed per day ──────────────────────────

function MonthBody({
  monthDays, currentDate, today, eventsOn, maxChips,
}: {
  monthDays: Date[]
  currentDate: Date
  today: Date
  eventsOn: (day: Date) => StudentCalendarEvent[]
  maxChips: number
}) {
  const numRows = monthDays.length / 7

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="grid grid-cols-7 border-b border-border shrink-0">
        {DAY_HEADERS.map((d) => (
          <div key={d} className="py-1 text-center text-[9px] font-medium text-muted-foreground uppercase tracking-wide">
            {d}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 flex-1 min-h-0" style={{ gridTemplateRows: `repeat(${numRows}, minmax(0, 1fr))` }}>
        {monthDays.map((day, idx) => {
          const dayEvents = eventsOn(day)
          const inMonth = isSameMonth(day, currentDate)
          const isToday = isSameDay(day, today)
          return (
            <div
              key={idx}
              className={cn(
                'flex flex-col min-h-0 border-b border-r border-border p-1 overflow-hidden',
                !inMonth && 'bg-muted/30',
              )}
            >
              <span className={cn(
                'mb-0.5 inline-flex h-4 w-4 shrink-0 self-start items-center justify-center rounded-full text-[10px] tabular-nums',
                isToday ? 'bg-primary text-primary-foreground font-semibold' : inMonth ? 'text-foreground' : 'text-muted-foreground',
              )}>
                {format(day, 'd')}
              </span>

              <div className="flex-1 min-h-0 overflow-hidden space-y-0.5">
                {dayEvents.slice(0, maxChips).map((ev) => (
                  <EventHoverCard side="left" align="start"
                    key={ev.id}
                    event={ev}
                    className="flex items-center gap-1 text-[9px] truncate px-1 py-px rounded-full hover:brightness-95 transition"
                    style={tintStyle(ev.kind)}
                  >
                    <span className="h-1 w-1 shrink-0 rounded-full" style={dotStyle(ev.kind)} />
                    <span className="truncate">{ev.courseCode || EVENT_STYLE[ev.kind].label}</span>
                  </EventHoverCard>
                ))}
                {dayEvents.length > maxChips && (
                  <Popover>
                    <PopoverTrigger asChild>
                      <button
                        type="button"
                        aria-label={`Show all ${dayEvents.length} events on ${format(day, 'MMMM d')}`}
                        className="block w-full text-left text-[9px] text-muted-foreground pl-1 hover:text-foreground transition-colors"
                      >
                        +{dayEvents.length - maxChips} more
                      </button>
                    </PopoverTrigger>
                    <PopoverContent side="right" align="start" className="w-56 p-2">
                      <p className="px-1 pb-1.5 text-[11px] font-semibold text-foreground">
                        {format(day, 'EEEE, MMM d')}
                      </p>
                      <div className="space-y-0.5">
                        {dayEvents.map((ev) => (
                          <Link
                            key={ev.id}
                            href={ev.href}
                            className="flex items-center gap-1.5 rounded-xl px-1.5 py-1 text-xs text-foreground hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                          >
                            <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={dotStyle(ev.kind)} />
                            <span className="truncate">
                              {ev.courseCode ? `${ev.courseCode} · ` : ''}{ev.title}
                            </span>
                          </Link>
                        ))}
                      </div>
                    </PopoverContent>
                  </Popover>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Small toolbar nav button ─────────────────────────────────────────────────

function NavButton({
  label, disabled, onClick, children,
}: {
  label: string
  disabled: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30 disabled:pointer-events-none transition-colors"
    >
      {children}
    </button>
  )
}
