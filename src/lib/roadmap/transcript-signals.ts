/**
 * transcript-signals — turns the stored transcript extraction
 * (`lc_transcript_insights`, roadmap-engine.md §5.1) into triage-engine
 * signals: quote-anchored spoken claims (P14/P16/P22/P23 and their student
 * twins S20–S22) and the per-deck delivery-depth contrast (P24/S23).
 *
 * IO only — the audience gate lives in the shared reader
 * (`@/lib/live-classroom/insights/read`), the contrast arithmetic is pure in
 * `aggregates.ts`, and the wording lives in `triage.ts`. Callers pass an admin
 * client they obtained behind their own ownership/enrollment check; degrades to
 * empty on any failure, like every other signal producer.
 */

import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import {
  fetchSectionTranscriptInsights,
  type TranscriptAudience,
} from '@/lib/live-classroom/insights/read'
import { depthContrast, type SlideMinutes } from './aggregates'
import type { SpokenClaim, DeliveryDepthSignal } from './triage'

export interface TranscriptSignals {
  spokenClaims: SpokenClaim[]
  deliveryDepth: DeliveryDepthSignal[]
}

const EMPTY: TranscriptSignals = { spokenClaims: [], deliveryDepth: [] }

export async function getTranscriptSignals(
  adminDb: SupabaseClient,
  sectionId: string,
  audience: TranscriptAudience,
): Promise<TranscriptSignals> {
  try {
    const rows = await fetchSectionTranscriptInsights(adminDb, sectionId, audience)
    if (!rows.length) return EMPTY

    const spokenClaims: SpokenClaim[] = []
    // Depth rows per deck, pooled across rooms (a deck belongs to one room, but
    // keying by deck is what the module-item resolution below needs anyway).
    const slidesByDeck = new Map<string, SlideMinutes[]>()
    for (const row of rows) {
      // An unnamed room has no session node to land on; the locator would drop
      // the candidate anyway, so drop the claim here and say nothing.
      if (row.roomName) {
        for (const c of row.insights.claims) {
          spokenClaims.push({
            kind: c.kind,
            sessionTitle: row.roomName,
            summary: c.summary,
            quote: c.quote,
            // Stored 0-based (joins lc_transcriptions); slides read 1-based.
            slide: c.pageNumber + 1,
          })
        }
      }
      for (const d of row.insights.depth) {
        let slides = slidesByDeck.get(d.deckId)
        if (!slides) slidesByDeck.set(d.deckId, (slides = []))
        slides.push({ slide: d.pageNumber + 1, minutes: d.minutes })
      }
    }

    // Resolve each deck to the module item its card renders as. A deck that was
    // never shared as course material has no node to annotate and is skipped.
    const deliveryDepth: DeliveryDepthSignal[] = []
    if (slidesByDeck.size) {
      // Deck ids come from the stored JSON blob, which this pipeline treats as
      // untrusted — so the resolution joins back through the deck's room and
      // re-pins the section rather than taking the blob's word for it.
      const { data: decks, error } = await adminDb
        .from('lc_decks')
        .select('id, module_item_id, lc_rooms!inner(section_id)')
        .in('id', [...slidesByDeck.keys()])
        .eq('lc_rooms.section_id', sectionId)
      if (error) {
        logger.warn('getTranscriptSignals: deck resolution failed', {
          source: 'transcriptSignals.getTranscriptSignals',
          sectionId,
          message: error.message,
        })
      }
      for (const deck of (decks ?? []) as { id: string; module_item_id: string | null }[]) {
        if (!deck.module_item_id) continue
        const contrast = depthContrast(slidesByDeck.get(deck.id) ?? [])
        if (contrast) deliveryDepth.push({ target: `item:${deck.module_item_id}`, ...contrast })
      }
    }

    return { spokenClaims, deliveryDepth }
  } catch (error) {
    logger.error('getTranscriptSignals', error, { sectionId })
    return EMPTY
  }
}
