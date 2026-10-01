// @vitest-environment node
//
// roadmap-rail-v1's WRITE side. `selectRailPages` (rail-page-selection.test.ts)
// decides which pages a topic gets; this file covers what happens to them
// afterwards — the Pinecone query that is scoped to one material, and the
// merge back onto `module_items.content`.
//
// That merge is the part with no other guard. `content` is a shared JSONB blob:
// the extraction worker writes `extraction`, `topics`, `concepts`, and `summary`
// into it moments earlier in the same job, the modules UI writes `filePath` and
// `images`. storeTopicPageAnchors re-reads and merges for exactly that reason —
// and if that merge ever degraded to a blind write, the failure is a professor's
// uploaded lecture losing its extracted text, reported by nothing. Every case
// here therefore asserts on the CONTENT of the update payload, not just that an
// update happened.
//
// No network: embedQuery and queryMaterialPageVectors are stubbed, which is also
// the only honest way to test this — the real ones need a Pinecone index and an
// API key.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

const embedQuery = vi.fn()
const queryMaterialPageVectors = vi.fn()
vi.mock('@/lib/pinecone/embed', () => ({
  embedQuery: (...a: unknown[]) => embedQuery(...a),
}))
vi.mock('@/lib/pinecone/data', () => ({
  queryMaterialPageVectors: (...a: unknown[]) => queryMaterialPageVectors(...a),
}))

import { storeTopicPageAnchors, computeTopicPages, RAIL_TOP_N } from '@/lib/pinecone/topic-pages'

const INSTITUTION = 'inst-1'
const SECTION = 'sec-1'
const ITEM = 'item-1'
const SCOPE = { institutionId: INSTITUTION, sectionId: SECTION }

/** A match as the wrapper returns it — only page_number and score are read. */
const match = (page: number, score: number) => ({
  id: `v#${page}`,
  score,
  metadata: { page_number: page, module_item_id: ITEM },
})

/**
 * Admin-client stub for `module_items`. Records every update payload so a test
 * can assert what actually landed in the JSONB column.
 *
 * `update(...).eq(...)` is AWAITED by the code under test, so `.eq()` has to
 * resolve — a chain that only returns itself hangs the call.
 */
function makeDb(row: { content: Record<string, unknown> } | null, opts?: { rejectOnUpdate?: boolean }) {
  const updates: Array<Record<string, unknown>> = []
  const selectFilters: string[] = []
  const db = {
    from(table: string) {
      expect(table).toBe('module_items')
      return {
        select: () => ({
          eq: (_col: string, id: string) => {
            selectFilters.push(id)
            return { maybeSingle: async () => ({ data: row, error: null }) }
          },
        }),
        update: (payload: Record<string, unknown>) => ({
          eq: async (_col: string, id: string) => {
            if (opts?.rejectOnUpdate) throw new Error('column "content" jsonb write rejected')
            updates.push({ ...payload, __id: id })
            return { error: null }
          },
        }),
      }
    },
  }
  return { db, updates, selectFilters }
}

/** Every topic resolves to the same page set unless a test says otherwise. */
function respondWith(matches: ReturnType<typeof match>[]) {
  embedQuery.mockResolvedValue({ values: [0.1], tokens: 3, estimated: false })
  queryMaterialPageVectors.mockResolvedValue(matches)
}

beforeEach(() => {
  embedQuery.mockReset()
  queryMaterialPageVectors.mockReset()
})

describe('storeTopicPageAnchors — merging anchors onto module_items.content', () => {
  it('preserves every other field in the shared content blob', async () => {
    respondWith([match(3, 0.71), match(4, 0.69)])
    // The blob as the extraction worker leaves it moments before this runs.
    const { db, updates } = makeDb({
      content: {
        filePath: 'sec-1/lecture6.pdf',
        topics: ['Positional encoding'],
        concepts: [{ name: 'Positional encoding', pages: [30] }],
        extraction: { status: 'completed', pages: [{ pageNumber: 1, text: 'x' }] },
        summary: 'Transformers, part 1',
      },
    })

    const result = await storeTopicPageAnchors(db, {
      institutionId: INSTITUTION,
      sectionId: SECTION,
      moduleItemId: ITEM,
      topics: ['Positional encoding'],
    })

    expect(result).toEqual({ 'Positional encoding': [3, 4] })
    expect(updates).toHaveLength(1)
    const content = updates[0].content as Record<string, unknown>
    expect(content).toMatchObject({
      filePath: 'sec-1/lecture6.pdf',
      topics: ['Positional encoding'],
      concepts: [{ name: 'Positional encoding', pages: [30] }],
      extraction: { status: 'completed', pages: [{ pageNumber: 1, text: 'x' }] },
      summary: 'Transformers, part 1',
      topicPages: { 'Positional encoding': [3, 4] },
    })
  })

  it('replaces a previous upload’s map instead of merging into it', async () => {
    // The file was replaced and re-extracted: "Beam search" is no longer one of
    // this document's topics, so its old page numbers point into a document
    // that is gone. A deep merge would keep them and the rail would send the
    // student to a page about something else.
    respondWith([match(2, 0.8)])
    const { db, updates } = makeDb({
      content: { topicPages: { 'Beam search': [11, 12], Attention: [3] } },
    })

    await storeTopicPageAnchors(db, {
      institutionId: INSTITUTION,
      sectionId: SECTION,
      moduleItemId: ITEM,
      topics: ['Attention'],
    })

    expect((updates[0].content as Record<string, unknown>).topicPages).toEqual({ Attention: [2] })
  })

  it('writes nothing at all when no topic matched a page', async () => {
    // The common case is a material whose pages are not in the index yet
    // (embed_material has not finished). Writing `{}` here would be a claim —
    // "this lecture covers none of its own topics" — and the roadmap's fallback
    // only fires when the key is absent.
    respondWith([])
    const { db, updates } = makeDb({ content: { topics: ['Attention'] } })

    const result = await storeTopicPageAnchors(db, {
      institutionId: INSTITUTION,
      sectionId: SECTION,
      moduleItemId: ITEM,
      topics: ['Attention'],
    })

    expect(result).toEqual({})
    expect(updates).toEqual([])
  })

  it('does not write when the item vanished mid-job', async () => {
    respondWith([match(2, 0.8)])
    const { db, updates } = makeDb(null)

    const result = await storeTopicPageAnchors(db, {
      institutionId: INSTITUTION,
      sectionId: SECTION,
      moduleItemId: ITEM,
      topics: ['Attention'],
    })

    // Anchors still returned to the caller; nothing written to a deleted row.
    expect(result).toEqual({ Attention: [2] })
    expect(updates).toEqual([])
  })

  it('tolerates an item whose content column is null', async () => {
    respondWith([match(2, 0.8)])
    const { db, updates } = makeDb({ content: null as unknown as Record<string, unknown> })

    await storeTopicPageAnchors(db, {
      institutionId: INSTITUTION,
      sectionId: SECTION,
      moduleItemId: ITEM,
      topics: ['Attention'],
    })

    expect(updates[0].content).toEqual({ topicPages: { Attention: [2] } })
  })

  it('never throws when the write fails — extraction must survive it', async () => {
    // This runs at the tail of a long extraction job that has already landed
    // the professor's text, images, and topics. A throw here would fail the
    // job and retry all of it for a best-effort rail.
    respondWith([match(2, 0.8)])
    const { db } = makeDb({ content: {} }, { rejectOnUpdate: true })

    await expect(
      storeTopicPageAnchors(db, {
        institutionId: INSTITUTION,
        sectionId: SECTION,
        moduleItemId: ITEM,
        topics: ['Attention'],
      }),
    ).resolves.toEqual({})
  })
})

describe('computeTopicPages — scoping and per-topic isolation', () => {
  it('scopes the query to this material and this tenant', async () => {
    // Without the module_item_id filter the best match for "Attention" is
    // usually a DIFFERENT lecture, and the rail would anchor a page number from
    // one document onto the viewer of another. The namespace args are the
    // tenant boundary — Pinecone has no RLS behind them.
    respondWith([match(2, 0.8)])

    await computeTopicPages(SCOPE, ITEM, ['Attention'])

    expect(queryMaterialPageVectors).toHaveBeenCalledTimes(1)
    const [scope, vector, opts] = queryMaterialPageVectors.mock.calls[0]
    expect(scope).toEqual(SCOPE)
    expect(vector).toEqual([0.1])
    expect(opts.moduleItemId).toBe(ITEM)
    // topK is the candidate pool the margin cut reads, not the answer.
    expect(opts.topK).toBeGreaterThan(RAIL_TOP_N)
  })

  it('drops only the topic whose embedding failed', async () => {
    embedQuery.mockImplementation(async (topic: string) => {
      if (topic === 'Attention') throw new Error('429 rate limited')
      return { values: [0.1], tokens: 3, estimated: false }
    })
    queryMaterialPageVectors.mockResolvedValue([match(5, 0.9)])

    const out = await computeTopicPages(SCOPE, ITEM, ['Attention', 'Softmax'])

    expect(out).toEqual({ Softmax: [5] })
  })

  it('embeds each distinct topic once', async () => {
    // Extraction can emit the same topic twice with different spacing; each
    // embed is a paid API call.
    respondWith([match(2, 0.8)])

    await computeTopicPages(SCOPE, ITEM, ['Attention', ' Attention ', '', '  '])

    expect(embedQuery).toHaveBeenCalledTimes(1)
    expect(embedQuery).toHaveBeenCalledWith('Attention')
  })

  it('makes no calls at all for a material with no topics', async () => {
    respondWith([match(2, 0.8)])

    expect(await computeTopicPages(SCOPE, ITEM, [])).toEqual({})
    expect(embedQuery).not.toHaveBeenCalled()
    expect(queryMaterialPageVectors).not.toHaveBeenCalled()
  })
})
