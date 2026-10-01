// `<input type="datetime-local">` speaks only `yyyy-MM-ddThh:mm` in the reader's
// own timezone; the database stores an absolute `timestamptz`. Announcements
// shipped with BOTH directions missing, which produced two user-visible bugs:
// the Publish At field rendered empty on every edit (browser rejects a
// timestamptz), and a time typed as 10:30 in New York was stored as 10:30Z, so
// the auto-publish sweep fired four hours early.
//
// THE TIMEZONE LOOP IS THE POINT OF THIS FILE. Both halves of that bug are
// invisible at UTC — where local and UTC agree, the buggy and the fixed code are
// indistinguishable. CI runs ubuntu-latest with no TZ set and neither
// vitest.config.ts nor setup.ts pins one, so a version of this file that ran
// only at the host timezone proved nothing about the regression it exists for.
// So every assertion runs under several offsets, including two non-hour ones.
// `process.env.TZ` is re-read by each `new Date()`, so reassigning it mid-test
// works; @/lib/datetime captures nothing at import time.

import { describe, it, expect, afterAll } from 'vitest'
import {
  toLocalDateTimeInput,
  fromLocalDateTimeInput,
  toLocalDateInput,
  fromLocalDateInput,
} from '@/lib/datetime'

const ORIGINAL_TZ = process.env.TZ

/** UTC first (where the bug hides), then east and west, including :45 and :30. */
const ZONES = [
  'UTC',
  'America/New_York', // -05:00 / -04:00
  'Asia/Kathmandu', //   +05:45
  'Australia/Adelaide', // +09:30 / +10:30
  'Pacific/Auckland', //  +12:00 / +13:00
]

function inZone(tz: string, fn: () => void) {
  process.env.TZ = tz
  try {
    fn()
  } finally {
    process.env.TZ = ORIGINAL_TZ
  }
}

/** Runs the body under every zone, naming the zone in any failure. */
function forEachZone(fn: (tz: string) => void) {
  for (const tz of ZONES) {
    inZone(tz, () => {
      try {
        fn(tz)
      } catch (e) {
        throw new Error(`under TZ=${tz}: ${(e as Error).message}`)
      }
    })
  }
}

afterAll(() => {
  process.env.TZ = ORIGINAL_TZ
})

describe('toLocalDateTimeInput', () => {
  it('renders a timestamptz in the exact format the input accepts', () => {
    forEachZone(() => {
      expect(toLocalDateTimeInput('2026-08-27T14:30:00+00:00')).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/,
      )
    })
  })

  it('renders the LOCAL wall-clock, not the UTC one', () => {
    // The other half of the shipped bug was reading the instant with getUTC*.
    inZone('America/New_York', () => {
      expect(toLocalDateTimeInput('2026-08-27T14:30:00Z')).toBe('2026-08-27T10:30')
    })
    inZone('Asia/Kathmandu', () => {
      expect(toLocalDateTimeInput('2026-08-27T14:30:00Z')).toBe('2026-08-27T20:15')
    })
    inZone('Australia/Adelaide', () => {
      // +09:30 in August (no DST) — and it rolls onto the next day.
      expect(toLocalDateTimeInput('2026-08-27T14:30:00Z')).toBe('2026-08-28T00:00')
    })
  })

  it('truncates seconds rather than rounding them', () => {
    // A stored instant routinely carries seconds. Rounding up would silently
    // move a schedule when a professor merely re-saves the form.
    inZone('UTC', () => {
      expect(toLocalDateTimeInput('2026-08-27T14:30:59.999Z')).toBe('2026-08-27T14:30')
    })
  })

  it('returns empty string for absent or unparseable input', () => {
    forEachZone(() => {
      expect(toLocalDateTimeInput(null)).toBe('')
      expect(toLocalDateTimeInput(undefined)).toBe('')
      expect(toLocalDateTimeInput('')).toBe('')
      // Must not render "NaN-NaN-NaNTNaN:NaN" into the field.
      expect(toLocalDateTimeInput('not-a-date')).toBe('')
    })
  })
})

describe('fromLocalDateTimeInput', () => {
  it('reads the field value as LOCAL time, not UTC', () => {
    // The shipped bug: '2026-08-27T10:30' stored verbatim, read back as 10:30Z.
    inZone('America/New_York', () => {
      expect(fromLocalDateTimeInput('2026-08-27T10:30')).toBe('2026-08-27T14:30:00.000Z')
    })
    inZone('Asia/Kathmandu', () => {
      expect(fromLocalDateTimeInput('2026-08-27T10:30')).toBe('2026-08-27T04:45:00.000Z')
    })
  })

  it('returns null instead of throwing on empty or half-typed input', () => {
    // `new Date('').toISOString()` raises RangeError: Invalid time value, which
    // would take the form down before its own validation could report anything.
    forEachZone(() => {
      expect(fromLocalDateTimeInput('')).toBeNull()
      expect(fromLocalDateTimeInput(null)).toBeNull()
      expect(fromLocalDateTimeInput(undefined)).toBeNull()
      expect(fromLocalDateTimeInput('2026-08-27T')).toBeNull()
      expect(fromLocalDateTimeInput('garbage')).toBeNull()
    })
  })

  it('is datetime-local only — a date-only value is NOT local midnight', () => {
    // Documents a real trap rather than endorsing it: JS parses a bare date as
    // UTC midnight, so pointing this helper at an <input type="date"> shifts the
    // day westward. Five call sites now share it; this pins the boundary.
    inZone('America/New_York', () => {
      const iso = fromLocalDateTimeInput('2026-08-27') as string
      expect(iso).toBe('2026-08-27T00:00:00.000Z')
      expect(toLocalDateTimeInput(iso)).toBe('2026-08-26T20:00') // previous day
    })
  })
})

describe('round-trip', () => {
  const LOCALS = [
    '2026-08-27T10:30',
    '2026-01-05T00:00',
    '2026-12-31T23:59',
    '2026-06-15T12:00',
  ]

  it('local → instant → local returns the same wall-clock, in every zone', () => {
    forEachZone(() => {
      for (const local of LOCALS) {
        const instant = fromLocalDateTimeInput(local)
        expect(instant).not.toBeNull()
        expect(toLocalDateTimeInput(instant)).toBe(local)
      }
    })
  })

  it('instant → local → instant returns the same moment, in every zone', () => {
    forEachZone(() => {
      for (const iso of [
        '2026-08-27T14:30:00.000Z',
        '2026-02-01T09:05:00.000Z',
        '2026-07-04T23:45:00.000Z',
      ]) {
        const back = fromLocalDateTimeInput(toLocalDateTimeInput(iso))
        expect(back).toBe(iso)
      }
    })
  })

  it('survives the professor changing timezone between authoring and editing', () => {
    // Schedule from one machine, edit from another: the stored instant must not
    // move, even though the wall-clock shown differs.
    let stored = ''
    inZone('America/New_York', () => {
      stored = fromLocalDateTimeInput('2026-08-27T10:30') as string
    })
    inZone('Pacific/Auckland', () => {
      const shown = toLocalDateTimeInput(stored)
      expect(shown).not.toBe('2026-08-27T10:30') // a different wall-clock…
      expect(fromLocalDateTimeInput(shown)).toBe(stored) // …the same instant
    })
  })

  it('handles the DST repeated hour without moving the instant', () => {
    // 2026-11-01 01:30 happens twice in New York; JS picks the earlier (EDT)
    // occurrence. Either way the round-trip must be stable.
    inZone('America/New_York', () => {
      const instant = fromLocalDateTimeInput('2026-11-01T01:30') as string
      expect(toLocalDateTimeInput(instant)).toBe('2026-11-01T01:30')
    })
  })

  it('normalises the DST gap hour forward, which does NOT round-trip', () => {
    // 2026-03-08 02:30 does not exist in New York — the clock jumps 02:00→03:00.
    // JS shifts it to 03:30, so local → instant → local returns a DIFFERENT
    // wall-clock. Pinned deliberately: it is the one input where the round-trip
    // cannot hold, and a future "fix" that made it hold would be wrong.
    inZone('America/New_York', () => {
      const instant = fromLocalDateTimeInput('2026-03-08T02:30') as string
      expect(toLocalDateTimeInput(instant)).toBe('2026-03-08T03:30')
    })
  })
})

/* The day-precision pair, added for `modules.unlock_date` (a release date, not an
   instant). The timezone loop matters here for a different reason than above: a
   date-only string is special-cased by the spec to parse as UTC, so the naive
   `new Date('2026-08-06')` would open a module on the 5th for everyone west of
   Greenwich. */
describe('toLocalDateInput / fromLocalDateInput', () => {
  it('round-trips a day under every offset', () => {
    forEachZone(() => {
      const instant = fromLocalDateInput('2026-08-06') as string
      expect(toLocalDateInput(instant)).toBe('2026-08-06')
    })
  })

  it('resolves to LOCAL midnight, not UTC midnight', () => {
    // The whole point: west of Greenwich, UTC midnight is still the day before.
    inZone('America/New_York', () => {
      expect(fromLocalDateInput('2026-08-06')).toBe('2026-08-06T04:00:00.000Z')
      expect(toLocalDateInput('2026-08-06T04:00:00.000Z')).toBe('2026-08-06')
    })
    inZone('Asia/Kathmandu', () => {
      expect(fromLocalDateInput('2026-08-06')).toBe('2026-08-05T18:15:00.000Z')
    })
  })

  it('returns null/empty for nothing to convert, rather than throwing', () => {
    // `new Date('').toISOString()` raises RangeError and would take the form down
    // before its own validation could report anything.
    expect(fromLocalDateInput('')).toBeNull()
    expect(fromLocalDateInput(null)).toBeNull()
    expect(fromLocalDateInput('not-a-date')).toBeNull()
    expect(toLocalDateInput(null)).toBe('')
    expect(toLocalDateInput('not-a-date')).toBe('')
  })

  /* Why unlock_date uses this pair and NOT datetime-local: that input reports
     `value === ''` for a partial entry, and its picker sets the day while leaving
     the time blank. Routed through fromLocalDateTimeInput that becomes null — a
     silent no-op that reported success and published the week immediately. Pinned
     so the trap is documented rather than rediscovered. */
  it('a date with no time is a real value here, where datetime-local yields nothing', () => {
    expect(fromLocalDateInput('2026-08-06')).not.toBeNull()
    expect(fromLocalDateTimeInput('')).toBeNull()
  })
})
