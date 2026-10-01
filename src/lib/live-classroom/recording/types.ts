// Shared types for Live Classroom recording playback. The player is fed a
// single RecordingData blob assembled server-side by getRecording.

/** MediaRecorder timeslice (ms). Also finalize's per-chunk duration fallback
 *  when a session closed without reporting its exact recorded length. */
export const RECORDING_TIMESLICE_MS = 15000

export type RecordingStatus = 'none' | 'recording' | 'processing' | 'failed' | 'ready'

export interface RecordingAudioSession {
  /** epoch ms when this session started recording (for wall-clock → audio mapping) */
  startedAt: number
  durationMs: number
  /** signed URL to the concatenated session audio */
  url: string
}

export interface RecordingAnnotation {
  deckId: string | null
  slideIndex: number
  /** epoch ms the stroke was drawn (mapped to audio time at playback) */
  ts: number
  /** raw stroke payload from lc_slide_annotations ({points,color,width,...}) */
  stroke: unknown
}

export interface RecordingData {
  status: RecordingStatus
  durationMs?: number
  audio?: RecordingAudioSession[]
  /** raw slide-change spine (wall-clock ts); the player maps it to audio time */
  timeline?: { ts: number; deck_id: string | null; slide_index: number }[]
  /** deckId → signed slide image URL per 0-based slide index */
  slideUrls?: Record<string, string[]>
  annotations?: RecordingAnnotation[]
}
