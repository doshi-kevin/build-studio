// Logic tests for computeProctoringSummary — the pure roll-up the professor reads.
// The behavior that matters: each suspicious flag fires at its documented threshold
// (paste>=3, tabSwitch>=10, copy>=5, mf>=1, ph>=1) and NOT one below it, the
// webcamDenied rule (video on + 0 snapshots, independent of detections), the kd/
// keystrokeCount tally split, and first/last event timestamps from event offsets.
import { describe, it, expect } from 'vitest'
import { computeProctoringSummary } from '@/lib/proctoring/summary'
import type { ProctoringEvent } from '@/lib/validations/proctoring'

const START = new Date('2026-06-09T01:00:00.000Z').getTime()

const baseOpts = {
  keystrokeCount: 0,
  snapshotCount: 0,
  videoEnabled: false,
  startedAtMs: START,
}

// Build n events of a single type, spaced 1s apart.
const many = (type: ProctoringEvent['type'], n: number): ProctoringEvent[] =>
  Array.from({ length: n }, (_, i) => ({ type, t: i * 1000 }))

describe('computeProctoringSummary — tallies', () => {
  it('sums plain keystrokeCount with kd events into totalKeystrokes', () => {
    const r = computeProctoringSummary(many('kd', 4), { ...baseOpts, keystrokeCount: 100 })
    expect(r.totalKeystrokes).toBe(104)
  })

  it('tallies copy/paste/cut/tabSwitch counts by event type', () => {
    const events = [...many('cp', 2), ...many('ps', 1), ...many('ct', 3), ...many('bl', 4)]
    const r = computeProctoringSummary(events, baseOpts)
    expect(r.copyCount).toBe(2)
    expect(r.pasteCount).toBe(1)
    expect(r.cutCount).toBe(3)
    expect(r.tabSwitchCount).toBe(4)
    expect(r.eventCount).toBe(10)
  })

  it('derives first/last event timestamps from offsets relative to startedAtMs, regardless of input order', () => {
    const events: ProctoringEvent[] = [{ type: 'cp', t: 5000 }, { type: 'ps', t: 1000 }]
    const r = computeProctoringSummary(events, baseOpts)
    expect(r.firstEventAt).toBe(new Date(START + 1000).toISOString())
    expect(r.lastEventAt).toBe(new Date(START + 5000).toISOString())
  })

  it('returns null timestamps when there are no events', () => {
    const r = computeProctoringSummary([], baseOpts)
    expect(r.firstEventAt).toBeNull()
    expect(r.lastEventAt).toBeNull()
    expect(r.eventCount).toBe(0)
    expect(r.suspiciousFlags).toEqual([])
  })
})

describe('computeProctoringSummary — suspicious flag thresholds', () => {
  it('flags multiple_paste_events at 3 pastes but not at 2', () => {
    expect(computeProctoringSummary(many('ps', 2), baseOpts).suspiciousFlags).not.toContain('multiple_paste_events')
    expect(computeProctoringSummary(many('ps', 3), baseOpts).suspiciousFlags).toContain('multiple_paste_events')
  })

  it('flags frequent_tab_switches at 10 blurs but not at 9', () => {
    expect(computeProctoringSummary(many('bl', 9), baseOpts).suspiciousFlags).not.toContain('frequent_tab_switches')
    expect(computeProctoringSummary(many('bl', 10), baseOpts).suspiciousFlags).toContain('frequent_tab_switches')
  })

  it('flags excessive_copying at 5 copies but not at 4', () => {
    expect(computeProctoringSummary(many('cp', 4), baseOpts).suspiciousFlags).not.toContain('excessive_copying')
    expect(computeProctoringSummary(many('cp', 5), baseOpts).suspiciousFlags).toContain('excessive_copying')
  })

  it('flags multiple_faces_detected on the first mf event', () => {
    expect(computeProctoringSummary([], baseOpts).suspiciousFlags).not.toContain('multiple_faces_detected')
    const r = computeProctoringSummary(many('mf', 1), baseOpts)
    expect(r.multipleFaceCount).toBe(1)
    expect(r.suspiciousFlags).toContain('multiple_faces_detected')
  })

  it('flags phone_detected on the first ph event', () => {
    expect(computeProctoringSummary([], baseOpts).suspiciousFlags).not.toContain('phone_detected')
    const r = computeProctoringSummary(many('ph', 1), baseOpts)
    expect(r.phoneDetectedCount).toBe(1)
    expect(r.suspiciousFlags).toContain('phone_detected')
  })
})

describe('computeProctoringSummary — fullscreen exits (fx)', () => {
  it('counts fx events into fullscreenExitCount', () => {
    const r = computeProctoringSummary(many('fx', 3), baseOpts)
    expect(r.fullscreenExitCount).toBe(3)
  })

  it('flags fullscreen_exit on the first fx event', () => {
    expect(computeProctoringSummary([], baseOpts).suspiciousFlags).not.toContain('fullscreen_exit')
    const r = computeProctoringSummary(many('fx', 1), baseOpts)
    expect(r.fullscreenExitCount).toBe(1)
    expect(r.suspiciousFlags).toContain('fullscreen_exit')
  })

  it('does NOT flag fullscreen_exit when there are no fx events', () => {
    const r = computeProctoringSummary(many('cp', 2), baseOpts)
    expect(r.fullscreenExitCount).toBe(0)
    expect(r.suspiciousFlags).not.toContain('fullscreen_exit')
  })
})

describe('computeProctoringSummary — webcamDenied rule', () => {
  it('flags camera_denied when video is on and no snapshots were stored', () => {
    const r = computeProctoringSummary([], { ...baseOpts, videoEnabled: true, snapshotCount: 0 })
    expect(r.webcamDenied).toBe(true)
    expect(r.suspiciousFlags).toContain('camera_denied')
  })

  it('does NOT flag camera_denied when video is on and at least one snapshot exists', () => {
    const r = computeProctoringSummary([], { ...baseOpts, videoEnabled: true, snapshotCount: 1 })
    expect(r.webcamDenied).toBe(false)
    expect(r.suspiciousFlags).not.toContain('camera_denied')
  })

  it('does NOT flag camera_denied when video was never enabled, even with 0 snapshots', () => {
    // A clean student with 0 detections and no video must not be flagged.
    const r = computeProctoringSummary([], { ...baseOpts, videoEnabled: false, snapshotCount: 0 })
    expect(r.webcamDenied).toBe(false)
    expect(r.suspiciousFlags).toEqual([])
  })
})
