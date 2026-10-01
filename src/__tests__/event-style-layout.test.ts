// Tests for layoutDayEvents' vertical-window math (event-style.ts). The contract
// that matters and would silently break the mini calendar's positioning: top and
// height are a percentage of the [windowStartMin, windowEndMin) span, not of a
// fixed 24h day. The default window (0..1440) must reproduce the old day-fraction
// math (full-grid regression guard), and a narrow/offset window — including the
// negative windowStart the mini calendar passes in production (-EDGE_PAD) — must
// scale relative to that window. Lane packing is exercised only where it affects
// the window assertions.

import { describe, it, expect } from 'vitest'
import { layoutDayEvents } from '@/components/student/calendar/event-style'
import type { StudentCalendarEvent } from '@/lib/calendar/student-events'

// Build a timed or deadline event at local wall-clock times on a fixed day.
// Times are interpreted in the runner's local zone, matching minutesOfDay().
function ev(
  id: string,
  startHHMM: string,
  endHHMM: string | null,
): StudentCalendarEvent {
  const iso = (t: string) => new Date(`2026-07-15T${t}:00`).toISOString()
  return {
    id,
    kind: endHHMM ? 'class_session' : 'assignment_due',
    title: id,
    start: iso(startHHMM),
    end: endHHMM ? iso(endHHMM) : null,
    courseCode: null,
    sectionId: null,
    href: '#',
    location: null,
    description: null,
    status: null,
  }
}

describe('layoutDayEvents vertical window', () => {
  it('defaults to the full 24h day: top/height are a fraction of 1440 min', () => {
    // 06:00–07:00 → top 25% (360/1440), height ~4.17% (60/1440).
    const [pos] = layoutDayEvents([ev('a', '06:00', '07:00')])
    expect(pos.topPct).toBeCloseTo((360 / 1440) * 100, 5)
    expect(pos.heightPct).toBeCloseTo((60 / 1440) * 100, 5)
  })

  it('scales top/height to a narrow window, not the whole day', () => {
    // Window 10:00–12:00 (span 120). Event 10:00–11:00 → top 0%, height 50%.
    const [pos] = layoutDayEvents([ev('a', '10:00', '11:00')], 600, 720)
    expect(pos.topPct).toBeCloseTo(0, 5)
    expect(pos.heightPct).toBeCloseTo(50, 5)
  })

  it('places an event at the exact window start at top 0%', () => {
    const [pos] = layoutDayEvents([ev('a', '08:00', '09:00')], 480, 1020)
    expect(pos.topPct).toBeCloseTo(0, 5)
  })

  it('handles a negative windowStart (the mini calendar pads past midnight)', () => {
    // Window -30..1470 (span 1500), matching the production edge-pad shape.
    // Event 00:00–01:00 → top (0-(-30))/1500 = 2%, height 60/1500 = 4%.
    const [pos] = layoutDayEvents([ev('a', '00:00', '01:00')], -30, 1470)
    expect(pos.topPct).toBeCloseTo(2, 5)
    expect(pos.heightPct).toBeCloseTo(4, 5)
  })

  it('scales deadlines by the window too but keeps heightPct null', () => {
    // Deadline at 12:00 in window 600..720 (span 120): top (720-600)/120... i.e.
    // (12:00=720 - 600)/120 = 100%. Height stays null (drawn as a marker).
    const [pos] = layoutDayEvents([ev('d', '12:00', null)], 600, 720)
    expect(pos.topPct).toBeCloseTo(100, 5)
    expect(pos.heightPct).toBeNull()
  })
})
