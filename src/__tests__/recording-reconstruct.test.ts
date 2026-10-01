import { describe, it, expect } from 'vitest'
import {
  mapWallClockToAudioElapsed,
  buildPlaybackTimeline,
  slideAt,
  buildChapters,
  totalAudioDurationSec,
  type AudioSessionInfo,
  type RawTimelineEntry,
} from '@/lib/live-classroom/recording/reconstruct'

// Two recorded sessions with a 9s WALL-CLOCK gap between them (professor paused
// or reloaded the tab). Audio covers [0,10]s (session A) then [10,15]s (B).
//   A: wall [1000, 11000]  → audio [0, 10]
//   gap: wall (11000, 20000)  → NOT in the audio
//   B: wall [20000, 25000] → audio [10, 15]
const sessions: AudioSessionInfo[] = [
  { startedAt: 1000, durationMs: 10000 },
  { startedAt: 20000, durationMs: 5000 },
]

describe('mapWallClockToAudioElapsed', () => {
  it('maps a timestamp inside the first session to its audio offset', () => {
    expect(mapWallClockToAudioElapsed(sessions, 6000)).toBe(5) // (6000-1000)/1000
  })

  it('maps a timestamp inside a later session across the cumulative offset', () => {
    // 10s of session A + (22000-20000)/1000 into B
    expect(mapWallClockToAudioElapsed(sessions, 22000)).toBe(12)
  })

  it('clamps a timestamp landing in a recording gap to the end of prior audio', () => {
    // 15000 is in the gap; audio has no coverage there → clamp to 10s (end of A).
    expect(mapWallClockToAudioElapsed(sessions, 15000)).toBe(10)
  })

  it('clamps a timestamp before the first session to 0', () => {
    expect(mapWallClockToAudioElapsed(sessions, 500)).toBe(0)
  })

  it('clamps a timestamp after the last session to total duration', () => {
    expect(mapWallClockToAudioElapsed(sessions, 30000)).toBe(15)
  })

  it('is order-independent (unsorted sessions)', () => {
    const reversed = [...sessions].reverse()
    expect(mapWallClockToAudioElapsed(reversed, 22000)).toBe(12)
  })
})

describe('totalAudioDurationSec', () => {
  it('sums session durations in seconds', () => {
    expect(totalAudioDurationSec(sessions)).toBe(15)
  })
})

describe('buildPlaybackTimeline', () => {
  const timeline: RawTimelineEntry[] = [
    { ts: 1000, deck_id: 'd1', slide_index: 0 }, // t=0
    { ts: 6000, deck_id: 'd1', slide_index: 1 }, // t=5
    { ts: 6500, deck_id: 'd1', slide_index: 1 }, // t=5.5 duplicate slide → collapsed
    { ts: 22000, deck_id: 'd1', slide_index: 2 }, // t=12
  ]

  it('maps entries to audio time, sorts, and collapses consecutive duplicates', () => {
    const pb = buildPlaybackTimeline(timeline, sessions)
    expect(pb).toEqual([
      { t: 0, deckId: 'd1', slideIndex: 0 },
      { t: 5, deckId: 'd1', slideIndex: 1 },
      { t: 12, deckId: 'd1', slideIndex: 2 },
    ])
  })

  it('returns empty for an empty timeline', () => {
    expect(buildPlaybackTimeline([], sessions)).toEqual([])
  })
})

describe('slideAt', () => {
  const pb = buildPlaybackTimeline(
    [
      { ts: 1000, deck_id: 'd1', slide_index: 0 },
      { ts: 6000, deck_id: 'd1', slide_index: 1 },
      { ts: 22000, deck_id: 'd1', slide_index: 2 },
    ],
    sessions,
  )

  it('returns the first slide before the first entry', () => {
    expect(slideAt(pb, -1)?.slideIndex).toBe(0)
  })

  it('returns the active slide at an exact boundary', () => {
    expect(slideAt(pb, 5)?.slideIndex).toBe(1)
  })

  it('returns the last slide whose start is <= t', () => {
    expect(slideAt(pb, 8)?.slideIndex).toBe(1)
    expect(slideAt(pb, 12.5)?.slideIndex).toBe(2)
  })

  it('returns null for an empty timeline', () => {
    expect(slideAt([], 3)).toBeNull()
  })
})

describe('buildChapters', () => {
  it('produces one 1-based labeled chapter per playback slide', () => {
    const pb = buildPlaybackTimeline(
      [
        { ts: 1000, deck_id: 'd1', slide_index: 0 },
        { ts: 6000, deck_id: 'd1', slide_index: 4 },
      ],
      sessions,
    )
    expect(buildChapters(pb)).toEqual([
      { t: 0, label: 'Slide 1' },
      { t: 5, label: 'Slide 5' },
    ])
  })
})
