// Transcript extraction — the IO half (roadmap-engine.md §5.1).
//
// Runs once when a live class ends, as a fourth best-effort call inside the
// insights orchestrator's Step B, on context that is already assembled. It
// writes ONE row: `lc_transcript_insights`, the read model the roadmap turns
// into annotations (P14/P16/P22-P24, S20-S23) and Athena answers from
// (athena-students.md U21-U24).
//
// Never throws. A failed extraction must not cost the student their flashcards.
//
// Security: server-only, admin client, called only from the internal
// end-of-class route which is gated by a shared secret. Nothing here trusts a
// user session; the room is already verified by the caller.

import 'server-only'

import { logger } from '@/lib/logger'
import { LIVE_QUIZ_MAX_CONTEXT_CHARS } from '@/lib/ai/config'
import { extractTranscriptInsights } from '@/lib/ai/llm-client'
import type { AiAttribution } from '@/lib/ai/usage'
import {
  transcriptInsightsSchema,
  type TranscriptInsights,
} from '@/lib/validations/lc-transcript-insights'
import {
  buildExtractionContext,
  computeDeliveryDepth,
  verifyAndAnchorClaims,
  type ExtractionDeck,
} from './transcript-extraction'

/**
 * Extract and store one room's transcript insights.
 *
 * The two halves fail independently on purpose: delivery depth is arithmetic
 * over rows we already have, so it is stored even when the model call dies —
 * P24/S23 keep working through an outage that kills the quote-based signals.
 */
export async function runTranscriptExtraction(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminDb: any,
  roomId: string,
  decks: ExtractionDeck[],
  attribution: AiAttribution,
): Promise<void> {
  try {
    const depth = computeDeliveryDepth(decks)

    // No spoken words anywhere (a quiz-only or slides-only session): there is
    // nothing to extract and nothing to store. An absent row means "nothing was
    // said", which is exactly what every consumer should render.
    if (depth.length === 0) return

    const { text, deckOrder } = buildExtractionContext(decks, LIVE_QUIZ_MAX_CONTEXT_CHARS)
    const result = await extractTranscriptInsights({ context: text }, attribution)

    // Verify every quote against the real transcript. This is not belt-and-
    // braces on top of the Zod schema — the schema proves shape, this proves
    // the professor actually said it, and only one of those matters here.
    const { claims, dropped } = verifyAndAnchorClaims(result.claims, deckOrder)

    const insights: TranscriptInsights = transcriptInsightsSchema.parse({
      version: 1,
      empty: claims.length === 0 && depth.length === 0,
      claims,
      depth,
      droppedClaims: dropped,
      ...(result.error ? { extractionFailed: true } : {}),
    })

    // A run that drops most of what the model produced is a prompt or model
    // regression, and it is invisible from the stored row alone (dropped claims
    // leave no trace in `claims`). Surface it where it can be alerted on.
    if (dropped > 0) {
      logger.info('runTranscriptExtraction: claims dropped in verification', {
        source: 'transcriptInsights.runTranscriptExtraction',
        roomId,
        kept: claims.length,
        dropped,
      })
    }

    const { error } = await adminDb.from('lc_transcript_insights').upsert(
      {
        room_id: roomId,
        insights,
        status: result.error ? 'failed' : 'ready',
        generated_at: new Date().toISOString(),
      },
      { onConflict: 'room_id' },
    )
    if (error) {
      logger.error('runTranscriptExtraction: store failed', error, { roomId })
    }
  } catch (error) {
    // Best-effort by design: the student study pack and the professor report
    // must survive an extraction failure untouched.
    logger.error('runTranscriptExtraction: unexpected error', error, { roomId })
  }
}
