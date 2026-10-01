// ElevenLabs text-to-speech for Pre-Class Primers. Reuses the ELEVENLABS_API_KEY
// already used for live Scribe transcription (same account, same header
// convention). Returns mp3 bytes; never throws — a quota/billing error comes
// back as { error } so the orchestrator can mark the primer failed.

import 'server-only'

import { logger } from '@/lib/logger'
import { recordExternalUsage } from '@/lib/costs/external-usage'
import type { AiAttribution } from '@/lib/ai/usage'

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY ?? ''
// A prebuilt ElevenLabs voice available on all accounts ("Rachel"); overridable.
const VOICE_ID = process.env.ELEVENLABS_PRIMER_VOICE_ID ?? '21m00Tcm4TlvDq8ikWAM'
// Turbo v2.5 is the low-latency, low-cost TTS model — ideal for narration.
const MODEL_ID = process.env.ELEVENLABS_PRIMER_MODEL_ID ?? 'eleven_turbo_v2_5'
const OUTPUT_FORMAT = 'mp3_44100_128' // 128 kbps mp3 ≈ 1 MB/min

export interface SynthesisResult {
  audio: Buffer | null
  error?: string
}

/** Synthesize spoken audio for `text`. Returns mp3 bytes, or an error string. */
export async function synthesizeSpeech(text: string, attribution?: AiAttribution): Promise<SynthesisResult> {
  if (!ELEVENLABS_API_KEY) {
    return { audio: null, error: 'TTS is not configured (ELEVENLABS_API_KEY missing)' }
  }

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=${OUTPUT_FORMAT}`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({ text, model_id: MODEL_ID }),
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      logger.error('synthesizeSpeech: ElevenLabs TTS failed', null, {
        status: res.status,
        body: detail.slice(0, 200),
      })
      return { audio: null, error: `TTS request failed (${res.status})` }
    }

    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length === 0) return { audio: null, error: 'TTS returned empty audio' }
    void recordExternalUsage({
      provider: 'elevenlabs',
      feature: 'primer_tts',
      quantity: text.length,
      institutionId: attribution?.institutionId,
      sectionId: attribution?.sectionId,
      userId: attribution?.userId,
      metadata: { model: MODEL_ID },
    })
    return { audio: buf }
  } catch (err) {
    logger.error('synthesizeSpeech: unexpected error', err)
    return { audio: null, error: err instanceof Error ? err.message : String(err) }
  }
}
