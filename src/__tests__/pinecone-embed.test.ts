// @vitest-environment node
//
// gemini-embedding-2 token accounting. embedMaterialPage/embedQuery are now the
// SOURCE of the billable token counts on the cost ledger (material_embedding,
// material_search), so the number they return is the number the dashboard bills
// — a wrong one is a wrong invoice, not a cosmetic slip. Three things are
// pinned:
//
//  - the API's reported count wins, and a reported 0 is a real 0 (?? not ||);
//  - a missing usageMetadata degrades to a chars/4 estimate FLAGGED as
//    estimated, never silently to 0 (which would read as a free call);
//  - the estimate counts TEXT parts only. The page image is a base64 string
//    ~1.3× the PNG's bytes; counting it would over-report a page embed by
//    orders of magnitude.
//
// Vector-shape and retry behavior are covered by the wrapper/search suites;
// every case here resolves on the first attempt so nothing waits on backoff.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

import { embedMaterialPage, embedQuery, embedTextsBatch } from '@/lib/pinecone/embed'
import { EMBEDDING_DIM } from '@/lib/pinecone/config'

const VALUES = new Array(EMBEDDING_DIM).fill(0.01)
const fetchMock = vi.fn()

/** One successful embedContent response with the given usageMetadata. */
function respondWith(usageMetadata?: Record<string, number>) {
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ embedding: { values: VALUES }, ...(usageMetadata ? { usageMetadata } : {}) }),
  })
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'test-key'
})

describe('embedQuery token accounting', () => {
  it('bills the promptTokenCount the API reported', async () => {
    respondWith({ promptTokenCount: 37, totalTokenCount: 999 })
    const r = await embedQuery('what is attention')
    expect(r.tokens).toBe(37)
    expect(r.estimated).toBe(false)
    expect(r.values).toHaveLength(EMBEDDING_DIM)
  })

  it('falls back to totalTokenCount when only that field is present', async () => {
    respondWith({ totalTokenCount: 21 })
    expect(await embedQuery('attention')).toMatchObject({ tokens: 21, estimated: false })
  })

  it('treats a reported 0 as a real zero, not as a missing count', async () => {
    // `??` vs `||`: with `||` this would silently become a chars/4 estimate and
    // the row would be flagged estimated for a call the API measured exactly.
    respondWith({ promptTokenCount: 0 })
    expect(await embedQuery('x')).toMatchObject({ tokens: 0, estimated: false })
  })

  it('estimates from text chars and FLAGS it when usageMetadata is absent', async () => {
    respondWith()
    const query = 'y'.repeat(40)
    const r = await embedQuery(query)
    // The prompt is the retrieval-task wrapper plus the query.
    const expectedChars = `task: search result | query: ${query}`.length
    expect(r.tokens).toBe(Math.ceil(expectedChars / 4))
    expect(r.estimated).toBe(true)
  })
})

describe('embedMaterialPage token accounting', () => {
  it('bills the reported multimodal count (text + image) as-is', async () => {
    respondWith({ promptTokenCount: 1_240 })
    const r = await embedMaterialPage({
      breadcrumb: 'CS101 / Week 1 / slides.pdf p3',
      pageText: 'gradient descent',
      imagePng: Buffer.alloc(50_000, 7),
    })
    expect(r).toMatchObject({ tokens: 1_240, estimated: false })
  })

  it('excludes the base64 image from the fallback estimate', async () => {
    respondWith()
    const breadcrumb = 'CS101 / Week 1 / slides.pdf p3'
    const pageText = 'z'.repeat(200)
    // 50 KB of PNG → ~66k base64 chars. If the estimate walked the image part,
    // tokens would be ~16k instead of ~58 — a 280× over-report per page.
    const r = await embedMaterialPage({ breadcrumb, pageText, imagePng: Buffer.alloc(50_000, 7) })
    expect(r.tokens).toBe(Math.ceil(`${breadcrumb}\n${pageText}`.length / 4))
    expect(r.tokens).toBeLessThan(100)
    expect(r.estimated).toBe(true)
  })
})

describe('embedTextsBatch', () => {
  it('returns vectors in input order and bills a chars/4 estimate flagged estimated', async () => {
    const texts = ['aaaa', 'bbbbbbbb']
    const v1 = new Array(EMBEDDING_DIM).fill(0.1)
    const v2 = new Array(EMBEDDING_DIM).fill(0.2)
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ embeddings: [{ values: v1 }, { values: v2 }] }),
    })
    const r = await embedTextsBatch(texts)
    expect(r.vectors[0][0]).toBe(0.1)
    expect(r.vectors[1][0]).toBe(0.2)
    // batchEmbedContents reports no usageMetadata — the ledger gets the chars/4
    // estimate, and it must be FLAGGED so the dashboard shows it as estimated.
    expect(r.tokens).toBe(Math.ceil(4 / 4) + Math.ceil(8 / 4))
    expect(r.estimated).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('falls back to per-request embedding on a non-retriable batch error, still billing tokens', async () => {
    // Batch endpoint 400s (non-retriable) → per-text embedContent fallback.
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'bad request' })
      .mockResolvedValue({
        ok: true,
        json: async () => ({ embedding: { values: VALUES }, usageMetadata: { promptTokenCount: 5 } }),
      })
    const r = await embedTextsBatch(['one', 'two'])
    expect(r.vectors).toHaveLength(2)
    expect(r.vectors[0]).toHaveLength(EMBEDDING_DIM)
    expect(r.tokens).toBe(10) // 5 reported per fallback call, summed — not dropped
    expect(fetchMock).toHaveBeenCalledTimes(3) // 1 failed batch + 2 fallback calls
  })

  it('returns empty for empty input without calling the API', async () => {
    expect(await embedTextsBatch([])).toEqual({ vectors: [], tokens: 0, estimated: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
