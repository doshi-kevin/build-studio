// @vitest-environment node
//
// The Vertex Ranking API call. Raw vendor contact would normally stay live-only
// — but moving off Pinecone's SDK moved the index mapping into OUR code, and
// that mapping is silent when it's wrong.
//
// The API answers with records SORTED BY SCORE, each carrying the id we minted
// from the input position. Reading the response's own order as the position (a
// one-line mutation, and the shape the old SDK actually had) yields indices
// 0,1,2… — perfectly plausible, always the first N pooled pages, stamped with
// someone else's relevance scores. Downstream that is an answer citing pages
// the cross-encoder never picked, with no error anywhere.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const getAccessToken = vi.fn(async () => 'test-token')
const getProjectId = vi.fn(async () => 'detected-project')

vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    getAccessToken = getAccessToken
    getProjectId = getProjectId
  },
}))

import { rerankPassages } from '@/lib/ai/vertex-rerank'

const DOCS = ['page zero', 'page one', 'page two', 'page three']

const fetchMock = vi.fn()

function respond(records: Array<Record<string, unknown>>) {
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ records }) })
}

beforeEach(() => {
  process.env.GOOGLE_CLOUD_PROJECT = 'test-project'
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

describe('rerankPassages', () => {
  it('maps each verdict back to its INPUT position, not the response order', async () => {
    respond([
      { id: '3', score: 0.91 },
      { id: '0', score: 0.44 },
      { id: '2', score: 0.30 },
    ])

    const out = await rerankPassages('semantic-ranker-default-004', 'attention', DOCS, 3, 4_000)

    expect(out).toEqual([
      { index: 3, score: 0.91 },
      { index: 0, score: 0.44 },
      { index: 2, score: 0.30 },
    ])
  })

  it('sends each document under its own position as the id — the other half of that contract', async () => {
    respond([{ id: '1', score: 0.5 }])

    await rerankPassages('semantic-ranker-default-004', 'attention', DOCS, 2, 4_000)

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body.records).toEqual([
      { id: '0', content: 'page zero' },
      { id: '1', content: 'page one' },
      { id: '2', content: 'page two' },
      { id: '3', content: 'page three' },
    ])
    expect(body).toMatchObject({ model: 'semantic-ranker-default-004', query: 'attention', topN: 2 })
  })

  it('drops ids that are not real positions rather than indexing into the caller’s pages', async () => {
    respond([
      { id: '1', score: 0.8 },
      { id: '9', score: 0.7 }, // past the end of the pool
      { id: 'abc', score: 0.6 }, // not a number
      { score: 0.5 }, // no id at all
      { id: '-1', score: 0.4 },
    ])

    const out = await rerankPassages('semantic-ranker-default-004', 'attention', DOCS, 5, 4_000)

    expect(out).toEqual([{ index: 1, score: 0.8 }])
  })

  it('throws on a non-OK response so the caller’s fallback fires', async () => {
    // Returning [] here instead would read as "the ranker ran and found
    // nothing" — the one verdict that must never be inferred from an outage.
    fetchMock.mockResolvedValue({ ok: false, status: 429, text: async () => 'quota exceeded' })

    await expect(rerankPassages('semantic-ranker-default-004', 'attention', DOCS, 3, 4_000)).rejects.toThrow('429')
  })
})
