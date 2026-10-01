import { describe, it, expect } from 'vitest'
import { generateICalFeed, type ICalEvent } from '@/lib/calendar/ical'

// Guards the Outlook-compatibility hardening in ical.ts:
//  - zero-duration deadline events get a non-zero DTEND (strict Outlook drops DTEND==DTSTART)
//  - CR / CRLF in text is escaped to a literal \n (a bare CR trips strict parsers)

const base: ICalEvent = {
  uid: 'evt@scholera.app',
  summary: 'Deadline',
  dtstart: new Date('2026-08-10T14:00:00Z'),
  dtend: new Date('2026-08-10T14:00:00Z'), // same as start = point-in-time deadline
}

describe('generateICalFeed — Outlook hardening', () => {
  it('bumps a zero-duration event to a 15-minute DTEND', () => {
    const ics = generateICalFeed([base], 'Cal')
    expect(ics).toContain('DTSTART:20260810T140000Z')
    expect(ics).toContain('DTEND:20260810T141500Z')
    expect(ics).not.toContain('DTEND:20260810T140000Z')
  })

  it('keeps the real DTEND when the event has a duration', () => {
    const ics = generateICalFeed([{ ...base, dtend: new Date('2026-08-10T15:00:00Z') }], 'Cal')
    expect(ics).toContain('DTEND:20260810T150000Z')
  })

  it('escapes CR/CRLF in text to a literal \\n and leaves no bare CR in any value', () => {
    const ics = generateICalFeed([{ ...base, summary: 'line1\r\nline2', description: 'a\rb' }], 'Cal')
    expect(ics).toContain('SUMMARY:line1\\nline2')
    expect(ics).toContain('DESCRIPTION:a\\nb')
    // Lines are separated by CRLF; no line should contain a stray CR of its own.
    expect(ics.split('\r\n').every((line) => !line.includes('\r'))).toBe(true)
  })
})
