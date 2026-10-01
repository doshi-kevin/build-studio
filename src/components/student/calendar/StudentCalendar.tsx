'use client'

// Student calendar orchestrator: owns the view (month/week/day) + current date,
// renders the toolbar, legend, and the active view. Read-only — events link
// through to their page. Reuses the shared grid geometry; the professor
// calendar is untouched.

import { useState, useMemo, useCallback, useSyncExternalStore } from 'react'
import {
  addMonths, subMonths, addWeeks, subWeeks, addDays, subDays, format,
  startOfMonth, endOfMonth, startOfWeek, endOfWeek,
} from 'date-fns'
import { ChevronLeft, ChevronRight, CircleAlert, Info, CalendarPlus, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { WINDOW_DAYS } from '@/lib/calendar/utils'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { CalendarFeedCard } from '@/components/shared/CalendarFeedCard'
import { getWeekDays } from '@/lib/calendar/utils'
import type { StudentCalendarEvent } from '@/lib/calendar/student-events'
import { StudentMonthView } from './StudentMonthView'
import { StudentTimeGrid } from './StudentTimeGrid'
import { CalendarColorSettings } from './CalendarColorSettings'
import { PersonalEventsManager } from './PersonalEventsManager'
import type { PersonalEventRow } from '@/lib/validations/calendar'

type ViewMode = 'month' | 'week' | 'day'

interface StudentCalendarProps {
  events: StudentCalendarEvent[]
  /** When the fetch failed, surface it — an empty grid must not read as "nothing scheduled". */
  loadError?: boolean
  /** Feed token for the "Subscribe" dialog; null when the student hasn't generated one yet. */
  calendarToken?: {
    id: string
    token: string
    last_accessed_at: string | null
    access_count: number
    created_at: string
  } | null
  /** The student's own personal events, for the "Add event" manager dialog. */
  personalEvents?: PersonalEventRow[]
}

const VIEWS: ViewMode[] = ['month', 'week', 'day']

/* Stable arguments for the mount check, matching MiniCalendar and SetupSpotlight. */
const subscribeNoop = () => () => {}
const snapshotTrue = () => true
const snapshotFalse = () => false

/**
 * Reserves the calendar's box before any date exists (#765).
 *
 * Draws the chrome and an empty month grid rather than nothing, so the page does not jump when the
 * real calendar mounts.
 */
function StudentCalendarSkeleton() {
  return (
    <div aria-busy="true" className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <div className="h-8 w-24 rounded-xl bg-muted/60" />
        <div className="h-5 flex-1 min-w-0 rounded bg-muted/50" />
        <div className="h-8 w-28 rounded-xl bg-muted/60" />
      </div>
      <div className="grid grid-cols-7 gap-1.5">
        {Array.from({ length: 35 }).map((_, i) => (
          <div key={i} className="aspect-square rounded-xl bg-muted/30" />
        ))}
      </div>
    </div>
  )
}

/**
 * Hydration boundary for the whole calendar (#765).
 *
 * Same defect as MiniCalendar, and this is the route QA actually saw React error #418 on. The body
 * derives `currentDate` and `today` from `new Date()`, and two descendants do the same
 * (`StudentMonthView`'s `today`, `StudentTimeGrid`'s `now`). Client components are still
 * SERVER-rendered, so all of those ran in the server's timezone first. React does not repair a
 * mismatch of this kind, so an out-of-zone student was shown the server's date.
 *
 * Gating here covers the descendants too, because they only render inside this body.
 */
export function StudentCalendar(props: StudentCalendarProps) {
  const mounted = useSyncExternalStore(subscribeNoop, snapshotTrue, snapshotFalse)
  if (!mounted) return <StudentCalendarSkeleton />
  return <StudentCalendarBody {...props} />
}

function StudentCalendarBody({
  events,
  loadError = false,
  calendarToken = null,
  personalEvents = [],
}: StudentCalendarProps) {
  const [view, setView] = useState<ViewMode>('month')
  const [currentDate, setCurrentDate] = useState(() => new Date())
  const today = useMemo(() => new Date(), [])

  // The "Add event" dialog doubles as the editor: clicking a personal event on the grid
  // opens it pre-focused on that event (editId); the Add-event button opens it in create mode.
  const [manageOpen, setManageOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const openPersonalEditor = useCallback((id: string) => {
    setEditId(id)
    setManageOpen(true)
  }, [])

  const weekDays = useMemo(() => getWeekDays(currentDate), [currentDate])

  // Events are only loaded for ±WINDOW_DAYS around today. Paging beyond that
  // shows a blank grid that reads identically to "nothing scheduled" — so when
  // the whole visible range sits outside the loaded window, say so explicitly.
  const outOfRange = useMemo(() => {
    const windowStart = subDays(today, WINDOW_DAYS)
    const windowEnd = addDays(today, WINDOW_DAYS)
    let rangeStart: Date
    let rangeEnd: Date
    if (view === 'month') {
      rangeStart = startOfWeek(startOfMonth(currentDate), { weekStartsOn: 1 })
      rangeEnd = endOfWeek(endOfMonth(currentDate), { weekStartsOn: 1 })
    } else if (view === 'week') {
      rangeStart = weekDays[0]
      rangeEnd = weekDays[6]
    } else {
      rangeStart = currentDate
      rangeEnd = currentDate
    }
    return rangeEnd < windowStart || rangeStart > windowEnd
  }, [view, currentDate, weekDays, today])

  const periodLabel = useMemo(() => {
    if (view === 'month') return format(currentDate, 'MMMM yyyy')
    if (view === 'day') return format(currentDate, 'EEEE, MMMM d, yyyy')
    const start = weekDays[0]
    const end = weekDays[6]
    const sameMonth = start.getMonth() === end.getMonth()
    return sameMonth
      ? `${format(start, 'MMM d')} – ${format(end, 'd, yyyy')}`
      : `${format(start, 'MMM d')} – ${format(end, 'MMM d, yyyy')}`
  }, [view, currentDate, weekDays])

  const shift = (dir: 1 | -1) => {
    setCurrentDate((d) => {
      if (view === 'month') return dir === 1 ? addMonths(d, 1) : subMonths(d, 1)
      if (view === 'week') return dir === 1 ? addWeeks(d, 1) : subWeeks(d, 1)
      return dir === 1 ? addDays(d, 1) : subDays(d, 1)
    })
  }

  return (
    <div className="flex flex-col h-full min-h-0 gap-3">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight text-foreground min-w-0">{periodLabel}</h1>
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm">
                <CalendarPlus className="h-4 w-4 mr-1.5" />
                Subscribe
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-2xl">
              <DialogHeader>
                <DialogTitle>Subscribe to Calendar</DialogTitle>
                {/* Card below shows this copy visually; sr-only here so the dialog
                    is properly described for assistive tech (and no Radix warning). */}
                <DialogDescription className="sr-only">
                  Add your Scholera events to an external calendar app like Outlook.
                </DialogDescription>
              </DialogHeader>
              <CalendarFeedCard initialToken={calendarToken} bare />
            </DialogContent>
          </Dialog>

          <Dialog
            open={manageOpen}
            onOpenChange={(o) => {
              setManageOpen(o)
              if (!o) setEditId(null)
            }}
          >
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" onClick={() => setEditId(null)}>
                <Plus className="h-4 w-4 mr-1.5" />
                Add event
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-lg">
              <DialogHeader>
                <DialogTitle>{editId ? 'Edit event' : 'Your events'}</DialogTitle>
                <DialogDescription>
                  Add personal events — study blocks, reminders — to your calendar. They&apos;re private to you.
                </DialogDescription>
              </DialogHeader>
              {/* key remounts the manager so it initializes in edit or create mode from editId. */}
              <PersonalEventsManager key={editId ?? 'new'} events={personalEvents} initialEditId={editId} />
            </DialogContent>
          </Dialog>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setCurrentDate(new Date())}>Today</Button>
          <div className="flex items-center">
            <Button variant="ghost" size="icon" aria-label="Previous" onClick={() => shift(-1)}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" aria-label="Next" onClick={() => shift(1)}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>

          {/* View toggle */}
          <div className="flex items-center rounded-xl border border-border p-0.5">
            {VIEWS.map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                className={cn(
                  'px-3 py-1.5 text-xs font-medium rounded-xl capitalize transition-colors',
                  view === v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Legend + per-category color pickers */}
      <div className="shrink-0">
        <CalendarColorSettings />
      </div>

      {/* A failed load must not read as an empty calendar — surface it with a retry path. */}
      {loadError && (
        <div className="shrink-0 flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive-muted px-3 py-2 text-sm text-destructive-muted-foreground">
          <CircleAlert className="h-4 w-4 shrink-0" />
          Couldn&apos;t load your calendar. Refresh the page to try again.
        </div>
      )}

      {/* A blank grid outside the loaded window must not read as "nothing scheduled". */}
      {!loadError && outOfRange && (
        <div className="shrink-0 flex items-center gap-2 rounded-xl border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
          <Info className="h-4 w-4 shrink-0" />
          You&apos;ve scrolled past the calendar&apos;s range — it covers about four months before and after today.
        </div>
      )}

      {/* Active view — fills the remaining height */}
      <div className="flex-1 min-h-0">
        {view === 'month' && (
          <StudentMonthView
            currentDate={currentDate}
            events={events}
            onSelectDay={(day) => { setCurrentDate(day); setView('day') }}
            onSelectPersonal={openPersonalEditor}
          />
        )}
        {view === 'week' && (
          <StudentTimeGrid days={weekDays} events={events} onSelectPersonal={openPersonalEditor} />
        )}
        {view === 'day' && (
          <StudentTimeGrid days={[currentDate]} events={events} onSelectPersonal={openPersonalEditor} />
        )}
      </div>
    </div>
  )
}
