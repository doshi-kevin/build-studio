/**
 * Curated list of ElevenLabs LIBRARY voices (public, stock voice_ids). We reference these
 * by id only - no voice cloning, no professor/student voice capture. Safe to import on the
 * client (these are just ids + labels; the API key is never here).
 */

export interface LibraryVoice {
  id: string
  name: string
  description: string
}

export const LIBRARY_VOICES: LibraryVoice[] = [
  { id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel', description: 'Calm, clear American female' },
  { id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam', description: 'Deep, steady American male' },
  { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah', description: 'Warm, friendly American female' },
  { id: 'ErXwobaYiN019PkySvjV', name: 'Antoni', description: 'Well-rounded American male' },
  { id: 'MF3mGyEYCl7XYWbV9V6O', name: 'Elli', description: 'Bright, younger American female' },
  { id: 'TxGEqnHWrfWFTfGW9XjX', name: 'Josh', description: 'Casual, younger American male' },
]

export const DEFAULT_VOICE_ID = LIBRARY_VOICES[0].id

export function isLibraryVoice(id: string): boolean {
  return LIBRARY_VOICES.some((v) => v.id === id)
}

export function voiceName(id: string): string {
  return LIBRARY_VOICES.find((v) => v.id === id)?.name ?? id
}
