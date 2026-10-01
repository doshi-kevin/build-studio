/**
 * Server-only ElevenLabs Text-to-Speech helper. NEVER import this into a client component.
 *
 * Reads ELEVENLABS_API_KEY from the server env (never hardcoded, never exposed). Uses the
 * low-latency, low-cost `eleven_flash_v2_5` model with a LIBRARY voice_id and returns MP3
 * audio bytes for the caller to store. It does NOT decide what to say - callers pass text.
 */
import 'server-only'
import { isLibraryVoice } from './voices'
import { recordExternalUsage } from '@/lib/costs/external-usage'
import type { AiAttribution } from '@/lib/ai/usage'

const TTS_BASE = 'https://api.elevenlabs.io/v1/text-to-speech'
const TTS_MODEL = 'eleven_flash_v2_5'
const MAX_TEXT_CHARS = 1500

export type TtsResult =
  | { ok: true; audio: Buffer; contentType: string }
  | { ok: false; error: string }

/** Synthesize `text` with a library voice. Returns MP3 bytes, or a safe error message. */
export async function synthesizeSpeech(text: string, voiceId: string, attribution?: AiAttribution): Promise<TtsResult> {
  const key = process.env.ELEVENLABS_API_KEY
  if (!key) return { ok: false, error: 'Voice synthesis is not configured.' }

  const clean = text.trim()
  if (!clean) return { ok: false, error: 'Nothing to synthesize.' }
  if (clean.length > MAX_TEXT_CHARS) return { ok: false, error: 'Question is too long to synthesize.' }
  // Only stock library voices - no cloned/custom voice ids.
  if (!isLibraryVoice(voiceId)) return { ok: false, error: 'Unknown voice.' }

  let res: Response
  try {
    res = await fetch(`${TTS_BASE}/${encodeURIComponent(voiceId)}`, {
      method: 'POST',
      headers: {
        'xi-api-key': key,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({ text: clean, model_id: TTS_MODEL }),
    })
  } catch {
    return { ok: false, error: 'Could not reach the voice service.' }
  }

  if (!res.ok) {
    return { ok: false, error: 'Voice synthesis failed. Please try again.' }
  }

  const audio = Buffer.from(await res.arrayBuffer())
  void recordExternalUsage({
    provider: 'elevenlabs',
    feature: 'verbal_tts',
    quantity: clean.length,
    institutionId: attribution?.institutionId,
    sectionId: attribution?.sectionId,
    userId: attribution?.userId,
    metadata: { model: TTS_MODEL },
  })
  return { ok: true, audio, contentType: 'audio/mpeg' }
}
