import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  attainmentHash,
  candidateHash,
  contentHash,
  indicatorListHash,
} from '@/lib/jobs/pipelines/outcome-alignment/cache'
import type {
  AlignmentRollup,
  EvidenceCandidate,
  Indicator,
  Level,
} from '@/lib/jobs/pipelines/outcome-alignment/types'
import type { MappedCandidate } from '@/lib/jobs/pipelines/outcome-alignment/map'
import type { PipelineContext } from '@/lib/jobs/types'

// Mock the two heavy stages the orchestrator depends on. gatherEvidence and
// mapCandidate are the only non-deterministic / IO-heavy pieces; everything the
// run() branch logic touches (fingerprinting, cache dispatch, reduce, summary,
// failure handling) is exercised for real against an in-memory fake DB.
const mockGather = vi.fn()
const mockMapCandidate = vi.fn()

vi.mock('@/lib/jobs/pipelines/outcome-alignment/gather', () => ({
  gatherEvidence: (...args: unknown[]) => mockGather(...args),
}))
vi.mock('@/lib/jobs/pipelines/outcome-alignment/map', async () => {
  const actual = await vi.importActual<typeof import('@/lib/jobs/pipelines/outcome-alignment/map')>(
    '@/lib/jobs/pipelines/outcome-alignment/map',
  )
  return { ...actual, mapCandidate: (...args: unknown[]) => mockMapCandidate(...args) }
})

// ── Fixtures ────────────────────────────────────────────────────
// DB shape (accreditation_* rows) → transformed Indicator[] as loadIndicators builds it.
const OUTCOME_ROWS = [{ id: 'o1', code: 'SO-1', order_index: 0 }]
const INDICATOR_ROWS = [
  { id: 'i11', code: 'PI 1.1', description: 'formulate', outcome_id: 'o1', order_index: 0 },
]
const INDICATORS: Indicator[] = [{ id: 'i11', code: 'PI 1.1', description: 'formulate', outcomeCode: 'SO-1' }]

const cand = (over: Partial<EvidenceCandidate> = {}): EvidenceCandidate => ({
  sourceType: 'assignment',
  sourceId: 'a-1',
  title: 'Assignment 1',
  signal: 'design a controller',
  cap: 'M',
  ...over,
})

const okMapped = (c: EvidenceCandidate): MappedCandidate => ({
  candidate: c,
  ok: true,
  matches: [
    { indicatorCode: 'PI 1.1', level: 'M' as Level, justification: 'clear evidence', confidence: 'high', indicator: INDICATORS[0] },
  ],
})
const failedMapped = (c: EvidenceCandidate): MappedCandidate => ({ candidate: c, ok: false, matches: [] })

// ── In-memory fake admin DB ─────────────────────────────────────
// Implements exactly the surface run() + its helpers touch. Chains are thenable:
// awaiting a select chain yields { data }, awaiting a write chain yields { error }.
interface FakeCfg {
  select?: Record<string, unknown[]>
  single?: Record<string, unknown>
}
function makeDb(cfg: FakeCfg) {
  const from = (table: string) => {
    let wrote = false
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'neq', 'in', 'order', 'limit', 'is', 'lt', 'gte', 'lte']) {
      chain[m] = () => chain
    }
    for (const w of ['upsert', 'update', 'delete', 'insert']) {
      chain[w] = () => {
        wrote = true
        return chain
      }
    }
    chain.single = async () => ({ data: cfg.single?.[table] ?? null, error: null })
    chain.maybeSingle = async () => ({ data: cfg.single?.[table] ?? null, error: null })
    chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
      const value = wrote ? { error: null } : { data: cfg.select?.[table] ?? [], error: null }
      return Promise.resolve(value).then(resolve, reject)
    }
    return chain
  }
  return { from, rpc: async () => ({ error: null }) } as unknown as SupabaseClient
}

function makeCtx(db: SupabaseClient): PipelineContext {
  return {
    adminDb: db,
    job: {
      id: 'job-current',
      type: 'outcome_alignment',
      params: {},
      status: 'running',
      progress: [],
      result: null,
      summary: null,
      error: null,
      institution_id: 'inst-1',
      section_id: 'sec-1',
      created_by: 'user-1',
      attempts: 1,
      max_attempts: 3,
      claimed_by: null,
      claim_expires_at: null,
      created_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      completed_at: null,
    },
    signal: new AbortController().signal,
    reportProgress: async () => {},
  }
}

const baseSelect = () => ({
  accreditation_outcomes: OUTCOME_ROWS,
  accreditation_indicators: INDICATOR_ROWS,
  outcome_alignment_map_cache: [], // cache empty → everything is a miss
})

// run() verifies the standard is global or tenant-owned before loading indicators.
const baseSingle = () => ({
  accreditation_standards: { id: 'std-1', institution_id: null },
})

// Compute the fingerprints run() will produce for a given candidate set.
function fingerprints(candidates: EvidenceCandidate[], mastery: Record<string, number>, count: number) {
  const indList = indicatorListHash(INDICATORS)
  const hashes = candidates.map((c) => candidateHash(c, indList))
  // `hashes` is exposed so a test can pre-seed the per-artifact cache and drive the
  // zero-LLM-call path.
  return { contentHash: contentHash(hashes), attainmentHash: attainmentHash(mastery, count), hashes }
}

async function importPipeline() {
  const mod = await import('@/lib/jobs/pipelines/outcome-alignment/index')
  return mod.outcomeAlignmentPipeline
}

beforeEach(() => {
  vi.resetModules()
  mockGather.mockReset()
  mockMapCandidate.mockReset()
})

describe('outcomeAlignmentPipeline.run — early abort on unchanged inputs', () => {
  it('returns the previous rollup and skips the LLM when nothing changed', async () => {
    const candidates = [cand()]
    mockGather.mockResolvedValue({ candidates, masteryBySkill: {}, quizResponseCount: 0 })
    const fp = fingerprints(candidates, {}, 0)
    const prevRollup: AlignmentRollup = {
      standardId: 'std-1',
      aligned: 1,
      gaps: [],
      outcomeLevels: { 'SO-1': 'M' },
      contentHash: fp.contentHash,
      attainmentHash: fp.attainmentHash,
    }
    const db = makeDb({
      select: baseSelect(),
      single: { ...baseSingle(), background_jobs: { id: 'prev', result: prevRollup, summary: 'previous summary' } },
    })

    const pipeline = await importPipeline()
    const res = await pipeline.run({ standardId: 'std-1' }, makeCtx(db))

    expect(res.result).toEqual(prevRollup)
    expect(res.summary).toContain('No changes since the last analysis')
    expect(res.summary).toContain('previous summary')
    expect(mockMapCandidate).not.toHaveBeenCalled()
  })

  it('does not advance the analysis date when every candidate came from cache', async () => {
    /* The attainment path: course content untouched, but a student submitted, so
       attainmentHash moved and the run does NOT early-abort. Every candidate then hits the
       per-artifact cache and mapCandidate is never called — the run is real, but nothing
       about the course was re-read. Restamping here would tell a professor their course was
       analysed today when the mapping is still January's, which is the same misleading
       freshness the early-abort branch refuses to produce. The two paths have to agree. */
    const candidates = [cand()]
    mockGather.mockResolvedValue({ candidates, masteryBySkill: { dynamics: 90 }, quizResponseCount: 12 })
    const fp = fingerprints(candidates, {}, 0) // previous run had NO quiz data
    const prevRollup: AlignmentRollup = {
      standardId: 'std-1',
      aligned: 1,
      gaps: [],
      outcomeLevels: { 'SO-1': 'M' },
      contentHash: fp.contentHash,
      attainmentHash: fp.attainmentHash,
      analyzedAt: '2026-01-05T00:00:00.000Z',
    }
    const db = makeDb({
      select: {
        ...baseSelect(),
        // Every candidate hash already cached => zero LLM calls this run.
        outcome_alignment_map_cache: candidates.map((_, i) => ({
          input_hash: fp.hashes[i],
          matches: [{ indicatorCode: 'PI 1.1', level: 'M', justification: 'cached', confidence: 'high' }],
        })),
      },
      single: {
        ...baseSingle(),
        background_jobs: { id: 'prev', result: prevRollup, summary: 'previous summary' },
      },
    })

    const pipeline = await importPipeline()
    const res = await pipeline.run({ standardId: 'std-1' }, makeCtx(db))

    expect(mockMapCandidate).not.toHaveBeenCalled()
    expect((res.result as AlignmentRollup).analyzedAt).toBe('2026-01-05T00:00:00.000Z')
  })

  it('carries the previous analysis date through, instead of restamping it as now', async () => {
    /* The abort writes a NEW job row, so that row's completed_at is when the fingerprint
       was last CHECKED. The mapping inside is January's. Reading completed_at as the
       analysis age would tell a professor their September re-check produced a September
       analysis, and their coverage would look freshly verified forever while nothing was
       re-read. analyzedAt rides inside the rollup precisely so the abort cannot touch it. */
    const candidates = [cand()]
    mockGather.mockResolvedValue({ candidates, masteryBySkill: {}, quizResponseCount: 0 })
    const fp = fingerprints(candidates, {}, 0)
    const prevRollup: AlignmentRollup = {
      standardId: 'std-1',
      aligned: 1,
      gaps: [],
      outcomeLevels: { 'SO-1': 'M' },
      contentHash: fp.contentHash,
      attainmentHash: fp.attainmentHash,
      analyzedAt: '2026-01-05T00:00:00.000Z',
    }
    const db = makeDb({
      select: baseSelect(),
      single: {
        ...baseSingle(),
        background_jobs: { id: 'prev', result: prevRollup, summary: 'previous summary' },
      },
    })

    const pipeline = await importPipeline()
    const res = await pipeline.run({ standardId: 'std-1' }, makeCtx(db))

    expect((res.result as AlignmentRollup).analyzedAt).toBe('2026-01-05T00:00:00.000Z')
  })

  it('stamps the analysis date on a run that actually mapped', async () => {
    const candidates = [cand()]
    mockGather.mockResolvedValue({ candidates, masteryBySkill: {}, quizResponseCount: 0 })
    mockMapCandidate.mockImplementation(async (c: EvidenceCandidate) => okMapped(c))
    const db = makeDb({ select: baseSelect(), single: baseSingle() })

    const before = Date.now()
    const pipeline = await importPipeline()
    const res = await pipeline.run({ standardId: 'std-1' }, makeCtx(db))
    const after = Date.now()

    // "Is a parseable date" is not the property this test is named for. Pin that it is NOW.
    const stamped = Date.parse((res.result as AlignmentRollup).analyzedAt as string)
    expect(stamped).toBeGreaterThanOrEqual(before)
    expect(stamped).toBeLessThanOrEqual(after)
  })

  it('does NOT early-abort when quiz attainment changed even if content is identical', async () => {
    const candidates = [cand()]
    mockGather.mockResolvedValue({ candidates, masteryBySkill: { dynamics: 90 }, quizResponseCount: 12 })
    mockMapCandidate.mockImplementation(async (c: EvidenceCandidate) => okMapped(c))
    const fp = fingerprints(candidates, {}, 0) // prev run had NO quiz data
    const db = makeDb({
      select: baseSelect(),
      single: {
        ...baseSingle(),
        background_jobs: {
          id: 'prev',
          result: { standardId: 'std-1', aligned: 1, gaps: [], outcomeLevels: {}, contentHash: fp.contentHash, attainmentHash: fp.attainmentHash },
          summary: 'previous summary',
        },
      },
    })

    const pipeline = await importPipeline()
    const res = await pipeline.run({ standardId: 'std-1' }, makeCtx(db))

    expect(mockMapCandidate).toHaveBeenCalledTimes(1)
    // Content unchanged + refreshed attainment → the dedicated note is appended.
    expect(res.summary).toContain('quiz attainment was refreshed')
  })
})

describe('outcomeAlignmentPipeline.run — map failure handling', () => {
  it('throws when EVERY map call fails (no confident all-gaps report)', async () => {
    const candidates = [cand({ sourceId: 'a-1' }), cand({ sourceId: 'a-2', title: 'Assignment 2' })]
    mockGather.mockResolvedValue({ candidates, masteryBySkill: {}, quizResponseCount: 0 })
    mockMapCandidate.mockImplementation(async (c: EvidenceCandidate) => failedMapped(c))
    const db = makeDb({ select: baseSelect(), single: baseSingle() })

    const pipeline = await importPipeline()
    await expect(pipeline.run({ standardId: 'std-1' }, makeCtx(db))).rejects.toThrow(/all 2 map calls failed/)
  })

  it('on partial failure: omits contentHash (so the retry is not early-aborted) and notes it in the summary', async () => {
    const candidates = [cand({ sourceId: 'a-1' }), cand({ sourceId: 'a-2', title: 'Assignment 2' })]
    mockGather.mockResolvedValue({ candidates, masteryBySkill: {}, quizResponseCount: 0 })
    mockMapCandidate.mockImplementation(async (c: EvidenceCandidate) =>
      c.sourceId === 'a-1' ? okMapped(c) : failedMapped(c),
    )
    const db = makeDb({ select: baseSelect(), single: baseSingle() })

    const pipeline = await importPipeline()
    const res = await pipeline.run({ standardId: 'std-1' }, makeCtx(db))
    const rollup = res.result as AlignmentRollup

    expect(rollup.contentHash).toBeUndefined() // not fingerprinted → next run re-tries the failed material
    expect(rollup.attainmentHash).toBeDefined()
    expect(res.summary).toMatch(/could not be analyzed this time/)
  })

  it('on a fully successful run: stamps the content fingerprint for future change detection', async () => {
    const candidates = [cand()]
    mockGather.mockResolvedValue({ candidates, masteryBySkill: {}, quizResponseCount: 0 })
    mockMapCandidate.mockImplementation(async (c: EvidenceCandidate) => okMapped(c))
    const db = makeDb({ select: baseSelect(), single: baseSingle() })
    const fp = fingerprints(candidates, {}, 0)

    const pipeline = await importPipeline()
    const res = await pipeline.run({ standardId: 'std-1' }, makeCtx(db))
    const rollup = res.result as AlignmentRollup

    expect(rollup.contentHash).toBe(fp.contentHash)
    expect(rollup.attainmentHash).toBe(fp.attainmentHash)
  })
})
