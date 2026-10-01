// regenerate_student_insights background pipeline — the whole-roster refresh
// behind the dossier card's refresh button. What is worth pinning here is not
// the aggregation (covered by roadmap-dossier.test.ts) but the loop's contract,
// because every one of its mistakes is expensive or invisible:
//
//   - COST: the section-wide inputs must load ONCE for the roster, not per
//     student, and the per-student write path must be the shared hash-guarded
//     one (a student whose signals haven't moved costs no model call).
//   - TENANCY: the section/institution the loop walks come from the JOB ROW,
//     never from `params` — params are attacker-shaped data on a queue.
//   - RESILIENCE: one student blowing up must not strip the rest of the roster
//     of their refresh, but a wholesale failure must fail the job rather than
//     reporting success.
//   - THE NUDGE: the professor gets "it's done" only when the walk actually
//     finished — an aborted (time-budget/cancelled) run must stay quiet, or
//     they trust numbers that were never rewritten.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildFullChain, createTableRouter } from './helpers/mock-supabase'
import { ON_ROSTER_STATUSES } from '@/lib/validations/enrollment'

const mockLoadShared = vi.fn()
const mockRefreshStudentInsight = vi.fn()
const mockEmitEvent = vi.fn()

vi.mock('@/lib/roadmap/dossier-facts', () => ({
  loadSectionInsightShared: (...args: unknown[]) => mockLoadShared(...args),
  refreshStudentInsight: (...args: unknown[]) => mockRefreshStudentInsight(...args),
}))
vi.mock('@/lib/events/emit', () => ({ emitEvent: (...args: unknown[]) => mockEmitEvent(...args) }))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

import { regenerateStudentInsightsPipeline } from '@/lib/jobs/pipelines/regenerate-student-insights'
import type { ProgressEntry } from '@/lib/jobs/types'

const SECTION = 'sec-1'
const INST = 'inst-1'
const PROF = 'prof-1'
const SHARED = { masteryMaps: 'MASTERY', refs: 'REFS' }

/** A job context whose roster is `names`, with progress + abort observable. */
function makeCtx(names: string[], job: Record<string, unknown> = {}) {
  const enrollments = buildFullChain({
    data: names.map((name, i) => ({ student_id: `stu-${i + 1}`, student: { name } })),
    error: null,
  })
  const sections = buildFullChain({ data: { course: { title: 'Natural Language Processing' } }, error: null })
  const progress: ProgressEntry[] = []
  const controller = new AbortController()
  const ctx = {
    adminDb: createTableRouter({ enrollments, course_sections: sections }),
    job: { section_id: SECTION, institution_id: INST, created_by: PROF, ...job },
    signal: controller.signal,
    reportProgress: async (entry: ProgressEntry) => { progress.push(entry) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
  return { ctx, enrollments, progress, controller }
}

/** Per-student outcomes in roster order; `Error` means that student threw. */
function outcomes(...results: (boolean | Error)[]) {
  let i = 0
  mockRefreshStudentInsight.mockImplementation(async () => {
    const r = results[i++]
    if (r instanceof Error) throw r
    return { summary: 'prose', generatedAt: '2026-07-31T12:00:00Z', regenerated: r }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockLoadShared.mockResolvedValue(SHARED)
  mockEmitEvent.mockResolvedValue(undefined)
  outcomes(true, true, true)
})

describe('regenerate_student_insights — cost discipline', () => {
  it('loads the section-wide inputs once for the whole roster and hands them to every student', async () => {
    // The whole point of the shared load: N students must not mean N mastery
    // rebuilds. If this regresses, the job still "works" — it just gets
    // linearly more expensive with class size, silently.
    const { ctx } = makeCtx(['Ada', 'Grace', 'Alan'])

    await regenerateStudentInsightsPipeline.run({}, ctx)

    expect(mockLoadShared).toHaveBeenCalledTimes(1)
    expect(mockRefreshStudentInsight).toHaveBeenCalledTimes(3)
    for (const call of mockRefreshStudentInsight.mock.calls) {
      expect(call[1]).toMatchObject({ shared: SHARED })
    }
  })

  it('reports rewritten vs already-current separately, so an all-cached run is visible as free', async () => {
    const { ctx } = makeCtx(['Ada', 'Grace', 'Alan'])
    outcomes(true, false, false)

    const out = await regenerateStudentInsightsPipeline.run({}, ctx)

    expect(out.result).toEqual({ regenerated: 1, unchanged: 2, failed: 0, total: 3 })
    expect(out.summary).toMatch(/1 summary rewritten, 2 already current/)
  })

  it('does nothing and says so for an empty roster', async () => {
    const { ctx } = makeCtx([])

    const out = await regenerateStudentInsightsPipeline.run({}, ctx)

    expect(mockRefreshStudentInsight).not.toHaveBeenCalled()
    expect(out.result).toEqual({ regenerated: 0, unchanged: 0, failed: 0, total: 0 })
    expect(out.summary).toMatch(/nothing to refresh/i)
  })
})

describe('regenerate_student_insights — scope comes from the job row', () => {
  it('ignores params entirely and walks the job\'s own section + institution', async () => {
    // Job params are persisted, replayable data. If the loop trusted them, a
    // crafted/stale row could aim an admin-client walk at another tenant.
    const { ctx, enrollments } = makeCtx(['Ada'])

    await regenerateStudentInsightsPipeline.run(
      { sectionId: 'someone-elses-section', institutionId: 'someone-elses-institution' },
      ctx,
    )

    expect(enrollments.eq).toHaveBeenCalledWith('section_id', SECTION)
    expect(enrollments.eq).not.toHaveBeenCalledWith('section_id', 'someone-elses-section')
    expect(mockLoadShared).toHaveBeenCalledWith(expect.anything(), SECTION)
    expect(mockRefreshStudentInsight).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sectionId: SECTION, institutionId: INST, studentId: 'stu-1' }),
    )
  })

  it('refuses to run at all when the job carries no section', async () => {
    const { ctx } = makeCtx(['Ada'], { section_id: null })

    await expect(regenerateStudentInsightsPipeline.run({}, ctx)).rejects.toThrow(/no section/i)
    expect(mockRefreshStudentInsight).not.toHaveBeenCalled()
  })

  it('only refreshes students actually on the roster', async () => {
    // A withdrawn student must not have a fresh AI narrative written about
    // them (and must not be billed for).
    const { ctx, enrollments } = makeCtx(['Ada'])

    await regenerateStudentInsightsPipeline.run({}, ctx)

    expect(enrollments.in).toHaveBeenCalledWith('status', ON_ROSTER_STATUSES)
  })
})

describe('regenerate_student_insights — failure handling', () => {
  it('keeps walking the roster when one student fails, and counts the casualty', async () => {
    const { ctx, progress } = makeCtx(['Ada', 'Grace', 'Alan'])
    outcomes(true, new Error('model 503'), true)

    const out = await regenerateStudentInsightsPipeline.run({}, ctx)

    expect(mockRefreshStudentInsight).toHaveBeenCalledTimes(3)
    expect(out.result).toEqual({ regenerated: 2, unchanged: 0, failed: 1, total: 3 })
    expect(out.summary).toMatch(/1 failed/)
    expect(progress.filter((p) => p.status === 'error').map((p) => p.label)).toEqual(['Grace'])
    expect(progress.filter((p) => p.status === 'done').map((p) => p.label)).toEqual(['Ada', 'Alan'])
  })

  it('throws when every student failed, so the job row records a failure', async () => {
    // A run where nothing worked must not land as a green "done" job — the
    // professor would read stale prose as freshly written.
    const { ctx } = makeCtx(['Ada', 'Grace'])
    outcomes(new Error('boom'), new Error('boom'))

    await expect(regenerateStudentInsightsPipeline.run({}, ctx)).rejects.toThrow(/all 2 students failed/)
  })
})

describe('regenerate_student_insights — the completion nudge', () => {
  it('notifies only the professor who triggered it, pointing at their roadmap', async () => {
    const { ctx } = makeCtx(['Ada', 'Grace'])
    outcomes(true, false)

    await regenerateStudentInsightsPipeline.run({}, ctx)

    expect(mockEmitEvent).toHaveBeenCalledTimes(1)
    expect(mockEmitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'class_insights_refreshed',
        sectionId: SECTION,
        audience: [PROF],
        linkUrl: `/professor/courses/${SECTION}/roadmap`,
      }),
    )
    // The body carries the same rollup the job row got — one source of truth.
    const body = (mockEmitEvent.mock.calls[0][0] as { body: string }).body
    expect(body).toMatch(/1 summary rewritten, 1 already current/)
  })

  it('stays quiet when the run was aborted part-way through the roster', async () => {
    // Abort = time budget hit or the job was cancelled. Telling the professor
    // "insights refreshed" here would be a lie about most of the class.
    const { ctx, controller } = makeCtx(['Ada', 'Grace', 'Alan'])
    mockRefreshStudentInsight.mockImplementation(async () => {
      controller.abort()
      return { summary: 'prose', generatedAt: '2026-07-31T12:00:00Z', regenerated: true }
    })

    const out = await regenerateStudentInsightsPipeline.run({}, ctx)

    expect(mockRefreshStudentInsight).toHaveBeenCalledTimes(1)
    expect(mockEmitEvent).not.toHaveBeenCalled()
    // The partial rollup still comes back — the worker records what got done.
    expect(out.result).toEqual({ regenerated: 1, unchanged: 0, failed: 0, total: 3 })
  })

  it('skips the nudge for a job with no creator (a sweep-enqueued run)', async () => {
    const { ctx } = makeCtx(['Ada'], { created_by: null })

    await regenerateStudentInsightsPipeline.run({}, ctx)

    expect(mockRefreshStudentInsight).toHaveBeenCalledTimes(1)
    expect(mockEmitEvent).not.toHaveBeenCalled()
  })
})
