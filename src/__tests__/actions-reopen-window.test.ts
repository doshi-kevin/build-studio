// reopenSubmission + requestChanges: invalid-window rejection, custom until window,
// and graded-but-never-submitted stub reset.
// Pattern 2: module-level mock vars + vi.mock + vi.resetModules() + dynamic import.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetUser = vi.fn()
const mockVerifySectionAccess = vi.fn()
const mockLogEvent = vi.fn()
const mockEmitEvent = vi.fn()

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}))
vi.mock('@/lib/auth/section-access', () => ({
  verifySectionAccess: (...args: unknown[]) => mockVerifySectionAccess(...args),
  canWriteAsStaff: (role: string) => role === 'professor' || role === 'ta',
}))
vi.mock('@/lib/supabase/event-logger', () => ({
  logEvent: (...args: unknown[]) => mockLogEvent(...args),
}))
vi.mock('@/lib/events/emit', () => ({
  emitEvent: (...args: unknown[]) => mockEmitEvent(...args),
  emitContentChange: vi.fn(),
}))
vi.mock('@/lib/email', () => ({ sendResubmissionRequested: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
// Heavy AI / external deps the professor actions import but we don't need
vi.mock('ai', () => ({ generateText: vi.fn() }))
vi.mock('@ai-sdk/google', () => ({ google: vi.fn() }))
vi.mock('@/lib/skills/grade-hook', () => ({ applyGradeToSkillMastery: vi.fn() }))
vi.mock('@/lib/extraction/enqueue', () => ({ enqueueMasteryRecompute: vi.fn() }))
vi.mock('next/server', () => ({ after: vi.fn((fn: () => void) => fn()) }))
vi.mock('@/lib/grades/fetch', () => ({ removeItemFromScheme: vi.fn() }))
vi.mock('@/lib/validations/studio', () => ({
  studioDocSchema: { safeParse: vi.fn() },
  assignmentDocumentSchema: { safeParse: vi.fn() },
  emptyAssignmentDocument: vi.fn(),
  parseAssignmentDocument: vi.fn().mockReturnValue(null),
}))
vi.mock('@/lib/assignments/studio/notebook-templates', () => ({ getNotebookTemplate: vi.fn() }))
vi.mock('@/lib/wolfram/client', () => ({ runWolfram: vi.fn() }))
vi.mock('@/lib/assignments/studio/notebook-model', () => ({
  emptyNotebook: vi.fn(),
  parseNotebookModel: vi.fn().mockReturnValue(null),
}))
vi.mock('@/lib/validations/verbal-assessment', () => ({
  verbalAssessmentSchema: { safeParse: vi.fn() },
}))
vi.mock('@/lib/assignments/verbal/config', () => ({ defaultVerbalAssessment: vi.fn() }))
vi.mock('@/lib/assignments/verbal/verbal-templates', () => ({ getVerbalTemplate: vi.fn() }))
vi.mock('@/lib/ai/elevenlabs/tts', () => ({ synthesizeSpeech: vi.fn() }))
vi.mock('@/lib/supabase/signed-urls', () => ({ signOne: vi.fn() }))
vi.mock('@/lib/supabase/storage', () => ({
  COURSE_MATERIALS_BUCKET: 'course-materials',
  ASSIGNMENT_CELL_IMAGES_BUCKET: 'assignment-cell-images',
  ASSIGNMENT_SUBMISSIONS_BUCKET: 'assignment-submissions',
}))
vi.mock('@/lib/document-parser', () => ({ parseDocument: vi.fn(), getTextForLLM: vi.fn() }))
vi.mock('@/lib/assignments/rubric-ai', () => ({ generateRubricFromText: vi.fn() }))
vi.mock('@/lib/assignments/studio/rubric-source', () => ({
  studioNotebookToRubricText: vi.fn(),
  studioDocumentToRubricText: vi.fn(),
}))
vi.mock('@/lib/events/content-change', () => ({ emitContentChange: vi.fn() }))

const FUTURE = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()

/** Build a per-table admin client for reopenSubmission.
 *
 *  Tables touched:
 *    assignments        → assignment row
 *    enrollments        → isEnrolledInSection
 *    assignment_submissions → upsert stub + graded-reset update + stamp update
 */
function makeReopenAdmin({
  assignment = { id: 'asg-1', section_id: 'sec-1', institution_id: 'inst-1', title: 'HW 1' } as unknown,
  enrollmentStatus = 'enrolled' as string | null,
  upsertError = null as { message: string } | null,
  resetUpdateRows = [] as unknown[], // rows from the graded-reset update (submitted_at IS NULL)
  stampUpdateError = null as { message: string } | null,
  captureStampPayload = false,
  subRow = null as unknown, // the existing submission row read by the assessment in-progress guard
  resetError = null as { message: string } | null, // drives the assessment reset UPDATE result
} = {}) {
  const upsert = vi.fn().mockResolvedValue({ error: upsertError })
  const storageRemove = vi.fn().mockResolvedValue({ data: null, error: null })

  // The graded-reset update chain (.update().eq().eq().is().eq())
  // returns with a thenable (no .select() needed)
  const resetChain: Record<string, unknown> = {}
  resetChain.eq = vi.fn().mockReturnValue(resetChain)
  resetChain.is = vi.fn().mockReturnValue(resetChain)
  // thenable — the action awaits the chain directly (no .select())
  const resolvedReset = { data: resetUpdateRows, error: resetError }
  Object.assign(resetChain, { then: (r: (v: unknown) => void) => Promise.resolve(resolvedReset).then(r) })

  // The stamp update chain (.update().eq().eq())
  let stampPayload: unknown
  const stampChain: Record<string, unknown> = {}
  stampChain.eq = vi.fn().mockReturnValue(stampChain)
  // thenable
  const resolvedStamp = { data: null, error: stampUpdateError }
  Object.assign(stampChain, { then: (r: (v: unknown) => void) => Promise.resolve(resolvedStamp).then(r) })

  let updateCallCount = 0
  const updateFn = vi.fn().mockImplementation((payload: unknown) => {
    updateCallCount++
    if (captureStampPayload && updateCallCount === 2) stampPayload = payload
    // First update = graded-reset; second = stamp
    return updateCallCount === 1 ? resetChain : stampChain
  })

  const subChain: Record<string, unknown> = {}
  subChain.select = () => subChain
  subChain.eq = () => subChain
  subChain.in = () => subChain
  subChain.is = () => subChain
  subChain.maybeSingle = () => Promise.resolve({ data: subRow, error: null })
  subChain.upsert = upsert
  subChain.update = updateFn

  const chainFor = (data: unknown) => {
    const c: Record<string, unknown> = {}
    c.select = () => c
    c.eq = () => c
    c.in = () => c
    c.is = () => c
    c.maybeSingle = () => Promise.resolve({ data, error: null })
    c.upsert = upsert
    c.update = updateFn
    return c
  }

  const adminDb = {
    from: (t: string) => {
      if (t === 'assignments') return chainFor(assignment)
      if (t === 'enrollments') {
        return chainFor(enrollmentStatus ? { status: enrollmentStatus } : null)
      }
      if (t === 'assignment_submissions') return subChain
      return chainFor(null)
    },
    storage: { from: () => ({ remove: storageRemove }) },
  }

  return { adminDb, upsert, updateFn, storageRemove, getStampPayload: () => stampPayload }
}

/** Build admin client for requestChanges. */
function makeRequestChangesAdmin({
  submission = {
    id: 'sub-1',
    assignment_id: 'asg-1',
    student_id: 'stu-1',
    assignment: { section_id: 'sec-1', title: 'HW 1' },
  } as unknown,
  updateError = null as { message: string } | null,
  captureUpdatePayload = false,
} = {}) {
  let capturedPayload: unknown
  const updateChain: Record<string, unknown> = {}
  updateChain.eq = vi.fn().mockReturnValue(updateChain)
  const resolved = { data: null, error: updateError }
  Object.assign(updateChain, { then: (r: (v: unknown) => void) => Promise.resolve(resolved).then(r) })

  const updateFn = vi.fn().mockImplementation((payload: unknown) => {
    if (captureUpdatePayload) capturedPayload = payload
    return updateChain
  })

  const chainFor = (data: unknown) => {
    const c: Record<string, unknown> = {}
    c.select = () => c
    c.eq = () => c
    c.maybeSingle = () => Promise.resolve({ data, error: null })
    c.update = updateFn
    return c
  }

  const adminDb = {
    from: (t: string) => {
      if (t === 'assignment_submissions') return chainFor(submission)
      if (t === 'profiles') return chainFor({ email: 'stu@x.edu', name: 'Student' })
      return chainFor(null)
    },
  }

  return { adminDb, updateFn, getCapturedPayload: () => capturedPayload }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mod: any

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset().mockResolvedValue({ data: { user: { id: 'prof-1' } }, error: null })
  mockLogEvent.mockReset()
  mockEmitEvent.mockReset()
  mod = await import('@/app/(dashboard)/professor/courses/[sectionId]/assignments/actions')
})

describe('reopenSubmission — invalid window', () => {
  it('9. { hours: 0 } is invalid → returns invalid-window error', async () => {
    const { adminDb } = makeReopenAdmin()
    mockVerifySectionAccess.mockReset().mockResolvedValue({ ok: true, role: 'professor', adminDb })
    const res = await mod.reopenSubmission('sec-1', 'asg-1', 'stu-1', { hours: 0 })
    expect(res).toEqual({ error: 'Invalid reopen window.' })
  })

  it('9b. a past { until } is invalid → returns invalid-window error', async () => {
    const { adminDb } = makeReopenAdmin()
    mockVerifySectionAccess.mockReset().mockResolvedValue({ ok: true, role: 'professor', adminDb })
    const pastUntil = new Date(Date.now() - 60_000).toISOString()
    const res = await mod.reopenSubmission('sec-1', 'asg-1', 'stu-1', { until: pastUntil })
    expect(res).toEqual({ error: 'Invalid reopen window.' })
  })
})

describe('reopenSubmission — custom until window', () => {
  it('10. custom { until } is honored: resubmit_until written equals the passed value', async () => {
    const { adminDb, getStampPayload } = makeReopenAdmin({ captureStampPayload: true })
    mockVerifySectionAccess.mockReset().mockResolvedValue({ ok: true, role: 'professor', adminDb })
    const res = await mod.reopenSubmission('sec-1', 'asg-1', 'stu-1', { until: FUTURE })
    expect(res).toEqual({ success: true })
    // The stamp update payload must carry exactly the passed `until` value
    const payload = getStampPayload() as Record<string, unknown>
    expect(payload).toBeDefined()
    expect(payload.resubmit_until).toBe(FUTURE)
  })
})

describe('reopenSubmission — non-assessment graded-but-never-submitted reset', () => {
  it('11. non-assessment: reset update is scoped to submitted_at IS NULL and status=graded', async () => {
    // No settings.assessment.enabled → takes the non-assessment branch
    const { adminDb, updateFn } = makeReopenAdmin()
    mockVerifySectionAccess.mockReset().mockResolvedValue({ ok: true, role: 'professor', adminDb })
    const res = await mod.reopenSubmission('sec-1', 'asg-1', 'stu-1', { hours: 24 })
    expect(res).toEqual({ success: true })

    // Two update calls: first = graded-reset (scoped), second = stamp
    expect(updateFn).toHaveBeenCalledTimes(2)

    // The graded-reset chain must have received .is() and .eq() for the submitted_at/status scope.
    // We verify indirectly: the first call to updateFn returns a chain whose .is was called.
    const firstCallReturnedChain = updateFn.mock.results[0].value as Record<string, ReturnType<typeof vi.fn>>
    // The chain's .is() should have been called with ('submitted_at', null)
    expect(firstCallReturnedChain.is).toHaveBeenCalledWith('submitted_at', null)
    // And .eq() should have been called with ('status', 'graded')
    const eqCalls = (firstCallReturnedChain.eq as ReturnType<typeof vi.fn>).mock.calls
    expect(eqCalls.some((c: unknown[]) => c[0] === 'status' && c[1] === 'graded')).toBe(true)
  })
})

describe('reopenSubmission — assessment reset (3a/3b fix)', () => {
  const assessmentAssignment = {
    id: 'asg-1',
    section_id: 'sec-1',
    institution_id: 'inst-1',
    title: 'Quiz 1',
    settings: { assessment: { enabled: true, workMinutes: 30, uploadMinutes: 5 } },
  }

  it('11b. assessment: reset update has no submitted_at/status filter (all statuses reset)', async () => {
    const { adminDb, updateFn } = makeReopenAdmin({ assignment: assessmentAssignment })
    mockVerifySectionAccess.mockReset().mockResolvedValue({ ok: true, role: 'professor', adminDb })
    const res = await mod.reopenSubmission('sec-1', 'asg-1', 'stu-1', { hours: 24 })
    expect(res).toEqual({ success: true })

    // Two update calls: first = assessment reset, second = stamp
    expect(updateFn).toHaveBeenCalledTimes(2)

    const firstCallReturnedChain = updateFn.mock.results[0].value as Record<string, ReturnType<typeof vi.fn>>
    // Assessment reset must NOT scope to submitted_at IS NULL (no .is() filter)
    expect(firstCallReturnedChain.is).not.toHaveBeenCalled()
    // And must NOT scope to status=graded
    const eqCalls = (firstCallReturnedChain.eq as ReturnType<typeof vi.fn>).mock.calls
    expect(eqCalls.some((c: unknown[]) => c[0] === 'status')).toBe(false)
  })

  it('11c. assessment: reset payload clears assessment_started_at, submitted_at, score, and sets status=draft', async () => {
    const { adminDb, updateFn } = makeReopenAdmin({ assignment: assessmentAssignment })
    mockVerifySectionAccess.mockReset().mockResolvedValue({ ok: true, role: 'professor', adminDb })
    const res = await mod.reopenSubmission('sec-1', 'asg-1', 'stu-1', { hours: 24 })
    expect(res).toEqual({ success: true })

    // First update call = the assessment reset payload
    const resetPayload = updateFn.mock.calls[0][0] as Record<string, unknown>
    expect(resetPayload.status).toBe('draft')
    expect(resetPayload.assessment_started_at).toBeNull()
    expect(resetPayload.submitted_at).toBeNull()
    expect(resetPayload.score).toBeNull()
    expect(resetPayload.graded_at).toBeNull()
    // Rubric fields must be cleared so the grader panel doesn't pre-select old ticks.
    expect(resetPayload.rubric_scores).toEqual([])
    expect(resetPayload.rubric_comments).toEqual({})
    expect(resetPayload.graded_with_rubric).toBe(false)
  })

  it('11d. assessment: refuses to reopen an IN-PROGRESS attempt (started, window open) — no wipe', async () => {
    // Student started 1 min ago; the 30-min work window is still open → phase is not 'closed'.
    // Reopening now would delete their live attempt, so the server must reject before any reset.
    const startedAt = new Date(Date.now() - 60_000).toISOString()
    const { adminDb, updateFn } = makeReopenAdmin({
      assignment: assessmentAssignment,
      subRow: { files: [], status: 'draft', assessment_started_at: startedAt, assessment_work_ended_at: null },
    })
    mockVerifySectionAccess.mockReset().mockResolvedValue({ ok: true, role: 'professor', adminDb })
    const res = await mod.reopenSubmission('sec-1', 'asg-1', 'stu-1', { hours: 24 })
    expect(res).toEqual({ error: expect.stringContaining('still taking') })
    expect(updateFn).not.toHaveBeenCalled() // no reset, no stamp — nothing wiped
  })

  it('11e. assessment: ALLOWS reopening a closed-but-never-submitted attempt (recovery path)', async () => {
    // Started 2h ago; a 30-min work + 5-min upload window is long closed → recovery is allowed.
    const startedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    const { adminDb, updateFn } = makeReopenAdmin({
      assignment: assessmentAssignment,
      subRow: { files: [], status: 'draft', assessment_started_at: startedAt, assessment_work_ended_at: null },
    })
    mockVerifySectionAccess.mockReset().mockResolvedValue({ ok: true, role: 'professor', adminDb })
    const res = await mod.reopenSubmission('sec-1', 'asg-1', 'stu-1', { hours: 24 })
    expect(res).toEqual({ success: true })
    expect(updateFn).toHaveBeenCalledTimes(2) // reset + stamp ran
  })

  it('11f. Edge D: a FAILED reset returns an error and does NOT delete the storage files (no orphan)', async () => {
    // If the reset UPDATE fails, deleting the files would leave the row pointing at deleted objects
    // (unrecoverable). Order matters: reset first + error-checked, storage delete only after.
    const { adminDb, updateFn, storageRemove } = makeReopenAdmin({
      assignment: assessmentAssignment,
      subRow: { files: [{ path: 'p1' }], status: 'graded', assessment_started_at: null, assessment_work_ended_at: null },
      resetError: { message: 'db down' },
    })
    mockVerifySectionAccess.mockReset().mockResolvedValue({ ok: true, role: 'professor', adminDb })
    const res = await mod.reopenSubmission('sec-1', 'asg-1', 'stu-1', { hours: 24 })
    expect(res).toEqual({ error: expect.any(String) })
    expect(storageRemove).not.toHaveBeenCalled() // files preserved because the reset failed
    expect(updateFn).toHaveBeenCalledTimes(1) // reset attempted; stamp never reached
  })

  it('11g. Edge D: a SUCCESSFUL reset deletes the snapshotted files after the row is cleared', async () => {
    const { adminDb, storageRemove } = makeReopenAdmin({
      assignment: assessmentAssignment,
      subRow: { files: [{ path: 'p1' }, { path: 'p2' }], status: 'graded', assessment_started_at: null, assessment_work_ended_at: null },
    })
    mockVerifySectionAccess.mockReset().mockResolvedValue({ ok: true, role: 'professor', adminDb })
    const res = await mod.reopenSubmission('sec-1', 'asg-1', 'stu-1', { hours: 24 })
    expect(res).toEqual({ success: true })
    expect(storageRemove).toHaveBeenCalledWith(['p1', 'p2'])
  })
})

describe('requestChanges — invalid window', () => {
  it('9c. { hours: 0 } is invalid for requestChanges too → invalid-window error', async () => {
    const { adminDb } = makeRequestChangesAdmin()
    mockVerifySectionAccess.mockReset().mockResolvedValue({ ok: true, role: 'professor', adminDb })
    const res = await mod.requestChanges('sec-1', 'sub-1', 'Please redo section 2.', { hours: 0 })
    expect(res).toEqual({ error: 'Invalid reopen window.' })
  })
})
