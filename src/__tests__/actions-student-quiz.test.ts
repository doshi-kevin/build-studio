// Tests for student quiz server actions — attempt lifecycle and results.
// Covers auth checks and enrollment verification for the quiz attempt flow.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Chain Builder ────────────────────────────────────────────

function buildChain(finalResult: { data: unknown; error: unknown; count?: number }) {
  const chain: Record<string, unknown> = {}
  chain.select = vi.fn().mockReturnValue(chain)
  chain.eq = vi.fn().mockReturnValue(chain)
  chain.neq = vi.fn().mockReturnValue(chain)
  chain.in = vi.fn().mockReturnValue(chain)
  chain.is = vi.fn().mockReturnValue(chain)
  chain.not = vi.fn().mockReturnValue(chain)
  chain.lte = vi.fn().mockReturnValue(chain)
  chain.order = vi.fn().mockReturnValue(chain)
  chain.limit = vi.fn().mockReturnValue(chain)
  chain.single = vi.fn().mockResolvedValue(finalResult)
  chain.maybeSingle = vi.fn().mockResolvedValue(finalResult)
  chain.insert = vi.fn().mockReturnValue(chain)
  chain.update = vi.fn().mockReturnValue(chain)
  chain.delete = vi.fn().mockReturnValue(chain)
  chain.upsert = vi.fn().mockReturnValue(chain)
  chain.then = undefined
  return chain
}

// Awaitable variant: a chain that resolves to { data, error } when the query
// ends on a LIST filter (.in()/.eq()/.order()) and is awaited directly, rather
// than via .single(). buildChain sets .then = undefined on purpose, so awaiting
// it yields undefined and destructuring `const { data } = await ...` throws.
// startAttempt's AI-graded exclusion awaits a `.in('id', ...)` list query, so it
// needs this. See agent-memory: quiz-action-mock-chain.
function buildAwaitableChain(finalResult: { data: unknown; error: unknown; count?: number }) {
  const chain = buildChain(finalResult) as Record<string, unknown>
  chain.then = (resolve: (v: unknown) => unknown) => resolve(finalResult)
  return chain
}

// ── Module-Level Mock References ─────────────────────────────

const mockGetUser = vi.fn()
const mockAdminClient = vi.fn()

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
vi.mock('@/lib/quiz/scoring', () => ({
  gradeAnswer: vi.fn(),
  resolveQuestionPool: vi.fn().mockReturnValue([]),
}))
// dueDeadlineMs uses the REAL implementation on purpose. checkDueDate delegates to
// it for every late/past-due decision, and a stub would make those tests assert
// against the stub rather than the shipped end-of-day rule. Omitting it entirely is
// worse than either: vitest throws "No 'dueDeadlineMs' export is defined on the
// mock" only when it is first called, and every call site sits inside a try/catch —
// so the action returns a generic error and the test reads as a normal rejection.
vi.mock('@/lib/quiz/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/quiz/utils')>()),
  shuffleArray: vi.fn((arr: unknown[]) => arr),
  nowISO: vi.fn(() => '2026-01-01T12:00:00Z'),
  generateId: vi.fn(() => 'mock-id'),
}))
vi.mock('@/lib/quiz/adaptive-engine', () => ({
  assignCohort: vi.fn().mockReturnValue('control'),
  calculateEloUpdate: vi.fn().mockReturnValue({ newStudentRating: 1200, newQuestionRating: 1200 }),
  selectAdaptiveQuestion: vi.fn(),
  selectControlQuestions: vi.fn().mockReturnValue([]),
  DEFAULT_START_RATING: 1200,
}))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))

// ── Test Setup ───────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let startAttempt: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let saveAnswer: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let submitAttempt: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let getPublishedQuizzes: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let getQuizClassAverage: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let getQuizLeaderboard: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let getUnifiedResult: any

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockAdminClient.mockReset()

  const mod = await import('@/app/(dashboard)/student/courses/[sectionId]/quizzes/actions')
  startAttempt = mod.startAttempt
  saveAnswer = mod.saveAnswer
  submitAttempt = mod.submitAttempt
  getPublishedQuizzes = mod.getPublishedQuizzes
  getQuizClassAverage = mod.getQuizClassAverage
  getQuizLeaderboard = mod.getQuizLeaderboard
  getUnifiedResult = mod.getUnifiedResult
})

// ── getQuizLeaderboard (Vuln 18) ─────────────────────────────
// Binds the quiz to the section AND respects the professor's
// show_leaderboard toggle before returning classmates' names + scores.

describe('getQuizLeaderboard', () => {
  function routed(quizRow: { data: unknown; error: unknown }) {
    return {
      from: vi.fn((table: string) => {
        if (table === 'enrollments') return buildChain({ data: { id: 'e1' }, error: null })
        if (table === 'quizzes') return buildChain(quizRow)
        // quiz_attempts / profiles — should not be reached when blocked
        return buildChain({ data: [], error: null })
      }),
    }
  }

  it('returns an error when the quiz is in another section', async () => {
    mockAuthenticated()
    const admin = routed({ data: null, error: null })
    mockAdminClient.mockReturnValue(admin)
    const result = await getQuizLeaderboard('section-1', 'quiz-other')
    expect(result.error).toBe('Quiz not found')
    expect(result.data).toEqual([])
  })

  it('returns an error when the professor disabled the leaderboard', async () => {
    mockAuthenticated()
    const admin = routed({ data: { id: 'quiz-1', show_leaderboard: false }, error: null })
    mockAdminClient.mockReturnValue(admin)
    const result = await getQuizLeaderboard('section-1', 'quiz-1')
    expect(result.error).toBe('Leaderboard is not enabled for this quiz')
    expect(result.data).toEqual([])
  })
})

// ── Helpers ──────────────────────────────────────────────────

function mockAuthenticated(userId = 'student-123') {
  mockGetUser.mockResolvedValue({ data: { user: { id: userId } }, error: null })
}

function mockUnauthenticated() {
  mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'No user' } })
}

// ── getPublishedQuizzes ──────────────────────────────────────

describe('getPublishedQuizzes', () => {
  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const result = await getPublishedQuizzes('section-1')
    expect(result.error).toBe('Not authenticated')
  })

  it('rejects non-enrolled students', async () => {
    mockAuthenticated()
    const admin = {
      from: vi.fn(() => buildChain({ data: null, error: null })),
    }
    mockAdminClient.mockReturnValue(admin)

    const result = await getPublishedQuizzes('section-1')
    expect(result.error).toBe('Not enrolled in this section')
  })

  // #311: this list load auto-publishes scheduled quizzes too. The "must have
  // questions" gate was originally added only to the professor path, so a
  // question-less scheduled quiz still reached students through here — whichever
  // page loaded first won. The rules live in quiz-auto-publish-gate.test.ts; this
  // pins that the STUDENT path actually consults them.
  it('does not auto-publish a due scheduled quiz that has no questions', async () => {
    mockAuthenticated()
    const quizzesChains: Record<string, ReturnType<typeof vi.fn>>[] = []
    const admin = {
      from: vi.fn((table: string) => {
        if (table === 'enrollments') return buildChain({ data: { id: 'e1' }, error: null })
        if (table === 'quiz_question_assignments') {
          // No rows → the due quiz has zero questions.
          return buildAwaitableChain({ data: [], error: null })
        }
        if (table === 'quizzes') {
          const chain = buildAwaitableChain(
            // 1st call: the due-draft list. Later calls: the published-quiz fetch.
            quizzesChains.length === 0
              ? { data: [{ id: 'q-empty' }], error: null }
              : { data: [], error: null },
          ) as Record<string, ReturnType<typeof vi.fn>>
          quizzesChains.push(chain)
          return chain
        }
        return buildAwaitableChain({ data: [], error: null })
      }),
    }
    mockAdminClient.mockReturnValue(admin)

    await getPublishedQuizzes('section-1')

    expect(quizzesChains.some((c) => c.update.mock.calls.length > 0)).toBe(false)
  })
})

// ── startAttempt ─────────────────────────────────────────────

describe('startAttempt', () => {
  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const result = await startAttempt('section-1', 'quiz-1')
    expect(result.error).toBe('Not authenticated')
  })

  it('rejects non-enrolled students', async () => {
    mockAuthenticated()
    const admin = {
      from: vi.fn(() => buildChain({ data: null, error: null })),
    }
    mockAdminClient.mockReturnValue(admin)

    const result = await startAttempt('section-1', 'quiz-1')
    expect(result.error).toBe('Not enrolled in this section')
  })

  // Issue #175: explanation/walkthrough (AI-graded) question types are adaptive-only.
  // The linear startAttempt flow must strip them from the resolved question set so a
  // stray one — added before the wizard gated these types, or drawn in via a tag pool —
  // never renders unanswerable and grades 0. We assert against resolved_question_ids
  // captured from the attempt INSERT, since that's what the linear player serves.
  describe('AI-graded type exclusion (issue #175)', () => {
    // Drives a full non-adaptive start to the insert. `assignmentQuestionIds` become the
    // quiz_question_assignments; `questionTypeRows` is what the quiz_questions .in() lookup
    // returns. Captures the insert payload so the test can assert on resolved_question_ids.
    function routedStart(
      assignmentQuestionIds: string[],
      questionTypeRows: { id: string; content: { questionType?: string } | null }[],
    ) {
      const captured: { insertArg?: { resolved_question_ids?: string[] } } = {}
      let attemptSelects = 0
      const admin = {
        from: vi.fn((table: string) => {
          if (table === 'enrollments') return buildChain({ data: { id: 'e1' }, error: null })
          if (table === 'quizzes')
            return buildChain({
              data: {
                id: 'quiz-1',
                adaptive_mode: false,
                due_date: null,
                max_attempts: 1,
                shuffle_questions: false,
                question_pools: [],
              },
              error: null,
            })
          if (table === 'quiz_attempts') {
            attemptSelects += 1
            // 1st read: submitted attempts (max-attempts check) → none.
            // 2nd read: in-progress attempts → none, so we fall through to a fresh start.
            // 3rd call: the INSERT → returns the created attempt via .single().
            if (attemptSelects <= 2) return buildAwaitableChain({ data: [], error: null })
            const insertChain = buildChain({
              data: { id: 'attempt-1', quiz_id: 'quiz-1', student_id: 'student-123', section_id: 'section-1', status: 'in_progress' },
              error: null,
            }) as Record<string, unknown>
            insertChain.insert = vi.fn((arg: { resolved_question_ids?: string[] }) => {
              captured.insertArg = arg
              return insertChain
            })
            return insertChain
          }
          if (table === 'quiz_question_assignments')
            return buildAwaitableChain({
              data: assignmentQuestionIds.map((question_id) => ({ question_id })),
              error: null,
            })
          if (table === 'quiz_questions')
            return buildAwaitableChain({ data: questionTypeRows, error: null })
          return buildChain({ data: null, error: null })
        }),
      }
      return { admin, captured }
    }

    it('strips explanation/walkthrough questions from the resolved set', async () => {
      mockAuthenticated()
      const { admin, captured } = routedStart(
        ['q-mcq', 'q-explanation', 'q-short', 'q-walkthrough'],
        [
          { id: 'q-mcq', content: { questionType: 'multiple_choice' } },
          { id: 'q-explanation', content: { questionType: 'explanation' } },
          { id: 'q-short', content: { questionType: 'short_answer' } },
          { id: 'q-walkthrough', content: { questionType: 'walkthrough' } },
        ],
      )
      mockAdminClient.mockReturnValue(admin)

      const result = await startAttempt('section-1', 'quiz-1')

      expect(result.error).toBeUndefined()
      expect(captured.insertArg?.resolved_question_ids).toEqual(['q-mcq', 'q-short'])
    })

    it('keeps all questions when none are AI-graded', async () => {
      mockAuthenticated()
      const { admin, captured } = routedStart(
        ['q-mcq', 'q-short'],
        [
          { id: 'q-mcq', content: { questionType: 'multiple_choice' } },
          { id: 'q-short', content: { questionType: 'short_answer' } },
        ],
      )
      mockAdminClient.mockReturnValue(admin)

      const result = await startAttempt('section-1', 'quiz-1')

      expect(result.error).toBeUndefined()
      expect(captured.insertArg?.resolved_question_ids).toEqual(['q-mcq', 'q-short'])
    })
  })

  // Issue #43: max_attempts is now nullable and NULL means "no limit". The old guard
  // read `?? 1`, so a NULL row allowed exactly one attempt — the inverse of what it
  // means today. These drive the real DB value through the server gate (not just the
  // attemptsExhausted unit) because this is the only thing stopping a student from
  // re-taking a graded quiz: an off-by-one here is either a lockout or free retakes.
  describe('max attempts gate (issue #43)', () => {
    // Routes far enough to answer one question: does the gate let this start through?
    // A pass lands on the resume path (an in-progress attempt already exists), which
    // is the shortest route past the gate that still returns a real attempt.
    function routedGate(maxAttempts: number | null, submittedCount: number) {
      let attemptSelects = 0
      return {
        from: vi.fn((table: string) => {
          if (table === 'enrollments') return buildChain({ data: { id: 'e1' }, error: null })
          if (table === 'quizzes')
            return buildChain({
              data: {
                id: 'quiz-1',
                adaptive_mode: false,
                due_date: null,
                time_limit_minutes: null,
                max_attempts: maxAttempts,
                shuffle_questions: false,
                question_pools: [],
              },
              error: null,
            })
          if (table === 'quiz_attempts') {
            attemptSelects += 1
            // 1st read: the submitted attempts the gate counts.
            if (attemptSelects === 1)
              return buildAwaitableChain({
                data: Array.from({ length: submittedCount }, (_, i) => ({ id: `done-${i}` })),
                error: null,
              })
            // 2nd read: an in-progress attempt to resume, so a pass is observable.
            return buildAwaitableChain({
              data: [
                {
                  id: 'attempt-live',
                  quiz_id: 'quiz-1',
                  student_id: 'student-123',
                  section_id: 'section-1',
                  status: 'in_progress',
                  started_at: '2026-01-01T00:00:00Z',
                },
              ],
              error: null,
            })
          }
          if (table === 'quiz_answers') return buildAwaitableChain({ data: [], error: null })
          return buildChain({ data: null, error: null })
        }),
      }
    }

    it('never blocks when max_attempts is NULL, however many attempts are submitted', async () => {
      mockAuthenticated()
      mockAdminClient.mockReturnValue(routedGate(null, 7))

      const result = await startAttempt('section-1', 'quiz-1')

      expect(result.error).toBeUndefined()
      expect(result.data?.id).toBe('attempt-live')
    })

    it('blocks once the submitted count reaches an explicit cap', async () => {
      mockAuthenticated()
      mockAdminClient.mockReturnValue(routedGate(2, 2))

      const result = await startAttempt('section-1', 'quiz-1')

      expect(result.error).toBe('Maximum attempts reached')
      expect(result.data).toBeUndefined()
    })

    it('allows the last attempt one short of the cap', async () => {
      mockAuthenticated()
      mockAdminClient.mockReturnValue(routedGate(2, 1))

      const result = await startAttempt('section-1', 'quiz-1')

      expect(result.error).toBeUndefined()
      expect(result.data?.id).toBe('attempt-live')
    })

    it('honours a cap far above the old ceiling of 10', async () => {
      mockAuthenticated()
      mockAdminClient.mockReturnValue(routedGate(99, 98))
      expect((await startAttempt('section-1', 'quiz-1')).error).toBeUndefined()

      mockAdminClient.mockReturnValue(routedGate(99, 99))
      expect((await startAttempt('section-1', 'quiz-1')).error).toBe('Maximum attempts reached')
    })
  })
})

// ── saveAnswer ───────────────────────────────────────────────

describe('saveAnswer', () => {
  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const result = await saveAnswer('attempt-1', 'q-1', {})
    expect(result.error).toBe('Not authenticated')
  })

  it('rejects invalid input', async () => {
    mockAuthenticated()
    // saveAnswer validates input before checking attempt ownership
    const result = await saveAnswer('attempt-1', 'q-1', 'not-an-object')
    expect(result.error).toBe('Invalid input: Invalid input: expected object, received string')
  })

  it('rejects when attempt not found', async () => {
    mockAuthenticated()
    const admin = {
      from: vi.fn(() => buildChain({ data: null, error: null })),
    }
    mockAdminClient.mockReturnValue(admin)

    const result = await saveAnswer('attempt-1', 'q-1', { selectedOptionIds: ['opt-1'] })
    expect(result.error).toBe('Attempt not found')
  })

  it('rejects saving to an adaptive attempt (must go through the adaptive player)', async () => {
    mockAuthenticated()
    const admin = {
      from: vi.fn((table: string) => {
        if (table === 'quiz_attempts')
          return buildChain({
            data: { id: 'attempt-1', student_id: 'student-123', status: 'in_progress', started_at: '2026-01-01T00:00:00Z', quiz_id: 'quiz-1' },
            error: null,
          })
        // The quiz this attempt belongs to is adaptive — linear saves must be refused.
        return buildChain({ data: { adaptive_mode: true, time_limit_minutes: null }, error: null })
      }),
    }
    mockAdminClient.mockReturnValue(admin)

    const result = await saveAnswer('attempt-1', 'q-1', { selectedChoiceIds: ['opt-1'] })
    expect(result.error).toBe('Adaptive quizzes must be answered through the adaptive player.')
  })
})

// ── submitAttempt ────────────────────────────────────────────

describe('submitAttempt', () => {
  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const result = await submitAttempt('section-1', 'attempt-1')
    expect(result.error).toBe('Not authenticated')
  })

  // #311: the lookup filters on status='in_progress', so no rows means the attempt
  // is already finished. The timer-expiry path races startAttempt, which auto-submits
  // an expired attempt server-side — the player used to show a hard error over a
  // blank, unmounted screen even though the score was recorded. `alreadySubmitted`
  // is the flag QuizPlayer branches on to redirect to results instead.
  it('flags a no-rows miss as alreadySubmitted so the player can redirect to results', async () => {
    mockAuthenticated()
    const admin = {
      // PGRST116 is what PostgREST returns for .single() with no matching row.
      from: vi.fn(() => buildChain({ data: null, error: { code: 'PGRST116', message: 'No rows' } })),
    }
    mockAdminClient.mockReturnValue(admin)

    const result = await submitAttempt('section-1', 'attempt-1')
    expect(result.error).toBe('Attempt not found or already submitted')
    expect(result.alreadySubmitted).toBe(true)
  })

  it('does NOT flag a genuine DB fault as alreadySubmitted', async () => {
    mockAuthenticated()
    const admin = {
      // A connection blip — not PGRST116, so nothing can be concluded about the
      // attempt's state. Flagging it would eject a student from a LIVE attempt to
      // a results page they never submitted, with no error and no way back.
      from: vi.fn(() => buildChain({ data: null, error: { code: '08006', message: 'connection failure' } })),
    }
    mockAdminClient.mockReturnValue(admin)

    const result = await submitAttempt('section-1', 'attempt-1')
    expect(result.alreadySubmitted).toBeUndefined()
    expect(result.error).toContain('try submitting again')
  })
})

// ── getQuizClassAverage ──────────────────────────────────────

describe('getQuizClassAverage', () => {
  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const result = await getQuizClassAverage('section-1', 'quiz-1')
    expect(result.error).toBe('Not authenticated')
  })

  it('rejects non-enrolled students', async () => {
    mockAuthenticated()
    const admin = {
      from: vi.fn(() => buildChain({ data: null, error: null })),
    }
    mockAdminClient.mockReturnValue(admin)

    const result = await getQuizClassAverage('section-1', 'quiz-1')
    expect(result.error).toBe('Not enrolled in this section')
  })
})

// ── getUnifiedResult — explanation gating (issue #175) ─────
// AI feedback (rationale + rubric node coverage) must respect the professor's
// show_explanations timing. When the reveal is gated off, rationale and node
// counts are dropped from the per-question review, while the score-bearing
// fields (isCorrect, earnedPoints, textAnswer) still populate.

describe('getUnifiedResult explanation gating', () => {
  // Drives a full unified-result read to the questionReview array. Sequential
  // adminDb.from calls: quiz_attempts .single(), quizzes .single(), then the
  // awaited list queries quiz_answers (.eq), quiz_question_assignments (.order),
  // and quiz_questions (.in).
  function routedResults(
    showExplanations: string,
    answerRows: Record<string, unknown>[],
    questionRows: Record<string, unknown>[],
  ) {
    return {
      from: vi.fn((table: string) => {
        if (table === 'enrollments') return buildChain({ data: { id: 'e1' }, error: null })
        if (table === 'quiz_attempts')
          return buildChain({
            data: {
              id: 'attempt-1',
              quiz_id: 'quiz-1',
              student_id: 'student-123',
              section_id: 'section-1',
              status: 'submitted',
              score: 80,
              theta: 0.5,
              se: 0.3,
              stop_reason: 'max_items',
              resolved_question_ids: ['q-1'],
            },
            error: null,
          })
        if (table === 'quizzes')
          return buildChain({
            data: {
              id: 'quiz-1',
              title: 'Adaptive Quiz',
              adaptive_mode: true,
              pass_threshold: 60,
              show_explanations: showExplanations,
              due_date: null,
            },
            error: null,
          })
        if (table === 'quiz_answers') return buildAwaitableChain({ data: answerRows, error: null })
        if (table === 'quiz_question_assignments') return buildAwaitableChain({ data: [{ question_id: 'q-1' }], error: null })
        if (table === 'quiz_questions') return buildAwaitableChain({ data: questionRows, error: null })
        return buildChain({ data: null, error: null })
      }),
    }
  }

  const answerRow = {
    question_id: 'q-1',
    is_correct: true,
    earned_points: 2,
    text_answer: 'my explanation answer',
    rationale: 'You correctly identified the key concept.',
    nodes: [{ met: true }, { met: false }],
    soft_score: null,
    is_formative: false,
  }
  const questionRow = {
    id: 'q-1',
    question_text: 'Explain the concept',
    content: { questionType: 'explanation' },
    tags: ['topic-a'],
    points: 2,
  }

  it("drops rationale and node counts when show_explanations is 'never'", async () => {
    mockAuthenticated()
    mockAdminClient.mockReturnValue(routedResults('never', [answerRow], [questionRow]))

    const res = await getUnifiedResult('section-1', 'attempt-1')

    expect(res.result.isAdaptive).toBe(true)
    expect(res.result.questionReview).toHaveLength(1)
    const item = res.result.questionReview[0]
    // Feedback gated off: rationale + node coverage absent from the review.
    expect(item.rationale).toBeUndefined()
    expect(item.nodesMet).toBeUndefined()
    expect(item.nodesTotal).toBeUndefined()
    // Score-bearing fields still populate regardless of the explanation gate.
    expect(item.isCorrect).toBe(true)
    expect(item.earnedPoints).toBe(2)
    expect(item.textAnswer).toBe('my explanation answer')
  })

  it("reveals rationale and counts met nodes when show_explanations is 'after_submission'", async () => {
    mockAuthenticated()
    mockAdminClient.mockReturnValue(routedResults('after_submission', [answerRow], [questionRow]))

    const res = await getUnifiedResult('section-1', 'attempt-1')

    expect(res.result.isAdaptive).toBe(true)
    expect(res.result.questionReview).toHaveLength(1)
    const item = res.result.questionReview[0]
    // Feedback revealed: rationale present, node coverage [met:true, met:false] → 1 of 2.
    expect(item.rationale).toBe('You correctly identified the key concept.')
    expect(item.nodesMet).toBe(1)
    expect(item.nodesTotal).toBe(2)
    expect(item.isCorrect).toBe(true)
    expect(item.earnedPoints).toBe(2)
    expect(item.textAnswer).toBe('my explanation answer')
  })

  // Anti-leak regression: questionReview reaches the student regardless of the
  // explanation gate, so inline {{blank:id:answers}} answers embedded in the
  // question text MUST be stripped before getUnifiedResult returns. Guards the
  // fourth strip site (added after a security review found this leak path).
  it('strips inline fill-in-blank answers from the returned question text', async () => {
    mockAuthenticated()
    const blankAnswerRow = { ...answerRow, is_correct: false, earned_points: 0, text_answer: 'wrong' }
    const blankQuestionRow = {
      id: 'q-1',
      question_text: 'The powerhouse is the {{blank:b1:mitochondria|mito}}.',
      content: { questionType: 'fill_in_blank', blanks: [{ id: 'b1', acceptedAnswers: ['mitochondria', 'mito'] }] },
      tags: ['bio'],
      points: 2,
    }
    // 'after_submission' is the MORE permissive gate — if answers leak anywhere, it's here.
    mockAdminClient.mockReturnValue(routedResults('after_submission', [blankAnswerRow], [blankQuestionRow]))

    const res = await getUnifiedResult('section-1', 'attempt-1')

    const text = res.result.questionReview[0].questionText
    expect(text).toBe('The powerhouse is the {{blank:b1}}.')
    expect(text).not.toContain('mitochondria')
    expect(text).not.toContain('mito')
  })

  // The strip is gated on questionType: a non-fill-in-blank question whose prose
  // legitimately contains a "{{blank:...}}" substring (e.g. a lesson on templating
  // syntax) must be returned verbatim, not mangled.
  it('leaves a non-fill-in-blank question text untouched even if it contains blank-token syntax', async () => {
    mockAuthenticated()
    const prose = 'Which templating token defines a gap: {{blank:id:value}} or {%%}?'
    const proseRow = {
      id: 'q-1',
      question_text: prose,
      content: {
        questionType: 'multiple_choice',
        choices: [{ id: 'c1', text: '{{blank}}', isCorrect: true }, { id: 'c2', text: '{%%}', isCorrect: false }],
      },
      tags: ['web'],
      points: 1,
    }
    mockAdminClient.mockReturnValue(routedResults('after_submission', [answerRow], [proseRow]))

    const res = await getUnifiedResult('section-1', 'attempt-1')

    expect(res.result.questionReview[0].questionText).toBe(prose)
  })
})


// ── startAttempt: resume after losing the insert race ─────────
/**
 * `uq_quiz_attempt_one_in_progress` rejects the second concurrent start with 23505, and the
 * action resumes the winner's attempt instead of erroring. That resume has to carry the
 * answers already saved against it.
 *
 * This is a SECOND copy of the resume logic — the ordinary resume path higher up in
 * startAttempt loads answers too — which is exactly why it needs pinning: the two can drift
 * apart silently, and the branch only runs under a real race, so no one exercises it by hand.
 *
 * The oracle is the answers, not the attempt id. Returning the right row with an empty
 * answer set is the bug: the player renders every question blank, the student reads their
 * work as lost, and the next autosave writes over what was really there.
 */
describe('startAttempt — resume after a concurrent start (23505)', () => {
  const RACED = {
    id: 'attempt-winner',
    quiz_id: 'quiz-1',
    student_id: 'student-123',
    section_id: 'section-1',
    status: 'in_progress',
    started_at: '2026-01-01T00:00:00Z',
    resolved_question_ids: ['q1', 'q2'],
  }

  /** Routes the four quiz_attempts round-trips of a losing start, in order. */
  function racedInsert(savedAnswers: unknown[], insertErrorCode = '23505') {
    let attemptCalls = 0
    return {
      from: vi.fn((table: string) => {
        if (table === 'enrollments') return buildChain({ data: { id: 'e1' }, error: null })
        if (table === 'quizzes')
          return buildChain({
            data: {
              id: 'quiz-1',
              adaptive_mode: false,
              due_date: null,
              time_limit_minutes: null,
              max_attempts: null,
              shuffle_questions: false,
              question_pools: [],
            },
            error: null,
          })
        if (table === 'quiz_question_assignments')
          return buildAwaitableChain({ data: [], error: null })
        if (table === 'quiz_answers')
          return buildAwaitableChain({ data: savedAnswers, error: null })
        if (table === 'quiz_attempts') {
          attemptCalls += 1
          // 1: submitted-attempt count for the max-attempts gate.
          if (attemptCalls === 1) return buildAwaitableChain({ data: [], error: null })
          // 2: no in-progress attempt visible yet — this request believes it is first.
          if (attemptCalls === 2) return buildAwaitableChain({ data: [], error: null })
          // 3: the INSERT, rejected by the unique index because the other request won.
          if (attemptCalls === 3)
            return buildChain({ data: null, error: { code: insertErrorCode } })
          // 4: the re-read that finds the winner's attempt.
          return buildChain({ data: RACED, error: null })
        }
        return buildChain({ data: null, error: null })
      }),
    }
  }

  it('returns the winner’s attempt carrying the answers already saved against it', async () => {
    mockAuthenticated()
    mockAdminClient.mockReturnValue(
      racedInsert([
        { question_id: 'q1', selected_choice_ids: ['c2'], time_spent_seconds: 41 },
        { question_id: 'q2', text_answer: 'a tokenizer splits text into subword units' },
      ]),
    )

    const result = await startAttempt('section-1', 'quiz-1')

    expect(result.error).toBeUndefined()
    expect(result.data?.id).toBe('attempt-winner')
    // The student's work survives the race, keyed by question so the player can restore it.
    expect(Object.keys(result.data?.answers ?? {}).sort()).toEqual(['q1', 'q2'])
    expect(result.data?.answers.q1.selectedChoiceIds).toEqual(['c2'])
    expect(result.data?.answers.q2.textAnswer).toBe(
      'a tokenizer splits text into subword units',
    )
  })

  it('resumes with an empty answer set when nothing was saved yet', async () => {
    // The genuinely-blank case must still resume rather than error, so a double-click on a
    // fresh quiz opens the attempt instead of showing "Failed to start attempt".
    mockAuthenticated()
    mockAdminClient.mockReturnValue(racedInsert([]))

    const result = await startAttempt('section-1', 'quiz-1')

    expect(result.error).toBeUndefined()
    expect(result.data?.id).toBe('attempt-winner')
    expect(result.data?.answers).toEqual({})
  })

  it('still fails when the insert error is not the one-in-progress conflict', async () => {
    // Only 23505 means "someone else already started one". Treating other insert failures as
    // a resume would hand back a stale or absent attempt and hide a real fault.
    mockAuthenticated()
    mockAdminClient.mockReturnValue(racedInsert([], '23502'))

    const result = await startAttempt('section-1', 'quiz-1')

    expect(result.error).toBe('Failed to start attempt')
  })
})
