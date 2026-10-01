// Transcript extraction — the pure half (roadmap-engine.md §5.1).
//
// Three pure functions, no IO, no model: build the labelled context the model
// reads, verify what it hands back against the real transcript, and compute the
// deterministic delivery-depth numbers that need no model at all.
//
// The verification step is the point of this file. An LLM asked "what did the
// professor promise?" will happily produce a fluent, plausible, entirely
// invented extension. So a claim is only kept if its `quote` actually occurs in
// the transcript of the slide it was attributed to — anything else is dropped.
// That turns "trust the model" into "trust the transcript", which is the only
// version of this feature worth shipping.

import {
  SLIDE_LABEL_OFFSET,
  type AnchoredClaim,
  type ExtractedClaim,
  type SlideDepth,
} from '@/lib/validations/lc-transcript-insights'

/** One deck of a session, with its per-slide spoken transcript. Mirrors
 *  `SessionReportInput['decks']` plus the deck's extracted slide text. */
export interface ExtractionDeck {
  id: string
  title: string | null
  position: number
  transcriptions: Array<{ page_number: number; text: string }>
  /** Slide text from `lc_decks.extraction`, 1-based `pageNumber` (as the
   *  extraction stores it). Optional — off-deck detection degrades to nothing
   *  without it rather than reporting everything as off-deck. */
  pages?: Array<{ pageNumber: number; text: string }>
}

/**
 * A quote shorter than this proves nothing — "the exam" occurs in almost any
 * lecture, so a 2-word quote would let a fabricated claim pass verification by
 * accident. Claims are dropped below it rather than trusted.
 */
export const MIN_QUOTE_WORDS = 4

/** Lecturing pace used to turn transcript volume into minutes. Deliberately a
 *  named constant: 130 wpm is a conservative mid-range for classroom speech,
 *  and the raw word count is stored alongside so a better estimate later needs
 *  no regeneration. */
export const SPEAKING_WORDS_PER_MINUTE = 130

/** Below this a slide was passed over, not taught — the "skimmed" reading. */
export const SKIMMED_SLIDE_MAX_WORDS = 40

/**
 * Normalize for quote matching. ASR output and the model's copy of it differ in
 * punctuation, casing and whitespace far more often than in words, so matching
 * on raw text would drop true claims; matching on words alone would not.
 */
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function wordCount(text: string): number {
  const normalized = normalizeForMatch(text)
  return normalized ? normalized.split(' ').length : 0
}

/**
 * Render the labelled context the model reads. Decks and slides are addressed
 * by 1-based position, never by uuid — a model asked to echo a uuid invents
 * one, and an out-of-range index is trivially dropped, while a hallucinated
 * uuid would have to be looked up to be caught.
 *
 * Both the slide text and the spoken words go in, labelled apart: the model
 * needs the contrast to answer "what was taught that the slides don't cover".
 */
export function buildExtractionContext(
  decks: ExtractionDeck[],
  maxChars: number,
): { text: string; deckOrder: ExtractionDeck[] } {
  const deckOrder = [...decks].sort((a, b) => a.position - b.position)
  const parts: string[] = []

  deckOrder.forEach((deck, i) => {
    const label = deck.title?.trim() || `Deck ${deck.position}`
    parts.push(`\n===== Deck ${i + 1}: ${label} =====`)
    const rows = [...deck.transcriptions].sort((a, b) => a.page_number - b.page_number)
    for (const row of rows) {
      if (!row.text.trim()) continue
      const slide = row.page_number + SLIDE_LABEL_OFFSET
      const page = deck.pages?.find((p) => p.pageNumber === slide)
      if (page?.text.trim()) {
        parts.push(`\n--- Deck ${i + 1}, Slide ${slide} — ON THE SLIDE ---\n${page.text.trim()}`)
      }
      parts.push(`--- Deck ${i + 1}, Slide ${slide} — SPOKEN ---\n${row.text.trim()}`)
    }
  })

  let text = parts.join('\n')
  if (text.length > maxChars) text = text.slice(0, maxChars) + '\n[...truncated]'
  return { text, deckOrder }
}

/**
 * Keep only the claims whose quote really appears in the transcript, and
 * resolve their (deckIndex, slide) label back to (deckId, pageNumber).
 *
 * A claim attributed to the wrong slide but quoting real speech is re-anchored
 * to where it was actually said — but only when exactly one slide in that deck
 * contains it, so re-anchoring can never invent a location. Everything else is
 * dropped, and the drop count is returned because it is this feature's only
 * fabrication-rate metric.
 */
export function verifyAndAnchorClaims(
  claims: ExtractedClaim[],
  deckOrder: ExtractionDeck[],
): { claims: AnchoredClaim[]; dropped: number } {
  const kept: AnchoredClaim[] = []
  const seen = new Set<string>()
  let dropped = 0

  for (const claim of claims) {
    const deck = deckOrder[claim.deckIndex - 1]
    if (!deck) {
      dropped++
      continue
    }
    if (wordCount(claim.quote) < MIN_QUOTE_WORDS) {
      dropped++
      continue
    }

    const needle = normalizeForMatch(claim.quote)
    const claimedPage = claim.slide - SLIDE_LABEL_OFFSET
    const rowsWithQuote = deck.transcriptions.filter((r) =>
      normalizeForMatch(r.text).includes(needle),
    )

    // Prefer the slide the model named; fall back to the unique slide that
    // actually contains the words. Two matches means the quote is ambiguous
    // boilerplate, not a locatable statement.
    const anchor =
      rowsWithQuote.find((r) => r.page_number === claimedPage) ??
      (rowsWithQuote.length === 1 ? rowsWithQuote[0] : undefined)
    if (!anchor) {
      dropped++
      continue
    }

    // One claim per (kind, quote): the model tends to report the same sentence
    // as both an emphasis and a commitment.
    const dedupKey = `${claim.kind}#${needle}`
    if (seen.has(dedupKey)) continue
    seen.add(dedupKey)

    kept.push({
      kind: claim.kind,
      summary: claim.summary,
      quote: claim.quote,
      deckId: deck.id,
      deckTitle: deck.title,
      pageNumber: anchor.page_number,
      ...(claim.topic ? { topic: claim.topic } : {}),
    })
  }

  return { claims: kept, dropped }
}

/**
 * Per-slide delivery depth (P24/S23) — words spoken per slide and the minutes
 * they imply. No model call: this is arithmetic, and it answers the question
 * slide position cannot ("the class reached slide 20" says nothing about
 * whether slide 9 got twelve minutes or forty seconds).
 */
export function computeDeliveryDepth(decks: ExtractionDeck[]): SlideDepth[] {
  const depth: SlideDepth[] = []
  for (const deck of decks) {
    for (const row of deck.transcriptions) {
      const words = wordCount(row.text)
      if (words === 0) continue
      depth.push({
        deckId: deck.id,
        pageNumber: row.page_number,
        words,
        minutes: Math.round((words / SPEAKING_WORDS_PER_MINUTE) * 10) / 10,
      })
    }
  }
  return depth.sort((a, b) => a.pageNumber - b.pageNumber)
}
