// Transcript ingestion (N1, athena-students.md §5): when a live class ends,
// each (deck, slide)'s spoken text becomes one `lecture_transcript` vector in
// the SAME index + namespace as the material pages, so "what did he say about
// X" competes with "what does the slide say about X" on score.
//
// Rides `generateClassInsights` (the end-of-class job) beside the transcript
// extraction pass — same posture: best-effort, never throws, a failed embed
// must not cost the student their flashcards. Postgres (`lc_transcriptions`)
// stays the source of truth: metadata carries only ids + locators, the spoken
// text hydrates from Postgres at query time, which is also where visibility is
// enforced (room ended + "Catch me up" on) — a toggle flip is effective
// immediately in BOTH directions without touching a vector.
//
// Deterministic ids ({room}#t_{deck}#s{page}) make re-runs idempotent; the
// erasure twin is `deleteTranscriptVectors` (data.ts), wired where transcript
// source rows are erased.

import 'server-only'

import { logger } from '@/lib/logger'
import { recordAiUsage } from '@/lib/ai/usage'
import {
  CONTENT_CLASS_LECTURE_TRANSCRIPT,
  EMBEDDING_MODEL,
  METADATA_SCHEMA_VERSION,
  TRANSCRIPT_CHUNKER_VERSION,
  TRANSCRIPT_MIN_WORDS,
} from './config'
import { embedMaterialText } from './embed'
import { buildTranscriptVectorId } from './ids'
import { upsertTranscriptVectors, type TenantScope, type TranscriptSlideVector } from './data'

/** Matches embed.ts's MAX_TEXT_CHARS — a slide's spoken text past this is cut
 *  for the embedding only; hydration returns the full row. */
const MAX_SLIDE_CHARS = 8_000

/** Hard ceiling on one session's embeddings. A marathon multi-deck class must
 *  not turn into hundreds of serial model calls on the end-of-class path — the
 *  study pack is what the student is waiting for. Well above a real session
 *  (a long lecture is ~40 spoken slides). */
const MAX_CHUNKS = 120

/** Embeds run a few at a time: serial made a long session's ingest as slow as
 *  the sum of every call, and unbounded parallelism would spike the embedding
 *  API. */
const EMBED_CONCURRENCY = 4

export interface TranscriptDeckInput {
  id: string
  title: string | null
  position: number
  /** Per-slide spoken rows, 0-based page numbers (lc_transcriptions shape). */
  transcriptions: Array<{ page_number: number; text: string }>
}

export interface TranscriptSlideChunk {
  deckId: string
  pageNumber: number
  breadcrumb: string
  text: string
}

const wordCount = (text: string): number => text.split(/\s+/).filter(Boolean).length

/**
 * Pure chunker: one chunk per (deck, slide) with enough speech to mean
 * something. Exported for tests; the ingest below is the IO shell around it.
 */
export function chunkTranscriptDecks(
  roomName: string,
  decks: TranscriptDeckInput[],
): TranscriptSlideChunk[] {
  const chunks: TranscriptSlideChunk[] = []
  for (const deck of decks) {
    const label = deck.title?.trim() || `Deck ${deck.position}`
    for (const row of deck.transcriptions) {
      const text = row.text.trim()
      if (wordCount(text) < TRANSCRIPT_MIN_WORDS) continue
      chunks.push({
        deckId: deck.id,
        pageNumber: row.page_number,
        // Slide label is 1-based — the number a student sees and cites.
        breadcrumb: `${roomName} › ${label} › slide ${row.page_number + 1} (spoken)`,
        text: text.slice(0, MAX_SLIDE_CHARS),
      })
    }
  }
  return chunks
}

/**
 * Embed and upsert one ended room's transcript. Best-effort by design —
 * logs loud and returns instead of throwing.
 */
export async function runTranscriptEmbedding(input: {
  scope: TenantScope
  roomId: string
  roomName: string
  decks: TranscriptDeckInput[]
  /** For the cost ledger row; the end-of-class job has no acting user. */
  createdBy?: string | null
}): Promise<void> {
  const { scope, roomId } = input
  try {
    const all = chunkTranscriptDecks(input.roomName, input.decks)
    if (all.length === 0) return // quiz-only / silent session: nothing to index
    const chunks = all.slice(0, MAX_CHUNKS)
    if (all.length > chunks.length) {
      // Never truncate silently — "indexed the class" would be a lie about the
      // tail of it.
      logger.warn('runTranscriptEmbedding: session over the chunk cap, tail not indexed', {
        source: 'pinecone.runTranscriptEmbedding',
        roomId,
        total: all.length,
        indexed: chunks.length,
      })
    }

    const vectors: TranscriptSlideVector[] = []
    let billedTokens = 0
    let tokensEstimated = false
    for (let i = 0; i < chunks.length; i += EMBED_CONCURRENCY) {
      const batch = chunks.slice(i, i + EMBED_CONCURRENCY)
      const embedded = await Promise.all(
        batch.map((chunk) => embedMaterialText({ breadcrumb: chunk.breadcrumb, text: chunk.text })),
      )
      embedded.forEach((result, j) => {
        const chunk = batch[j]
        billedTokens += result.tokens
        tokensEstimated = tokensEstimated || result.estimated
        vectors.push({
          id: buildTranscriptVectorId(roomId, chunk.deckId, chunk.pageNumber),
          values: result.values,
          metadata: {
            institution_id: scope.institutionId,
            section_id: scope.sectionId,
            room_id: roomId,
            deck_id: chunk.deckId,
            page_number: chunk.pageNumber,
            content_class: CONTENT_CLASS_LECTURE_TRANSCRIPT,
            schema_version: METADATA_SCHEMA_VERSION,
            embedding_model: EMBEDDING_MODEL,
            chunker_version: TRANSCRIPT_CHUNKER_VERSION,
          },
        })
      })
    }

    await upsertTranscriptVectors(scope, vectors)

    await recordAiUsage({
      feature: 'transcript_embedding',
      model: EMBEDDING_MODEL,
      institutionId: scope.institutionId,
      sectionId: scope.sectionId,
      userId: input.createdBy ?? undefined,
      usage: { inputTokens: billedTokens },
      metadata: {
        roomId,
        slidesEmbedded: vectors.length,
        ...(tokensEstimated ? { estimated_tokens: true } : {}),
      },
    })

    logger.info('runTranscriptEmbedding: indexed', {
      source: 'pinecone.runTranscriptEmbedding',
      roomId,
      slides: vectors.length,
    })
  } catch (error) {
    // Loud, never fatal — the study pack and the professor report must land
    // whether or not the index write did. Re-ending the room re-runs this
    // idempotently (deterministic ids).
    logger.error('runTranscriptEmbedding: failed', error, { roomId })
  }
}
