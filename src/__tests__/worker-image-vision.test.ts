// @vitest-environment node
//
// Phase 5c — the worker's standalone-image branch (worker.ts), the orchestration
// the unit tests for runVisionOnImage/extractImage don't exercise end-to-end. We
// drive the public runOneJob with an in-memory fake admin client (no DB) and stub
// runVisionOnImage (already covered by image-vision.test.ts), then assert what the
// worker STORES on module_items.content.extraction:
//   • success      → vision units stamped, statuses completed, one VLM call
//   • VLM failure  → partial, Tier-0 page kept (never lose the row), statuses failed
//   • over MB cap  → vision skipped, runVisionOnImage never called
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import sharp from 'sharp'

// Stub only runVisionOnImage; keep the real gate/scanned helpers the worker also
// uses. A plain controllable fn (not a vi.fn) + manual counter: a vi.fn whose
// impl throws gets its thrown result surfaced by vitest as a test failure even
// when the worker catches it, so we drive behavior by hand instead.
type Vision = typeof import('@/lib/document-parser/vision').runVisionOnImage
const vision = {
  calls: 0,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  impl: (async () => visionUnits) as (...a: unknown[]) => any,
}
/* AI kill switch: these tests exercise the AI-ENABLED path — mock the guard
   open so their stubbed DB clients don't trip its fail-closed refusal. The
   disabled/locked paths are covered in ai-kill-switch.test.ts. */
vi.mock('@/lib/ai/kill-switch', () => ({
  checkAiFeature: vi.fn(async () => ({ allowed: true })),
  checkAiFeatureBySection: vi.fn(async () => ({ allowed: true })),
}))

vi.mock('@/lib/document-parser/vision', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/document-parser/vision')>()),
  runVisionOnImage: ((...args: unknown[]) => {
    vision.calls += 1
    return vision.impl(...args)
  }) as unknown as Vision,
}))
// Keep the best-effort topic/concept step offline (it would otherwise call the LLM).
vi.mock('@/lib/ai/llm-client', () => ({
  extractTopicsFromContent: vi.fn(async () => ({ topics: [], summary: null })),
  extractQuizConcepts: vi.fn(async () => null),
  CONCEPT_MIN_CONCEPTS: 3,
}))
// Keep the post-extract mastery recompute offline too. It builds its OWN admin client
// via createAdminClient() rather than using the mock passed to runOneJob, so the real
// one issues live requests at whatever SUPABASE_URL the env holds — on CI that is the
// unroutable placeholder host, and the awaited round-trips blow the 5s test timeout.
// Nothing here asserts on recompute; every other caller-side test mocks it the same way.
vi.mock('@/lib/extraction/enqueue', () => ({ enqueueMasteryRecompute: vi.fn() }))
/* Pinecone, mocked because it was NOT. worker.ts calls storeTopicPageAnchors on the
   concept-SUCCESS branch, and this is the only test that takes that branch (every other one
   forces concepts to null), so this file was the single place in the suite making a real
   network call to the vector index. It timed out at 5 s, consistently, on main.

   The worse half: local runs point at the PRODUCTION Pinecone index, so a full `vitest run`
   was writing test topic-page anchors into it. Same class as the #730 flake, which was an
   unmocked logEvent doing real network I/O. */
vi.mock('@/lib/pinecone/topic-pages', () => ({ storeTopicPageAnchors: vi.fn(async () => undefined) }))

import { runOneJob } from '@/lib/extraction/worker'
import { extractQuizConcepts, extractTopicsFromContent } from '@/lib/ai/llm-client'

const visionUnits = {
  formulas: [{ pageNumber: 1, latex: 'a^2+b^2=c^2', kind: 'display' as const, source: 'vision' as const }],
  figures: [{ pageNumber: 1, description: 'a right triangle', source: 'vision' as const }],
  tables: [{ pageNumber: 1, html: '<table><tr><td>x</td></tr></table>', rows: 1, cols: 1, source: 'vision' as const }],
}

let png: Buffer
beforeAll(async () => {
  png = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer()
})

// A stateful fake admin: one pending image job + one module_items row whose
// content.extraction the worker reads-modify-writes. Records job-status updates.
function makeAdmin() {
  const moduleItem = {
    id: 'mi1', item_type: 'lecture', module_id: 'mod1',
    content: { fileType: 'image', filePath: 'sec1/mi1/photo.png', fileSize: png.length } as Record<string, unknown>,
  }
  const job = {
    id: 'job1', kind: 'extract', module_item_id: 'mi1', status: 'pending', attempts: 0, max_attempts: 3,
    payload: { sectionId: 'sec1' }, error: null, claimed_by: null, claim_expires_at: null,
    created_at: '', started_at: null, completed_at: null, heartbeat_at: null,
  }
  let claimed = false
  const jobUpdates: Array<Record<string, unknown>> = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const apply = (table: string, obj: any) => {
    if (table === 'module_items' && obj?.content) moduleItem.content = obj.content
    if (table === 'extraction_jobs') jobUpdates.push(obj)
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin: any = {
    rpc: async (name: string) => {
      if (name === 'claim_next_extraction_job' && !claimed) { claimed = true; return { data: job, error: null } }
      return { data: null, error: null }
    },
    from: (table: string) => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: table === 'modules' ? { section_id: 'sec1', course_sections: { institution_id: 'inst1' } } : { ...moduleItem }, error: null }) }) }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      update: (obj: any) => ({ eq: async () => { apply(table, obj); return { data: null, error: null } } }),
    }),
    storage: {
      from: () => ({
        download: async () => ({ data: { arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) }, error: null }),
        upload: async () => ({ error: null }),
        getPublicUrl: () => ({ data: { publicUrl: 'https://x/i.png' } }),
      }),
    },
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { admin, jobUpdates, extraction: () => (moduleItem.content as any).extraction, content: () => moduleItem.content }
}

beforeEach(() => {
  vision.calls = 0
  vision.impl = async () => visionUnits
})
afterEach(() => { delete process.env.EXTRACTION_VISION_MAX_MB_PER_DOC })

describe('worker — standalone image → vision branch (Phase 5c)', () => {
  it('runs the VLM once and stamps vision formulas/tables/figures, status completed', async () => {
    const { admin, jobUpdates, extraction } = makeAdmin()

    const res = await runOneJob({ adminClient: admin, workerId: 'w' })

    expect(res).toMatchObject({ claimed: true, kind: 'extract', finalStatus: 'completed' })
    expect(vision.calls).toBe(1) // one call for the whole image

    const ext = extraction()
    expect(ext.status).toBe('completed')
    expect(ext.formulasStatus).toBe('completed')
    expect(ext.tablesStatus).toBe('completed')
    expect(ext.formulas[0]).toMatchObject({ pageNumber: 1, source: 'vision' })
    expect(ext.tables[0]).toMatchObject({ source: 'vision' })
    expect(ext.figures[0]).toMatchObject({ source: 'vision', description: 'a right triangle' })
    expect(jobUpdates.at(-1)).toMatchObject({ status: 'completed' })
  })

  it('on VLM failure: marks partial and KEEPS the Tier-0 page (never loses the row)', async () => {
    vision.impl = async () => { throw new Error('vision exploded') }
    const { admin, extraction } = makeAdmin()

    const res = await runOneJob({ adminClient: admin, workerId: 'w' })

    expect(res.finalStatus).toBe('partial')
    const ext = extraction()
    expect(ext.status).toBe('partial')
    expect(ext.formulasStatus).toBe('failed')
    expect(ext.tablesStatus).toBe('failed')
    expect(ext.pages).toHaveLength(1) // the row survived — extraction still stored
    expect(ext.formulas).toBeUndefined()
  })

  it('skips vision (and the VLM call) when the image exceeds the MB cap', async () => {
    process.env.EXTRACTION_VISION_MAX_MB_PER_DOC = '0' // any non-empty image trips it
    const { admin, extraction } = makeAdmin()

    const res = await runOneJob({ adminClient: admin, workerId: 'w' })

    expect(res.finalStatus).toBe('completed') // Tier-0 stub still completes
    expect(vision.calls).toBe(0) // never paid for a VLM call
    expect(extraction().formulasStatus).toBe('skipped')
    expect(extraction().tablesStatus).toBe('skipped')
  })

  // The concept-SUCCESS branch of runExtractJob — the every-upload path. Every
  // other test here (and jobs-worker) runs with extractQuizConcepts → null, so
  // the extract job only ever exercises the topic-only FALLBACK. This pins the
  // branch the backfill job can't cover: on a good concept pass, the written
  // topics come from the top-7 concept names (NOT extractTopicsFromContent,
  // which must be skipped), and concepts + topics + summary land together.
  it('on a successful concept pass: stores concepts + concept-derived topics + summary, skips the topic-only fallback', async () => {
    vi.mocked(extractTopicsFromContent).mockClear()
    vi.mocked(extractQuizConcepts).mockResolvedValueOnce({
      summary: 'Covers n-gram language models and smoothing.',
      concepts: [
        { name: 'N-gram models', importance: 9, markers: ['[x, page 1]'], summary: 'next-word probability from counts' },
        { name: 'Laplace smoothing', importance: 7, markers: ['[x, page 1]'], summary: 'add-one smoothing' },
        { name: 'Perplexity', importance: 8, markers: ['[x, page 1]'], summary: 'inverse-probability metric' },
      ],
    })
    const { admin, content } = makeAdmin()

    const res = await runOneJob({ adminClient: admin, workerId: 'w' })
    expect(res).toMatchObject({ claimed: true, kind: 'extract', finalStatus: 'completed' })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = content() as any
    // Concepts land, shaped for storage (markers → page numbers).
    expect(c.concepts).toEqual([
      { name: 'N-gram models', importance: 9, pages: [1], summary: 'next-word probability from counts' },
      { name: 'Laplace smoothing', importance: 7, pages: [1], summary: 'add-one smoothing' },
      { name: 'Perplexity', importance: 8, pages: [1], summary: 'inverse-probability metric' },
    ])
    // Topics come from the top concept names, NOT the plain topic extractor…
    expect(c.topics).toEqual(['N-gram models', 'Laplace smoothing', 'Perplexity'])
    expect(c.summary).toBe('Covers n-gram language models and smoothing.')
    // …which a successful concept pass must skip entirely.
    expect(vi.mocked(extractTopicsFromContent)).not.toHaveBeenCalled()
  })
})
