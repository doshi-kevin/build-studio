// Pure reconstruction math for recording playback. No IO, no React — unit tested.
//
// The recorded audio (the concatenated MediaRecorder sessions) is the MASTER
// CLOCK. Every visual event — a slide change, an annotation stroke — carries an
// absolute wall-clock epoch-ms timestamp. We map that onto elapsed audio time so
// the visuals stay locked to what the listener hears, even across:
//   • recording GAPS (the professor paused, or a tab reload split the audio into
//     two sessions) — the wall-clock time in the gap is NOT in the audio, so an
//     event there clamps to the surrounding session boundary; and
//   • sound-card sample-rate drift over a long lecture — because we seek visuals
//     to audio.currentTime, drift can't accumulate.

export interface AudioSessionInfo {
  /** epoch ms when this session's recording started */
  startedAt: number
  /** client-reported recorded length in ms */
  durationMs: number
}

export interface RawTimelineEntry {
  ts: number // epoch ms (written by the lc_rooms timeline trigger)
  deck_id: string | null
  slide_index: number
}

export interface PlaybackSlide {
  /** seconds into the concatenated audio when this slide became active */
  t: number
  deckId: string | null
  slideIndex: number
}

export interface Chapter {
  t: number // seconds
  label: string
}

/** Total playable audio length in seconds (sum of session durations). */
export function totalAudioDurationSec(sessions: AudioSessionInfo[]): number {
  return sessions.reduce((sum, s) => sum + Math.max(0, s.durationMs), 0) / 1000
}

/**
 * Map an absolute wall-clock timestamp (epoch ms) to elapsed SECONDS in the
 * concatenated audio. Time between sessions isn't recorded, so an event landing
 * in a gap clamps to the end of the preceding recorded audio. Sessions need not
 * be pre-sorted.
 */
export function mapWallClockToAudioElapsed(
  sessions: AudioSessionInfo[],
  wallTs: number,
): number {
  const ordered = [...sessions].sort((a, b) => a.startedAt - b.startedAt)
  let cumulative = 0 // seconds of audio accumulated before the current session
  for (const s of ordered) {
    const dur = Math.max(0, s.durationMs)
    const end = s.startedAt + dur
    if (wallTs < s.startedAt) {
      // Before this session began → the event sits in a gap (or before start);
      // clamp to the audio position where recording resumes.
      return cumulative
    }
    if (wallTs <= end) {
      return cumulative + (wallTs - s.startedAt) / 1000
    }
    cumulative += dur / 1000
  }
  // After the last session ends → end of audio.
  return cumulative
}

/**
 * Convert raw slide-change entries (wall-clock) into playback slides
 * (audio-elapsed seconds), sorted by time, with consecutive duplicates of the
 * same deck+slide collapsed (a no-op re-render adds no chapter). Entries are
 * mapped through the audio timeline so they line up with the audio.
 */
export function buildPlaybackTimeline(
  timeline: RawTimelineEntry[],
  sessions: AudioSessionInfo[],
): PlaybackSlide[] {
  const mapped = timeline
    .map((e) => ({
      t: mapWallClockToAudioElapsed(sessions, e.ts),
      deckId: e.deck_id,
      slideIndex: e.slide_index,
    }))
    .sort((a, b) => a.t - b.t)

  const out: PlaybackSlide[] = []
  for (const s of mapped) {
    const prev = out[out.length - 1]
    if (prev && prev.deckId === s.deckId && prev.slideIndex === s.slideIndex) continue
    out.push(s)
  }
  return out
}

/**
 * The slide active at `t` seconds: the last entry whose start time is <= t.
 * Before the first entry, returns the first entry so a slide always renders.
 * Returns null only for an empty timeline. Binary search — O(log n) per seek.
 */
export function slideAt(playback: PlaybackSlide[], t: number): PlaybackSlide | null {
  if (playback.length === 0) return null
  if (t < playback[0].t) return playback[0]
  let lo = 0
  let hi = playback.length - 1
  let ans = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (playback[mid].t <= t) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return playback[ans]
}

/** One chapter marker per slide in the playback timeline (for the scrubber). */
export function buildChapters(
  playback: PlaybackSlide[],
  label: (slideIndex: number, deckId: string | null) => string = (i) => `Slide ${i + 1}`,
): Chapter[] {
  return playback.map((s) => ({ t: s.t, label: label(s.slideIndex, s.deckId) }))
}
