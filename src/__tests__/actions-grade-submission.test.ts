// gradeSubmission must reject a score above the assignment's own points — the client
// guards it, but the server is the source of truth, so a crafted call mustn't inflate
// the gradebook (PR #198 review, blocking #2). Zod allows 0..1000; the per-assignment
// ceiling is the business rule tested here.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockAdminClient, buildFullChain, createTableRouter } from './helpers/mock-supabase'

const mockGetUser = vi.fn()
const mockVerifySectionAccess = vi.fn()
let adminClient: ReturnType<typeof createMockAdminClient>

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
// gradeSubmission awaits applyGradeToSkillMastery on the real write path; it calls the real
// createAdminClient(), so without this mock the provenance tests attempt a live network call and
// hang past vitest's 5s timeout (same reason actions-reopen-window.test.ts mocks it).
vi.mock('@/lib/skills/grade-hook', () => ({ applyGradeToSkillMastery: vi.fn() }))
// gradeSubmission also schedules a post-response mastery recompute via next/server's after(); in a
// unit test there's no request scope, so stub it to a no-op.
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
  /* #746: score writes admit graders. */
  canGrade: (role: string) => role === 'professor' || role === 'ta' || role === 'grader',
}))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mod: any

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset().mockResolvedValue({ data: { user: { id: 'prof-1' } }, error: null })
  // Submission in 'sec-1' whose assignment is worth 100 points.
  adminClient = createMockAdminClient({
    assignment_submissions: {
      data: { id: 'sub-1', assignment_id: 'asg-1', assignment: { section_id: 'sec-1', points: 100 } },
      error: null,
    },
  })
  mockVerifySectionAccess.mockReset().mockResolvedValue({ ok: true, role: 'professor', adminDb: adminClient })
  mod = await import('@/app/(dashboard)/professor/courses/[sectionId]/assignments/actions')
})

describe('gradeSubmission — score ceiling', () => {
  it('rejects a score above the assignment points (no gradebook inflation)', async () => {
    const res = await mod.gradeSubmission('sec-1', {
      submissionId: '550e8400-e29b-41d4-a716-446655440000',
      score: 1000,
      feedback: '',
    })
    expect(res).toEqual({ error: expect.stringContaining('100 points') })
    // Guard fires before any write: only the lookup touched the table, not an update.
    const writes = adminClient._tableCalls.filter((t) => t === 'assignment_submissions')
    expect(writes).toHaveLength(1)
  })

  it('still enforces the ceiling when rubricScores is supplied (rubric path is no bypass)', async () => {
    // Rubric grading sums criteria client-side into `score`; the server must still
    // bound that score by the assignment points, not trust the rubric path.
    const res = await mod.gradeSubmission('sec-1', {
      submissionId: '550e8400-e29b-41d4-a716-446655440000',
      score: 150,
      feedback: '',
      rubricScores: ['0:0', '0:1'],
    })
    expect(res).toEqual({ error: expect.stringContaining('100 points') })
    const writes = adminClient._tableCalls.filter((t) => t === 'assignment_submissions')
    expect(writes).toHaveLength(1) // lookup only — no update
  })
})

describe('gradeSubmission — a returned submission is not gradeable', () => {
  // The grader hides every save control while a submission is `returned`, but the invariant has to
  // live on the server too: a stale second tab (or a TA returning the work in parallel) would
  // otherwise still land the write, flipping the row to `graded` and silently cancelling the change
  // request the student was asked to act on.
  it('refuses to grade a returned submission, and writes nothing', async () => {
    adminClient = createMockAdminClient({
      assignment_submissions: {
        data: {
          id: 'sub-1',
          assignment_id: 'asg-1',
          status: 'returned',
          assignment: { section_id: 'sec-1', points: 100 },
        },
        error: null,
      },
    })
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb: adminClient })

    const res = await mod.gradeSubmission('sec-1', {
      submissionId: '550e8400-e29b-41d4-a716-446655440000',
      score: 85,
      feedback: 'looks good now',
    })

    expect(res).toEqual({ error: expect.stringContaining('revise') })
    // Only the lookup touched the table — no update.
    expect(adminClient._tableCalls.filter((t) => t === 'assignment_submissions')).toHaveLength(1)
  })

  it('still grades a normally submitted submission (the guard is not over-broad)', async () => {
    // buildFullChain (not createMockAdminClient) because this one reaches the .update() write.
    const chain = buildFullChain({
      data: {
        id: 'sub-1', assignment_id: 'asg-1', student_id: 'stu-1', status: 'submitted',
        score: null, feedback: '', rubric_scores: [], rubric_comments: {}, graded_with_rubric: false,
        assignment: { section_id: 'sec-1', points: 100, title: 'HW', settings: {} },
      },
      error: null,
    })
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb: { from: vi.fn(() => chain) } })

    const res = await mod.gradeSubmission('sec-1', {
      submissionId: '550e8400-e29b-41d4-a716-446655440000',
      score: 85,
      feedback: 'nice work',
    })

    expect(res).toEqual({ success: true })
    expect((chain.update.mock.calls[0][0] as { status: string }).status).toBe('graded')
  })
})

describe('gradeSubmission — no-op re-save', () => {
  it('treats a same-values re-save as a no-op even when rubric-comment keys are reordered', async () => {
    // The stored comments come back from jsonb in normalized key order; the client sends them in
    // insertion order. A plain stringify comparison would false-negative here and re-stamp
    // graded_at / log a phantom "graded" event. canonComments sorts keys, so this must be a no-op.
    const stored = {
      id: 'sub-1',
      assignment_id: 'asg-1',
      student_id: 'stu-1',
      status: 'graded',
      score: 40,
      feedback: 'Great work',
      rubric_scores: ['0:0', '0:1'],
      rubric_comments: { '1': 'clarity', '0': 'thesis' }, // reversed vs the incoming payload
      graded_with_rubric: true,
      // A rubric exists on the assignment, so graded_with_rubric derives to true (matches the row),
      // keeping this a genuine no-op.
      assignment: {
        section_id: 'sec-1', points: 100, title: 'HW1',
        settings: { rubric: { questions: [{ label: 'Q1', points: 100, criteria: [{ description: 'Thesis', points: 50 }] }] } },
      },
    }
    const client = createMockAdminClient({ assignment_submissions: { data: stored, error: null } })
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb: client })

    const res = await mod.gradeSubmission('sec-1', {
      submissionId: '550e8400-e29b-41d4-a716-446655440000',
      score: 40,
      feedback: 'Great work',
      rubricScores: ['0:1', '0:0'], // reordered — sameRubricScores already sorts
      rubricComments: { '0': 'thesis', '1': 'clarity' }, // same content, different key order
    })

    expect(res).toEqual({ success: true })
    // No-op returns before writing: only the lookup touched the table, no update.
    const writes = client._tableCalls.filter((t) => t === 'assignment_submissions')
    expect(writes).toHaveLength(1)
  })
})

describe('gradeSubmission — clearing stale rubric ticks is a real change, not a no-op', () => {
  // "Keep this score" on a grade whose rubric changed sends rubricScores: [] so the stale positional
  // keys are cleared. If the no-op guard treated that as "nothing changed" it would write nothing and
  // the professor would be re-asked "the rubric changed…" on every visit, forever.
  it('writes rubric_scores: [] when the stored ticks are stale and everything else matches', async () => {
    const chain = buildFullChain({
      data: {
        id: 'sub-1', assignment_id: 'asg-1', student_id: 'stu-1', status: 'graded',
        score: 10, feedback: 'kept', rubric_scores: ['0:1'], rubric_comments: {}, graded_with_rubric: true,
        assignment: {
          section_id: 'sec-1', points: 100, title: 'HW',
          settings: { rubric: { questions: [{ label: 'Q1', points: 40, criteria: [{ description: 'c', points: 10 }] }] } },
        },
      },
      error: null,
    })
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb: { from: vi.fn(() => chain) } })

    const res = await mod.gradeSubmission('sec-1', {
      submissionId: '550e8400-e29b-41d4-a716-446655440000',
      score: 10,
      feedback: 'kept',
      rubricScores: [],
    })

    expect(res).toEqual({ success: true })
    const written = chain.update.mock.calls[0][0] as { rubric_scores: string[]; score: number }
    expect(written.rubric_scores).toEqual([])
    // ...and the kept score survives.
    expect(written.score).toBe(10)
  })
})

describe('gradeSubmission — graded_with_rubric provenance (the manual-after-rubric fix)', () => {
  const run = async (settings: Record<string, unknown>, submissionId = '550e8400-e29b-41d4-a716-446655440000') => {
    const chain = buildFullChain({
      data: {
        id: 'sub-1', assignment_id: 'asg-1', student_id: 'stu-1', status: 'submitted',
        score: null, feedback: '', rubric_scores: [], rubric_comments: {}, graded_with_rubric: false,
        assignment: { section_id: 'sec-1', points: 100, title: 'HW', settings },
      },
      error: null,
    })
    const adminDb = { from: vi.fn(() => chain) }
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb })
    // Manual path: no rubricScores sent (the professor used the score field).
    const res = await mod.gradeSubmission('sec-1', { submissionId, score: 80, feedback: 'good' })
    return { res, chain }
  }
  const RUBRIC = { rubric: { questions: [{ label: 'Q1', points: 100, criteria: [{ description: 'c', points: 50 }] }] } }

  it('writes graded_with_rubric=TRUE on a real manual grade when the assignment has a rubric', async () => {
    // The crux of MAJOR 5: even without rubricScores, a grade saved while a rubric exists is
    // intentional and must persist true so segmentRoster keeps it in Graded (not re-flagged).
    const { res, chain } = await run(RUBRIC)
    expect(res).toEqual({ success: true })
    expect((chain.update.mock.calls[0][0] as { graded_with_rubric: boolean }).graded_with_rubric).toBe(true)
  })

  it('writes graded_with_rubric=FALSE when the assignment has no rubric', async () => {
    const { res, chain } = await run({})
    expect(res).toEqual({ success: true })
    expect((chain.update.mock.calls[0][0] as { graded_with_rubric: boolean }).graded_with_rubric).toBe(false)
  })
})

/**
 * Concurrent grading. Two people on one submission — a professor and a TA, or two graders
 * splitting a pile — is the ordinary case, and the write was a plain UPDATE by id, so the
 * later save overwrote the earlier one and told nobody.
 *
 * The oracle is that the losing grader is TOLD. A test asserting only "the row ends up with
 * one score" would have passed against the broken code: the database was always consistent;
 * the loss was silent.
 *
 * Note the baseline has to come from the client. The server's own read is fresh by
 * definition, so comparing against it would let every overwrite through — which is why
 * these tests drive `expectedUpdatedAt` rather than anything the action reads itself.
 */
describe('gradeSubmission — concurrent grade guard', () => {
  const SUB_ID = '550e8400-e29b-41d4-a716-446655440000'
  const LOADED_AT = '2026-08-10T12:00:00.000Z'
  const GRADED_SINCE = '2026-08-10T12:05:00.000Z'

  /** One persistent chain for the table, so the SELECT and the UPDATE are both observable. */
  async function withRowUpdatedAt(updatedAt: string) {
    vi.resetModules()
    const subs = buildFullChain({
      data: {
        id: 'sub-1',
        assignment_id: 'asg-1',
        student_id: 'stu-1',
        status: 'submitted',
        score: null,
        feedback: '',
        updated_at: updatedAt,
        assignment: { section_id: 'sec-1', points: 100 },
      },
      error: null,
    })
    const client = createTableRouter({ assignment_submissions: subs })
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb: client })
    const m = await import('@/app/(dashboard)/professor/courses/[sectionId]/assignments/actions')
    return { m, subs }
  }

  it('refuses the save when the row changed since the grader loaded the page', async () => {
    // The grader's page saw LOADED_AT; someone else graded since, so the row is newer.
    const { m, subs } = await withRowUpdatedAt(GRADED_SINCE)

    const res = await m.gradeSubmission('sec-1', {
      submissionId: SUB_ID,
      score: 15,
      feedback: '',
      expectedUpdatedAt: LOADED_AT,
    })

    expect(res).toEqual({ error: expect.stringContaining('graded this submission') })
    // and critically: nothing was written
    expect(subs.update).not.toHaveBeenCalled()
  })

  it('lets the save through when the row is untouched since the page loaded', async () => {
    const { m, subs } = await withRowUpdatedAt(LOADED_AT)

    const res = await m.gradeSubmission('sec-1', {
      submissionId: SUB_ID,
      score: 15,
      feedback: '',
      expectedUpdatedAt: LOADED_AT,
    })

    expect(res).not.toEqual({ error: expect.stringContaining('graded this submission') })
    expect(subs.update).toHaveBeenCalled()
  })

  /* Raised by CodeRabbit on PR #624 and it was right: the guard read
     `if (expectedUpdatedAt && ...)`, and the field is OPTIONAL in the schema — so omitting it
     skipped the freshness check entirely and re-enabled the silent overwrite #610 exists to
     prevent. Our own grader always sends it, but a stale bundle or any direct caller would not.
     "No token" must never mean "no conflict" on a check whose job is refusing unverified writes. */
  it('refuses a blind write when NO baseline is supplied and the row has a version', async () => {
    const { m, subs } = await withRowUpdatedAt(GRADED_SINCE)

    const res = await m.gradeSubmission('sec-1', {
      submissionId: SUB_ID,
      score: 15,
      feedback: '',
      // expectedUpdatedAt deliberately omitted
    })

    expect('error' in res).toBe(true)
    const msg = 'error' in res ? res.error : ''
    expect(msg).toMatch(/latest version/i)
    // The oracle is that NOTHING was written — an error alone would also be true of a rejection
    // for some unrelated reason.
    expect(subs.update).not.toHaveBeenCalled()
  })

  it('pins the write itself to the row version it read (closing the read-to-write window)', async () => {
    const { m, subs } = await withRowUpdatedAt(LOADED_AT)

    await m.gradeSubmission('sec-1', {
      submissionId: SUB_ID,
      score: 15,
      feedback: '',
      expectedUpdatedAt: LOADED_AT,
    })

    // Two callers can both clear the baseline check and still race here, so the UPDATE has to
    // carry the version in its WHERE rather than trusting the earlier read.
    expect(subs.eq).toHaveBeenCalledWith('updated_at', LOADED_AT)
  })
})

/* The feedback ceiling is enforced in THREE places that must not drift — the two schemas, the
   textarea's maxLength, and Athena's fill. Boundary tests requested in review: the limit itself
   must pass and one character past it must fail, so a future off-by-one is caught here rather
   than by a professor losing a long piece of feedback at save time. */
describe('feedback length boundary', () => {
  it('accepts feedback of exactly MAX_GRADE_FEEDBACK_LENGTH and rejects one more', async () => {
    const { gradeSubmissionSchema, MAX_GRADE_FEEDBACK_LENGTH } = await import('@/lib/validations/assignment')
    const base = { submissionId: '11111111-1111-4111-8111-111111111111', score: 1 }

    const atLimit = gradeSubmissionSchema.safeParse({
      ...base, feedback: 'x'.repeat(MAX_GRADE_FEEDBACK_LENGTH),
    })
    expect(atLimit.success).toBe(true)

    const overLimit = gradeSubmissionSchema.safeParse({
      ...base, feedback: 'x'.repeat(MAX_GRADE_FEEDBACK_LENGTH + 1),
    })
    expect(overLimit.success).toBe(false)
  })
})
