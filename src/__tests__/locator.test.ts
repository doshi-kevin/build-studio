// Pure locator resolution: parse "lecture 6 slide 27" / "word2vec page 3" style
// references and map to (moduleItemId, page), refusing to guess when ambiguous.
import { describe, it, expect } from 'vitest'
import { resolveLocator, type LocatorItem } from '@/lib/pinecone/locator'

const L6 = 'l6-pdf'
const L6DECK = 'l6-deck'
const W2V = 'w2v'
const L1 = 'l1'
const items: LocatorItem[] = [
  { moduleItemId: L1, title: 'Lecture 1: Introduction to NLP' },
  { moduleItemId: L6, title: 'Lecture 6: Transformers' },
  { moduleItemId: L6DECK, title: 'Lecture 6: Transformers — Slides (PPTX)' },
  { moduleItemId: W2V, title: 'Notes: word2vec' },
]

describe('resolveLocator', () => {
  it('resolves "lecture 6 slide 27" to the primary lecture PDF, page 27', () => {
    // "slide" (singular) is just a page synonym → primary material, not the deck.
    expect(resolveLocator('lecture 6 slide 27', items)).toEqual({ moduleItemId: L6, page: 27 })
  })

  it('routes an explicit deck reference to the slide deck', () => {
    expect(resolveLocator('lecture 6 slides page 3', items)).toEqual({ moduleItemId: L6DECK, page: 3 })
  })

  it('resolves a distinctive keyword + page ("word2vec page 3")', () => {
    expect(resolveLocator('remind me what word2vec page 3 said', items)).toEqual({ moduleItemId: W2V, page: 3 })
  })

  it('handles "page 40 of the transformers notes" → primary transformers material', () => {
    expect(resolveLocator('page 40 of the transformers notes', items)).toEqual({ moduleItemId: L6, page: 40 })
  })

  it('anchors the lecture number (does not confuse "Lecture 1" inside another title)', () => {
    const withReading = [...items, { moduleItemId: 'ext', title: 'Stanford CS224N — Lecture 1: Intro & Word Vectors' }]
    // Only the item whose title STARTS with "lecture 1" resolves.
    expect(resolveLocator('lecture 1 page 5', withReading)).toEqual({ moduleItemId: L1, page: 5 })
  })

  it('returns null when there is no page/slide number (not a locator)', () => {
    expect(resolveLocator('explain lecture 6 transformers', items)).toBeNull()
    expect(resolveLocator('what are the 3 types of attention', items)).toBeNull()
  })

  it('returns null when the material is ambiguous (refuses to guess)', () => {
    const twoNotes: LocatorItem[] = [
      { moduleItemId: 'a', title: 'Notes: Attention Basics' },
      { moduleItemId: 'b', title: 'Reading: Attention Deep Dive' },
    ]
    // "attention" matches both non-deck items equally → ambiguous → null.
    expect(resolveLocator('attention page 2', twoNotes)).toBeNull()
  })
})
