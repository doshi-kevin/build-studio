/**
 * The two halves of an `<input type="datetime-local">` round-trip.
 *
 * That input speaks ONLY `yyyy-MM-ddThh:mm` in the reader's own timezone — it has
 * no offset. The database stores `timestamptz`, an absolute instant. Getting one
 * of the two directions wrong is silent:
 *
 * - Feed a `timestamptz` straight in and the browser rejects the value outright
 *   (`does not conform to the required format`), so the field renders EMPTY and
 *   the professor thinks their schedule was lost.
 * - Send the field's raw value straight to Postgres and the offset-less string is
 *   read as UTC, so a time typed as 10:30 in New York is stored as 10:30Z and
 *   fires four hours early.
 *
 * Announcements shipped with both halves missing, which is why this module
 * exists. Keeping the pair together makes the asymmetry hard to reintroduce.
 */

/** `timestamptz`/ISO → the local `yyyy-MM-ddThh:mm` a datetime-local expects. */
export function toLocalDateTimeInput(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * A datetime-local value (local wall-clock) → an absolute ISO instant, or null.
 *
 * `new Date('2026-08-27T10:30')` parses as LOCAL time, so `.toISOString()` yields
 * the correct instant for whatever timezone the professor is actually in — which
 * is why this conversion belongs in the browser and not on the server, where the
 * offset is unknowable.
 *
 * Returns null rather than throwing on empty or half-typed input: a bare
 * `new Date('').toISOString()` raises `RangeError: Invalid time value` and would
 * take the whole form down before its own validation could report the problem.
 */
export function fromLocalDateTimeInput(local: string | null | undefined): string | null {
  if (!local) return null
  const d = new Date(local)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

/* ── Day-precision variants (`<input type="date">`) ──────────────────
 *
 * Use these when the value MEANS a day, not an instant — a release date, a
 * cutoff. Not just a simpler `datetime-local`: that input reports `value === ''`
 * for any PARTIAL entry, and its calendar picker fills the date while leaving the
 * time segments blank. So "click the icon, pick a day, save" round-trips through
 * `fromLocalDateTimeInput('')` as null — a silent no-op that reports success.
 * Reach for `datetime-local` only when the time of day is genuinely part of the
 * meaning, and then require both halves before you accept the value.
 */

/** `timestamptz`/ISO → the local `yyyy-MM-dd` a date input expects. */
export function toLocalDateInput(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * A date input's `yyyy-MM-dd` → that day's LOCAL midnight as an absolute instant.
 *
 * Local, not UTC: `new Date('2026-08-06')` parses as UTC (a date-only string is
 * special-cased by the spec), which would open a module on the 5th for anyone west
 * of Greenwich. Splitting the parts and using the `Date(y, m, d)` constructor keeps
 * the professor's own midnight.
 */
export function fromLocalDateInput(day: string | null | undefined): string | null {
  if (!day) return null
  const [y, m, d] = day.split('-').map(Number)
  if (!y || !m || !d) return null
  const at = new Date(y, m - 1, d)
  if (Number.isNaN(at.getTime())) return null
  return at.toISOString()
}
