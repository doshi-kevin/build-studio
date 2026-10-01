// gradeSubmission's correction-capture wiring (calibration flywheel, phase 1a).
//
// captureGradingCorrections is unit-tested against a fake client in
// ai-grading-corrections.test.ts. What CANNOT be seen from there is how the action calls
// it, and two of those properties fail silently:
//
//  1. ORDER. Capture reads the suggestion row `WHERE status = 'suggested'`, and
//     supersedeAiSuggestions flips exactly that column. If the two calls are ever
//     reordered, capture finds no row, returns quietly (it is best-effort by design), and
//     the flywheel collects ZERO data forever while every grade still saves and every
//     other test still passes. Nothing in the UI would show it.
//  2. GATING. Only a rubric-ticked commit carries a per-criterion signal. A manual-score
//     save has no ticks, so capturing there would write professor_tick=false against
//     every criterion the AI judged — inventing wholesale disagreement out of a grade
//     that never expressed an opinion, and poisoning the calibration stats.
//
// Also pinned: the payload the action derives itself (grader id from the session, rubric
// version from the assignment's own aiGrading stamp) rather than from the client.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildFullChain } from './helpers/mock-supabase'

const mockGetUser = vi.fn()
const mockVerifySectionAccess = vi.fn()
const mockCapture = vi.fn()
const mockSupersede = vi.fn()

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/skills/grade-hook', () => ({ applyGradeToSkillMastery: vi.fn() }))
vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (fn: () => void) => { void fn },
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}))
vi.mock('@/lib/auth/section-access', () => ({
  verifySectionAccess: (...args: unknown[]) => mockVerifySectionAccess(...args),
  canWriteAsStaff: (role: string) => role === 'professor' || role === 'ta',
  canWriteAsProfessor: (role: string) => role === 'professor',
  canGrade: (role: string) => role === 'professor' || role === 'ta' || role === 'grader',
}))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('@/lib/assignments/ai-grading/corrections', () => ({
  captureGradingCorrections: (...args: unknown[]) => mockCapture(...args),
}))
vi.mock('@/lib/assignments/ai-grading/invalidate', () => ({
  supersedeAiSuggestions: (...args: unknown[]) => mockSupersede(...args),
}))

const SUB_ID = '550e8400-e29b-41d4-a716-446655440000'
const LOADED_AT = '2026-09-07T12:00:00.000Z'
const DRAFT_VERSION = '2026-09-07T11:59:00.000+00:00'
const RUBRIC = {
  questions: [{ label: 'Q1', points: 10, criteria: [{ description: 'c', points: 5 }] }],
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mod: any
let chain: ReturnType<typeof buildFullChain>

/** One gradeable submission whose assignment carries a rubric and an aiGrading stamp. */
async function setup(settings: Record<string, unknown>) {
  vi.resetModules()
  mockGetUser.mockResolvedValue({ data: { user: { id: 'prof-1' } }, error: null })
  chain = buildFullChain({
    data: {
      id: 'sub-1',
      assignment_id: 'asg-1',
      student_id: 'stu-1',
      status: 'submitted',
      score: null,
      feedback: '',
      rubric_scores: [],
      rubric_comments: {},
      graded_with_rubric: false,
      updated_at: LOADED_AT,
      assignment: { section_id: 'sec-1', points: 100, title: 'HW', settings },
    },
    error: null,
  })
  mockVerifySectionAccess.mockResolvedValue({
    ok: true,
    role: 'professor',
    adminDb: { from: vi.fn(() => chain) },
  })
  mod = await import('@/app/(dashboard)/professor/courses/[sectionId]/assignments/actions')
}

beforeEach(() => {
  // mockClear, not mockReset: neither implementation throws, but clearing keeps the
  // invocationCallOrder counters meaningful per test.
  mockCapture.mockClear()
  mockSupersede.mockClear()
  mockGetUser.mockClear()
})

describe('gradeSubmission — correction capture', () => {
  it('captures the diff BEFORE superseding the suggestion, with server-derived payload', async () => {
    await setup({
      rubric: RUBRIC,
      aiGrading: { status: 'ready', refCount: 4, embeddedAt: '2026-09-01T00:00:00Z' },
    })

    const res = await mod.gradeSubmission('sec-1', {
      submissionId: SUB_ID,
      score: 5,
      feedback: 'good',
      rubricScores: ['0:0'],
      expectedUpdatedAt: LOADED_AT,
      suggestionUpdatedAt: DRAFT_VERSION,
    })

    expect(res).toEqual({ success: true })
    expect(mockCapture).toHaveBeenCalledTimes(1)
    expect(mockCapture.mock.calls[0][1]).toEqual({
      submissionId: SUB_ID,
      reviewedSuggestionUpdatedAt: DRAFT_VERSION,
      committedRubricScores: ['0:0'],
      // From the session and the assignment row — never from the client payload.
      graderId: 'prof-1',
      rubricVersion: '2026-09-01T00:00:00Z',
    })

    // The ordering IS the behaviour: supersede clears status='suggested', which is the row
    // capture has to read. Reversed, capture silently sees nothing.
    expect(mockSupersede).toHaveBeenCalledTimes(1)
    expect(mockCapture.mock.invocationCallOrder[0]).toBeLessThan(
      mockSupersede.mock.invocationCallOrder[0],
    )
  })

  it('sends rubricVersion: null when the assignment has no aiGrading stamp', async () => {
    await setup({ rubric: RUBRIC })

    await mod.gradeSubmission('sec-1', {
      submissionId: SUB_ID,
      score: 5,
      feedback: '',
      rubricScores: ['0:0'],
      expectedUpdatedAt: LOADED_AT,
      suggestionUpdatedAt: DRAFT_VERSION,
    })

    expect(mockCapture.mock.calls[0][1]).toMatchObject({ rubricVersion: null })
  })

  it('does NOT capture a manual-score save, but still supersedes the suggestion', async () => {
    await setup({
      rubric: RUBRIC,
      aiGrading: { status: 'ready', refCount: 4, embeddedAt: '2026-09-01T00:00:00Z' },
    })

    // No rubricScores: the professor typed a score. There are no committed ticks to diff,
    // so capturing here would record disagreement on every criterion the AI judged.
    const res = await mod.gradeSubmission('sec-1', {
      submissionId: SUB_ID,
      score: 80,
      feedback: 'typed a number',
      expectedUpdatedAt: LOADED_AT,
      suggestionUpdatedAt: DRAFT_VERSION,
    })

    expect(res).toEqual({ success: true })
    expect(mockCapture).not.toHaveBeenCalled()
    // The draft is still spent — a stale suggestion must not re-show over the saved grade.
    expect(mockSupersede).toHaveBeenCalledTimes(1)
  })

  it('captures nothing when the grade write itself was refused', async () => {
    await setup({ rubric: RUBRIC })

    // A conflicting save: the row moved on since the page loaded, so the guarded UPDATE
    // never lands. Capture must not run on a grade that was never committed.
    const res = await mod.gradeSubmission('sec-1', {
      submissionId: SUB_ID,
      score: 5,
      feedback: '',
      rubricScores: ['0:0'],
      expectedUpdatedAt: '2026-09-07T09:00:00.000Z', // stale baseline
      suggestionUpdatedAt: DRAFT_VERSION,
    })

    expect('error' in res).toBe(true)
    expect(chain.update).not.toHaveBeenCalled()
    expect(mockCapture).not.toHaveBeenCalled()
  })
})
