/**
 * Server-only ElevenLabs Speech-to-Text helper. NEVER import this into a client component.
 *
 * Reads ELEVENLABS_API_KEY from the server env (never hardcoded, never exposed). Uses the
 * batch Scribe endpoint to transcribe an uploaded recording with word-level timestamps, so
 * callers can slice the transcript by time window (one window per verbal-assessment question).
 *
 * This is the authoritative transcript source: in-browser Web Speech is unreliable, so we
 * transcribe the recording we already store on the server instead.
 */
import 'server-only'
import { recordExternalUsage } from '@/lib/costs/external-usage'
import type { AiAttribution } from '@/lib/ai/usage'

const STT_URL = 'https://api.elevenlabs.io/v1/speech-to-text'
const STT_MODEL = 'scribe_v1'

/** A single recognized word with its position (seconds) in the recording. */
export interface TranscribedWord {
  text: string
  start: number
}

export type SttResult =
  | { ok: true; words: TranscribedWord[]; text: string }
  | { ok: false; error: string }

/**
 * Transcribe an audio/video recording. `contentType` is the stored MIME (e.g. video/webm);
 * Scribe extracts the audio track itself. Returns word-timestamped output, or a safe error.
 */
export async function transcribeRecording(
  buffer: Buffer,
  contentType: string,
  attribution?: AiAttribution,
): Promise<SttResult> {
  const key = process.env.ELEVENLABS_API_KEY
  if (!key) return { ok: false, error: 'Transcription is not configured.' }
  if (buffer.length === 0) return { ok: false, error: 'Nothing to transcribe.' }

  const form = new FormData()
  form.append('model_id', STT_MODEL)
  form.append('file', new Blob([new Uint8Array(buffer)], { type: contentType || 'video/webm' }), 'recording.webm')

  let res: Response
  try {
    res = await fetch(STT_URL, { method: 'POST', headers: { 'xi-api-key': key }, body: form })
  } catch {
    return { ok: false, error: 'Could not reach the transcription service.' }
  }
  if (!res.ok) return { ok: false, error: 'Transcription failed.' }

  let data: { text?: string; words?: Array<{ text?: string; start?: number; type?: string }> }
  try {
    data = await res.json()
  } catch {
    return { ok: false, error: 'Transcription returned an unexpected response.' }
  }

  const words: TranscribedWord[] = (data.words ?? [])
    .filter((w) => w.type !== 'spacing' && typeof w.start === 'number' && Boolean(w.text?.trim()))
    .map((w) => ({ text: w.text as string, start: w.start as number }))

  // Batch STT bills by audio duration; the API response carries no duration
  // field, so the last word's timestamp is the measured (slightly-low) bound.
  const audioSeconds = words.length > 0 ? Math.ceil(words[words.length - 1].start) : 0
  void recordExternalUsage({
    provider: 'elevenlabs',
    feature: 'verbal_stt',
    quantity: audioSeconds,
    institutionId: attribution?.institutionId,
    sectionId: attribution?.sectionId,
    userId: attribution?.userId,
    metadata: { model: STT_MODEL, measured_via: 'last_word_start' },
  })

  return { ok: true, words, text: (data.text ?? '').trim() }
}

/**
 * Slice transcribed words into ordered time windows. `offsets[i]` is the start (seconds) of
 * window i; each window runs until the next offset (the last runs to the end). Returns one
 * joined transcript string per window, aligned to the offsets array.
 */
export function sliceByOffsets(words: TranscribedWord[], offsets: number[]): string[] {
  return offsets.map((start, i) => {
    const end = i + 1 < offsets.length ? offsets[i + 1] : Infinity
    return words
      .filter((w) => w.start >= start && w.start < end)
      .map((w) => w.text)
      .join(' ')
      .replace(/\s+([,.!?;:])/g, '$1')
      .trim()
  })
}
