// The verification half of the transcript extraction pass
// (docs/designs/roadmap-mastery/roadmap-engine.md §5.1).
//
// These tests exist for one reason: the feature tells a student "your professor
// said the deadline moved to Friday". If that is ever produced from a sentence
// the professor never said, the feature is worse than not shipping. So the
// cases below are mostly about what must be THROWN AWAY, not what is kept.

import { describe, it, expect } from 'vitest'
import {
  buildExtractionContext,
  computeDeliveryDepth,
  verifyAndAnchorClaims,
  MIN_QUOTE_WORDS,
  SPEAKING_WORDS_PER_MINUTE,
  type ExtractionDeck,
} from '@/lib/live-classroom/insights/transcript-extraction'
import type { ExtractedClaim } from '@/lib/validations/lc-transcript-insights'

const deck = (over: Partial<ExtractionDeck> = {}): ExtractionDeck => ({
  id: 'deck-1',
  title: 'Lecture 6 — Transformers',
  position: 1,
  transcriptions: [
    { page_number: 0, text: 'Welcome back everyone, today we are looking at attention.' },
    {
      page_number: 1,
      text: "I'm pushing the assignment two deadline to Friday, so you have the weekend.",
    },
    { page_number: 2, text: 'The key idea here is that attention is a weighted average.' },
  ],
  ...over,
})

const claim = (over: Partial<ExtractedClaim> = {}): ExtractedClaim => ({
  kind: 'commitment',
  summary: 'Assignment 2 was moved to Friday.',
  quote: "I'm pushing the assignment two deadline to Friday",
  deckIndex: 1,
  slide: 2, // 1-based label for page_number 1
  ...over,
})

describe('verifyAndAnchorClaims', () => {
  it('keeps a real quote and resolves its label to the deck id and 0-based page', () => {
    const { claims, dropped } = verifyAndAnchorClaims([claim()], [deck()])

    expect(dropped).toBe(0)
    expect(claims).toHaveLength(1)
    expect(claims[0]).toMatchObject({ deckId: 'deck-1', pageNumber: 1, kind: 'commitment' })
  })

  it('drops a fabricated commitment the professor never said', () => {
    const invented = claim({
      summary: 'The final exam is cancelled.',
      quote: 'there will be no final exam this term',
    })

    const { claims, dropped } = verifyAndAnchorClaims([invented], [deck()])

    expect(claims).toEqual([])
    expect(dropped).toBe(1)
  })

  it('re-anchors a real quote the model attributed to the wrong slide', () => {
    // Same words, but the model said slide 1 instead of slide 2. The statement
    // is real, so it belongs on the map — at the slide that actually has it.
    const { claims } = verifyAndAnchorClaims([claim({ slide: 1 })], [deck()])

    expect(claims).toHaveLength(1)
    expect(claims[0].pageNumber).toBe(1)
  })

  it('drops a quote that appears on more than one slide rather than guessing', () => {
    const repeated = deck({
      transcriptions: [
        { page_number: 0, text: 'this will be on the exam, remember that' },
        { page_number: 1, text: 'and again, this will be on the exam' },
      ],
    })
    const ambiguous = claim({
      kind: 'emphasis',
      quote: 'this will be on the exam',
      slide: 5, // not a real slide, so the fallback search decides
    })

    const { claims, dropped } = verifyAndAnchorClaims([ambiguous], [repeated])

    expect(claims).toEqual([])
    expect(dropped).toBe(1)
  })

  it('matches through punctuation, casing and whitespace differences', () => {
    // ASR text and the model's copy of it differ this way constantly; dropping
    // these would throw away true claims.
    const messy = claim({ quote: "I'M  PUSHING the Assignment Two deadline, to Friday!" })

    const { claims } = verifyAndAnchorClaims([messy], [deck()])

    expect(claims).toHaveLength(1)
  })

  it('drops a quote too short to prove anything', () => {
    const fragment = claim({ quote: 'to Friday' })
    expect(fragment.quote.split(' ').length).toBeLessThan(MIN_QUOTE_WORDS)

    const { claims, dropped } = verifyAndAnchorClaims([fragment], [deck()])

    expect(claims).toEqual([])
    expect(dropped).toBe(1)
  })

  it('drops a claim pointing at a deck that was never presented', () => {
    const { claims, dropped } = verifyAndAnchorClaims([claim({ deckIndex: 4 })], [deck()])

    expect(claims).toEqual([])
    expect(dropped).toBe(1)
  })

  it('keeps one claim per kind and quote, but lets two kinds share a sentence', () => {
    const sameKind = [claim(), claim({ summary: 'Deadline moved.' })]
    const twoKinds = [claim(), claim({ kind: 'emphasis' })]

    expect(verifyAndAnchorClaims(sameKind, [deck()]).claims).toHaveLength(1)
    expect(verifyAndAnchorClaims(twoKinds, [deck()]).claims).toHaveLength(2)
  })
})

describe('computeDeliveryDepth', () => {
  it('turns spoken volume per slide into words and minutes, skipping silent slides', () => {
    const words = Array.from({ length: SPEAKING_WORDS_PER_MINUTE * 2 }, () => 'attention').join(' ')
    const d = deck({
      transcriptions: [
        { page_number: 0, text: words },
        { page_number: 1, text: '   ' },
      ],
    })

    const depth = computeDeliveryDepth([d])

    expect(depth).toHaveLength(1)
    expect(depth[0]).toMatchObject({ deckId: 'deck-1', pageNumber: 0, words: 260, minutes: 2 })
  })
})

describe('buildExtractionContext', () => {
  it('labels decks 1-based in presentation order and separates slide text from speech', () => {
    const second = deck({ id: 'deck-2', title: 'Lecture 7', position: 2, transcriptions: [
      { page_number: 0, text: 'moving on to decoding' },
    ] })
    const first = deck({ pages: [{ pageNumber: 1, text: 'Attention Is All You Need' }] })

    const { text, deckOrder } = buildExtractionContext([second, first], 10_000)

    expect(deckOrder.map((d) => d.id)).toEqual(['deck-1', 'deck-2'])
    expect(text).toContain('Deck 1, Slide 1 — ON THE SLIDE')
    expect(text).toContain('Deck 1, Slide 1 — SPOKEN')
    expect(text).toContain('Deck 2, Slide 1 — SPOKEN')
  })

  it('truncates to the caller budget', () => {
    const { text } = buildExtractionContext([deck()], 50)
    expect(text.length).toBeLessThan(80)
    expect(text).toContain('[...truncated]')
  })
})
