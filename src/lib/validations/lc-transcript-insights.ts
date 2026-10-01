// Shapes for the transcript extraction read model (roadmap-engine.md §5.1).
//
// One structured LLM pass per ended live class turns the per-slide transcript
// into claims the roadmap can annotate with (P14/P16/P22-P24, S20-S23) and
// Athena can answer from (athena-students.md U21-U24).
//
// The whole trust design is in one field: `quote`. Every claim carries the
// professor's verbatim words plus the deck and slide they were said on, and
// `verifyAndAnchorClaims()` (transcript-extraction.ts) checks that quote really
// occurs in that slide's transcript before anything is stored. A claim that
// cannot be anchored is DROPPED — never stored with a hedge — because an
// invented promise ("he said the deadline moved") is worse than no signal at
// all. These schemas are what makes "never trust raw LLM output" enforceable.

import { z } from 'zod'

/**
 * What kind of statement was extracted. Each maps to a roadmap signal pair
 * (professor / student) and to an Athena use case:
 *  - commitment    → P14 / S20 / U21 — a promise: moved deadline, extension,
 *                    a section dropped from the syllabus.
 *  - exam_scope    → P16 / U24 — what an assessment does or doesn't cover.
 *  - emphasis      → P22 / S21 / U22 — "this will be on the exam", "the key
 *                    idea here is…"; the strongest importance signal a course
 *                    produces, and one the slides never carry.
 *  - off_deck      → P23 / S22 / U23 — taught at length, on no slide.
 */
export const TRANSCRIPT_CLAIM_KINDS = ['commitment', 'exam_scope', 'emphasis', 'off_deck'] as const
export type TranscriptClaimKind = (typeof TRANSCRIPT_CLAIM_KINDS)[number]

// ── What the model returns ───────────────────────────────────────────

/**
 * Slides are addressed the way the prompt labels them: 1-based per deck, which
 * is also what the student sees ("Slide 12"). `lc_transcriptions.page_number`
 * is 0-based, so anchoring converts — see SLIDE_LABEL_OFFSET.
 */
export const extractedClaimSchema = z.object({
  kind: z.enum(TRANSCRIPT_CLAIM_KINDS),
  /** The annotation text — one plain sentence, no markdown, no hedging. */
  summary: z.string().min(1).max(200),
  /** The professor's own words, copied exactly. Verified before storage. */
  quote: z.string().min(1).max(400),
  /** 1-based deck number as labelled in the prompt (not a uuid — a model
   *  echoing uuids invents them; an index out of range is simply dropped). */
  deckIndex: z.number().int().min(1),
  /** 1-based slide number as labelled in the prompt. */
  slide: z.number().int().min(1),
  /** 1-3 words naming the topic, used to match the claim to a roadmap node. */
  topic: z.string().min(1).max(60).optional(),
})
export type ExtractedClaim = z.infer<typeof extractedClaimSchema>

export const transcriptExtractionOutputSchema = z.object({
  claims: z.array(extractedClaimSchema).max(30),
})

// ── What we store ────────────────────────────────────────────────────

/** Prompt labels slides 1-based; lc_transcriptions.page_number is 0-based. */
export const SLIDE_LABEL_OFFSET = 1

export const anchoredClaimSchema = z.object({
  kind: z.enum(TRANSCRIPT_CLAIM_KINDS),
  summary: z.string().min(1).max(200),
  quote: z.string().min(1).max(400),
  /** Resolved from deckIndex — the real `lc_decks.id`. */
  deckId: z.string(),
  deckTitle: z.string().nullable(),
  /** 0-based, joins straight back to `lc_transcriptions.page_number`. */
  pageNumber: z.number().int().min(0),
  topic: z.string().min(1).max(60).optional(),
})
export type AnchoredClaim = z.infer<typeof anchoredClaimSchema>

/**
 * Per-slide delivery depth (P24/S23). Deterministic — no model call: reaching a
 * slide and actually teaching it are different things, and transcript volume is
 * a fair proxy for the second. Deliberately kept as raw words alongside the
 * derived minutes so a better speaking-rate estimate later doesn't need a
 * regeneration pass.
 */
export const slideDepthSchema = z.object({
  deckId: z.string(),
  pageNumber: z.number().int().min(0),
  words: z.number().int().min(0),
  minutes: z.number().min(0),
})
export type SlideDepth = z.infer<typeof slideDepthSchema>

export const transcriptInsightsSchema = z.object({
  version: z.literal(1),
  /** True when the session had no usable transcript at all — the surfaces
   *  render nothing rather than an apology. */
  empty: z.boolean(),
  claims: z.array(anchoredClaimSchema),
  depth: z.array(slideDepthSchema),
  /** How many model claims failed quote verification and were dropped. Kept
   *  because it is the only fabrication-rate metric this feature has: a run
   *  that drops most of what the model produced is a prompt regression, and
   *  without this it would look identical to a quiet lecture. */
  droppedClaims: z.number().int().min(0),
  /** Set when the model call itself failed; the depth half still stores. */
  extractionFailed: z.boolean().optional(),
})
export type TranscriptInsights = z.infer<typeof transcriptInsightsSchema>
