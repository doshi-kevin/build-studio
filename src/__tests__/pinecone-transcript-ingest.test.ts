// Tests for the transcript ingestion primitives (N1): the pure per-slide
// chunker, the deterministic id grammar and its two erasure prefixes, and the
// strict metadata whitelist for the second content class. The IO shell
// (runTranscriptEmbedding) is best-effort glue over these — its wiring is
// exercised live via the end-of-class flow.

import { describe, expect, it } from 'vitest'
import { chunkTranscriptDecks } from '@/lib/pinecone/transcript-ingest'
import { buildTranscriptVectorId, transcriptVectorPrefix } from '@/lib/pinecone/ids'
import {
  transcriptSlideMetadataSchema,
  materialPageMetadataSchema,
  vectorMetadataSchema,
} from '@/lib/pinecone/metadata'

const ROOM = 'a1b2c3d4-1111-4111-8111-00000000000c'
const DECK = 'a1b2c3d4-1111-4111-8111-00000000000d'

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ')

describe('chunkTranscriptDecks', () => {
  it('keeps one chunk per spoken slide and skips asides below the word floor', () => {
    const out = chunkTranscriptDecks('Lecture 6 live', [
      {
        id: DECK,
        title: 'Transformers',
        position: 1,
        transcriptions: [
          { page_number: 0, text: words(30) },
          { page_number: 3, text: 'okay next slide' }, // 3 words — an aside, not teaching
          { page_number: 7, text: words(20) }, // exactly at the floor — kept
        ],
      },
    ])
    expect(out.map((c) => c.pageNumber)).toEqual([0, 7])
  })

  it('labels the breadcrumb with the 1-based slide a student counts, marked spoken', () => {
    const [chunk] = chunkTranscriptDecks('Lecture 6 live', [
      { id: DECK, title: 'Transformers', position: 1, transcriptions: [{ page_number: 11, text: words(25) }] },
    ])
    expect(chunk.breadcrumb).toBe('Lecture 6 live › Transformers › slide 12 (spoken)')
    expect(chunk.pageNumber).toBe(11) // the metadata keeps the raw 0-based join key
  })

  it('falls back to the deck position when a deck is untitled', () => {
    const [chunk] = chunkTranscriptDecks('Live class', [
      { id: DECK, title: '  ', position: 2, transcriptions: [{ page_number: 0, text: words(25) }] },
    ])
    expect(chunk.breadcrumb).toContain('› Deck 2 ›')
  })

  it('caps a marathon slide at the embed limit without touching shorter ones', () => {
    const long = 'x'.repeat(9_000) + ' ' + words(30)
    const [chunk] = chunkTranscriptDecks('Live class', [
      { id: DECK, title: 'T', position: 1, transcriptions: [{ page_number: 0, text: long }] },
    ])
    expect(chunk.text.length).toBe(8_000)
  })
})

describe('transcript vector ids', () => {
  it('both erasure grains are true prefixes of the id', () => {
    const id = buildTranscriptVectorId(ROOM, DECK, 11)
    expect(id).toBe(`${ROOM}#t_${DECK}#s0011`)
    expect(id.startsWith(transcriptVectorPrefix(ROOM))).toBe(true) // whole-room
    expect(id.startsWith(transcriptVectorPrefix(ROOM, DECK))).toBe(true) // one deck
  })

  it('zero-pads so slide 1 can never prefix-match slide 10', () => {
    const one = buildTranscriptVectorId(ROOM, DECK, 1)
    const ten = buildTranscriptVectorId(ROOM, DECK, 10)
    expect(ten.startsWith(one)).toBe(false)
  })

  it('the room prefix can never collide with a material page prefix', () => {
    // Material ids are {module_item_id}#p…; transcript ids are {room_id}#t_…
    // — even a room and an item sharing a uuid diverge at the marker.
    expect(transcriptVectorPrefix(ROOM)).toBe(`${ROOM}#t_`)
    expect(transcriptVectorPrefix(ROOM)).not.toContain('#p')
  })

  it('rejects fence-breaking ids', () => {
    expect(() => buildTranscriptVectorId('room#evil', DECK, 1)).toThrow()
    expect(() => buildTranscriptVectorId(ROOM, 'deck#evil', 1)).toThrow()
    expect(() => buildTranscriptVectorId(ROOM, DECK, -1)).toThrow()
  })
})

describe('transcript metadata whitelist', () => {
  const valid = {
    institution_id: 'a1b2c3d4-1111-4111-8111-000000000002',
    section_id: 'a1b2c3d4-1111-4111-8111-000000000003',
    room_id: ROOM,
    deck_id: DECK,
    page_number: 0,
    content_class: 'lecture_transcript',
    schema_version: 1,
    embedding_model: 'gemini-embedding-2',
    chunker_version: 'slide-v1',
  }

  it('accepts a 0-based page and rejects any extra key (no text can sneak in)', () => {
    expect(() => transcriptSlideMetadataSchema.parse(valid)).not.toThrow()
    expect(() => transcriptSlideMetadataSchema.parse({ ...valid, text: 'spoken words' })).toThrow()
  })

  it('each class parses ONLY under its own schema; the union discriminates both', () => {
    expect(() => materialPageMetadataSchema.parse(valid)).toThrow()
    const parsed = vectorMetadataSchema.parse(valid)
    expect(parsed.content_class).toBe('lecture_transcript')
  })
})
