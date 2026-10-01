// Shared types and constants for the live classroom transcription system.
// ElevenLabs Scribe v2 real-time WebSocket configuration.

export const SCRIBE_WS_URL = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime'
export const SCRIBE_SAMPLE_RATE = 16000
export const SCRIBE_MODEL = 'scribe_v2_realtime'

export const TRANSCRIPT_DEBOUNCE_MS = 5000
export const RECONNECT_MAX_RETRIES = 5
export const RECONNECT_BASE_DELAY_MS = 1000

export interface ScribeSessionStarted {
  message_type: 'session_started'
  session_id: string
}

export interface ScribePartialTranscript {
  message_type: 'partial_transcript'
  text: string
}

export interface ScribeCommittedTranscript {
  message_type: 'committed_transcript'
  text: string
}

export type ScribeMessage =
  | ScribeSessionStarted
  | ScribePartialTranscript
  | ScribeCommittedTranscript

export interface TranscriptionState {
  isListening: boolean
  isConnected: boolean
  partialText: string
  transcriptByPage: Map<number, string>
  error: string | null
}
