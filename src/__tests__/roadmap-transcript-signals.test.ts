// Shaping stored transcript extractions into roadmap signals
// (roadmap-engine.md §5.1, slice 4).
//
// The arithmetic is pure in aggregates.ts and the wording is pure in triage.ts,
// so what is left here is exactly the part neither of those can catch:
//
//   - the 0-based → 1-based slide conversion, on BOTH the claims and the depth
//     rows (a stored pageNumber joins lc_transcriptions; a student counts from
//     1, and "slide 8" vs "slide 9" is an annotation that points at the wrong
//     slide while looking perfectly correct);
//   - the two silent skips — an unnamed room has no session node to land on,
//     and a deck never shared as course material has no card to annotate;
//   - the audience the reader is asked for, which is the G14 gate's only wiring.

import { describe, it, expect, vi } from 'vitest'

const mockFetch = vi.fn()
vi.mock('@/lib/live-classroom/insights/read', () => ({
  fetchSectionTranscriptInsights: (...a: unknown[]) => mockFetch(...a),
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

import { getTranscriptSignals } from '@/lib/roadmap/transcript-signals'

const SECTION = 'sec-1'

const claim = (over: Record<string, unknown> = {}) => ({
  kind: 'commitment',
  summary: 'The deadline moved to Friday.',
  quote: 'I am pushing the deadline to Friday',
  deckId: 'deck-1',
  deckTitle: 'Lecture 6',
  pageNumber: 11, // 0-based → slide 12
  ...over,
})

/** A deck taught unevenly enough for depthContrast to have something to say. */
const unevenDepth = (deckId = 'deck-1') => [
  { deckId, pageNumber: 8, words: 1800, minutes: 12 },
  { deckId, pageNumber: 9, words: 700, minutes: 5 },
  { deckId, pageNumber: 10, words: 600, minutes: 4 },
  { deckId, pageNumber: 21, words: 90, minutes: 0.6 },
]

const room = (over: Record<string, unknown> = {}) => ({
  roomId: 'r-1',
  roomName: 'Lecture 6 live',
  endedAt: '2026-03-01T10:30:00Z',
  insights: { version: 1, empty: false, droppedClaims: 0, claims: [], depth: [], ...(over.insights as object ?? {}) },
  ...over,
})

/** Decks table double; `.in()` is filtered so a deck absent from the table (or
 *  carrying no module_item_id) exercises the skip. */
function makeDb(decks: { id: string; module_item_id: string | null }[], error: { message: string } | null = null) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {
    select: () => chain,
    // The deck query re-pins the section (.eq('lc_rooms.section_id', …));
    // the fake passes it through untested — RLS-adjacent scoping is IO.
    eq: () => chain,
    in: (_col: string, ids: string[]) => {
      chain._ids = ids
      return chain
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    then: (res: any, rej: any) =>
      Promise.resolve({
        data: error ? null : decks.filter((d) => (chain._ids as string[]).includes(d.id)),
        error,
      }).then(res, rej),
  }
  return { from: () => chain }
}

/** Reset inside the call (never in beforeEach — see CLAUDE.md Learned Mistakes). */
const rowsAre = (rows: unknown[]) => {
  mockFetch.mockReset()
  mockFetch.mockResolvedValue(rows)
}

describe('getTranscriptSignals (slice 4)', () => {
  it('asks the reader for the caller-declared audience — the only wiring of the G14 gate', async () => {
    rowsAre([])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await getTranscriptSignals(makeDb([]) as any, SECTION, 'student')
    expect(mockFetch).toHaveBeenCalledWith(expect.anything(), SECTION, 'student')
  })

  it('anchors a claim to its session node and counts its slide the way a student does', async () => {
    rowsAre([room({ insights: { version: 1, empty: false, droppedClaims: 0, claims: [claim()], depth: [] } })])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await getTranscriptSignals(makeDb([]) as any, SECTION, 'professor')
    expect(out.spokenClaims).toEqual([
      {
        kind: 'commitment',
        sessionTitle: 'Lecture 6 live',
        summary: 'The deadline moved to Friday.',
        quote: 'I am pushing the deadline to Friday',
        slide: 12, // stored 0-based 11
      },
    ])
  })

  it('drops the claims of an unnamed room but still counts its delivery depth', async () => {
    // The claim has no session node to land on; the deck card still exists.
    rowsAre([
      room({
        roomName: null,
        insights: { version: 1, empty: false, droppedClaims: 0, claims: [claim()], depth: unevenDepth() },
      }),
    ])
    const db = makeDb([{ id: 'deck-1', module_item_id: 'item-9' }])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await getTranscriptSignals(db as any, SECTION, 'professor')
    expect(out.spokenClaims).toEqual([])
    expect(out.deliveryDepth).toEqual([
      // Stored pages 8 and 21 → slides 9 and 22.
      { target: 'item:item-9', deepSlide: 9, deepMinutes: 12, skimmedSlide: 22, skimmedSeconds: 35 },
    ])
  })

  it('says nothing about a deck that was never shared as course material', async () => {
    rowsAre([room({ insights: { version: 1, empty: false, droppedClaims: 0, claims: [], depth: unevenDepth() } })])
    // Present in lc_decks, but promoted to no module item — no card to annotate.
    const db = makeDb([{ id: 'deck-1', module_item_id: null }])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((await getTranscriptSignals(db as any, SECTION, 'professor')).deliveryDepth).toEqual([])
  })

  it('pools a deck’s slides across rows instead of letting the last row win', async () => {
    // Two rows, two slides each: neither reaches the 4-slide floor alone, so a
    // contrast only exists if the accumulation is real.
    const half = (pages: [number, number][]) =>
      pages.map(([pageNumber, minutes]) => ({ deckId: 'deck-1', pageNumber, words: 1, minutes }))
    rowsAre([
      room({ roomId: 'r-1', insights: { version: 1, empty: false, droppedClaims: 0, claims: [], depth: half([[8, 12], [9, 5]]) } }),
      room({ roomId: 'r-2', insights: { version: 1, empty: false, droppedClaims: 0, claims: [], depth: half([[10, 4], [21, 0.6]]) } }),
    ])
    const db = makeDb([{ id: 'deck-1', module_item_id: 'item-9' }])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await getTranscriptSignals(db as any, SECTION, 'professor')
    expect(out.deliveryDepth).toHaveLength(1)
    expect(out.deliveryDepth[0]).toMatchObject({ deepSlide: 9, skimmedSlide: 22 })
  })

  it('still returns the spoken claims when deck resolution fails', async () => {
    rowsAre([room({ insights: { version: 1, empty: false, droppedClaims: 0, claims: [claim()], depth: unevenDepth() } })])
    const db = makeDb([{ id: 'deck-1', module_item_id: 'item-9' }], { message: 'boom' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await getTranscriptSignals(db as any, SECTION, 'professor')
    expect(out.spokenClaims).toHaveLength(1)
    expect(out.deliveryDepth).toEqual([])
  })

  it('degrades to empty when the read itself fails, like every other signal producer', async () => {
    mockFetch.mockReset()
    mockFetch.mockRejectedValue(new Error('read failed'))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await getTranscriptSignals(makeDb([]) as any, SECTION, 'student')).toEqual({
      spokenClaims: [],
      deliveryDepth: [],
    })
  })
})
