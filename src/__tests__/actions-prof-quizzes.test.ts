// Tests for professor quiz server actions — auth, access, and role gating.
// Verifies that professor actions reject unauthenticated / unauthorized callers,
// permit active TAs to perform read + staff writes, and block TAs from the
// professor-only nuclear operations (publish, unpublish, delete, duplicate).

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Chain Builder ────────────────────────────────────────────

function buildChain(finalResult: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {}
  chain.select = vi.fn().mockReturnValue(chain)
  chain.eq = vi.fn().mockReturnValue(chain)
  chain.neq = vi.fn().mockReturnValue(chain)
  chain.in = vi.fn().mockReturnValue(chain)
  chain.is = vi.fn().mockReturnValue(chain)
  chain.order = vi.fn().mockReturnValue(chain)
  chain.limit = vi.fn().mockReturnValue(chain)
  chain.gt = vi.fn().mockReturnValue(chain)
  chain.not = vi.fn().mockReturnValue(chain)
  chain.lte = vi.fn().mockReturnValue(chain)
  chain.single = vi.fn().mockResolvedValue(finalResult)
  chain.maybeSingle = vi.fn().mockResolvedValue(finalResult)
  chain.insert = vi.fn().mockReturnValue(chain)
  chain.update = vi.fn().mockReturnValue(chain)
  chain.delete = vi.fn().mockReturnValue(chain)
  chain.then = undefined
  return chain
}

// NOTE: `.lte`/`.not` above are needed by the scheduled auto-publish due query.
// The awaitable variant of this chain (`buildAwaitableChain`) is declared further
// down, next to registerQuizUpload — hoisted, so it is usable from any test here.
// See agent-memory: quiz-action-mock-chain for why the default chain is NOT
// awaitable and when you need the awaitable one.

// ── Module-Level Mock References ─────────────────────────────

const mockGetUser = vi.fn()
const mockAdminClient = vi.fn()
const mockEmitEvent = vi.fn()

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/server', () => ({ after: (fn: () => unknown) => fn() }))
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
vi.mock('@/lib/events/emit', () => ({
  emitEvent: (...args: unknown[]) => mockEmitEvent(...args),
  markFeedItemDone: vi.fn(),
}))
vi.mock('@/lib/extraction/enqueue', () => ({
  enqueueExtractionJob: vi.fn(),
  enqueueMasteryRecompute: vi.fn(),
}))
vi.mock('@/lib/quiz/utils', () => ({
  shuffleArray: vi.fn((arr: unknown[]) => arr),
  generateId: vi.fn(() => 'mock-id'),
  nowISO: vi.fn(() => '2026-01-01T12:00:00Z'),
}))

// ── Test Setup ───────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
let getQuestions: any
let createQuiz: any
let getQuizSubmissionCounts: any
let publishQuiz: any
let deleteQuiz: any
let createQuizFull: any
let duplicateQuiz: any
let updateQuiz: any
let registerQuizUpload: any
let getQuizUploadStatuses: any
let bulkUpdateQuestionContent: any
let getQuizzes: any
/* eslint-enable @typescript-eslint/no-explicit-any */

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockAdminClient.mockReset()
  mockEmitEvent.mockReset()

  const mod = await import('@/app/(dashboard)/professor/courses/[sectionId]/quizzes/actions')
  getQuestions = mod.getQuestions
  createQuiz = mod.createQuiz
  getQuizSubmissionCounts = mod.getQuizSubmissionCounts
  publishQuiz = mod.publishQuiz
  deleteQuiz = mod.deleteQuiz
  createQuizFull = mod.createQuizFull
  duplicateQuiz = mod.duplicateQuiz
  updateQuiz = mod.updateQuiz
  registerQuizUpload = mod.registerQuizUpload
  getQuizUploadStatuses = mod.getQuizUploadStatuses
  bulkUpdateQuestionContent = mod.bulkUpdateQuestionContent
  getQuizzes = mod.getQuizzes
})

function mockUnauthenticated() {
  mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'No user' } })
}

function mockAuthenticated(userId = 'prof-1') {
  mockGetUser.mockResolvedValue({ data: { user: { id: userId } }, error: null })
}

/**
 * Table-keyed admin mock — routes by table name so the mock is resilient to
 * verifySectionAccess internal call ordering. Any table not in `overrides`
 * returns an empty result.
 */
function buildTableKeyedAdmin(
  overrides: Record<string, { data: unknown; error: unknown }>,
) {
  return {
    from: vi.fn((table: string) => {
      const result = overrides[table] ?? { data: null, error: null }
      return buildChain(result)
    }),
  }
}

/** Non-owner: section exists but belongs to another prof; no section_staff row. */
function mockNonOwnerAdmin() {
  const admin = buildTableKeyedAdmin({
    course_sections: { data: { id: 'section-1', professor_id: 'real-prof-id' }, error: null },
    section_staff: { data: null, error: null },
  })
  mockAdminClient.mockReturnValue(admin)
  return admin
}

/** Active TA: section belongs to another prof, and section_staff has an active TA row. */
function mockActiveTaAdmin() {
  const admin = buildTableKeyedAdmin({
    course_sections: { data: { id: 'section-1', professor_id: 'real-prof-id' }, error: null },
    section_staff: { data: { role: 'ta' }, error: null },
  })
  mockAdminClient.mockReturnValue(admin)
  return admin
}

// ── getQuestions ─────────────────────────────────────────────

describe('getQuestions', () => {
  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const result = await getQuestions('section-1')
    expect(result.error).toBe('Not authenticated')
  })

  it('rejects users who do not have access to the section', async () => {
    mockAuthenticated('attacker-id')
    mockNonOwnerAdmin()
    const result = await getQuestions('section-1')
    expect(result.error).toContain('do not have access')
  })

  it('allows an active TA to read questions', async () => {
    mockAuthenticated('ta-user-id')
    mockActiveTaAdmin()
    const result = await getQuestions('section-1')
    expect(result.error ?? '').not.toContain('do not have access')
  })
})

// ── createQuiz ───────────────────────────────────────────────

describe('createQuiz', () => {
  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const result = await createQuiz('section-1', { title: 'Test Quiz', description: '' })
    expect(result.error).toBe('Not authenticated')
  })

  it('rejects users who do not have access to the section', async () => {
    mockAuthenticated('attacker-id')
    mockNonOwnerAdmin()
    const result = await createQuiz('section-1', { title: 'Test Quiz', description: '' })
    // createQuiz is gated by the staff-write check (!owned), which returns a
    // permission error rather than an access error — both indicate rejection.
    expect(result.error).toContain('do not have permission')
  })

  it('allows an active TA to attempt creating a quiz (no access error)', async () => {
    mockAuthenticated('ta-user-id')
    mockActiveTaAdmin()
    const result = await createQuiz('section-1', { title: 'Test Quiz', description: '' })
    // Downstream insert chain is mocked minimally, so we don't assert success,
    // but the access gate must not reject a TA.
    expect(result.error ?? '').not.toContain('do not have access')
  })
})

// ── getQuizSubmissionCounts ──────────────────────────────────

describe('getQuizSubmissionCounts', () => {
  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const result = await getQuizSubmissionCounts('section-1')
    expect(result.error).toBe('Not authenticated')
  })

  it('rejects users who do not have access to the section', async () => {
    mockAuthenticated('attacker-id')
    mockNonOwnerAdmin()
    const result = await getQuizSubmissionCounts('section-1')
    expect(result.error).toContain('do not have access')
  })

  it('allows an active TA to read submission counts', async () => {
    mockAuthenticated('ta-user-id')
    mockActiveTaAdmin()
    const result = await getQuizSubmissionCounts('section-1')
    expect(result.error ?? '').not.toContain('do not have access')
  })
})

// ── publishQuiz (professor-only) ─────────────────────────────

describe('publishQuiz', () => {
  it('blocks TAs — only the professor can publish', async () => {
    mockAuthenticated('ta-user-id')
    mockActiveTaAdmin()
    const result = await publishQuiz('section-1', 'quiz-1')
    expect(result.error).toBe('Only the professor can publish a quiz')
  })

  // Server-side guard (defense-in-depth): an incomplete placeholder question
  // must never reach students even if publishQuiz is called directly.
  function mockPublishAdmin(assignments: { data: unknown; error: unknown }) {
    mockAdminClient.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === 'course_sections') return buildChain({ data: { id: 'section-1', professor_id: 'prof-1' }, error: null })
        if (table === 'quizzes') return buildChain({ data: { id: 'quiz-1', title: 'Quiz 1', due_date: null }, error: null })
        if (table === 'quiz_question_assignments') return buildAwaitableChain(assignments)
        return buildChain({ data: null, error: null })
      }),
    })
  }

  it('blocks publish when an assigned question is an incomplete placeholder', async () => {
    mockAuthenticated('prof-1')
    mockPublishAdmin({ data: [{ id: 'a1', question: { is_complete: false } }], error: null })
    const result = await publishQuiz('section-1', 'quiz-1')
    expect(result.error).toMatch(/incomplete/i)
  })

  it('publishes when every assigned question is complete', async () => {
    mockAuthenticated('prof-1')
    mockPublishAdmin({ data: [{ id: 'a1', question: { is_complete: true } }], error: null })
    const result = await publishQuiz('section-1', 'quiz-1')
    expect(result.success).toBe(true)
  })

  // Thenable chain: supports .maybeSingle()/.single() AND a direct `await` of the query
  // builder (publishQuiz's question-count check awaits without .single()).
  function thenableChain(result: { data: unknown; error: unknown }) {
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'neq', 'in', 'is', 'order', 'limit', 'gt', 'insert', 'update', 'delete']) {
      chain[m] = vi.fn(() => chain)
    }
    chain.single = vi.fn().mockResolvedValue(result)
    chain.maybeSingle = vi.fn().mockResolvedValue(result)
    chain.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(onF, onR)
    return chain
  }

  // Professor owns the section, quiz has a question, and the quizzes row reports
  // `priorStatus` — which drives the wasPublished branch.
  function ownerAdminWithQuiz(priorStatus: string) {
    mockAuthenticated('prof-1')
    mockAdminClient.mockReturnValue({
      from: vi.fn((table: string) =>
        thenableChain(
          table === 'course_sections'
            ? { data: { id: 'section-1', professor_id: 'prof-1' }, error: null }
            : table === 'quiz_question_assignments'
              ? { data: [{ id: 'qqa-1' }], error: null }
              : table === 'quizzes'
                ? { data: { status: priorStatus, title: 'Quiz 1', due_date: null }, error: null }
                : { data: null, error: null },
        ),
      ),
    })
  }

  // The #417 fix: re-saving a live quiz must send a CHANGE notice, not re-announce it
  // as new (which dedups away for already-notified students).
  it('emits quiz_updated (not quiz_published) when re-saving an already-published quiz', async () => {
    ownerAdminWithQuiz('published')
    const result = await publishQuiz('section-1', 'quiz-1')
    expect(result.success).toBe(true)
    expect(mockEmitEvent).toHaveBeenCalledTimes(1)
    expect(mockEmitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'quiz_updated',
        actionable: false,
        onDuplicate: 'refresh',
        entity: { type: 'quiz', id: 'quiz-1' },
      }),
    )
  })

  it('emits quiz_published on first publish (quiz was draft)', async () => {
    ownerAdminWithQuiz('draft')
    const result = await publishQuiz('section-1', 'quiz-1')
    expect(result.success).toBe(true)
    expect(mockEmitEvent).toHaveBeenCalledTimes(1)
    expect(mockEmitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'quiz_published', actionable: true, entity: { type: 'quiz', id: 'quiz-1' } }),
    )
  })
})

// ── deleteQuiz (professor-only) ──────────────────────────────

describe('deleteQuiz', () => {
  it('blocks TAs — only the professor can delete', async () => {
    mockAuthenticated('ta-user-id')
    mockActiveTaAdmin()
    const result = await deleteQuiz('section-1', 'quiz-1')
    expect(result.error).toBe('Only the professor can delete a quiz')
  })
})

// ── deleteQuiz: orphaned-skill unchecking ────────────────────
// After a quiz is deleted, its activity_skills mappings are pruned. Any skill the
// quiz was the ONLY remaining evidence for must be soft-excluded (untracked);
// skills still covered by another activity must stay tracked. This locks the
// coverage-diff AND its ordering invariant: the "still covered" check runs AFTER
// the prune, so the deleted quiz's own rows can't count as coverage for itself.

/**
 * Owner admin for deleteQuiz. `activity_skills` is read/written three times in
 * order — (1) select mapped skill_ids, (2) delete the mappings, (3) select which
 * of those skills still have coverage — so route it by call sequence. Captures
 * the `skills` chain so tests can assert the untrack update + its id filter.
 */
function mockDeleteQuizAdmin(
  userId: string,
  opts: { mapped: string[]; stillCovered: string[] },
) {
  const skillsChain = buildAwaitableChain({ data: null, error: null })
  let activitySkillsCall = 0
  const admin = {
    from: vi.fn((table: string) => {
      if (table === 'course_sections') {
        return buildChain({ data: { id: 'section-1', professor_id: userId }, error: null })
      }
      if (table === 'quizzes') {
        return buildAwaitableChain({ data: null, error: null })
      }
      if (table === 'activity_skills') {
        activitySkillsCall += 1
        if (activitySkillsCall === 1) {
          return buildAwaitableChain({ data: opts.mapped.map((id) => ({ skill_id: id })), error: null })
        }
        if (activitySkillsCall === 2) {
          return buildAwaitableChain({ data: null, error: null }) // the delete
        }
        return buildAwaitableChain({ data: opts.stillCovered.map((id) => ({ skill_id: id })), error: null })
      }
      if (table === 'skills') {
        return skillsChain
      }
      return buildAwaitableChain({ data: null, error: null })
    }),
  }
  mockAdminClient.mockReturnValue(admin)
  return { admin, skillsChain }
}

describe('deleteQuiz: orphaned-skill unchecking', () => {
  it('untracks only skills the deleted quiz was the last evidence for', async () => {
    mockAuthenticated('prof-1')
    // skill-A stays covered by another activity; skill-B is now orphaned.
    const { admin, skillsChain } = mockDeleteQuizAdmin('prof-1', {
      mapped: ['skill-A', 'skill-B'],
      stillCovered: ['skill-A'],
    })

    const result = await deleteQuiz('section-1', 'quiz-1')
    expect(result.success).toBe(true)

    // The skills table was touched (untrack update issued).
    expect(admin.from).toHaveBeenCalledWith('skills')
    const updateFn = skillsChain.update as ReturnType<typeof vi.fn>
    expect(updateFn).toHaveBeenCalledTimes(1)
    expect(updateFn.mock.calls[0][0]).toMatchObject({ excluded: true })

    // Only the orphaned skill (skill-B) is unchecked — skill-A is left tracked.
    const inFn = skillsChain.in as ReturnType<typeof vi.fn>
    const idFilter = inFn.mock.calls.find((c) => c[0] === 'id')
    expect(idFilter?.[1]).toEqual(['skill-B'])
  })

  it('leaves every skill tracked when all mapped skills still have coverage', async () => {
    mockAuthenticated('prof-1')
    const { admin } = mockDeleteQuizAdmin('prof-1', {
      mapped: ['skill-A'],
      stillCovered: ['skill-A'],
    })

    const result = await deleteQuiz('section-1', 'quiz-1')
    expect(result.success).toBe(true)
    // Nothing orphaned → the skills table is never written.
    expect(admin.from).not.toHaveBeenCalledWith('skills')
  })
})

// ── Adaptive config persistence (CCAT v2) ────────────────────
// The legacy "wire-out" (hard-force adaptive_mode=false) was REMOVED for ENG-38.
// The professor write paths now HONOR the adaptive config from input, so a quiz
// can be made adaptive. These tests lock that the config is persisted, not dropped.
// (duplicateQuiz is unchanged — it still copies as non-adaptive; preserving the
// original's adaptive flags on duplicate is a separate follow-up.)

/**
 * Owner admin whose `professor_id` matches the authed user (→ role 'professor',
 * canWriteProfessor true). Records every chain returned for the `quizzes` table so
 * tests can inspect insert/update payloads. The `quizzes` result is reused for both
 * any source-row fetch (.single) and the write — callers only assert on call args.
 */
function mockOwnerAdmin(
  userId: string,
  quizzesResult: { data: unknown; error: unknown },
) {
  const quizzesChains: Record<string, ReturnType<typeof buildChain>>[] = []
  const admin = {
    from: vi.fn((table: string) => {
      if (table === 'course_sections') {
        return buildChain({ data: { id: 'section-1', professor_id: userId }, error: null })
      }
      if (table === 'quizzes') {
        const chain = buildChain(quizzesResult)
        quizzesChains.push({ [table]: chain })
        return chain
      }
      return buildChain({ data: null, error: null })
    }),
  }
  mockAdminClient.mockReturnValue(admin)
  return { quizzesChains }
}

type QuizzesChain = Record<string, ReturnType<typeof buildChain>>

/** First payload passed to the named write method across all `quizzes` chains. */
function firstWritePayload(quizzesChains: QuizzesChain[], method: 'insert' | 'update') {
  for (const c of quizzesChains) {
    const fn = c.quizzes[method] as ReturnType<typeof vi.fn>
    if (fn.mock.calls.length > 0) return fn.mock.calls[0][0]
  }
  return undefined
}

describe('adaptive config: writes honor adaptiveMode from input', () => {
  it('createQuizFull persists adaptiveMode + config when the client enables adaptive', async () => {
    mockAuthenticated('prof-1')
    const { quizzesChains } = mockOwnerAdmin('prof-1', {
      data: { id: 'new-quiz', section_id: 'section-1' },
      error: null,
    })

    const result = await createQuizFull('section-1', {
      title: 'Adaptive quiz',
      description: '',
      adaptiveMode: true,
      adaptiveQuestionCount: 8,
      selectLambda: 1,
      stopMode: 'precision',
      targetSe: 0.25,
      showRatingToStudents: true,
    })

    // Must not be rejected by the access gate.
    expect(result.error ?? '').not.toContain('permission')

    const payload = firstWritePayload(quizzesChains, 'insert')
    expect(payload).toBeDefined()
    expect(payload.adaptive_mode).toBe(true)
    expect(payload.adaptive_question_count).toBe(8)
    expect(payload.select_lambda).toBe(1)
    expect(payload.stop_mode).toBe('precision')
    expect(payload.show_rating_to_students).toBe(true)
  })

  it('duplicateQuiz preserves the original quiz\'s adaptive config on the copy', async () => {
    mockAuthenticated('prof-1')
    // Source row is an adaptive quiz; the copy must stay adaptive with the same config.
    const { quizzesChains } = mockOwnerAdmin('prof-1', {
      data: {
        id: 'orig-quiz',
        section_id: 'section-1',
        title: 'Adaptive Quiz',
        adaptive_mode: true,
        adaptive_question_count: 15,
        select_lambda: 1,
        stop_mode: 'precision',
        target_se: 0.25,
        show_rating_to_students: true,
      },
      error: null,
    })

    const result = await duplicateQuiz('section-1', 'orig-quiz')

    expect(result.error ?? '').not.toContain('Only the professor')

    const payload = firstWritePayload(quizzesChains, 'insert')
    expect(payload).toBeDefined()
    expect(payload.adaptive_mode).toBe(true)
    expect(payload.adaptive_question_count).toBe(15)
    expect(payload.select_lambda).toBe(1)
    expect(payload.stop_mode).toBe('precision')
    expect(payload.show_rating_to_students).toBe(true)
  })

  it('updateQuiz persists adaptiveMode + config when the client enables adaptive', async () => {
    mockAuthenticated('prof-1')
    const { quizzesChains } = mockOwnerAdmin('prof-1', {
      data: { id: 'quiz-1', section_id: 'section-1' },
      error: null,
    })

    const result = await updateQuiz('section-1', 'quiz-1', {
      adaptiveMode: true,
      selectLambda: 0.5,
      stopMode: 'fixed',
    })

    expect(result.error ?? '').not.toContain('permission')

    const payload = firstWritePayload(quizzesChains, 'update')
    expect(payload).toBeDefined()
    expect(payload.adaptive_mode).toBe(true)
    expect(payload.select_lambda).toBe(0.5)
    expect(payload.stop_mode).toBe('fixed')
  })
})

// ── max_attempts writes (issue #43) ──────────────────────────
// NULL is a real setting now (no limit), so the write paths have to carry it as a
// value rather than treat it as "nothing to change". updateQuiz builds its payload
// field-by-field: a truthiness check instead of `!== undefined` would silently drop
// the null and leave the old cap in place, and the professor's save would look like
// it worked — and on an existing quiz a dropped key leaves whatever cap was there.

describe('max_attempts writes', () => {
  it('updateQuiz writes an explicit null rather than dropping the field', async () => {
    mockAuthenticated('prof-1')
    const { quizzesChains } = mockOwnerAdmin('prof-1', {
      data: { id: 'quiz-1', section_id: 'section-1' },
      error: null,
    })

    const result = await updateQuiz('section-1', 'quiz-1', { maxAttempts: null })

    expect(result.error ?? '').not.toContain('permission')
    const payload = firstWritePayload(quizzesChains, 'update')
    expect(payload).toBeDefined()
    // Presence matters as much as the value — a dropped key leaves the old cap.
    expect('max_attempts' in payload).toBe(true)
    expect(payload.max_attempts).toBeNull()
  })

  it('updateQuiz writes a cap above the old ceiling of 10', async () => {
    mockAuthenticated('prof-1')
    const { quizzesChains } = mockOwnerAdmin('prof-1', {
      data: { id: 'quiz-1', section_id: 'section-1' },
      error: null,
    })

    await updateQuiz('section-1', 'quiz-1', { maxAttempts: 99 })

    expect(firstWritePayload(quizzesChains, 'update').max_attempts).toBe(99)
  })

  it('createQuizFull persists null as no limit, and a high cap as given', async () => {
    mockAuthenticated('prof-1')
    const nulled = mockOwnerAdmin('prof-1', {
      data: { id: 'new-quiz', section_id: 'section-1' },
      error: null,
    })

    await createQuizFull('section-1', { title: 'Unlimited retakes', maxAttempts: null })
    expect(firstWritePayload(nulled.quizzesChains, 'insert').max_attempts).toBeNull()

    mockAuthenticated('prof-1')
    const capped = mockOwnerAdmin('prof-1', {
      data: { id: 'new-quiz-2', section_id: 'section-1' },
      error: null,
    })

    await createQuizFull('section-1', { title: 'Ninety-nine', maxAttempts: 99 })
    expect(firstWritePayload(capped.quizzesChains, 'insert').max_attempts).toBe(99)
  })
})

// ── registerQuizUpload (ad-hoc AI-quiz upload → hidden module item) ──
// IDOR-sensitive write path: it creates a real module item and enqueues
// extraction. These lock the access gate AND the hand-rolled path-prefix
// guard, which is the only thing stopping a caller from registering a file
// under a different section's storage prefix.

/**
 * Like buildChain but the chain itself is awaitable (resolves to finalResult).
 * Needed for queries that end on a list filter (.in/.eq/.limit) and await the
 * chain directly instead of calling .single()/.maybeSingle().
 */
function buildAwaitableChain(finalResult: { data: unknown; error: unknown }) {
  const chain = buildChain(finalResult)
  chain.not = vi.fn().mockReturnValue(chain)
  chain.then = (resolve: (v: unknown) => unknown) => resolve(finalResult)
  return chain
}

describe('registerQuizUpload', () => {
  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const result = await registerQuizUpload(
      'section-1',
      'section-1/quiz-ai-uploads/file.pdf',
      'file.pdf',
    )
    expect(result.error).toBe('Not authenticated')
  })

  it('rejects users who do not own the section (staff-write gate)', async () => {
    mockAuthenticated('attacker-id')
    mockNonOwnerAdmin()
    const result = await registerQuizUpload(
      'section-1',
      'section-1/quiz-ai-uploads/file.pdf',
      'file.pdf',
    )
    expect(result.error).toContain('do not have permission')
  })

  it('rejects a forged file path outside the section\'s quiz-ai-uploads prefix', async () => {
    // Owner of section-1, but the path points at ANOTHER section's storage.
    mockAuthenticated('prof-1')
    mockOwnerAdmin('prof-1', { data: null, error: null })
    const result = await registerQuizUpload(
      'section-1',
      'victim-section/quiz-ai-uploads/stolen.pdf',
      'stolen.pdf',
    )
    expect(result.error).toBe('Invalid upload path')
  })

  it('rejects a path under the right section but the wrong subfolder', async () => {
    mockAuthenticated('prof-1')
    mockOwnerAdmin('prof-1', { data: null, error: null })
    const result = await registerQuizUpload(
      'section-1',
      'section-1/lectures/notes.pdf',
      'notes.pdf',
    )
    expect(result.error).toBe('Invalid upload path')
  })

  it('rejects an unsupported file type even with a valid path', async () => {
    // .txt is READABLE now (it gained an extractor), so the unsupported case
    // has to be something genuinely unparseable.
    mockAuthenticated('prof-1')
    mockOwnerAdmin('prof-1', { data: null, error: null })
    const result = await registerQuizUpload(
      'section-1',
      'section-1/quiz-ai-uploads/dataset.zip',
      'dataset.zip',
    )
    expect(result.error).toBe('Unsupported file type for extraction')
  })

  it('registers a valid PDF upload: creates the item and returns its id', async () => {
    mockAuthenticated('prof-1')
    // Owner admin: course_sections.professor_id matches the user, modules
    // find-or-create returns a module id, module_items insert returns an id.
    const admin = {
      from: vi.fn((table: string) => {
        if (table === 'course_sections') {
          return buildChain({ data: { id: 'section-1', professor_id: 'prof-1' }, error: null })
        }
        if (table === 'modules') {
          // find-or-create reads existing via .limit(1) (awaited list query)
          return buildAwaitableChain({ data: [{ id: 'mod-uploads' }], error: null })
        }
        if (table === 'module_items') {
          // insert(...).select('id').single()
          return buildChain({ data: { id: 'item-99' }, error: null })
        }
        return buildChain({ data: null, error: null })
      }),
    }
    mockAdminClient.mockReturnValue(admin)

    const result = await registerQuizUpload(
      'section-1',
      'section-1/quiz-ai-uploads/lecture.pdf',
      'lecture.pdf',
    )
    expect(result.error).toBeUndefined()
    expect(result.data?.moduleItemId).toBe('item-99')
    expect(result.data?.moduleId).toBe('mod-uploads')
  })
})

// ── getQuizUploadStatuses (section-scoped parsing-status poll) ──

describe('getQuizUploadStatuses', () => {
  it('rejects unauthenticated users (empty data + error)', async () => {
    mockUnauthenticated()
    const result = await getQuizUploadStatuses('section-1', ['item-1'])
    expect(result.error).toBe('Not authenticated')
    expect(result.data).toEqual([])
  })

  it('rejects users without access to the section', async () => {
    mockAuthenticated('attacker-id')
    mockNonOwnerAdmin()
    const result = await getQuizUploadStatuses('section-1', ['item-1'])
    expect(result.error).toContain('do not have access')
    expect(result.data).toEqual([])
  })

  it('maps extraction status, defaulting to processing when not yet completed', async () => {
    mockAuthenticated('prof-1')
    const admin = {
      from: vi.fn((table: string) => {
        if (table === 'course_sections') {
          return buildChain({ data: { id: 'section-1', professor_id: 'prof-1' }, error: null })
        }
        if (table === 'module_items') {
          // .select(...).in(...).eq('module.section_id', ...) awaited as a list
          return buildAwaitableChain({
            data: [
              { id: 'done', content: { extraction: { status: 'completed', metadata: { pageCount: 4 } } } },
              { id: 'pending', content: { extraction: { status: 'queued' } } },
              { id: 'bare', content: {} },
            ],
            error: null,
          })
        }
        return buildChain({ data: null, error: null })
      }),
    }
    mockAdminClient.mockReturnValue(admin)

    const result = await getQuizUploadStatuses('section-1', ['done', 'pending', 'bare'])
    expect(result.error).toBeUndefined()
    expect(result.data).toEqual([
      { id: 'done', status: 'completed', pageCount: 4 },
      { id: 'pending', status: 'processing', pageCount: 0 },
      { id: 'bare', status: 'processing', pageCount: 0 },
    ])
  })
})

// ── bulkUpdateQuestionContent (rubric write guard) ──────────────
// The autosave/publish content sync. It writes the `rubric` column ONLY when the
// client explicitly provides a well-formed value — an omitted or malformed rubric
// must NOT reach the UPDATE payload, or a stale client would wipe the stored
// rubric that explanation/walkthrough grading depends on. These lock that
// decision table (undefined→preserve, malformed→preserve, valid→write, null→clear).

/** Owner admin that records every `quiz_questions` chain so a test can read the
 *  UPDATE payload. course_sections.professor_id matches the user → owned=true. */
function mockOwnerAdminForQuestions(userId: string) {
  const questionChains: ReturnType<typeof buildChain>[] = []
  const admin = {
    from: vi.fn((table: string) => {
      if (table === 'course_sections') {
        return buildChain({ data: { id: 'section-1', professor_id: userId }, error: null })
      }
      if (table === 'quiz_questions') {
        const chain = buildChain({ data: null, error: null })
        questionChains.push(chain)
        return chain
      }
      return buildChain({ data: null, error: null })
    }),
  }
  mockAdminClient.mockReturnValue(admin)
  return { questionChains }
}

/** The object passed to the first `quiz_questions` .update() call. */
function firstUpdatePayload(questionChains: ReturnType<typeof buildChain>[]) {
  const fn = questionChains[0].update as ReturnType<typeof vi.fn>
  return fn.mock.calls[0]?.[0]
}

/** A minimal, valid content-update entry (rubric intentionally absent). */
const baseContentUpdate = {
  questionId: 'q-1',
  questionText: 'Explain gradient descent.',
  content: { questionType: 'explanation' },
  difficulty: 'medium',
  bloomsLevel: null,
  tags: [],
  points: 5,
  explanation: '',
  isBonus: false,
  isExtraCredit: false,
  imageUrl: null,
  imagePath: null,
  codeSnippet: null,
  eloRating: 1200,
  expectedTimeSeconds: null,
}

describe('bulkUpdateQuestionContent — rubric write guard', () => {
  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const result = await bulkUpdateQuestionContent('section-1', [baseContentUpdate])
    expect(result.error).toBe('Not authenticated')
  })

  it('rejects a caller who does not own the section', async () => {
    mockAuthenticated('attacker-id')
    mockNonOwnerAdmin()
    const result = await bulkUpdateQuestionContent('section-1', [baseContentUpdate])
    expect(result.error).toContain('do not have permission')
  })

  it('omits the rubric key when rubric is absent (a stale client cannot wipe the stored rubric)', async () => {
    mockAuthenticated('prof-1')
    const { questionChains } = mockOwnerAdminForQuestions('prof-1')
    await bulkUpdateQuestionContent('section-1', [baseContentUpdate])
    const payload = firstUpdatePayload(questionChains)
    expect(payload).toBeDefined()
    expect('rubric' in payload).toBe(false)
  })

  it('omits the rubric key when the provided rubric is malformed (schema rejects it → preserve)', async () => {
    mockAuthenticated('prof-1')
    const { questionChains } = mockOwnerAdminForQuestions('prof-1')
    // concept must be a non-empty string (min(1)); '' fails the schema at runtime.
    await bulkUpdateQuestionContent('section-1', [{ ...baseContentUpdate, rubric: [{ concept: '' }] }])
    const payload = firstUpdatePayload(questionChains)
    expect('rubric' in payload).toBe(false)
  })

  it('writes a well-formed rubric into the update payload', async () => {
    mockAuthenticated('prof-1')
    const { questionChains } = mockOwnerAdminForQuestions('prof-1')
    const rubric = [{ concept: 'slope of the tangent line' }]
    await bulkUpdateQuestionContent('section-1', [{ ...baseContentUpdate, rubric }])
    const payload = firstUpdatePayload(questionChains)
    expect(payload.rubric).toEqual(rubric)
  })

  it('writes rubric: null when explicitly cleared (distinct from an omitted rubric)', async () => {
    mockAuthenticated('prof-1')
    const { questionChains } = mockOwnerAdminForQuestions('prof-1')
    await bulkUpdateQuestionContent('section-1', [{ ...baseContentUpdate, rubric: null }])
    const payload = firstUpdatePayload(questionChains)
    expect('rubric' in payload).toBe(true)
    expect(payload.rubric).toBeNull()
  })
})

// ── Scheduled auto-publish gate (#311) ────────────────────────
//
// `autoPublishScheduledQuizzes` runs on every professor quiz-list load. It used to
// BE the update — one statement that flipped any due draft to published, including
// a draft with zero questions or with placeholder ones. A scheduled empty quiz went
// live to students, bypassing the exact gate `publishQuiz` enforces.
//
// The eligibility RULES are unit-tested against the shared helper in
// quiz-auto-publish-gate.test.ts. What is left to prove HERE is the wiring: that
// this action consults the gate before writing, and that the write it then issues
// stays scoped to the section.

type Chain = Record<string, ReturnType<typeof vi.fn>>

/**
 * Admin double for the getQuizzes → autoPublishScheduledQuizzes path. The `quizzes`
 * table is hit up to three times in a fixed order (due-draft list → auto-publish
 * update → the list fetch), so it is routed by call index, not by table alone.
 */
function mockAdminForAutoPublish(opts: {
  dueIds: string[]
  assignments: unknown[]
}) {
  const quizzesChains: Chain[] = []
  const admin = {
    from: vi.fn((table: string) => {
      if (table === 'course_sections') {
        return buildChain({ data: { id: 'section-1', professor_id: 'prof-1' }, error: null })
      }
      if (table === 'quiz_question_assignments') {
        return buildAwaitableChain({ data: opts.assignments, error: null })
      }
      if (table === 'quizzes') {
        const chain = buildAwaitableChain(
          quizzesChains.length === 0
            ? { data: opts.dueIds.map((id) => ({ id })), error: null }
            : { data: [], error: null },
        ) as Chain
        quizzesChains.push(chain)
        return chain
      }
      return buildChain({ data: null, error: null })
    }),
  }
  mockAdminClient.mockReturnValue(admin)
  return { quizzesChains }
}

/** The id list the auto-publish UPDATE was scoped to, or null if it never ran. */
function autoPublishedIds(chains: Chain[]): string[] | null {
  for (const chain of chains) {
    if (chain.update.mock.calls.length === 0) continue
    const idFilter = chain.in.mock.calls.find((args) => args[0] === 'id')
    return (idFilter?.[1] as string[]) ?? []
  }
  return null
}

/** The chain the UPDATE ran on, for asserting its payload and tenant filters. */
function updateChain(chains: Chain[]): Chain | undefined {
  return chains.find((c) => c.update.mock.calls.length > 0)
}

const complete = (quizId: string) => ({ quiz_id: quizId, question: { is_complete: true } })
const incomplete = (quizId: string) => ({ quiz_id: quizId, question: { is_complete: false } })

describe('autoPublishScheduledQuizzes: only publishes drafts that pass the publish gate (#311)', () => {
  it('publishes a due draft with complete questions and holds back the empty and incomplete ones', async () => {
    mockAuthenticated('prof-1')
    const { quizzesChains } = mockAdminForAutoPublish({
      dueIds: ['q-ready', 'q-empty', 'q-incomplete'],
      // q-empty has NO assignment rows at all — the scheduled-empty-quiz bug.
      assignments: [complete('q-ready'), complete('q-ready'), complete('q-incomplete'), incomplete('q-incomplete')],
    })

    await getQuizzes('section-1')

    expect(autoPublishedIds(quizzesChains)).toEqual(['q-ready'])
  })

  it('issues no write at all when every due draft fails the gate', async () => {
    mockAuthenticated('prof-1')
    const { quizzesChains } = mockAdminForAutoPublish({
      dueIds: ['q-empty'],
      assignments: [],
    })

    await getQuizzes('section-1')

    // Not "an update scoped to []" — the action must return before touching the
    // write path, so a held-back quiz keeps its schedule and publishes itself
    // later, once the professor finishes the questions.
    expect(autoPublishedIds(quizzesChains)).toBeNull()
  })

  it('keeps the publish write tenant-scoped and draft-only', async () => {
    mockAuthenticated('prof-1')
    const { quizzesChains } = mockAdminForAutoPublish({
      dueIds: ['q-ready'],
      assignments: [complete('q-ready')],
    })

    await getQuizzes('section-1')

    const chain = updateChain(quizzesChains)
    expect(chain).toBeDefined()
    // The id list is now built by a separate query, so the write must carry its
    // own section filter — otherwise a future change to how ids are gathered
    // could flip a quiz in another section. status='draft' keeps the flip an
    // atomic per-row claim so two concurrent loads can't both "publish" it.
    expect(chain!.eq.mock.calls).toEqual(
      expect.arrayContaining([['section_id', 'section-1'], ['status', 'draft']]),
    )
    const payload = chain!.update.mock.calls[0][0]
    expect(payload.status).toBe('published')
    // Cleared so the row stops matching the due query on the next load.
    expect(payload.scheduled_publish_at).toBeNull()
  })

})

// ── updateQuiz scheduled publish (#311) ───────────────────────
//
// A past scheduled_publish_at makes the auto-publish sweep flip the quiz live on the
// next list load, so the server must refuse to SET one. It must NOT refuse a past
// value that is simply the STORED one coming back: QuizStudio's autosave resends the
// field on every save while publishMode === 'scheduled', so a schedule that elapsed
// mid-edit would otherwise reject every later autosave — title and question edits in
// the same payload included.

/** Owner admin whose stored quizzes row (read via .single()) is `row`. */
function mockOwnerAdminWithQuiz(row: Record<string, unknown>) {
  const quizzesChains: Chain[] = []
  const admin = {
    from: vi.fn((table: string) => {
      if (table === 'course_sections') {
        return buildChain({ data: { id: 'section-1', professor_id: 'prof-1' }, error: null })
      }
      if (table === 'quizzes') {
        const chain = buildChain({ data: row, error: null }) as Chain
        quizzesChains.push(chain)
        return chain
      }
      return buildChain({ data: null, error: null })
    }),
  }
  mockAdminClient.mockReturnValue(admin)
  return { quizzesChains }
}

const HOUR_MS = 60 * 60 * 1000
const futureIso = () => new Date(Date.now() + HOUR_MS).toISOString()
const pastIso = () => new Date(Date.now() - HOUR_MS).toISOString()

describe('updateQuiz: scheduled publish time', () => {
  it('rejects a NEW past time', async () => {
    mockAuthenticated('prof-1')
    const { quizzesChains } = mockOwnerAdminWithQuiz({ id: 'quiz-1', scheduled_publish_at: null })

    const result = await updateQuiz('section-1', 'quiz-1', { scheduledPublishAt: pastIso() })

    expect(result.error).toBe('Scheduled publish time must be in the future')
    // Refused before writing — a rejected schedule must not land in the row.
    expect(quizzesChains.some((c) => c.update.mock.calls.length > 0)).toBe(false)
  })

  it('rejects a past time that DIFFERS from the stored one', async () => {
    mockAuthenticated('prof-1')
    const stored = new Date(Date.now() - 2 * HOUR_MS).toISOString()
    mockOwnerAdminWithQuiz({ id: 'quiz-1', scheduled_publish_at: stored })

    // Moving a schedule further into the past is still setting a new past time.
    const result = await updateQuiz('section-1', 'quiz-1', { scheduledPublishAt: pastIso() })

    expect(result.error).toBe('Scheduled publish time must be in the future')
  })

  it('allows an UNCHANGED past time — the autosave round-trip', async () => {
    mockAuthenticated('prof-1')
    const elapsed = pastIso()
    const { quizzesChains } = mockOwnerAdminWithQuiz({ id: 'quiz-1', scheduled_publish_at: elapsed })

    const result = await updateQuiz('section-1', 'quiz-1', {
      title: 'Half-finished quiz',
      scheduledPublishAt: elapsed,
    })

    expect(result.error).toBeUndefined()
    // The unrelated edit in the same payload has to survive — that is the point.
    const payload = firstWritePayload(
      quizzesChains.map((c) => ({ quizzes: c })) as QuizzesChain[],
      'update',
    )
    expect(payload.title).toBe('Half-finished quiz')
  })

  it('allows clearing the schedule to null even when the stored value is past', async () => {
    mockAuthenticated('prof-1')
    mockOwnerAdminWithQuiz({ id: 'quiz-1', scheduled_publish_at: pastIso() })

    // Un-scheduling is the professor's escape hatch from an elapsed schedule; a
    // rule that blocked it would strand the quiz.
    const result = await updateQuiz('section-1', 'quiz-1', { scheduledPublishAt: null })

    expect(result.error).toBeUndefined()
  })

  it('allows a future time', async () => {
    mockAuthenticated('prof-1')
    mockOwnerAdminWithQuiz({ id: 'quiz-1', scheduled_publish_at: null })

    const result = await updateQuiz('section-1', 'quiz-1', { scheduledPublishAt: futureIso() })

    expect(result.error).toBeUndefined()
  })
})
