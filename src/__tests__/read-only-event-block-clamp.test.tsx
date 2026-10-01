// Professor calendar read-only overlay — clamping off-grid events into the
// 7 AM–9 PM window, AND lane-packing the clamped result.
//
// Why this is tested: the professor calendar's time grid only spans
// GRID_START_HOUR..GRID_END_HOUR, but assignment/quiz due dates are authored
// freely and a large share of real published deadlines fall OUTSIDE that window
// (11:59 PM being the single most common due time anyone sets). Positioned
// unclamped, those render at a negative offset (over the day header) or below
// the last row into unlabeled dead space — a deadline that silently vanished.
//
// Three things must hold, and they pull against each other:
//   1. Every block stays INSIDE the grid, with a clickable minimum height.
//   2. A block that had to move discloses its real time, because a 11:59 PM
//      deadline pinned to the 8:40 PM row is otherwise a lie about when it's due.
//   3. Lanes are assigned from the CLAMPED spans, not the raw ones. This is the
//      subtle one and it was a real bug: two deadlines that don't overlap in
//      real time each took a full-width lane, then both clamped onto the same
//      box — so one completely hid the other, and could equally hide a genuine
//      late-evening class. Clamping without re-packing just relocates the
//      occlusion it was meant to prevent.
//
// Assertions read positions back in wall-clock minutes rather than pixels, so
// they describe behaviour ("pinned to 7:00, 20 minutes tall") not px arithmetic.

import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import {
  ReadOnlyEventBlock,
  layoutReadOnlyDay,
} from '@/components/professor/calendar/ReadOnlyEventBlock'
import { GRID_START_HOUR, GRID_END_HOUR, MIN_BLOCK_MIN } from '@/lib/calendar/utils'
import type { StudentCalendarEvent } from '@/lib/calendar/student-events'

const GRID_START_MIN = GRID_START_HOUR * 60 // 420 — 7:00 AM
const GRID_END_MIN = GRID_END_HOUR * 60 //     1260 — 9:00 PM

// Local-time ISO (no trailing Z) on purpose: grid position derives from local
// wall-clock hours, so this keeps the test TZ-independent.
const event = (overrides: Partial<StudentCalendarEvent> = {}): StudentCalendarEvent => ({
  id: 'quiz-1',
  kind: 'quiz_due',
  title: 'Midterm',
  start: '2026-04-06T14:00:00',
  end: null,
  courseCode: 'CS 101',
  sectionId: 'sec-1',
  href: '/professor/courses/sec-1/quizzes/quiz-1',
  location: null,
  description: null,
  status: null,
  ...overrides,
})

const one = (ev: StudentCalendarEvent) => layoutReadOnlyDay([ev])[0]

describe('clamping into the grid window', () => {
  it('leaves an in-window event at its real time and discloses no time', () => {
    // The control case. If this starts disclosing a time, the clamped check has
    // inverted or gone always-true, and every chip grows a redundant prefix.
    const g = one(event({ start: '2026-04-06T14:00:00', end: '2026-04-06T15:00:00' }))
    expect(g.startMin).toBe(14 * 60)
    expect(g.endMin).toBe(15 * 60)
    expect(g.clampedFromMin).toBeNull()
  })

  it('pins a pre-dawn event to the top of the grid and reports its real start', () => {
    const g = one(event({ kind: 'class_session', start: '2026-04-06T06:00:00', end: '2026-04-06T06:30:00' }))
    expect(g.startMin).toBe(GRID_START_MIN)
    // Entirely above the window, so only the minimum sliver remains.
    expect(g.endMin).toBe(GRID_START_MIN + MIN_BLOCK_MIN)
    expect(g.clampedFromMin).toBe(6 * 60) // 6:00 AM, not the 7:00 AM it's drawn at
  })

  it('keeps a late-night deadline inside the grid instead of below the last row', () => {
    // 11:30 PM with no end time — the common real case.
    const g = one(event({ start: '2026-04-06T23:30:00', end: null }))
    expect(g.endMin).toBe(GRID_END_MIN)
    expect(g.startMin).toBe(GRID_END_MIN - MIN_BLOCK_MIN)
    expect(g.clampedFromMin).toBe(23 * 60 + 30)
  })

  it('fits an all-day event to exactly the grid, overflowing neither edge', () => {
    const g = one(event({ kind: 'class_session', start: '2026-04-06T06:00:00', end: '2026-04-06T23:00:00' }))
    expect(g.startMin).toBe(GRID_START_MIN)
    expect(g.endMin).toBe(GRID_END_MIN)
  })

  it('treats an event ending exactly on the grid boundary as unclamped', () => {
    // A real 8–9 PM class ends precisely at GRID_END. An exclusive comparison
    // would flag every one as clamped and tack "8:00 PM ·" onto a block already
    // sitting at 8:00 PM.
    const g = one(event({ kind: 'class_session', start: '2026-04-06T20:00:00', end: '2026-04-06T21:00:00' }))
    expect(g.startMin).toBe(20 * 60)
    expect(g.endMin).toBe(GRID_END_MIN)
    expect(g.clampedFromMin).toBeNull()
  })

  it('never produces a zero- or negative-height block when the end precedes the start', () => {
    // Bad data rather than a boundary, but it reaches here from the aggregator
    // unvalidated, and a negative height collapses the chip to an unclickable line.
    const g = one(event({ kind: 'class_session', start: '2026-04-06T10:00:00', end: '2026-04-06T09:00:00' }))
    expect(g.endMin - g.startMin).toBe(MIN_BLOCK_MIN)
    expect(g.endMin).toBeGreaterThan(g.startMin)
  })
})

describe('lanes come from the clamped spans, so nothing is hidden', () => {
  it('splits two off-grid deadlines that clamp onto the same box', () => {
    // 10 PM and 11:59 PM do NOT overlap in real time, so raw-time packing gives
    // each a full-width lane — and then both clamp to the last 20 minutes of the
    // grid, stacking exactly on top of each other.
    const rows = layoutReadOnlyDay([
      event({ id: 'a', title: 'Quiz 4', start: '2026-04-06T22:00:00' }),
      event({ id: 'b', title: 'Problem Set 6', start: '2026-04-06T23:59:00' }),
    ])
    expect(rows.map((r) => [r.startMin, r.endMin])).toEqual([
      [GRID_END_MIN - MIN_BLOCK_MIN, GRID_END_MIN],
      [GRID_END_MIN - MIN_BLOCK_MIN, GRID_END_MIN],
    ])
    // Same box → must be side by side, not co-located.
    expect(rows.map((r) => r.widthPct)).toEqual([50, 50])
    expect(new Set(rows.map((r) => r.leftPct)).size).toBe(2)
  })

  it('does not let a clamped deadline cover a real late-evening class', () => {
    // The worst case: the class is genuinely at 8:40–9:00 PM (in-window, needing
    // no clamp) and the deadline clamps onto precisely that span.
    const rows = layoutReadOnlyDay([
      event({ id: 'class', kind: 'class_session', title: 'Evening lab', start: '2026-04-06T20:40:00', end: '2026-04-06T21:00:00' }),
      event({ id: 'due', title: 'Essay', start: '2026-04-06T23:59:00' }),
    ])
    const byId = Object.fromEntries(rows.map((r) => [r.event.id, r]))
    expect(byId.class.startMin).toBe(20 * 60 + 40)
    expect(byId.due.startMin).toBe(GRID_END_MIN - MIN_BLOCK_MIN) // same 20:40
    expect(byId.class.widthPct).toBe(50)
    expect(byId.due.widthPct).toBe(50)
    expect(byId.class.leftPct).not.toBe(byId.due.leftPct)
  })

  it('still gives a genuinely solitary event the full width', () => {
    // Guards the opposite failure: packing everything into narrow lanes whether
    // or not anything overlaps.
    const rows = layoutReadOnlyDay([
      event({ id: 'a', kind: 'class_session', start: '2026-04-06T09:00:00', end: '2026-04-06T10:00:00' }),
      event({ id: 'b', kind: 'class_session', start: '2026-04-06T13:00:00', end: '2026-04-06T14:00:00' }),
    ])
    expect(rows.map((r) => r.widthPct)).toEqual([100, 100])
  })
})

describe('the disclosed time survives truncation', () => {
  it('puts the real time FIRST in the label when clamped', () => {
    // A week column leaves the label ~88px, so a trailing correction is the
    // first thing `truncate` removes — which is the one part that must survive.
    const g = one(event({ title: 'Problem Set: Softmax and Complexity', start: '2026-04-06T23:59:00' }))
    const { container } = render(
      <ReadOnlyEventBlock
        event={g.event}
        startMin={g.startMin}
        endMin={g.endMin}
        clampedFromMin={g.clampedFromMin}
        leftPct={g.leftPct}
        widthPct={g.widthPct}
      />,
    )
    expect(container.querySelector('a')?.textContent).toBe(
      '11:59 PM · CS 101 · Problem Set: Softmax and Complexity',
    )
  })

  it('adds no prefix to an in-window event', () => {
    const g = one(event({ start: '2026-04-06T14:00:00', end: '2026-04-06T15:00:00' }))
    const { container } = render(
      <ReadOnlyEventBlock
        event={g.event}
        startMin={g.startMin}
        endMin={g.endMin}
        clampedFromMin={g.clampedFromMin}
        leftPct={g.leftPct}
        widthPct={g.widthPct}
      />,
    )
    expect(container.querySelector('a')?.textContent).toBe('CS 101 · Midterm')
  })
})
