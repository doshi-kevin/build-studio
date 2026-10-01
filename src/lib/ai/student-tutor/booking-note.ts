/**
 * C10 — office-hours escalation. Design doc §12.2, built as a `propose` action
 * (§14).
 *
 * Two pure pieces, both parameterised on `now` so a Sunday-evening edge case is
 * testable rather than something you find out about on a Sunday evening:
 *
 *   • `nextOfficeHoursDate` — the soonest day the professor actually holds
 *     office hours, so the drive lands on a day with slots on it instead of on
 *     today, which is usually empty.
 *   • `draftBookingNote` — what the student says when they get there.
 *
 * The note is composed here, not generated, for the same reason C11's question
 * is: it goes to their professor with their name on it. A student can check a
 * templated sentence at a glance; a generated one they'd have to read closely
 * to catch an invented detail. Unlike C11 this one is private — a note the
 * professor reads before the meeting — so it does quote what they got wrong.
 */

import type { MissedQuestion } from './class-question'

/** Matches `office_hours.day_of_week`. */
export type WeekDay =
  | 'sunday'
  | 'monday'
  | 'tuesday'
  | 'wednesday'
  | 'thursday'
  | 'friday'
  | 'saturday'

const WEEK: readonly WeekDay[] = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
]

/** `YYYY-MM-DD` in UTC, which is the shape the booking page's date state uses. */
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/**
 * The soonest date on or after `now` that falls on one of these weekdays.
 * Returns null when the professor holds no office hours at all.
 *
 * Deliberately includes today: an 11am slot is still bookable at 9am. Filtering
 * out today's already-passed slots is the booking page's job — it is the thing
 * that generates them, and duplicating that here would be a second source of
 * truth about availability.
 */
export function nextOfficeHoursDate(days: readonly string[], now: string): string | null {
  const wanted = new Set(days.filter((d): d is WeekDay => (WEEK as readonly string[]).includes(d)))
  if (wanted.size === 0) return null

  const start = new Date(now)
  if (Number.isNaN(start.getTime())) return null
  for (let offset = 0; offset < 7; offset++) {
    const day = new Date(start.getTime() + offset * 86_400_000)
    if (wanted.has(WEEK[day.getUTCDay()])) return isoDate(day)
  }
  return null
}

/** Prompt text long enough to identify the question, short enough to read. */
const MAX_QUOTED = 200

/**
 * The note that lands in the booking form's "anything you'd like to raise" box.
 * Names the topics first (that's what the professor needs to prepare) and the
 * specific miss second (that's the evidence).
 */
export function draftBookingNote(weakTopics: string[], miss: MissedQuestion | null): string {
  const topics = weakTopics.slice(0, 3)
  const lead =
    topics.length === 0
      ? "Hi — I'd like some help with the course material."
      : topics.length === 1
        ? `Hi — I'd like some help with ${topics[0]}.`
        : `Hi — I'd like some help with ${topics.slice(0, -1).join(', ')} and ${topics[topics.length - 1]}.`

  if (!miss) return lead

  const quoted =
    miss.question.length > MAX_QUOTED
      ? `${miss.question.slice(0, MAX_QUOTED).trimEnd()}…`
      : miss.question
  return `${lead} On ${miss.quiz} I answered "${miss.yourAnswer}" to "${quoted}" when the answer was "${miss.correctAnswer}", and I'd like to understand why.`
}
