/**
 * AvailabilityGrid — when the professor and this student are both free.
 *
 * A dumb renderer on purpose. Every interval here was merged, padded, inverted
 * and bucketed into an Eastern day on the SERVER (see
 * `src/lib/calendar/availability.ts`). Doing that here would mean shipping the
 * student's raw calendar to the browser, and bucketing in the reader's timezone
 * would shift every block for a professor who is travelling.
 *
 * A block is opaque unless it is one of the viewing professor's own classes.
 * The professor needs to know when the student is unavailable, not why: what
 * else they are taking, and what they wrote on their own study blocks and
 * reminders, is not on this page at any zoom level.
 *
 * THE SHORTLIST COMES FIRST, then the grid. The list is the answer and the grid
 * is the evidence for it; a professor who trusts the list never has to scroll,
 * which is the entire time saving. It used to sit below a 420px grid that also
 * scrolls sideways on a phone, which put the one actionable thing on the page
 * more than a screen down.
 *
 * Type: Client Component (week toggle)
 */
'use client'

import { useMemo, useState } from 'react'
import { format } from 'date-fns'
import { CalendarClock, CalendarOff, Mail } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { formatTimeDisplay, minutesToTime } from '@/lib/calendar/utils'
import { WINDOW_END_MIN, WINDOW_START_MIN, type FreeSlot } from '@/lib/calendar/availability'

/** One block of occupied time, already merged. Minutes from Eastern midnight. */
interface BusyBlock {
  startMin: number
  endMin: number
  /** Course code, when this is one of the viewing professor's own classes. */
  label: string | null
}

interface AvailabilityDay {
  /** `yyyy-MM-dd`, Eastern. */
  date: string
  busy: BusyBlock[]
  /** Stretches where neither person has anything, long enough to meet in. */
  free: { startMin: number; endMin: number }[]
}

interface AvailabilityGridProps {
  days: AvailabilityDay[]
  suggestions: FreeSlot[]
  studentName: string
  studentEmail: string
  /** False when neither calendar had a single entry in the window. */
  hasCalendarData: boolean
  /** True when a calendar read failed, which is not the same as "nothing on". */
  loadError: boolean
}

const WINDOW_MINUTES = WINDOW_END_MIN - WINDOW_START_MIN
const DAYS_PER_PAGE = 7

/** Label every second hour: 14 labels in this height is unreadable. */
const HOUR_LABELS = Array.from(
  { length: Math.floor(WINDOW_MINUTES / 60) + 1 },
  (_, i) => WINDOW_START_MIN + i * 60,
).filter((min) => (min / 60) % 2 === 1)

/** `yyyy-MM-dd` to a Date in the reader's zone, for display only. */
function toDisplayDate(date: string): Date {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y, m - 1, d)
}

function formatSlotRange(slot: FreeSlot): string {
  return `${formatTimeDisplay(minutesToTime(slot.startMin))} to ${formatTimeDisplay(minutesToTime(slot.endMin))}`
}

/** Short hour label for the gutter: "11 AM" rather than "11:00 AM". */
function formatHourLabel(min: number): string {
  const h = Math.floor(min / 60)
  const period = h >= 12 ? 'PM' : 'AM'
  const display = h === 0 ? 12 : h > 12 ? h - 12 : h
  return `${display} ${period}`
}

/**
 * A ready-to-send email proposing one slot. The professor's mail client opens
 * with the day and time already written in, which is the whole point of having
 * calculated the slot.
 *
 * The time says "Eastern" out loud. Every hour on this page is Eastern by
 * design, but the professor reading it may not be, and a bare "3:00 PM" in an
 * email is how two people end up at different meetings.
 */
function buildMailto(slot: FreeSlot, studentName: string, studentEmail: string): string {
  const day = format(toDisplayDate(slot.date), 'EEEE, MMMM d')
  const firstName = studentName.split(' ')[0] || 'there'
  const subject = `Meeting on ${format(toDisplayDate(slot.date), 'MMM d')}?`
  const body = `Hi ${firstName},\n\nAre you free to meet on ${day} from ${formatSlotRange(slot)} Eastern?\n\nThanks`
  return `mailto:${encodeURIComponent(studentEmail)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
}

export function AvailabilityGrid({
  days,
  suggestions,
  studentName,
  studentEmail,
  hasCalendarData,
  loadError,
}: AvailabilityGridProps) {
  const [page, setPage] = useState(0)

  const pageCount = Math.max(1, Math.ceil(days.length / DAYS_PER_PAGE))
  const visibleDays = useMemo(
    () => days.slice(page * DAYS_PER_PAGE, page * DAYS_PER_PAGE + DAYS_PER_PAGE),
    [days, page],
  )

  const firstName = studentName.split(' ')[0] || studentName

  /** Every state that cannot show a grid still offers the way forward: email them. */
  const emailButton = (
    <Button asChild variant="outline" size="sm">
      <a href={`mailto:${encodeURIComponent(studentEmail)}`}>
        <Mail className="h-4 w-4" />
        Email {firstName}
      </a>
    </Button>
  )

  /* Three different claims, and the copy has to keep them apart. A failed read
     means we don't know. No entries means we have nothing on record, which is
     NOT the same as the student being free all week. Only a grid with data can
     say anything about availability. */
  if (loadError) {
    return (
      <EmptyState
        icon={CalendarOff}
        title="Couldn't load the schedules"
        description="One of the calendars didn't come back, so this would show gaps that may not be real. Reload to try again."
        className="py-10"
      >
        {emailButton}
      </EmptyState>
    )
  }

  if (!hasCalendarData) {
    return (
      <EmptyState
        icon={CalendarClock}
        title="Nothing on either calendar"
        description={`Neither your schedule nor ${studentName}'s has anything in the next two weeks, so there is nothing to compare.`}
        className="py-10"
      >
        {emailButton}
      </EmptyState>
    )
  }

  return (
    <div className="space-y-6">
      {/* ── The answer. Above the grid deliberately. ───────────────────────── */}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Times that work for both of you
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Soonest half-hour openings across the next two weeks, Eastern time, with a little room
          either side for getting there.
        </p>

        {suggestions.length === 0 ? (
          <div className="mt-3 rounded-xl border border-border bg-muted/30 px-4 py-3">
            <p className="text-sm text-muted-foreground">
              No half-hour gap in the next two weeks where you are both free between 7am and 9pm.
            </p>
            <div className="mt-3">{emailButton}</div>
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-border overflow-hidden rounded-xl border border-border">
            {suggestions.map((slot) => (
              <li
                key={`${slot.date}-${slot.startMin}`}
                className="flex flex-wrap items-center justify-between gap-2 bg-card px-4 py-2.5"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">
                    {format(toDisplayDate(slot.date), 'EEE d MMM')}
                  </p>
                  <p className="text-xs tabular-nums text-muted-foreground">{formatSlotRange(slot)}</p>
                </div>
                <Button asChild variant="outline" size="sm">
                  <a href={buildMailto(slot, studentName, studentEmail)}>
                    <Mail className="h-3.5 w-3.5" />
                    Propose by email
                  </a>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── The evidence. ─────────────────────────────────────────────────── */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex h-9 items-center rounded-lg bg-muted p-1 text-muted-foreground gap-1" role="group" aria-label="Which week to show">
            {Array.from({ length: pageCount }, (_, i) => {
              const slice = days.slice(i * DAYS_PER_PAGE, i * DAYS_PER_PAGE + DAYS_PER_PAGE)
              // Dated labels, so the button says which week rather than making
              // the reader hold "the week after" in their head.
              const label = slice.length
                ? `${format(toDisplayDate(slice[0].date), 'MMM d')} – ${format(toDisplayDate(slice[slice.length - 1].date), 'MMM d')}`
                : `Week ${i + 1}`
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => setPage(i)}
                  aria-pressed={page === i}
                  className={cn(
                    'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                    page === i ? 'bg-background text-foreground shadow-sm' : 'hover:text-foreground',
                  )}
                >
                  {label}
                </button>
              )
            })}
          </div>

          {/* Each state has a swatch AND a word — the grid must not rely on
              colour alone to be readable. */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
            <span className="inline-flex items-center gap-1.5 font-medium text-success-muted-foreground">
              <span className="h-3 w-3 rounded-md border border-success-muted-foreground/30 bg-success-muted" />
              Both free
            </span>
            <span className="inline-flex items-center gap-1.5 text-muted-foreground">
              <span className="h-3 w-3 rounded-md bg-muted-foreground/60" />
              Busy
            </span>
            <span className="inline-flex items-center gap-1.5 text-muted-foreground">
              <span className="h-3 w-3 rounded-md border border-primary/50 bg-primary/25" />
              Your class
            </span>
          </div>
        </div>

        {/* A screen reader gets the list above, which carries the same answer in
            text with a button per slot. Wading through 40 unlabelled positioned
            divs to reach it would be worse than skipping them. */}
        <p className="sr-only">
          Grid of shared free time for the fortnight, shown visually. The times you can propose
          are listed above it in full.
        </p>

        <div
          className="overflow-x-auto rounded-2xl border border-border bg-card"
          aria-hidden="true"
        >
          <div className="min-w-[600px]">
            <div
              className="grid"
              style={{ gridTemplateColumns: `56px repeat(${visibleDays.length}, minmax(0, 1fr))` }}
            >
              {/* Header row. The corner cell is sticky for the same reason the
                  gutter below it is. */}
              <div className="sticky left-0 z-20 border-b border-border bg-card" />
              {visibleDays.map((day) => {
                const d = toDisplayDate(day.date)
                return (
                  <div key={day.date} className="border-b border-l border-border px-2 py-2 text-center">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      {format(d, 'EEE')}
                    </p>
                    <p className="text-sm font-medium tabular-nums text-foreground">{format(d, 'd')}</p>
                  </div>
                )
              })}

              {/* Hour gutter. STICKY: the grid scrolls sideways on a phone, and
                  once the gutter left the viewport every block became a coloured
                  rectangle at an unknown time. Same treatment GradebookTable
                  gives its name column. */}
              <div className="sticky left-0 z-20 h-[420px] bg-card">
                {HOUR_LABELS.map((min, i) => {
                  const isFirst = i === 0
                  const isLast = i === HOUR_LABELS.length - 1
                  return (
                    <span
                      key={min}
                      className={cn(
                        'absolute right-2 whitespace-nowrap text-[10px] tabular-nums text-muted-foreground',
                        // Clamp the end labels inside the 420px box. Centring
                        // them on their rule pushed 7 AM up into the header and
                        // 9 PM past the bottom, which also gave the card a
                        // phantom 7px vertical scrollbar.
                        isFirst ? 'translate-y-0' : isLast ? '-translate-y-full' : '-translate-y-1/2',
                      )}
                      style={{ top: `${((min - WINDOW_START_MIN) / WINDOW_MINUTES) * 100}%` }}
                    >
                      {formatHourLabel(min)}
                    </span>
                  )
                })}
              </div>

              {/* One column per day. All three states are blocks with the same
                  inset and radius: free, busy, and your own class. */}
              {visibleDays.map((day) => {
                /* Labelled blocks paint LAST so they always win. Two blocks can
                   now share a start and end minute — block off an hour over a
                   class you teach and you get the class plus an opaque block at
                   identical geometry — and DOM order alone was deciding which
                   one the professor saw. The named block is the one the legend
                   promises, so it goes on top. */
                const unlabelled = day.busy.filter((b) => !b.label)
                const labelled = day.busy.filter((b) => b.label)

                return (
                  <div key={day.date} className="relative h-[420px] border-l border-border">
                    {HOUR_LABELS.map((min) => (
                      <div
                        key={min}
                        className="absolute inset-x-0 border-t border-border/50"
                        style={{ top: `${((min - WINDOW_START_MIN) / WINDOW_MINUTES) * 100}%` }}
                      />
                    ))}

                    {/* Free first, underneath everything. The thin uncoloured
                        sliver between a green block and a grey one is the
                        transit room either side of a commitment, made visible. */}
                    {day.free.map((slot) => {
                      const start = Math.max(slot.startMin, WINDOW_START_MIN)
                      const end = Math.min(slot.endMin, WINDOW_END_MIN)
                      if (end <= start) return null
                      return (
                        <div
                          key={`free-${day.date}-${slot.startMin}-${slot.endMin}`}
                          className="absolute inset-x-1 rounded-md border border-success-muted-foreground/25 bg-success-muted"
                          style={{
                            top: `${((start - WINDOW_START_MIN) / WINDOW_MINUTES) * 100}%`,
                            height: `${((end - start) / WINDOW_MINUTES) * 100}%`,
                          }}
                          title={`Both free · ${formatTimeDisplay(minutesToTime(start))} to ${formatTimeDisplay(minutesToTime(end))}`}
                        />
                      )
                    })}

                    {[...unlabelled, ...labelled].map((block) => {
                      // Clip to the visible window; a 6am class or an 11pm one
                      // would otherwise be positioned outside the column.
                      const start = Math.max(block.startMin, WINDOW_START_MIN)
                      const end = Math.min(block.endMin, WINDOW_END_MIN)
                      if (end <= start) return null

                      const spansWholeWindow =
                        block.startMin <= WINDOW_START_MIN && block.endMin >= WINDOW_END_MIN

                      return (
                        <div
                          /* The label is part of the key. Without it two blocks
                             sharing a start and end minute collided on
                             `date-start-end`, and React warned about duplicate
                             children and dropped one. */
                          key={`busy-${day.date}-${block.startMin}-${block.endMin}-${block.label ?? 'none'}`}
                          className={cn(
                            'absolute overflow-hidden rounded-md px-1.5 py-0.5',
                            block.label
                              ? 'inset-x-2 z-10 border border-primary/50 bg-primary/25'
                              : 'inset-x-1 bg-muted-foreground/60',
                          )}
                          style={{
                            top: `${((start - WINDOW_START_MIN) / WINDOW_MINUTES) * 100}%`,
                            height: `${((end - start) / WINDOW_MINUTES) * 100}%`,
                          }}
                          title={
                            block.label
                              ? `${block.label} · ${formatTimeDisplay(minutesToTime(block.startMin))} to ${formatTimeDisplay(minutesToTime(block.endMin))}`
                              : spansWholeWindow
                                ? 'Busy all day'
                                : `Busy · ${formatTimeDisplay(minutesToTime(block.startMin))} to ${formatTimeDisplay(minutesToTime(block.endMin))}`
                          }
                        >
                          {block.label ? (
                            <span className="text-[10px] font-medium leading-tight text-foreground">
                              {block.label}
                            </span>
                          ) : (
                            /* A solid grey column with no words reads like a
                               rendering failure rather than a full day. */
                            spansWholeWindow && (
                              <span className="text-[10px] font-medium leading-tight text-foreground/70">
                                All day
                              </span>
                            )
                          )}
                        </div>
                      )
                    })}
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
