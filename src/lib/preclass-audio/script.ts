// Pure helpers for the primer script → audio path. No server-only imports so
// they're unit-testable in isolation (hash-independent formatting logic).

import { PRECLASS_PRIMER_MAX_TTS_CHARS, PRECLASS_PRIMER_WPM } from '@/lib/ai/config'

/** Rough spoken-word count (whitespace-separated tokens). */
export function countWords(text: string): number {
  const t = text.trim()
  return t ? t.split(/\s+/).length : 0
}

/**
 * Estimate how long `text` takes to narrate, in whole seconds, at the primer
 * WPM. Used only for the "~N min listen" label — not exact audio duration.
 */
export function estimateDurationSeconds(text: string): number {
  return Math.round((countWords(text) / PRECLASS_PRIMER_WPM) * 60)
}

/**
 * Cap the script sent to TTS at a hard char ceiling to bound ElevenLabs spend,
 * cutting at the last sentence boundary before the ceiling so audio never ends
 * mid-word. Falls back to a hard slice only if there's no sentence break in the
 * first `maxChars` (pathological input).
 */
export function truncateScriptForTts(
  script: string,
  maxChars: number = PRECLASS_PRIMER_MAX_TTS_CHARS,
): string {
  const s = script.trim()
  if (s.length <= maxChars) return s
  const window = s.slice(0, maxChars)
  const lastBreak = Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '))
  if (lastBreak > maxChars * 0.5) return window.slice(0, lastBreak + 1).trim()
  return window.trim()
}
