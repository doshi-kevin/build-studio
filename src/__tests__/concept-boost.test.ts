// Pure logic of the concept→page boost: matching a query to stored concept
// names, and re-ranking so the concept's pages pin above near-duplicates.
import { describe, it, expect } from 'vitest'
import {
  normalizeForMatch,
  matchConceptPages,
  applyConceptBoost,
  pageKey,
  CONCEPT_PIN_BOOST,
  type ConceptPageRef,
} from '@/lib/pinecone/concept-boost'

const ITEM = 'a1b2c3d4-1111-4111-8111-00000000000a'
const refs: ConceptPageRef[] = [
  { name: 'Scaled Dot-Product Attention', moduleItemId: ITEM, page: 27 },
  { name: 'Scaled Dot-Product Attention', moduleItemId: ITEM, page: 49 },
  { name: 'Multi-Head Attention', moduleItemId: ITEM, page: 48 },
  { name: 'KV-Cache', moduleItemId: ITEM, page: 60 },
]

describe('normalizeForMatch', () => {
  it('lowercases and collapses punctuation/whitespace so name variants align', () => {
    expect(normalizeForMatch('Scaled Dot-Product Attention')).toBe('scaled dot product attention')
    expect(normalizeForMatch('  KV-Cache!! ')).toBe('kv cache')
  })
})

describe('matchConceptPages', () => {
  it('pins all pages of a concept the query names (as a whole phrase)', () => {
    const pinned = matchConceptPages('what is the scaled dot-product attention formula?', refs)
    expect(pinned).toEqual(new Set([pageKey(ITEM, 27), pageKey(ITEM, 49)]))
  })

  it('is case- and punctuation-insensitive', () => {
    const pinned = matchConceptPages('explain MULTI HEAD ATTENTION', refs)
    expect(pinned).toEqual(new Set([pageKey(ITEM, 48)]))
  })

  it('does not fire on a morphological variant (precision trade-off)', () => {
    // "KV caching" is not the phrase "kv cache" → no false pin.
    expect(matchConceptPages('how does KV caching work', refs).size).toBe(0)
  })

  it('returns empty when the query names no concept', () => {
    expect(matchConceptPages('explain alpha-beta pruning', refs).size).toBe(0)
  })
})

describe('applyConceptBoost', () => {
  const row = (moduleItemId: string, pageNumber: number, score: number) => ({
    moduleItemId,
    pageNumber,
    score,
    title: 't',
  })

  it('lifts pinned pages above higher-scoring non-pinned pages, preserving intra-group order', () => {
    const results = [
      row(ITEM, 3, 0.72), // non-pinned, highest cosine
      row(ITEM, 8, 0.65), // non-pinned
      row(ITEM, 27, 0.63), // pinned concept page (was #3)
    ]
    const pinned = new Set([pageKey(ITEM, 27)])
    const out = applyConceptBoost(results, pinned)
    expect(out[0].pageNumber).toBe(27) // pinned page now #1
    expect(out[0].score).toBeCloseTo(0.63 + CONCEPT_PIN_BOOST)
    expect(out.slice(1).map((r) => r.pageNumber)).toEqual([3, 8]) // rest keep order
  })

  it('is a no-op when nothing is pinned', () => {
    const results = [row(ITEM, 3, 0.72), row(ITEM, 8, 0.65)]
    const out = applyConceptBoost(results, new Set())
    expect(out).toBe(results) // same reference — untouched
  })

  it('ranks a pinned-but-unretrieved page (base score 0) above all non-pinned', () => {
    const results = [row(ITEM, 3, 0.72), row(ITEM, 49, 0)] // 49 was added as a direct lookup
    const out = applyConceptBoost(results, new Set([pageKey(ITEM, 49)]))
    expect(out[0].pageNumber).toBe(49)
  })
})
