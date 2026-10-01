// @vitest-environment node
//
// 'backfill-concepts' job (design §11a backfill): stores quiz concepts for a
// legacy item by running ONLY the concept pass over its already-stored
// extraction — no download/parse/vision. Must be idempotent (valid concepts →
// no-op), must never touch topics, must not overwrite an existing summary,
// and must refuse to write concepts derived from a superseded extraction.
import { describe, it, expect, vi } from 'vitest'

// Keep the concept step offline; behavior is set per test. (No beforeEach
// mockReset — see the vitest-4 note in llm-quiz-dedup-types.test.ts.)
/* AI kill switch: these tests exercise the AI-ENABLED path — mock the guard
   open so their stubbed DB clients don't trip its fail-closed refusal. They pin
   the AI-on path ONLY; this file asserts nothing about the disabled degradation.
   (ai-kill-switch.test.ts covers the guard module itself, not this pipeline.) */
vi.mock('@/lib/ai/kill-switch', () => ({
  checkAiFeature: vi.fn(async () => ({ allowed: true })),
  checkAiFeatureBySection: vi.fn(async () => ({ allowed: true })),
}))

vi.mock('@/lib/ai/llm-client', () => ({
  extractTopicsFromContent: vi.fn(async () => ({ topics: [], summary: null })),
  extractQuizConcepts: vi.fn(),
  CONCEPT_MIN_CONCEPTS: 3,
}))
// Keep the post-extract mastery recompute offline: it builds its own admin client via
// createAdminClient() instead of the mock handed to runOneJob, so the real one issues
// live requests against whatever SUPABASE_URL the env holds. Nothing here asserts on it.
vi.mock('@/lib/extraction/enqueue', () => ({ enqueueMasteryRecompute: vi.fn() }))

import { extractQuizConcepts } from '@/lib/ai/llm-client'
import { runOneJob } from '@/lib/extraction/worker'

const extract = vi.mocked(extractQuizConcepts)

const TITLE = 'Lecture 2: Language Modeling'
const richConcepts = {
  summary: 'Covers n-gram language models and smoothing.',
  concepts: [
    { name: 'N-gram models', importance: 9, markers: [`[${TITLE}, page 1]`, `[${TITLE}, page 2]`], summary: 'estimating next-word probability from counts' },
    { name: 'Laplace smoothing', importance: 7, markers: [`[${TITLE}, page 2]`], summary: 'add-one smoothing tradeoffs' },
    { name: 'Perplexity', importance: 8, markers: [`[${TITLE}, page 1]`], summary: 'inverse-probability evaluation metric' },
  ],
}

const completedExtraction = (jobId?: string) => ({
  status: 'completed',
  extractedAt: '2026-01-01T00:00:00Z',
  error: null,
  metadata: { pageCount: 2, wordCount: 40 },
  pages: [
    { pageNumber: 1, text: 'N-grams assign probabilities to word sequences. Perplexity evaluates them.' },
    { pageNumber: 2, text: 'Laplace smoothing adds one to every count.' },
  ],
  ...(jobId ? { jobId } : {}),
})

// Stateful fake admin: one pending backfill-concepts job + one module_items
// row. `onFetchItem` lets a test mutate the row between the handler's initial
// read and its pre-write re-fetch (the supersede-race window).
function makeAdmin(
  content: Record<string, unknown>,
  onFetchItem?: (fetchCount: number, item: { content: Record<string, unknown> }) => void,
) {
  const moduleItem = { id: 'mi1', title: TITLE, item_type: 'lecture', module_id: 'mod1', content }
  const job = {
    id: 'job-bc-1', kind: 'backfill-concepts', module_item_id: 'mi1', status: 'pending', attempts: 0,
    max_attempts: 3, payload: { sectionId: 'sec1' }, error: null, claimed_by: null,
    claim_expires_at: null, created_at: '', started_at: null, completed_at: null, heartbeat_at: null,
  }
  let claimed = false
  let itemFetches = 0
  const jobUpdates: Array<Record<string, unknown>> = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin: any = {
    rpc: async (name: string) => {
      if (name === 'claim_next_extraction_job' && !claimed) { claimed = true; return { data: job, error: null } }
      return { data: null, error: null }
    },
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          single: async () => {
            if (table === 'modules') {
              return { data: { section_id: 'sec1', course_sections: { institution_id: 'inst1' } }, error: null }
            }
            itemFetches += 1
            onFetchItem?.(itemFetches, moduleItem)
            return { data: { ...moduleItem, content: { ...moduleItem.content } }, error: null }
          },
        }),
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      update: (obj: any) => ({
        eq: async () => {
          if (table === 'module_items' && obj?.content) moduleItem.content = obj.content
          if (table === 'extraction_jobs') jobUpdates.push(obj)
          return { data: null, error: null }
        },
      }),
    }),
  }
  return { admin, jobUpdates, content: () => moduleItem.content as Record<string, unknown> }
}

describe('worker — backfill-concepts job', () => {
  it('stores concepts (markers → page numbers) and the doc summary; topics stay untouched', async () => {
    extract.mockResolvedValueOnce(richConcepts)
    const { admin, jobUpdates, content } = makeAdmin({
      fileType: 'pdf', filePath: 'sec1/mi1/deck.pdf',
      extraction: completedExtraction('old-extract-job'),
      topics: ['Professor-curated topic'],
    })

    const res = await runOneJob({ adminClient: admin, workerId: 'w' })
    expect(res).toMatchObject({ claimed: true, kind: 'backfill-concepts', finalStatus: 'completed' })

    const c = content()
    expect(c.concepts).toEqual([
      { name: 'N-gram models', importance: 9, pages: [1, 2], summary: 'estimating next-word probability from counts' },
      { name: 'Laplace smoothing', importance: 7, pages: [2], summary: 'add-one smoothing tradeoffs' },
      { name: 'Perplexity', importance: 8, pages: [1], summary: 'inverse-probability evaluation metric' },
    ])
    expect(c.summary).toBe('Covers n-gram language models and smoothing.')
    expect(c.topics).toEqual(['Professor-curated topic']) // deliberately not rewritten
    expect(jobUpdates.at(-1)).toMatchObject({ status: 'completed', error: null })
  })

  it('never overwrites an existing doc summary', async () => {
    extract.mockResolvedValueOnce(richConcepts)
    const { admin, content } = makeAdmin({
      extraction: completedExtraction(),
      summary: 'Original professor-visible summary',
    })
    await runOneJob({ adminClient: admin, workerId: 'w' })
    expect(content().summary).toBe('Original professor-visible summary')
    expect(content().concepts).toHaveLength(3)
  })

  it('is idempotent: a valid stored list completes as a no-op without an LLM call', async () => {
    extract.mockClear()
    const stored = richConcepts.concepts.map((c) => ({
      name: c.name, importance: c.importance, pages: [1], summary: c.summary,
    }))
    const { admin, jobUpdates, content } = makeAdmin({ extraction: completedExtraction(), concepts: stored })
    const res = await runOneJob({ adminClient: admin, workerId: 'w' })
    expect(res.finalStatus).toBe('completed')
    expect(extract).not.toHaveBeenCalled()
    expect(content().concepts).toEqual(stored)
    expect(jobUpdates.at(-1)).toMatchObject({ status: 'completed' })
  })

  it('fails cleanly when the item has no completed extraction', async () => {
    const { admin } = makeAdmin({ fileType: 'pdf', filePath: 'sec1/mi1/deck.pdf' })
    const res = await runOneJob({ adminClient: admin, workerId: 'w' })
    expect(res.finalStatus).toBe('failed')
    expect(res.error).toMatch(/no completed extraction/)
  })

  it('fails (retriably) when the concept pass finds too little', async () => {
    extract.mockResolvedValueOnce(null)
    const { admin, content } = makeAdmin({ extraction: completedExtraction() })
    const res = await runOneJob({ adminClient: admin, workerId: 'w' })
    expect(res.finalStatus).toBe('failed')
    expect(res.error).toMatch(/concept extraction failed/)
    expect(content().concepts).toBeUndefined()
  })

  it('refuses to write concepts when a newer extraction superseded the one it read', async () => {
    extract.mockResolvedValueOnce(richConcepts)
    const { admin, content } = makeAdmin(
      { extraction: completedExtraction('old-extract-job') },
      (fetchCount, item) => {
        // Between the initial read and the pre-write re-fetch, a professor
        // re-upload lands: the row now carries a NEW extraction jobId.
        if (fetchCount === 2) item.content = { extraction: completedExtraction('newer-extract-job') }
      },
    )
    const res = await runOneJob({ adminClient: admin, workerId: 'w' })
    expect(res.finalStatus).toBe('failed')
    expect(res.error).toMatch(/superseded/)
    expect(content().concepts).toBeUndefined() // stale concepts were NOT written
  })
})
