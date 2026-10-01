// Guards + cache behaviour for the CLASS insight actions (professor roadmap →
// Class analytics drawer). The pure facts maths lives in
// roadmap-class-insight.test.ts; what only reaches through the action is:
//
// 1. AUTHZ. The action takes a bare sectionId from the client and then uses the
//    RLS-bypassing admin client, so verifyOwnership is the whole boundary. It
//    also spends money and ships the class' facts — student names included — to
//    Google, so a failed guard must refuse BEFORE the model call, not just
//    before the write.
// 2. THE HASH CACHE. One stored row per section keyed by a content hash of the
//    facts. If that comparison inverts or the key stops being written, the
//    failure is silent in both directions: either every drawer open pays for a
//    fresh model call, or professors read prose written from stale numbers.
//    The hash is an opaque token here — captured from the action's own upsert,
//    never recomputed.
// 3. THE TENANT ON THE WRITE. class_insight_summaries has RLS enabled with no
//    policies, so institution_id on the row is what any later cross-section
//    reader (Athena, the intelligence layer) scopes by.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildFullChain, createTableRouter } from './helpers/mock-supabase'

const mockGetUser = vi.fn()
const mockAdminClient = vi.fn()
const mockGenerateClassInsight = vi.fn()

/* AI kill switch: these tests exercise the AI-ENABLED path — mock the guard
   open so their stubbed DB clients don't trip its fail-closed refusal. The
   disabled/locked paths are covered in ai-kill-switch.test.ts. */
vi.mock('@/lib/ai/kill-switch', () => ({
  checkAiFeature: vi.fn(async () => ({ allowed: true })),
  checkAiFeatureBySection: vi.fn(async () => ({ allowed: true })),
}))

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: (...args: unknown[]) => mockAdminClient(...args),
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
vi.mock('@/lib/supabase/signed-urls', () => ({ signModuleItemContent: vi.fn(async (x) => x) }))
vi.mock('@/lib/ai/student-insight', () => ({ generateStudentInsight: vi.fn() }))
vi.mock('@/lib/ai/class-insight', () => ({
  generateClassInsight: (...args: unknown[]) => mockGenerateClassInsight(...args),
}))
vi.mock('@/lib/jobs/enqueue', () => ({ enqueueJob: vi.fn() }))

/* The action now refuses to spend a model call on a section with nothing to say
   (empty roster, or nothing graded). These tests are about authz, the tenant on
   the write and the hash cache, so they need facts that clear that gate. The
   router's empty snapshot no longer does. Override only the facts builder and
   keep the real blocker, so the gate itself is exercised rather than stubbed —
   its own rules are covered in roadmap-class-insight.test.ts. */
vi.mock('@/lib/roadmap/class-insight', async () => {
  const actual = await vi.importActual<typeof import('@/lib/roadmap/class-insight')>('@/lib/roadmap/class-insight')
  return {
    ...actual,
    buildClassInsightFacts: () => ({
      version: 1,
      totalStudents: 3,
      classMasteryPct: 61,
      classQuizAvg: 58,
      excelling: 1,
      onTrack: 1,
      needsSupport: 1,
      noData: 0,
      journeyCounts: {},
      weakestSkills: [],
      strongestSkills: [],
      skillsWithoutData: 0,
      needsAttentionCount: 1,
      needsAttention: [],
      noSignalStudents: [],
    }),
  }
})

/* eslint-disable @typescript-eslint/no-explicit-any */
let generateClassInsightSummary: any
/* eslint-enable @typescript-eslint/no-explicit-any */

const SECTION = 'sec-1'
const PROF = 'prof-1'
const INST = 'inst-1'
const PROSE = 'The class sits at **61%** mastery.'

/**
 * An admin client for the class-insight path. Every table the facts snapshot
 * reads (enrollments, quiz_attempts, roadmap_progress, modules, skills,
 * skill_mastery, …) falls through to the router's empty default: the roster and
 * skill aggregation are already covered elsewhere, so the facts here are
 * deliberately the empty snapshot — deterministic, hence a stable hash.
 */
function adminFor(opts: { owner?: string; cached?: unknown } = {}) {
  const sections = buildFullChain({
    // One chain serves both reads of this table: verifyOwnership's
    // (id, professor_id) and the generate path's (institution_id, course).
    data: {
      id: SECTION,
      professor_id: opts.owner ?? PROF,
      institution_id: INST,
      course: { title: 'Natural Language Processing' },
    },
    error: null,
  })
  const summaries = buildFullChain({ data: opts.cached ?? null, error: null })
  const router = createTableRouter({
    course_sections: sections,
    class_insight_summaries: summaries,
  })
  mockAdminClient.mockReturnValue(router)
  return { sections, summaries }
}

/** The row the action upserted, as a plain object. */
function upsertedRow(summaries: ReturnType<typeof buildFullChain>): Record<string, unknown> {
  return summaries.upsert.mock.calls[0][0] as Record<string, unknown>
}

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockAdminClient.mockReset()
  mockGenerateClassInsight.mockReset().mockResolvedValue(PROSE)

  const mod = await import('@/app/(dashboard)/professor/courses/[sectionId]/roadmap/actions')
  generateClassInsightSummary = mod.generateClassInsightSummary
})

function authed() {
  mockGetUser.mockResolvedValue({ data: { user: { id: PROF } }, error: null })
}
function unauthed() {
  mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no user' } })
}

describe('generateClassInsightSummary — authz precedes the model call', () => {
  // A failed guard must cost nothing and leak nothing: no tokens spent, and no
  // other section's roster handed to the model provider.
  it('refuses unauthenticated callers without touching the DB or the model', async () => {
    unauthed()
    const res = await generateClassInsightSummary(SECTION)
    expect(res.error).toBeTruthy()
    expect(mockAdminClient).not.toHaveBeenCalled()
    expect(mockGenerateClassInsight).not.toHaveBeenCalled()
  })

  it('refuses a non-owner before calling the model or writing a row', async () => {
    authed()
    const { summaries } = adminFor({ owner: 'other-prof' })
    const res = await generateClassInsightSummary(SECTION)
    expect(res.error).toMatch(/do not own/i)
    expect(mockGenerateClassInsight).not.toHaveBeenCalled()
    expect(summaries.upsert).not.toHaveBeenCalled()
  })
})

describe('generateClassInsightSummary — the stored row', () => {
  it('carries the tenant, the cache key and the model that wrote it', async () => {
    authed()
    const { summaries } = adminFor()
    const res = await generateClassInsightSummary(SECTION)

    expect(res.data?.summary).toBe(PROSE)
    const row = upsertedRow(summaries)
    // institution_id is the multi-tenant requirement for every scoped write, and
    // this table has RLS on with no policies — the column is the only scope a
    // later cross-section reader has.
    expect(row.institution_id).toBe(INST)
    expect(row.section_id).toBe(SECTION)
    expect(row.model).toBeTruthy()
    expect(row.signal_hash).toEqual(expect.any(String))
    // The facts snapshot is stored beside the prose, versioned, so a later
    // reader can tell which shape it is looking at.
    expect((row.facts as { version: number }).version).toEqual(expect.any(Number))
    // One row per section — a second generate must replace, not append, or the
    // cache read (maybeSingle) starts erroring on duplicates.
    expect(summaries.upsert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ onConflict: 'section_id' }),
    )
  })

  it('returns an error instead of throwing when the model fails', async () => {
    // The drawer degrades to "the tiles below are still current" — it can only
    // do that if the action resolves with an error rather than rejecting.
    authed()
    const { summaries } = adminFor()
    mockGenerateClassInsight.mockRejectedValue(new Error('503 from provider'))

    const res = await generateClassInsightSummary(SECTION)
    expect(res.error).toBeTruthy()
    expect(res.data).toBeUndefined()
    expect(summaries.upsert).not.toHaveBeenCalled() // no prose, no row
  })
})

describe('generateClassInsightSummary — one action serves both paths', () => {
  // The drawer makes exactly ONE call per open: a hash match must hand back the
  // stored prose (with its original stamp, so "updated 2h ago" stays honest),
  // and a mismatch must rewrite. If the match arm regressed to always
  // regenerating, the only symptom is a silent bill on every drawer open.
  it('returns stored prose with its original timestamp on a hash match, and rewrites on a mismatch', async () => {
    authed()
    const { summaries } = adminFor()

    // Borrow the action's own hash of the current facts (opaque token).
    await generateClassInsightSummary(SECTION)
    const hash = upsertedRow(summaries).signal_hash
    expect(mockGenerateClassInsight).toHaveBeenCalledTimes(1)

    summaries.maybeSingle.mockResolvedValue({
      data: { summary: 'stored prose', signal_hash: hash, generated_at: '2026-08-02T12:00:00Z' },
      error: null,
    })
    const cached = await generateClassInsightSummary(SECTION)
    expect(cached.data).toEqual({ summary: 'stored prose', generatedAt: '2026-08-02T12:00:00Z' })
    expect(mockGenerateClassInsight).toHaveBeenCalledTimes(1)

    // A signal moved since it was written: rewrite, and stamp it fresh.
    summaries.maybeSingle.mockResolvedValue({
      data: { summary: 'stored prose', signal_hash: 'hash-from-older-numbers', generated_at: '2026-08-01T12:00:00Z' },
      error: null,
    })
    const rewritten = await generateClassInsightSummary(SECTION)
    expect(mockGenerateClassInsight).toHaveBeenCalledTimes(2)
    expect(rewritten.data?.summary).toBe(PROSE)
    expect(rewritten.data?.generatedAt).not.toBe('2026-08-01T12:00:00Z')
  })
})

describe('generateClassInsightSummary — refuses before spending money', () => {
  /* The drawer had no sparse-data branch at all, so an empty section rendered
     zeroed tiles and still paid for a model call to narrate them. The
     assertion that matters is not the copy, it is that generateClassInsight is
     never reached and nothing is written. */
  it('does not call the model, or write a row, when there is nothing to say', async () => {
    authed()
    const { summaries } = adminFor()

    const mod = await import('@/lib/roadmap/class-insight')
    const spy = vi.spyOn(mod, 'buildClassInsightFacts').mockReturnValue({
      version: 1,
      totalStudents: 0,
      classMasteryPct: null,
      classQuizAvg: null,
      excelling: 0,
      onTrack: 0,
      needsSupport: 0,
      noData: 0,
      journeyCounts: {},
      weakestSkills: [],
      strongestSkills: [],
      skillsWithoutData: 0,
      needsAttentionCount: 0,
      needsAttention: [],
      noSignalStudents: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)

    const res = await generateClassInsightSummary(SECTION)

    expect(res.error).toMatch(/no students/i)
    expect(res.data).toBeUndefined()
    expect(mockGenerateClassInsight).not.toHaveBeenCalled()
    expect(summaries.upsert).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})
