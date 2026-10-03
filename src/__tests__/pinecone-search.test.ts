// Tests for the searchMaterialPages retrieval primitive — specifically the
// correctness edges a single-material live E2E cannot expose: the per-column
// .in() hydration fetch re-matched into exact (item, page) pairs (a broken
// re-match returns plausible-but-WRONG page text), the empty-query guard, and
// drift handling for vectors with no source row — and the cross-encoder
// circuit-breaker, whose fail-open fallback is invisible from the caller's side
// by design (last describe block).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const embedQuery = vi.fn()
const queryMaterialPageVectors = vi.fn()
const queryCourseContentVectors = vi.fn()
const logEvent = vi.fn()
const recordAiUsage = vi.fn().mockResolvedValue(undefined)
const rerankPassages = vi.fn()

// Thenable supabase query-builder chain: every method returns itself; awaiting
// it resolves to { data }.
function chainResolving(data: unknown) {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'or']) {
    chain[m] = vi.fn(() => chain)
  }
  chain.then = (resolve: (v: { data: unknown }) => void) => resolve({ data })
  return chain
}
let hydrationRows: unknown[] = []
let transcriptRows: unknown[] = []
const from = vi.fn((table: string) =>
  chainResolving(table === 'lc_transcriptions' ? transcriptRows : hydrationRows),
)

vi.mock('@/lib/pinecone/embed', () => ({ embedQuery: (...a: unknown[]) => embedQuery(...a) }))
vi.mock('@/lib/pinecone/data', () => ({
  queryMaterialPageVectors: (...a: unknown[]) => queryMaterialPageVectors(...a),
  queryCourseContentVectors: (...a: unknown[]) => queryCourseContentVectors(...a),
}))
vi.mock('@/lib/ai/vertex-rerank', () => ({
  rerankPassages: (...a: unknown[]) => rerankPassages(...a),
}))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from }) }))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: (...a: unknown[]) => logEvent(...a) }))
vi.mock('@/lib/ai/usage', () => ({ recordAiUsage: (...a: unknown[]) => recordAiUsage(...a) }))

import { searchMaterialPages } from '@/lib/pinecone/search'

const INSTITUTION = 'a1b2c3d4-1111-4111-8111-000000000002'
const SECTION = 'a1b2c3d4-1111-4111-8111-000000000003'
const ITEM_A = 'a1b2c3d4-1111-4111-8111-00000000000a'
const ITEM_B = 'a1b2c3d4-1111-4111-8111-00000000000b'
const MODULE = 'a1b2c3d4-1111-4111-8111-000000000004'
const ACTOR = 'a1b2c3d4-1111-4111-8111-0000000000ff'

function match(itemId: string, page: number, score: number) {
  return {
    id: `${itemId}#p${String(page).padStart(4, '0')}`,
    score,
    metadata: {
      institution_id: INSTITUTION,
      section_id: SECTION,
      module_id: MODULE,
      module_item_id: itemId,
      page_number: page,
      content_class: 'course_material',
      schema_version: 1,
      embedding_model: 'gemini-embedding-2',
      chunker_version: 'page-v1',
    },
  }
}

function row(
  itemId: string,
  page: number,
  text: string,
  joinShape: 'object' | 'array' = 'object',
  vis: { is_visible?: boolean; is_published?: boolean; unlock_date?: string | null } = {},
) {
  const mod = { is_published: vis.is_published ?? true, unlock_date: vis.unlock_date ?? null }
  const item = { title: `title-${itemId.slice(-1)}`, is_visible: vis.is_visible ?? true, modules: joinShape === 'array' ? [mod] : mod }
  return {
    module_item_id: itemId,
    module_id: MODULE,
    page_number: page,
    breadcrumb: `crumb ${itemId.slice(-1)} p.${page}`,
    content: text,
    module_items: joinShape === 'array' ? [item] : item,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  hydrationRows = []
  transcriptRows = []
  embedQuery.mockResolvedValue({ values: [0.1, 0.2], tokens: 12, estimated: false })
})

describe('searchMaterialPages', () => {
  it('returns [] for empty/whitespace queries without embedding anything', async () => {
    const out = await searchMaterialPages({
      institutionId: INSTITUTION,
      sectionId: SECTION,
      query: '   ',
    })
    expect(out).toEqual([])
    expect(embedQuery).not.toHaveBeenCalled()
    expect(queryMaterialPageVectors).not.toHaveBeenCalled()
    expect(recordAiUsage).not.toHaveBeenCalled()
  })

  it('meters the query embedding with the tokens the API reported', async () => {
    queryMaterialPageVectors.mockResolvedValue([])
    await searchMaterialPages({ institutionId: INSTITUTION, sectionId: SECTION, query: 'attention' })
    expect(recordAiUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        feature: 'material_search',
        model: 'gemini-embedding-2',
        institutionId: INSTITUTION,
        usage: { inputTokens: 12 },
      }),
    )
  })

  it('re-matches exact (item, page) pairs — never the .in() cartesian cross-product', async () => {
    // Matches: A p.14 and B p.3. The per-column .in() fetch legitimately
    // returns the cross-product rows too (A p.3, B p.14 exist as other pages);
    // each match must hydrate ONLY its own pair's text.
    queryMaterialPageVectors.mockResolvedValue([match(ITEM_A, 14, 0.9), match(ITEM_B, 3, 0.8)])
    hydrationRows = [
      row(ITEM_A, 14, 'text-A14'),
      row(ITEM_A, 3, 'text-A3'),
      row(ITEM_B, 14, 'text-B14'),
      row(ITEM_B, 3, 'text-B3'),
    ]
    const out = await searchMaterialPages({
      institutionId: INSTITUTION,
      sectionId: SECTION,
      query: 'attention',
    })
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ moduleItemId: ITEM_A, pageNumber: 14, text: 'text-A14' })
    expect(out[1]).toMatchObject({ moduleItemId: ITEM_B, pageNumber: 3, text: 'text-B3' })
  })

  it('drops matches with no source row (reconciliation drift) instead of returning empty text', async () => {
    queryMaterialPageVectors.mockResolvedValue([match(ITEM_A, 1, 0.9), match(ITEM_B, 2, 0.8)])
    hydrationRows = [row(ITEM_A, 1, 'text-A1')] // B#2 vector has no Postgres row
    const out = await searchMaterialPages({
      institutionId: INSTITUTION,
      sectionId: SECTION,
      query: 'q',
    })
    expect(out).toHaveLength(1)
    expect(out[0].moduleItemId).toBe(ITEM_A)
  })

  it('drops pages from hidden items or unpublished modules (visibility enforced at hydration)', async () => {
    // A = visible+published (kept); B = hidden item (dropped); C = unpublished module (dropped).
    queryMaterialPageVectors.mockResolvedValue([
      match(ITEM_A, 1, 0.9),
      match(ITEM_B, 2, 0.8),
      match(ITEM_A, 5, 0.7),
    ])
    hydrationRows = [
      row(ITEM_A, 1, 'visible', 'object', { is_visible: true, is_published: true }),
      row(ITEM_B, 2, 'hidden-item', 'object', { is_visible: false, is_published: true }),
      row(ITEM_A, 5, 'unpublished-module', 'object', { is_visible: true, is_published: false }),
    ]
    const out = await searchMaterialPages({
      institutionId: INSTITUTION,
      sectionId: SECTION,
      query: 'q',
    })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ moduleItemId: ITEM_A, pageNumber: 1, text: 'visible' })
  })

  it('drops pages from published modules whose open date has not arrived', async () => {
    // A student must not get next week's material before it opens: the tutor is a
    // student-facing reader of modules (unlock.ts), so hydration applies the open date
    // as well as the publish and visibility flags.
    const future = new Date(Date.now() + 7 * 86_400_000).toISOString()
    const past = new Date(Date.now() - 86_400_000).toISOString()
    queryMaterialPageVectors.mockResolvedValue([
      match(ITEM_A, 1, 0.9),
      match(ITEM_B, 2, 0.8),
      match(ITEM_A, 3, 0.7),
    ])
    hydrationRows = [
      row(ITEM_A, 1, 'opened', 'object', { unlock_date: past }),
      row(ITEM_B, 2, 'scheduled', 'array', { unlock_date: future }),
      row(ITEM_A, 3, 'no-date', 'object', { unlock_date: null }),
    ]
    const out = await searchMaterialPages({
      institutionId: INSTITUTION,
      sectionId: SECTION,
      query: 'q',
      conceptBoost: false,
    })
    expect(out.map((r) => r.text)).toEqual(['opened', 'no-date'])
  })

  it("judges a page by its item's current module, not the chunk's copied module_id", async () => {
    // The chunk row was embedded while the item sat in an open week; the item has since
    // been moved into a scheduled one. Only the item's own module may decide.
    const future = new Date(Date.now() + 7 * 86_400_000).toISOString()
    queryMaterialPageVectors.mockResolvedValue([match(ITEM_A, 1, 0.9)])
    hydrationRows = [{ ...row(ITEM_A, 1, 'moved', 'object', { unlock_date: future }), modules: { is_published: true, unlock_date: null } }]
    const out = await searchMaterialPages({ institutionId: INSTITUTION, sectionId: SECTION, query: 'q', conceptBoost: false })
    expect(out).toEqual([])
  })

  it('reads boost data only from open modules', async () => {
    queryMaterialPageVectors.mockResolvedValue([])
    await searchMaterialPages({ institutionId: INSTITUTION, sectionId: SECTION, query: 'q' })
    const boost = from.mock.results.find((_, i) => from.mock.calls[i][0] === 'module_items')?.value as { or: ReturnType<typeof vi.fn> }
    expect(boost.or).toHaveBeenCalledWith(expect.stringMatching(/^unlock_date\.is\.null,unlock_date\.lte\./), { referencedTable: 'modules' })
  })

  it('resolves the module_items join whether Supabase returns object or array', async () => {
    queryMaterialPageVectors.mockResolvedValue([match(ITEM_A, 1, 0.9), match(ITEM_B, 2, 0.8)])
    hydrationRows = [row(ITEM_A, 1, 'a', 'object'), row(ITEM_B, 2, 'b', 'array')]
    const out = await searchMaterialPages({
      institutionId: INSTITUTION,
      sectionId: SECTION,
      query: 'q',
    })
    expect(out.map((r) => r.title)).toEqual(['title-a', 'title-b'])
  })

  it('logs the audit event only when an actor is supplied', async () => {
    queryMaterialPageVectors.mockResolvedValue([match(ITEM_A, 1, 0.9)])
    hydrationRows = [row(ITEM_A, 1, 'a')]
    await searchMaterialPages({ institutionId: INSTITUTION, sectionId: SECTION, query: 'q' })
    expect(logEvent).not.toHaveBeenCalled()
    await searchMaterialPages({
      institutionId: INSTITUTION,
      sectionId: SECTION,
      query: 'q',
      userId: 'a1b2c3d4-1111-4111-8111-0000000000ff',
    })
    expect(logEvent).toHaveBeenCalledTimes(1)
  })
})

// ── Spoken lane (N1) — transcript slides pooled into the same ranked list ──
describe('searchMaterialPages with transcripts', () => {
  const ROOM = 'a1b2c3d4-1111-4111-8111-00000000000c'
  const DECK = 'a1b2c3d4-1111-4111-8111-00000000000d'
  const DECK_ITEM = 'a1b2c3d4-1111-4111-8111-00000000000e'

  function spokenMatch(page: number, score: number) {
    return {
      id: `${ROOM}#t_${DECK}#s${String(page).padStart(4, '0')}`,
      score,
      metadata: {
        institution_id: INSTITUTION,
        section_id: SECTION,
        room_id: ROOM,
        deck_id: DECK,
        page_number: page,
        content_class: 'lecture_transcript',
        schema_version: 1,
        embedding_model: 'gemini-embedding-2',
        chunker_version: 'slide-v1',
      },
    }
  }
  function transcriptRow(
    page: number,
    text: string,
    room: Partial<{ name: string; status: string; lecture_summary_enabled: boolean | null; section_id: string }> = {},
  ) {
    return {
      deck_id: DECK,
      page_number: page,
      text,
      lc_rooms: {
        name: 'Lecture 6 live',
        status: 'ended',
        lecture_summary_enabled: true,
        section_id: SECTION,
        ...room,
      },
      lc_decks: { title: 'Lecture 6: Transformers', module_item_id: DECK_ITEM },
    }
  }

  it('uses the two-class query and shapes a spoken slide for citation (1-based, marked spoken)', async () => {
    queryCourseContentVectors.mockResolvedValue([spokenMatch(11, 0.8)])
    transcriptRows = [transcriptRow(11, 'so the key thing I want you to remember about attention is')]
    const out = await searchMaterialPages({
      institutionId: INSTITUTION,
      sectionId: SECTION,
      query: 'attention',
      includeTranscripts: true,
      conceptBoost: false,
    })
    expect(queryCourseContentVectors).toHaveBeenCalled()
    expect(queryMaterialPageVectors).not.toHaveBeenCalled()
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      spoken: true,
      title: 'Lecture 6: Transformers',
      pageNumber: 12, // stored 0-based page 11 → the slide a student counts
      moduleItemId: DECK_ITEM, // the promoted material — what makes the chip previewable
      text: 'so the key thing I want you to remember about attention is',
    })
  })

  it('pools spoken and page results by score, not by lane', async () => {
    queryCourseContentVectors.mockResolvedValue([match(ITEM_A, 14, 0.6), spokenMatch(3, 0.9)])
    hydrationRows = [row(ITEM_A, 14, 'slide text')]
    transcriptRows = [transcriptRow(3, 'spoken words about the same idea')]
    const out = await searchMaterialPages({
      institutionId: INSTITUTION,
      sectionId: SECTION,
      query: 'q',
      includeTranscripts: true,
      conceptBoost: false,
    })
    expect(out.map((r) => [r.spoken ?? false, r.score])).toEqual([
      [true, 0.9],
      [false, 0.6],
    ])
  })

  it('drops a spoken match when the replay toggle is off — G14 at hydration', async () => {
    queryCourseContentVectors.mockResolvedValue([spokenMatch(3, 0.9)])
    transcriptRows = [transcriptRow(3, 'words', { lecture_summary_enabled: false })]
    const out = await searchMaterialPages({
      institutionId: INSTITUTION,
      sectionId: SECTION,
      query: 'q',
      includeTranscripts: true,
      conceptBoost: false,
    })
    expect(out).toEqual([])
  })

  it('a null toggle predates the column and means ON', async () => {
    queryCourseContentVectors.mockResolvedValue([spokenMatch(3, 0.9)])
    transcriptRows = [transcriptRow(3, 'words', { lecture_summary_enabled: null })]
    const out = await searchMaterialPages({
      institutionId: INSTITUTION,
      sectionId: SECTION,
      query: 'q',
      includeTranscripts: true,
      conceptBoost: false,
    })
    expect(out).toHaveLength(1)
  })

  it('drops spoken matches from live rooms and from another section', async () => {
    queryCourseContentVectors.mockResolvedValue([spokenMatch(3, 0.9), spokenMatch(4, 0.8)])
    transcriptRows = [
      transcriptRow(3, 'still being said', { status: 'live' }),
      transcriptRow(4, 'someone else’s class', { section_id: 'a1b2c3d4-1111-4111-8111-0000000000ff' }),
    ]
    const out = await searchMaterialPages({
      institutionId: INSTITUTION,
      sectionId: SECTION,
      query: 'q',
      includeTranscripts: true,
      conceptBoost: false,
    })
    expect(out).toEqual([])
  })

  it('a spoken vector whose source row was erased is dropped, never empty-texted', async () => {
    queryCourseContentVectors.mockResolvedValue([spokenMatch(3, 0.9)])
    transcriptRows = [] // deck removed → lc_transcriptions cascaded
    const out = await searchMaterialPages({
      institutionId: INSTITUTION,
      sectionId: SECTION,
      query: 'q',
      includeTranscripts: true,
      conceptBoost: false,
    })
    expect(out).toEqual([])
  })

  it('default (no opt-in) never touches the two-class query', async () => {
    queryMaterialPageVectors.mockResolvedValue([])
    await searchMaterialPages({ institutionId: INSTITUTION, sectionId: SECTION, query: 'q' })
    expect(queryCourseContentVectors).not.toHaveBeenCalled()
  })

  it('a material-scoped search stays material-scoped even when transcripts are asked for', async () => {
    // The two-class query has no moduleItemId narrowing, so honouring the
    // opt-in here would quietly widen "search inside THIS document" to the
    // whole section — the caller's scope silently lost.
    queryMaterialPageVectors.mockResolvedValue([])
    await searchMaterialPages({
      institutionId: INSTITUTION,
      sectionId: SECTION,
      query: 'q',
      moduleItemId: ITEM_A,
      includeTranscripts: true,
    })
    expect(queryCourseContentVectors).not.toHaveBeenCalled()
    expect(queryMaterialPageVectors.mock.calls[0][2]).toMatchObject({ moduleItemId: ITEM_A })
  })
})

// ── Cross-encoder rerank + its circuit-breaker ────────────────────────────
//
// The failure mode these guard is a SILENT one: the breaker is designed to fall
// back to the dense order rather than error, so a dead reranker looks exactly
// like a working one from the caller's side. The one thing that must never
// happen is dense scores coming back stamped `reranked` — downstream that means
// a cosine gets judged against the cross-encoder floor (0.12), and every
// irrelevant page clears it, turning honest refusal into confident nonsense.
describe('searchMaterialPages rerank', () => {
  const prevEnv = process.env.RERANK_ENABLED

  beforeEach(() => {
    process.env.RERANK_ENABLED = '1'
    queryMaterialPageVectors.mockResolvedValue([
      match(ITEM_A, 1, 0.9),
      match(ITEM_A, 2, 0.8),
      match(ITEM_B, 3, 0.7),
    ])
    hydrationRows = [row(ITEM_A, 1, 'text-A1'), row(ITEM_A, 2, 'text-A2'), row(ITEM_B, 3, 'text-B3')]
  })
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.RERANK_ENABLED
    else process.env.RERANK_ENABLED = prevEnv
  })

  const search = () =>
    searchMaterialPages({
      institutionId: INSTITUTION,
      sectionId: SECTION,
      query: 'attention',
      rerank: true,
      conceptBoost: false,
      userId: ACTOR,
    })

  it('returns the cross-encoder order with its scores, stamped reranked', async () => {
    rerankPassages.mockResolvedValue([
      { index: 2, score: 0.61 },
      { index: 0, score: 0.09 },
    ])
    const out = await search()
    expect(out.map((p) => [p.pageNumber, p.score, p.reranked])).toEqual([
      [3, 0.61, true],
      [1, 0.09, true],
    ])
  })

  it('sends the title-prefixed page text and clamps top-N to what it actually has', async () => {
    rerankPassages.mockResolvedValue([{ index: 0, score: 0.5 }])
    await searchMaterialPages({
      institutionId: INSTITUTION,
      sectionId: SECTION,
      query: 'attention',
      rerank: true,
      rerankTopN: 10,
      conceptBoost: false,
    })
    const [model, query, documents, topN] = rerankPassages.mock.calls[0]
    expect(model).toBe('semantic-ranker-default-004')
    expect(query).toBe('attention')
    expect(documents[0]).toContain('title-a, page 1')
    expect(documents[0]).toContain('text-A1')
    // 3 candidates, top-N of 6 — asking for more than exists is a 400 waiting.
    expect(topN).toBe(3)
  })

  it('meters the call per REQUEST, not per token', async () => {
    rerankPassages.mockResolvedValue([{ index: 0, score: 0.5 }])
    await search()
    const billed = recordAiUsage.mock.calls
      .map((c) => c[0] as { model: string; usage: unknown })
      .find((c) => c.model === 'semantic-ranker-default-004')
    expect(billed).toBeDefined()
    expect(billed!.usage).toEqual({ requests: 1 })
  })

  // ── the fail-open path ──
  it('falls back to the DENSE order — dense scores, no reranked stamp — when the reranker throws', async () => {
    rerankPassages.mockImplementation(async () => {
      throw new Error('RESOURCE_EXHAUSTED: rerank request limit (0)')
    })
    const out = await search()
    // Guard against a vacuous pass: this must be the CATCH path, not a run
    // where the reranker was never reached.
    expect(rerankPassages).toHaveBeenCalledTimes(1)
    expect(out.map((p) => [p.pageNumber, p.score])).toEqual([
      [1, 0.9],
      [2, 0.8],
      [3, 0.7],
    ])
    // The load-bearing assertion: a dense cosine must NEVER carry the stamp
    // that sends it to the 0.12 cross-encoder floor.
    expect(out.some((p) => p.reranked)).toBe(false)
  })

  it('does not bill a request the reranker never completed', async () => {
    rerankPassages.mockImplementation(async () => {
      throw new Error('timeout')
    })
    await search()
    expect(recordAiUsage.mock.calls.some((c) => (c[0] as { model: string }).model === 'semantic-ranker-default-004')).toBe(false)
  })

  it('treats an empty verdict as failure, not as "no relevant pages"', async () => {
    // Falling through would hand the caller zero pages for a good question —
    // an honest-refusal branch fired by a broken dependency.
    rerankPassages.mockResolvedValue([])
    const out = await search()
    expect(rerankPassages).toHaveBeenCalledTimes(1)
    expect(out).toHaveLength(3)
    expect(out.some((p) => p.reranked)).toBe(false)
  })

  it('tells the audit trail whether the cross-encoder actually ran', async () => {
    rerankPassages.mockImplementation(async () => {
      throw new Error('nope')
    })
    await search()
    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ reranked: false, results: 3 }) }),
    )
  })

  it('stops calling the reranker after repeated failures — the breaker that makes default-on safe', async () => {
    // With reranking ON by default, an environment missing the IAM grant would
    // otherwise pay a doomed round trip on EVERY student message. After a few
    // consecutive failures the breaker opens and the dense order is served
    // directly, so a deployment mistake costs latency once, not forever.
    process.env.RERANK_ENABLED = '1'
    rerankPassages.mockImplementation(async () => {
      throw new Error('403 caller lacks discoveryengine.servingConfigs.rank')
    })

    for (let i = 0; i < 6; i++) await search()
    const afterTripping = rerankPassages.mock.calls.length
    for (let i = 0; i < 4; i++) await search()

    // Asserted as "it STOPS", not as an exact count: the breaker is
    // process-local state by design, so a prior test in this file may already
    // have moved it — an exact-count assertion would pass or fail on test
    // ordering rather than on the behaviour.
    expect(rerankPassages.mock.calls.length).toBe(afterTripping)
    expect(afterTripping).toBeLessThanOrEqual(3)
  })

  // ── the two "don't pay for it" guards ──
  it('never calls the reranker when RERANK_ENABLED is 0, even if the caller opts in', async () => {
    process.env.RERANK_ENABLED = '0'
    const out = await search()
    expect(rerankPassages).not.toHaveBeenCalled()
    expect(out).toHaveLength(3)
    expect(out.some((p) => p.reranked)).toBe(false)
  })

  it('never calls the reranker for callers that did not opt in', async () => {
    await searchMaterialPages({ institutionId: INSTITUTION, sectionId: SECTION, query: 'q', conceptBoost: false })
    expect(rerankPassages).not.toHaveBeenCalled()
  })

  it('skips a billable request when there is only one candidate to order', async () => {
    queryMaterialPageVectors.mockResolvedValue([match(ITEM_A, 1, 0.9)])
    hydrationRows = [row(ITEM_A, 1, 'text-A1')]
    const out = await search()
    expect(rerankPassages).not.toHaveBeenCalled()
    expect(out).toHaveLength(1)
  })
})
