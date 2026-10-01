// Weekly recurrence expansion for scheduled live classrooms.
//
// Runs in the BROWSER (the professor's local timezone) so the dialog can preview
// occurrences and build the exact instant list it submits — this keeps all
// timezone reasoning on the client and off the UTC server. The server only
// validates the submitted instants (future + capped). Shared with unit tests.

/** Hard cap on occurrences a single weekly series can create. */
export const MAX_SCHEDULE_OCCURRENCES = 50

/**
 * Expand a weekly recurrence into concrete occurrence instants.
 *
 * @param start    First candidate instant; its time-of-day is used for every occurrence.
 * @param weekdays Days to repeat on, JS `getDay()` convention (0=Sun … 6=Sat).
 * @param until    Last calendar day (inclusive) an occurrence may fall on.
 * @param cap      Max occurrences to emit (defaults to MAX_SCHEDULE_OCCURRENCES).
 * @returns Occurrence instants at `start`'s time-of-day, ascending, `<= cap`.
 *          Empty when `weekdays` is empty.
 */
export function expandWeeklyOccurrences(
  start: Date,
  weekdays: number[],
  until: Date,
  cap: number = MAX_SCHEDULE_OCCURRENCES,
): Date[] {
  const out: Date[] = []
  if (weekdays.length === 0) return out

  const cursor = new Date(start)
  cursor.setHours(start.getHours(), start.getMinutes(), 0, 0)

  const untilEnd = new Date(until)
  untilEnd.setHours(23, 59, 59, 999)

  while (cursor <= untilEnd && out.length < cap) {
    if (weekdays.includes(cursor.getDay())) out.push(new Date(cursor))
    cursor.setDate(cursor.getDate() + 1)
  }
  return out
}
