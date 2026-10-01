/**
 * iCal Feed Generator — RFC 5545 compliant VCALENDAR output.
 *
 * Generates iCal text manually (simple text format, no npm dependency needed).
 * Supports VEVENT with VALARM reminders, proper escaping, and line folding.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc5545
 */

// ── Types ────────────────────────────────────────────────────────

export interface ICalEvent {
  uid: string
  summary: string
  description?: string
  location?: string
  dtstart: Date
  dtend: Date
  categories?: string[]
  /** Alarm reminder in minutes before event. 0 = no alarm. */
  alarmMinutes?: number
  status?: 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED'
}

// ── Helpers ──────────────────────────────────────────────────────

/** Escape text per RFC 5545 §3.3.11. Collapses every line-break form (CRLF / CR / LF)
 *  to the literal `\n` sequence — a bare CR left in a value trips strict parsers (Outlook). */
function escapeText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
}

/** Format Date as iCal date-time in UTC: YYYYMMDDTHHMMSSZ */
function formatDateTimeUTC(date: Date): string {
  const y = date.getUTCFullYear()
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  const d = String(date.getUTCDate()).padStart(2, '0')
  const h = String(date.getUTCHours()).padStart(2, '0')
  const min = String(date.getUTCMinutes()).padStart(2, '0')
  const s = String(date.getUTCSeconds()).padStart(2, '0')
  return `${y}${m}${d}T${h}${min}${s}Z`
}

/** Current timestamp for DTSTAMP */
function dtstamp(): string {
  return formatDateTimeUTC(new Date())
}

/**
 * Fold long lines per RFC 5545 §3.1 — lines must be ≤75 octets.
 * Continuation lines start with a single space.
 */
function foldLine(line: string): string {
  if (line.length <= 75) return line
  const parts: string[] = []
  parts.push(line.slice(0, 75))
  let i = 75
  while (i < line.length) {
    parts.push(' ' + line.slice(i, i + 74))
    i += 74
  }
  return parts.join('\r\n')
}

/** Add a property line with folding */
function prop(name: string, value: string): string {
  return foldLine(`${name}:${value}`)
}

// ── VEVENT Builder ───────────────────────────────────────────────

function buildVEvent(event: ICalEvent): string {
  const lines: string[] = []
  lines.push('BEGIN:VEVENT')
  lines.push(prop('UID', event.uid))
  lines.push(prop('DTSTAMP', dtstamp()))
  lines.push(prop('DTSTART', formatDateTimeUTC(event.dtstart)))
  // RFC 5545 requires DTEND strictly after DTSTART. Deadline items (assignments, quizzes,
  // project phases) come in as point-in-time with dtend === dtstart; strict clients like
  // Outlook silently drop a zero-duration VEVENT. Give those a 15-minute block so they show.
  const end =
    event.dtend.getTime() > event.dtstart.getTime()
      ? event.dtend
      : new Date(event.dtstart.getTime() + 15 * 60 * 1000)
  lines.push(prop('DTEND', formatDateTimeUTC(end)))
  lines.push(prop('SUMMARY', escapeText(event.summary)))

  if (event.description) {
    lines.push(prop('DESCRIPTION', escapeText(event.description)))
  }

  if (event.location) {
    lines.push(prop('LOCATION', escapeText(event.location)))
  }

  if (event.categories && event.categories.length > 0) {
    lines.push(prop('CATEGORIES', event.categories.map(escapeText).join(',')))
  }

  if (event.status) {
    lines.push(prop('STATUS', event.status))
  }

  // VALARM — display alarm
  if (event.alarmMinutes && event.alarmMinutes > 0) {
    lines.push('BEGIN:VALARM')
    lines.push(prop('TRIGGER', `-PT${event.alarmMinutes}M`))
    lines.push(prop('ACTION', 'DISPLAY'))
    lines.push(prop('DESCRIPTION', escapeText(`Reminder: ${event.summary}`)))
    lines.push('END:VALARM')
  }

  lines.push('END:VEVENT')
  return lines.join('\r\n')
}

// ── VCALENDAR Builder ────────────────────────────────────────────

/**
 * Generate a full iCal feed string from a list of events.
 *
 * @param events - Array of calendar events
 * @param calendarName - Display name for the calendar
 * @returns RFC 5545 compliant VCALENDAR string
 */
export function generateICalFeed(events: ICalEvent[], calendarName: string): string {
  const lines: string[] = []

  // Calendar header
  lines.push('BEGIN:VCALENDAR')
  lines.push(prop('VERSION', '2.0'))
  lines.push(prop('PRODID', '-//Scholera//Calendar Feed//EN'))
  lines.push(prop('CALSCALE', 'GREGORIAN'))
  lines.push(prop('METHOD', 'PUBLISH'))
  lines.push(prop('X-WR-CALNAME', escapeText(calendarName)))
  lines.push(prop('X-WR-TIMEZONE', 'America/New_York'))

  // VTIMEZONE for America/New_York (EST/EDT)
  lines.push('BEGIN:VTIMEZONE')
  lines.push(prop('TZID', 'America/New_York'))
  // Eastern Standard Time
  lines.push('BEGIN:STANDARD')
  lines.push(prop('DTSTART', '19701101T020000'))
  lines.push(prop('RRULE', 'FREQ=YEARLY;BYMONTH=11;BYDAY=1SU'))
  lines.push(prop('TZOFFSETFROM', '-0400'))
  lines.push(prop('TZOFFSETTO', '-0500'))
  lines.push(prop('TZNAME', 'EST'))
  lines.push('END:STANDARD')
  // Eastern Daylight Time
  lines.push('BEGIN:DAYLIGHT')
  lines.push(prop('DTSTART', '19700308T020000'))
  lines.push(prop('RRULE', 'FREQ=YEARLY;BYMONTH=3;BYDAY=2SU'))
  lines.push(prop('TZOFFSETFROM', '-0500'))
  lines.push(prop('TZOFFSETTO', '-0400'))
  lines.push(prop('TZNAME', 'EDT'))
  lines.push('END:DAYLIGHT')
  lines.push('END:VTIMEZONE')

  // Events
  for (const event of events) {
    lines.push(buildVEvent(event))
  }

  lines.push('END:VCALENDAR')

  // RFC 5545 requires CRLF line endings
  return lines.join('\r\n') + '\r\n'
}
