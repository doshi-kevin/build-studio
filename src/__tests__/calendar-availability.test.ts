// Tests for the meet-time finder behind the professor's student profile page.
//
// The four things worth testing are the four things the naive version gets
// wrong: deadlines counted as appointments, only one person's calendar checked,
// transit gaps offered as meetings, and days bucketed in the server's zone
// instead of Eastern. Each has its own describe block below.

import { describe, it, expect } from 'vitest'
import {
  toBusyIntervals,
  mergeBusyIntervals,
  etDayKeys,
  invertToFreeSlots,
  suggestMeetingSlots,
  TRANSIT_PAD_MIN,
  WINDOW_START_MIN,
  WINDOW_END_MIN,
} from '@/lib/calendar/availability'
import type { StudentCalendarEvent, StudentCalendarEventKind } from '@/lib/calendar/student-events'

/**
 * An event at a given Eastern wall-clock time. Uses a July date so the offset is
 * EDT (-4) unless a test overrides the date; DST is tested explicitly below.
 */
function event(
  startIso: string,
  endIso: string | null,
  overrides: Partial<StudentCalendarEvent> = {},
): StudentCalendarEvent {
  return {
    id: `e-${startIso}`,
    kind: 'class_session' as StudentCalendarEventKind,
    title: 'Should never be rendered',
    start: startIso,
    end: endIso,
    courseCode: null,
    sectionId: null,
    href: '/',
    location: null,
    description: null,
    status: null,
    ...overrides,
  }
}

/**
 * An Eastern wall-clock time in July 2026 as a UTC instant. July is EDT, so the
 * offset is a flat -4; going through Date.UTC rather than string concatenation
 * means a late-evening time rolls the UTC date instead of producing hour 27.
 */
const et = (day: string, hhmm: string): string => {
  const [h, m] = hhmm.split(':').map(Number)
  return new Date(Date.UTC(2026, 6, Number(day), h + 4, m)).toISOString()
}

describe('rule 1: a deadline is not an appointment', () => {
  it('gives a due date zero busy minutes', () => {
    const deadlines = [
      event(et('15', '23:59'), null, { kind: 'assignment_due' }),
      event(et('15', '23:59'), null, { kind: 'quiz_due' }),
      event(et('16', '17:00'), null, { kind: 'project_due' }),
    ]

    expect(toBusyIntervals(deadlines)).toEqual([])
  })

  it('leaves the whole window free on a day that has only deadlines', () => {
    const busy = toBusyIntervals([event(et('15', '23:59'), null, { kind: 'assignment_due' })])
    const slots = invertToFreeSlots(['2026-07-15'], mergeBusyIntervals(busy))

    expect(slots).toEqual([
      { date: '2026-07-15', startMin: WINDOW_START_MIN, endMin: WINDOW_END_MIN },
    ])
  })

  it('still counts a timed class on the same day', () => {
    const busy = toBusyIntervals([
      event(et('15', '23:59'), null, { kind: 'assignment_due' }),
      event(et('15', '09:00'), et('15', '10:00')),
    ])

    expect(busy).toHaveLength(1)
    expect(busy[0]).toMatchObject({ date: '2026-07-15', startMin: 540, endMin: 600 })
  })
})

describe('rule 2: both calendars count', () => {
  it('treats the professor busy as busy, not just the student', () => {
    const studentBusy = toBusyIntervals([event(et('15', '09:00'), et('15', '10:00'))])
    const professorBusy = toBusyIntervals([event(et('15', '10:00'), et('15', '19:30'))])

    const merged = mergeBusyIntervals([...studentBusy, ...professorBusy])
    const slots = invertToFreeSlots(['2026-07-15'], merged)

    // 07:00-09:00 before, 19:30-21:00 after. Nothing in the middle, because the
    // professor is teaching through the student's free afternoon.
    expect(slots).toEqual([
      { date: '2026-07-15', startMin: 420, endMin: 540 },
      { date: '2026-07-15', startMin: 1170, endMin: 1260 },
    ])
  })

  it('merges two overlapping commitments into one block', () => {
    const busy = toBusyIntervals([
      event(et('15', '09:00'), et('15', '11:00')),
      event(et('15', '10:30'), et('15', '12:00')),
    ])

    const day = mergeBusyIntervals(busy).get('2026-07-15')!
    expect(day).toHaveLength(1)
    expect(day[0]).toMatchObject({ startMin: 540, endMin: 720 })
  })

  it('merges blocks that only touch, leaving no zero-width gap', () => {
    const busy = toBusyIntervals([
      event(et('15', '09:00'), et('15', '10:00')),
      event(et('15', '10:00'), et('15', '11:00')),
    ])

    const day = mergeBusyIntervals(busy).get('2026-07-15')!
    expect(day).toHaveLength(1)
    expect(day[0]).toMatchObject({ startMin: 540, endMin: 660 })
  })
})

describe('rule 3: a transit gap is not a meeting slot', () => {
  // 12:00-13:00 then 13:30-14:30. The bare gap is exactly 30 minutes, so
  // without padding it looks like a bookable half hour; with padding it is the
  // 10 minutes it really is.
  const backToBack = toBusyIntervals([
    event(et('15', '12:00'), et('15', '13:00')),
    event(et('15', '13:30'), et('15', '14:30')),
  ])

  it('would offer the 30-minute walk as a meeting if nothing were padded', () => {
    const slots = invertToFreeSlots(['2026-07-15'], mergeBusyIntervals(backToBack, 0))

    expect(slots).toContainEqual({ date: '2026-07-15', startMin: 780, endMin: 810 })
  })

  it('does not offer it once transit padding is applied', () => {
    const slots = invertToFreeSlots(
      ['2026-07-15'],
      mergeBusyIntervals(backToBack, TRANSIT_PAD_MIN),
    )

    expect(slots.some((s) => s.startMin >= 780 && s.endMin <= 810)).toBe(false)
    // The rest of the day is unaffected: morning and late afternoon survive.
    expect(slots).toEqual([
      { date: '2026-07-15', startMin: 420, endMin: 710 },
      { date: '2026-07-15', startMin: 880, endMin: 1260 },
    ])
  })

  it('collapses the padding between two adjacent classes instead of double-counting it', () => {
    const adjacent = toBusyIntervals([
      event(et('15', '09:00'), et('15', '10:00')),
      event(et('15', '10:00'), et('15', '11:00')),
    ])

    const day = mergeBusyIntervals(adjacent, TRANSIT_PAD_MIN).get('2026-07-15')!
    // One block 08:50-11:10, not two with a phantom busy overlap in between.
    expect(day).toHaveLength(1)
    expect(day[0]).toMatchObject({ startMin: 530, endMin: 670 })
  })
})

describe('rule 4: the clock is Eastern, not the server', () => {
  it('keeps a late-evening class on the Eastern day it happens', () => {
    // 2026-07-16T02:30Z is 10:30 PM on the 15th in Eastern time. Bucketing with
    // the runtime's own accessors on Cloud Run (UTC) would file it on the 16th.
    const busy = toBusyIntervals([
      event('2026-07-16T02:30:00.000Z', '2026-07-16T03:30:00.000Z'),
    ])

    expect(busy).toHaveLength(1)
    expect(busy[0].date).toBe('2026-07-15')
    expect(busy[0].startMin).toBe(22 * 60 + 30)
  })

  it('resolves the offset per date, so winter and summer differ by an hour', () => {
    const winter = toBusyIntervals([
      event('2026-01-15T18:00:00.000Z', '2026-01-15T19:00:00.000Z'),
    ])
    const summer = toBusyIntervals([
      event('2026-07-15T18:00:00.000Z', '2026-07-15T19:00:00.000Z'),
    ])

    // Same instant-of-day, five hours back in EST and four in EDT.
    expect(winter[0].startMin).toBe(13 * 60)
    expect(summer[0].startMin).toBe(14 * 60)
  })

  it('clips an event that rolls past Eastern midnight to the end of its own day', () => {
    const busy = toBusyIntervals([
      event('2026-07-16T03:00:00.000Z', '2026-07-16T05:00:00.000Z'),
    ])

    expect(busy[0]).toMatchObject({ date: '2026-07-15', startMin: 23 * 60, endMin: 24 * 60 })
  })
})

describe('labels', () => {
  it("labels a class in the professor's own section with its course code", () => {
    const busy = toBusyIntervals(
      [event(et('15', '11:00'), et('15', '12:15'), { sectionId: 'sec-mine', courseCode: '506-NLP' })],
      new Set(['sec-mine']),
    )

    expect(busy[0].label).toBe('506-NLP')
  })

  it("leaves another course's class opaque even though the code is available", () => {
    const busy = toBusyIntervals(
      [event(et('15', '11:00'), et('15', '12:15'), { sectionId: 'sec-theirs', courseCode: '101-CPE' })],
      new Set(['sec-mine']),
    )

    expect(busy[0].label).toBeNull()
  })

  it('never labels a personal event, whatever its title says', () => {
    const busy = toBusyIntervals(
      [
        event(et('15', '15:00'), et('15', '16:00'), {
          kind: 'personal',
          title: 'Therapy appointment',
          description: 'private note',
          sectionId: 'sec-mine',
          courseCode: '506-NLP',
        }),
      ],
      new Set(['sec-mine']),
    )

    expect(busy[0].label).toBeNull()
  })
})

describe('edge cases', () => {
  it('blacks out the whole day for an all-day personal event', () => {
    const busy = toBusyIntervals([
      event(et('15', '00:00'), et('15', '23:59'), { kind: 'personal' }),
    ])
    const slots = invertToFreeSlots(['2026-07-15'], mergeBusyIntervals(busy))

    expect(slots).toEqual([])
  })

  it('trims the rest of today rather than discarding the day', () => {
    const slots = invertToFreeSlots(['2026-07-15'], new Map(), {
      notBefore: { date: '2026-07-15', minute: 15 * 60 },
    })

    expect(slots).toEqual([{ date: '2026-07-15', startMin: 15 * 60, endMin: WINDOW_END_MIN }])
  })

  it("rounds today's opening up to the next quarter hour", () => {
    // Loaded at 9:54. Proposing "9:54am" by email reads like a machine wrote it.
    const slots = invertToFreeSlots(['2026-07-15'], new Map(), {
      notBefore: { date: '2026-07-15', minute: 9 * 60 + 54 },
    })

    expect(slots[0].startMin).toBe(10 * 60)
  })

  it('leaves an already-round opening alone', () => {
    const slots = invertToFreeSlots(['2026-07-15'], new Map(), {
      notBefore: { date: '2026-07-15', minute: 10 * 60 + 30 },
    })

    expect(slots[0].startMin).toBe(10 * 60 + 30)
  })

  it('drops days that are entirely in the past', () => {
    const slots = invertToFreeSlots(['2026-07-14', '2026-07-15'], new Map(), {
      notBefore: { date: '2026-07-15', minute: 12 * 60 },
    })

    expect(slots.map((s) => s.date)).toEqual(['2026-07-15'])
  })

  it('yields nothing today when the window has already closed', () => {
    const slots = invertToFreeSlots(['2026-07-15'], new Map(), {
      notBefore: { date: '2026-07-15', minute: 22 * 60 },
    })

    expect(slots).toEqual([])
  })

  it('ignores commitments that sit entirely outside the 7am-9pm window', () => {
    const busy = toBusyIntervals([
      event(et('15', '05:00'), et('15', '06:00')),
      event(et('15', '22:00'), et('15', '23:00')),
    ])
    const slots = invertToFreeSlots(['2026-07-15'], mergeBusyIntervals(busy))

    expect(slots).toEqual([
      { date: '2026-07-15', startMin: WINDOW_START_MIN, endMin: WINDOW_END_MIN },
    ])
  })

  it('discards a zero-length event instead of emitting an empty block', () => {
    expect(toBusyIntervals([event(et('15', '09:00'), et('15', '09:00'))])).toEqual([])
  })
})

describe('suggestMeetingSlots', () => {
  it('trims a long stretch to the meeting length', () => {
    const suggested = suggestMeetingSlots([
      { date: '2026-07-15', startMin: 420, endMin: 1260 },
    ])

    expect(suggested).toEqual([{ date: '2026-07-15', startMin: 420, endMin: 450 }])
  })

  it('ranks weekdays ahead of a sooner weekend slot', () => {
    // 2026-07-18 is a Saturday; 2026-07-20 is the Monday after it.
    const suggested = suggestMeetingSlots([
      { date: '2026-07-18', startMin: 600, endMin: 660 },
      { date: '2026-07-20', startMin: 600, endMin: 660 },
    ])

    expect(suggested.map((s) => s.date)).toEqual(['2026-07-20', '2026-07-18'])
  })

  it('orders same-day slots by time and honours the limit', () => {
    const suggested = suggestMeetingSlots(
      [
        { date: '2026-07-15', startMin: 900, endMin: 960 },
        { date: '2026-07-15', startMin: 480, endMin: 540 },
        { date: '2026-07-16', startMin: 480, endMin: 540 },
      ],
      { limit: 2 },
    )

    expect(suggested).toHaveLength(2)
    expect(suggested.map((s) => [s.date, s.startMin])).toEqual([
      ['2026-07-15', 480],
      ['2026-07-15', 900],
    ])
  })
})

describe('labelled blocks stay their own length', () => {
  // Found by running live data through the pipeline: a 1-hour class touching
  // 2 hours of office hours rendered as one 3-hour block labelled with the
  // course code, so the grid claimed the class ran three times as long.
  const classThenOfficeHours = [
    { date: '2026-07-15', startMin: 13 * 60, endMin: 14 * 60, label: '506-NLP' },
    { date: '2026-07-15', startMin: 14 * 60, endMin: 16 * 60, label: null },
  ]

  it('keeps the class at its real length when labels must stay separate', () => {
    const day = mergeBusyIntervals(classThenOfficeHours, 0, { keepLabelsSeparate: true }).get(
      '2026-07-15',
    )!

    expect(day).toHaveLength(2)
    expect(day[0]).toMatchObject({ startMin: 780, endMin: 840, label: '506-NLP' })
    expect(day[1]).toMatchObject({ startMin: 840, endMin: 960, label: null })
  })

  it('still fuses them for free-slot finding, where busy is just busy', () => {
    const day = mergeBusyIntervals(classThenOfficeHours, 0).get('2026-07-15')!

    expect(day).toHaveLength(1)
    expect(day[0]).toMatchObject({ startMin: 780, endMin: 960 })
  })

  it('leaves no phantom gap between two separated blocks', () => {
    const merged = mergeBusyIntervals(classThenOfficeHours, 0, { keepLabelsSeparate: true })
    const slots = invertToFreeSlots(['2026-07-15'], merged)

    // 13:00-16:00 is solid whichever way it was split, so no free slot may
    // appear inside it.
    expect(slots.some((s) => s.startMin >= 780 && s.endMin <= 960)).toBe(false)
  })

  it('merges two blocks that share the same label', () => {
    const day = mergeBusyIntervals(
      [
        { date: '2026-07-15', startMin: 540, endMin: 600, label: '506-NLP' },
        { date: '2026-07-15', startMin: 600, endMin: 660, label: '506-NLP' },
      ],
      0,
      { keepLabelsSeparate: true },
    ).get('2026-07-15')!

    expect(day).toHaveLength(1)
    expect(day[0]).toMatchObject({ startMin: 540, endMin: 660, label: '506-NLP' })
  })
})

describe('the same class arriving from both calendars', () => {
  /* A class the professor teaches this student in sits on BOTH calendars, so it
     reaches the grid twice. While everything merged indiscriminately the
     duplicate was invisible; once labelled blocks stopped merging into their
     neighbours it drew twice. Matching labels on both copies is the fix. */
  const sameClassTwice = [
    { date: '2026-07-15', startMin: 13 * 60, endMin: 14 * 60, label: '506-NLP' },
    { date: '2026-07-15', startMin: 13 * 60, endMin: 14 * 60, label: '506-NLP' },
  ]

  it('collapses the duplicate into one block', () => {
    const day = mergeBusyIntervals(sameClassTwice, 0, { keepLabelsSeparate: true }).get(
      '2026-07-15',
    )!

    expect(day).toHaveLength(1)
    expect(day[0]).toMatchObject({ startMin: 780, endMin: 840, label: '506-NLP' })
  })

  it('would draw it twice if only one copy were labelled', () => {
    const onlyOneLabelled = [
      { date: '2026-07-15', startMin: 13 * 60, endMin: 14 * 60, label: '506-NLP' },
      { date: '2026-07-15', startMin: 13 * 60, endMin: 14 * 60, label: null },
    ]
    const day = mergeBusyIntervals(onlyOneLabelled, 0, { keepLabelsSeparate: true }).get(
      '2026-07-15',
    )!

    // Guards the reason the page passes the same section set to both feeds.
    expect(day).toHaveLength(2)
  })

  it('costs no availability either way, since free-slot finding ignores labels', () => {
    const free = invertToFreeSlots(['2026-07-15'], mergeBusyIntervals(sameClassTwice, 0))

    expect(free).toEqual([
      { date: '2026-07-15', startMin: WINDOW_START_MIN, endMin: 780 },
      { date: '2026-07-15', startMin: 840, endMin: WINDOW_END_MIN },
    ])
  })
})

describe('etDayKeys builds the window', () => {
  /* The only exported function in this module the rest of the suite never
     touches, and it decides WHICH fourteen days the whole page shows. Its one
     real hazard is calendar arithmetic at a boundary: a rewrite using string
     manipulation or a flat `+ 86_400_000` gets these wrong, and a professor
     opening the page in the last days of a month sees days that don't exist. */

  it('rolls over a month, a year, and a leap day', () => {
    expect(etDayKeys('2026-07-31', 3)).toEqual(['2026-07-31', '2026-08-01', '2026-08-02'])
    expect(etDayKeys('2026-12-31', 3)).toEqual(['2026-12-31', '2027-01-01', '2027-01-02'])
    // 2028 is a leap year, so the 29th must be there.
    expect(etDayKeys('2028-02-28', 3)).toEqual(['2028-02-28', '2028-02-29', '2028-03-01'])
  })

  it('stays on consecutive days across the spring-forward date', () => {
    // 2026-03-08 is the DST change. A ms-arithmetic version run in a US zone
    // skips or repeats a day here; UTC date-stepping cannot.
    expect(etDayKeys('2026-03-07', 3)).toEqual(['2026-03-07', '2026-03-08', '2026-03-09'])
  })

  it('returns the full window length and starts on the given day', () => {
    const keys = etDayKeys('2026-07-15', 14)

    expect(keys).toHaveLength(14)
    expect(keys[0]).toBe('2026-07-15')
    expect(keys[13]).toBe('2026-07-28')
    expect(etDayKeys('2026-07-15', 0)).toEqual([])
  })
})
