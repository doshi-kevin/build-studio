// Shapes for Pre-Class Primers — the short AI-generated audio "advance
// organizer" a student listens to before a lecture.
//
// The LLM output (the spoken script) is validated against the Zod schema here
// before it is stored / sent to TTS, so the rest of the pipeline can trust its
// shape (never trust raw LLM output).

import { z } from 'zod'

/**
 * The generated primer script. One field: the spoken text. The upper bound is
 * a safety ceiling (the prompt targets 450–600 words ≈ ~3600 chars); generate.ts
 * truncates to PRECLASS_PRIMER_MAX_TTS_CHARS at a sentence boundary before TTS,
 * so a slightly-long script is bounded rather than rejected.
 */
export const primerScriptOutputSchema = z.object({
  script: z.string().min(200).max(8000),
})
export type PrimerScriptOutput = z.infer<typeof primerScriptOutputSchema>
