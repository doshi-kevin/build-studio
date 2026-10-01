/**
 * Minimal iCal (.ics) parser — extracts VEVENT entries from an iCal string.
 *
 * Supports standard VCALENDAR files exported from Outlook, Google Calendar, Apple Calendar.
 * Handles line folding (RFC 5545 §3.1) and basic text unescaping.
 */

export interface ParsedEvent {
  uid: string
  summary: string
  description: string
  location: string
  dtstart: Date | null
  dtend: Date | null
  status: string
  categories: string[]
}

/** Unfold lines per RFC 5545 — continuation lines start with space or tab */
function unfoldLines(raw: string): string {
  return raw.replace(/\r?\n[ \t]/g, '')
}

/** Unescape iCal text values */
function unescapeText(text: string): string {
  return text
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
}

/**
 * Parse an iCal date-time string into a JS Date.
 * Handles: 20240301T100000Z (UTC), 20240301T100000 (local), 20240301 (date only)
 */
function parseICalDate(value: string): Date | null {
  // Strip any TZID prefix (e.g. "TZID=America/New_York:")
  const clean = value.replace(/^TZID=[^:]+:/, '').trim()

  // Date-time with Z (UTC)
  const utcMatch = clean.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/)
  if (utcMatch) {
    const [, y, m, d, h, min, s] = utcMatch
    return new Date(Date.UTC(+y, +m - 1, +d, +h, +min, +s))
  }

  // Date-time without Z (local time)
  const localMatch = clean.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/)
  if (localMatch) {
    const [, y, m, d, h, min, s] = localMatch
    return new Date(+y, +m - 1, +d, +h, +min, +s)
  }

  // Date only
  const dateMatch = clean.match(/^(\d{4})(\d{2})(\d{2})$/)
  if (dateMatch) {
    const [, y, m, d] = dateMatch
    return new Date(+y, +m - 1, +d)
  }

  return null
}

/**
 * Parse an iCal (.ics) string and extract all VEVENT entries.
 */
export function parseICalString(icsContent: string): ParsedEvent[] {
  const unfolded = unfoldLines(icsContent)
  const lines = unfolded.split(/\r?\n/)
  const events: ParsedEvent[] = []

  let inEvent = false
  let current: Partial<ParsedEvent> = {}

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      inEvent = true
      current = {
        uid: '',
        summary: '',
        description: '',
        location: '',
        dtstart: null,
        dtend: null,
        status: '',
        categories: [],
      }
      continue
    }

    if (line === 'END:VEVENT') {
      inEvent = false
      if (current.summary || current.dtstart) {
        events.push(current as ParsedEvent)
      }
      continue
    }

    if (!inEvent) continue

    // Parse property:value (handle properties with params like DTSTART;TZID=...:value)
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue

    const propFull = line.slice(0, colonIdx)
    const value = line.slice(colonIdx + 1)
    const propName = propFull.split(';')[0].toUpperCase()

    switch (propName) {
      case 'UID':
        current.uid = value
        break
      case 'SUMMARY':
        current.summary = unescapeText(value)
        break
      case 'DESCRIPTION':
        current.description = unescapeText(value)
        break
      case 'LOCATION':
        current.location = unescapeText(value)
        break
      case 'DTSTART':
        current.dtstart = parseICalDate(value) ?? parseICalDate(propFull.split(':').pop() + ':' + value)
        // Re-parse with full property string if TZID is in the property params
        if (!current.dtstart) {
          const tzidMatch = propFull.match(/TZID=([^;:]+)/)
          if (tzidMatch) {
            current.dtstart = parseICalDate(value)
          }
        }
        break
      case 'DTEND':
        current.dtend = parseICalDate(value) ?? parseICalDate(propFull.split(':').pop() + ':' + value)
        if (!current.dtend) {
          const tzidMatch = propFull.match(/TZID=([^;:]+)/)
          if (tzidMatch) {
            current.dtend = parseICalDate(value)
          }
        }
        break
      case 'STATUS':
        current.status = value
        break
      case 'CATEGORIES':
        current.categories = value.split(',').map((c) => unescapeText(c.trim()))
        break
    }
  }

  return events
}
