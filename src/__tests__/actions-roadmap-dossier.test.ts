// Guards + cache behaviour for the student dossier actions (professor roadmap).
//
// Two things are worth pinning here, and neither is reachable from the pure
// aggregation tests (roadmap-dossier.test.ts):
//
// 1. AUTHZ. Both actions take a bare (sectionId, studentId) from the client and
//    then use the RLS-bypassing admin client, so the only thing standing between
//    a professor and another section's student is verifyDossierAccess. The
//    generate action additionally spends money and ships the facts to Google, so
//    a failed guard must refuse BEFORE the model call, not just before the write.
// 2. THE HASH CACHE. The narrative is stored keyed by a content hash of the
//    facts. If that comparison inverts or the key stops being written, the
//    failure is silent in both directions: either every card open pays for a
//    fresh model call, or professors are shown prose written from stale numbers.
//    The hash is treated as an opaque token throughout — captured from the
//    action's own upsert, never recomputed here.
// 3. THE CLASS-REFRESH COOLDOWN. The refresh button fans one click out to a
//    model call PER ENROLLED STUDENT, so the 24h/section cooldown is the only
//    thing between a professor's mouse and unbounded LLM spend. It is server-side
//    state (background_jobs rows), so nothing in the UI can be trusted to hold it.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildFullChain, createTableRouter } from './helpers/mock-supabase'
import { ON_ROSTER_STATUSES } from '@/lib/validations/enrollment'

const mockGetUser = vi.fn()
const mockAdminClient = vi.fn()
const mockGenerateInsight = vi.fn()
const mockEnqueueJob = vi.fn()

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
vi.mock('@/lib/ai/student-insight', () => ({
  generateStudentInsight: (...args: unknown[]) => mockGenerateInsight(...args),
}))
vi.mock('@/lib/jobs/enqueue', () => ({
  enqueueJob: (...args: unknown[]) => mockEnqueueJob(...args),
}))

/* eslint-disable @typescript-eslint/no-explicit-any */
let getStudentDossier: any
let generateStudentDossierSummary: any
let refreshClassInsights: any
let getClassInsightsRefreshStatus: any
/* eslint-enable @typescript-eslint/no-explicit-any */

const SECTION = 'sec-1'
const PROF = 'prof-1'
const STUDENT = 'stu-1'
const INST = 'inst-1'
const HOUR = 3_600_000
/** Keep in step with CLASS_INSIGHTS_COOLDOWN_HOURS in the action. */
const COOLDOWN_HOURS = 24

/** ISO timestamp `hours` in the past. */
const hoursAgo = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString()

/**
 * An admin client for the dossier path. Every table the facts collection reads
 * (skills, skill_mastery, quiz_attempts, quiz_answers, assignment_submissions,
 * roadmap_progress, modules) falls through to the router's empty default — the
 * aggregation maths is already covered by roadmap-dossier.test.ts, so the facts
 * here are deliberately the empty snapshot: deterministic, hence a stable hash.
 */
function adminFor(opts: {
  owner?: string
  onRoster?: boolean
  cached?: unknown
  /** The newest non-failed refresh job inside the cooldown window, if any. */
  recentJob?: { status: string; created_at: string } | null
} = {}) {
  const sections = buildFullChain({
    // One chain serves both reads of this table: verifyOwnership's
    // (id, professor_id) and verifyDossierAccess's (institution_id, course).
    data: {
      id: SECTION,
      professor_id: opts.owner ?? PROF,
      institution_id: INST,
      course: { title: 'Natural Language Processing' },
    },
    error: null,
  })
  /* This table is read TWICE on the dossier path, with different shapes:
     verifyDossierAccess takes one row via .maybeSingle(), and the facts'
     section-wide open-rate read awaits the chain for the whole roster (it
     needs the roster to average over). buildFullChain keeps maybeSingle as
     its own mock, so the chain serves the list and maybeSingle the row. */
  const rosterRow = opts.onRoster === false
    ? null
    : {
      student_id: STUDENT,
      student: { name: 'Ada Lovelace', avatar_url: 'https://cdn/a.png', last_active_at: '2026-07-31T09:00:00.000Z' },
    }
  const enrollments = buildFullChain({ data: rosterRow ? [rosterRow] : [], error: null })
  enrollments.maybeSingle = vi.fn().mockResolvedValue({ data: rosterRow, error: null })
  const summaries = buildFullChain({ data: opts.cached ?? null, error: null })
  const jobs = buildFullChain({ data: opts.recentJob ?? null, error: null })
  const router = createTableRouter({
    course_sections: sections,
    enrollments,
    student_insight_summaries: summaries,
    background_jobs: jobs,
  })
  mockAdminClient.mockReturnValue(router)
  return { sections, enrollments, summaries, jobs }
}

/** The row the action upserted, as a plain object. */
function upsertedRow(summaries: ReturnType<typeof buildFullChain>): Record<string, unknown> {
  return summaries.upsert.mock.calls[0][0] as Record<string, unknown>
}

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockAdminClient.mockReset()
  mockGenerateInsight.mockReset().mockResolvedValue('Ada is tracking a little below the class.')
  mockEnqueueJob.mockReset().mockResolvedValue({ jobId: 'job-1', alreadyActive: false, kicked: true })

  const mod = await import('@/app/(dashboard)/professor/courses/[sectionId]/roadmap/actions')
  getStudentDossier = mod.getStudentDossier
  generateStudentDossierSummary = mod.generateStudentDossierSummary
  refreshClassInsights = mod.refreshClassInsights
  getClassInsightsRefreshStatus = mod.getClassInsightsRefreshStatus
})

function authed() {
  mockGetUser.mockResolvedValue({ data: { user: { id: PROF } }, error: null })
}
function unauthed() {
  mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no user' } })
}

describe('getStudentDossier — authz', () => {
  it('refuses unauthenticated callers without touching the DB', async () => {
    unauthed()
    const res = await getStudentDossier(SECTION, STUDENT)
    expect(res.error).toBeTruthy()
    expect(res.data).toBeUndefined()
    expect(mockAdminClient).not.toHaveBeenCalled()
  })

  it('refuses a professor who does not own the section', async () => {
    authed()
    adminFor({ owner: 'other-prof' })
    const res = await getStudentDossier(SECTION, STUDENT)
    expect(res.error).toMatch(/do not own/i)
    expect(res.data).toBeUndefined()
  })

  it('refuses a student who is not on this section roster, gated on ON_ROSTER_STATUSES', async () => {
    // The IDOR that matters: studentId arrives from the client, so owning the
    // section must not be enough to pull any student's dossier — and a
    // withdrawn/pending enrollment is not "on the roster" either.
    authed()
    const { enrollments } = adminFor({ onRoster: false })
    const res = await getStudentDossier(SECTION, 'someone-elses-student')
    expect(res.error).toMatch(/not found in this section/i)
    expect(res.data).toBeUndefined()
    expect(enrollments.eq).toHaveBeenCalledWith('section_id', SECTION)
    expect(enrollments.eq).toHaveBeenCalledWith('student_id', 'someone-elses-student')
    expect(enrollments.in).toHaveBeenCalledWith('status', ON_ROSTER_STATUSES)
  })
})

describe('generateStudentDossierSummary — authz precedes the model call', () => {
  // A failed guard must cost nothing and leak nothing: no tokens spent, and no
  // other section's facts handed to the model provider.
  it('refuses unauthenticated callers without touching the DB or the model', async () => {
    unauthed()
    const res = await generateStudentDossierSummary(SECTION, STUDENT)
    expect(res.error).toBeTruthy()
    expect(mockAdminClient).not.toHaveBeenCalled()
    expect(mockGenerateInsight).not.toHaveBeenCalled()
  })

  it('refuses a professor who does not own the section before calling the model', async () => {
    authed()
    adminFor({ owner: 'other-prof' })
    const res = await generateStudentDossierSummary(SECTION, STUDENT)
    expect(res.error).toMatch(/do not own/i)
    expect(mockGenerateInsight).not.toHaveBeenCalled()
  })

  it('refuses a student off the roster before calling the model', async () => {
    authed()
    const { summaries } = adminFor({ onRoster: false })
    const res = await generateStudentDossierSummary(SECTION, 'someone-elses-student')
    expect(res.error).toMatch(/not found in this section/i)
    expect(mockGenerateInsight).not.toHaveBeenCalled()
    expect(summaries.upsert).not.toHaveBeenCalled()
  })
})

describe('generateStudentDossierSummary — the stored row', () => {
  it('carries the tenant, the cache key and the model that wrote it', async () => {
    authed()
    const { summaries } = adminFor()
    const res = await generateStudentDossierSummary(SECTION, STUDENT)

    expect(res.data?.summary).toBe('Ada is tracking a little below the class.')
    const row = upsertedRow(summaries)
    // institution_id is the multi-tenant requirement for every scoped write —
    // this table is read cross-section by the intelligence layer later.
    expect(row.institution_id).toBe(INST)
    expect(row.section_id).toBe(SECTION)
    expect(row.student_id).toBe(STUDENT)
    expect(row.model).toBeTruthy()
    expect(row.signal_hash).toEqual(expect.any(String))
    // The facts snapshot is stored alongside the prose, versioned, so a later
    // reader can tell which shape it is looking at.
    expect((row.facts as { version: number }).version).toEqual(expect.any(Number))
    // One row per (section, student) — a second generate must replace, not
    // append, or the cache read (maybeSingle) starts erroring on duplicates.
    expect(summaries.upsert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ onConflict: 'section_id,student_id' }),
    )
  })

  it('skips the model when the stored hash still matches the current signals', async () => {
    authed()
    const { summaries } = adminFor()

    // First generate: nothing cached, so the model runs and writes the key.
    await generateStudentDossierSummary(SECTION, STUDENT)
    expect(mockGenerateInsight).toHaveBeenCalledTimes(1)
    const hash = upsertedRow(summaries).signal_hash

    // Now that key is on the row and the signals have not moved.
    summaries.maybeSingle.mockResolvedValue({
      data: { summary: 'already written', signal_hash: hash, generated_at: '2026-07-31T12:00:00Z' },
      error: null,
    })
    const again = await generateStudentDossierSummary(SECTION, STUDENT)

    expect(mockGenerateInsight).toHaveBeenCalledTimes(1) // no second call — no second bill
    expect(again.data).toEqual({ summary: 'already written', generatedAt: '2026-07-31T12:00:00Z' })
  })

  it('returns an error instead of throwing when the model fails', async () => {
    // The card degrades to "the numbers below are still current" — it can only
    // do that if the action resolves with an error rather than rejecting.
    authed()
    const { summaries } = adminFor()
    mockGenerateInsight.mockRejectedValue(new Error('503 from provider'))

    const res = await generateStudentDossierSummary(SECTION, STUDENT)
    expect(res.error).toBeTruthy()
    expect(res.data).toBeUndefined()
    expect(summaries.upsert).not.toHaveBeenCalled() // no prose, no row
  })
})

describe('getStudentDossier — serves stored prose only while it is still current', () => {
  it('returns the cached narrative on a hash match and withholds it on a mismatch', async () => {
    authed()
    const { summaries } = adminFor()

    // Borrow the action's own hash of the current facts (opaque token).
    await generateStudentDossierSummary(SECTION, STUDENT)
    const hash = upsertedRow(summaries).signal_hash

    summaries.maybeSingle.mockResolvedValue({
      data: { summary: 'stored prose', signal_hash: hash, generated_at: '2026-07-31T12:00:00Z' },
      error: null,
    })
    const fresh = await getStudentDossier(SECTION, STUDENT)
    expect(fresh.data?.summary).toBe('stored prose')
    expect(fresh.data?.summaryGeneratedAt).toBe('2026-07-31T12:00:00Z')

    // A signal moved since it was written: the prose is withheld so the card
    // asks for a rewrite, but the facts (and the avatar) still come back.
    summaries.maybeSingle.mockResolvedValue({
      data: { summary: 'stored prose', signal_hash: 'hash-from-older-signals', generated_at: '2026-07-30T12:00:00Z' },
      error: null,
    })
    const stale = await getStudentDossier(SECTION, STUDENT)
    expect(stale.data?.summary).toBeNull()
    expect(stale.data?.summaryGeneratedAt).toBeNull()
    expect(stale.data?.facts).toEqual(fresh.data?.facts)
    expect(stale.data?.avatarUrl).toBe('https://cdn/a.png')
  })

  it('reports the roster activity stamp and the live class-refresh state to the card', async () => {
    // Both feed UI the client cannot derive: "last active 2h ago" and whether
    // the refresh button must render disabled/busy.
    authed()
    adminFor({ recentJob: { status: 'running', created_at: hoursAgo(0.5) } })

    const res = await getStudentDossier(SECTION, STUDENT)

    expect(res.data?.lastActiveAt).toBe('2026-07-31T09:00:00.000Z')
    expect(res.data?.classRefresh.active).toBe(true)
  })
})

describe('refreshClassInsights — authz', () => {
  // One click fans out to a model call per enrolled student, so a failed guard
  // must not merely fail to write — it must not put the job on the queue.
  it('refuses unauthenticated callers without queuing anything', async () => {
    unauthed()
    const res = await refreshClassInsights(SECTION)
    expect(res.error).toBeTruthy()
    expect(mockAdminClient).not.toHaveBeenCalled()
    expect(mockEnqueueJob).not.toHaveBeenCalled()
  })

  it('refuses a professor who does not own the section', async () => {
    authed()
    adminFor({ owner: 'other-prof' })
    const res = await refreshClassInsights(SECTION)
    expect(res.error).toMatch(/do not own/i)
    expect(mockEnqueueJob).not.toHaveBeenCalled()
  })
})

describe('refreshClassInsights — the cooldown that caps LLM spend', () => {
  it('queues the roster walk with the section tenant and the triggering professor', async () => {
    authed()
    adminFor({ recentJob: null })

    const res = await refreshClassInsights(SECTION)

    expect(res.data).toEqual({ queued: true })
    // institution_id comes from the section row, never the caller — the job row
    // is what the pipeline later derives its whole tenant scope from.
    expect(mockEnqueueJob).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'regenerate_student_insights',
        institutionId: INST,
        sectionId: SECTION,
        createdBy: PROF,
      }),
    )
  })

  it.each(['pending', 'running'])('refuses to stack a second job while one is %s', async (status) => {
    authed()
    adminFor({ recentJob: { status, created_at: hoursAgo(0.1) } })

    const res = await refreshClassInsights(SECTION)

    expect(res.error).toMatch(/already running/i)
    expect(mockEnqueueJob).not.toHaveBeenCalled()
  })

  it('refuses inside the window and tells the professor how long is left', async () => {
    // The arithmetic matters: it is the only feedback the button's tooltip has,
    // and an off-by-one here reads as "refresh again in 0h" on a live cooldown.
    authed()
    adminFor({ recentJob: { status: 'done', created_at: hoursAgo(2) } })

    const res = await refreshClassInsights(SECTION)

    expect(res.error).toMatch(/22h/)
    expect(mockEnqueueJob).not.toHaveBeenCalled()
  })

  it('looks back exactly 24h and lets a failed run go unpunished', async () => {
    // The mock cannot enforce PostgREST filters, so the filters themselves are
    // the assertion: they ARE the cooldown policy (24h window; a run that
    // failed must not burn the professor's one daily refresh).
    authed()
    const { jobs } = adminFor({ recentJob: null })

    await refreshClassInsights(SECTION)

    expect(jobs.eq).toHaveBeenCalledWith('type', 'regenerate_student_insights')
    expect(jobs.eq).toHaveBeenCalledWith('section_id', SECTION)
    expect(jobs.neq).toHaveBeenCalledWith('status', 'failed')
    const windowStart = new Date(jobs.gte.mock.calls[0][1] as string).getTime()
    expect(Date.now() - windowStart).toBeGreaterThan(COOLDOWN_HOURS * HOUR - 5_000)
    expect(Date.now() - windowStart).toBeLessThan(COOLDOWN_HOURS * HOUR + 5_000)
    // Newest first, one row — otherwise an older job in the window decides the state.
    expect(jobs.order).toHaveBeenCalledWith('created_at', { ascending: false })
  })
})

describe('getClassInsightsRefreshStatus', () => {
  it('is owner-gated like the trigger it polls for', async () => {
    authed()
    adminFor({ owner: 'other-prof' })
    const res = await getClassInsightsRefreshStatus(SECTION)
    expect(res.error).toMatch(/do not own/i)
    expect(res.data).toBeUndefined()
  })

  it('clears `active` once the job finishes but keeps the cooldown until 24h after it started', async () => {
    // The card stops polling on !active and reloads; the button must stay
    // disabled afterwards, so these two flags have to move independently.
    authed()
    adminFor({ recentJob: { status: 'done', created_at: '2026-07-31T00:00:00.000Z' } })

    const res = await getClassInsightsRefreshStatus(SECTION)

    expect(res.data).toEqual({ active: false, cooldownUntil: '2026-08-01T00:00:00.000Z', lastStatus: 'done', lastOutcome: null })
  })

  it('reports the button available when nothing ran in the window', async () => {
    authed()
    adminFor({ recentJob: null })
    const res = await getClassInsightsRefreshStatus(SECTION)
    expect(res.data).toEqual({ active: false, cooldownUntil: null, lastStatus: null, lastOutcome: null })
  })
})
