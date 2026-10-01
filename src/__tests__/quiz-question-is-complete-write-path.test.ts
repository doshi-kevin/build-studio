// `quiz_questions.is_complete` is `NOT NULL DEFAULT true`, and publishQuiz gates
// on it: "an incomplete placeholder must never reach students". createQuestion
// and updateQuestion never set it, so anything they wrote claimed to be complete
// — which is how the Question Bank persisted an ungradeable question that then
// cleared the publish gate.
//
// The flag's CONSUMER was already tested (actions-prof-quizzes.test.ts asserts
// publishQuiz's gate) but against a MOCKED is_complete. Its PRODUCER was not
// tested at all. That seam is exactly where the bug lived, so these tests pin
// the write payload.
//
// The zero-correct MCQ case is covered upstream in schema-quiz-zero-correct:
// createQuestionServerSchema now rejects it outright, so it never reaches the
// insert. What still reaches it is an explanation/walkthrough question with no
// rubric — valid to the schema (`rubric` is nullable) but ungradeable, because
// every answer would score 0.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetUser = vi.fn()
const mockAdminClient = vi.fn()

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
vi.mock('@/lib/events/emit', () => ({ emitEvent: vi.fn(), markFeedItemDone: vi.fn() }))
vi.mock('@/lib/extraction/enqueue', () => ({
  enqueueExtractionJob: vi.fn(),
  enqueueMasteryRecompute: vi.fn(),
}))

import {
  createQuestion,
  updateQuestion,
} from '@/app/(dashboard)/professor/courses/[sectionId]/quizzes/actions'

const SECTION = 'section-1'
const PROF = 'prof-1'
const QUESTION = 'q-1'

/** A chain whose terminal read/write resolves to `result`, recording payloads. */
function chain(result: { data: unknown; error: unknown }) {
  const c: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'order', 'limit', 'lte', 'is']) {
    c[m] = vi.fn(() => c)
  }
  c.insert = vi.fn(() => c)
  c.update = vi.fn(() => c)
  c.single = vi.fn(async () => result)
  c.maybeSingle = vi.fn(async () => result)
  return c
}

/**
 * Ownership passes, and `quiz_questions` reads return `currentRow` so
 * updateQuestion's merge path can run (the shared helper in
 * actions-prof-quizzes returns null there, which short-circuits it).
 */
function mockDb(currentRow: unknown) {
  const questionChains: Record<string, unknown>[] = []
  mockGetUser.mockResolvedValue({ data: { user: { id: PROF } }, error: null })
  mockAdminClient.mockReturnValue({
    from: vi.fn((table: string) => {
      if (table === 'course_sections') {
        return chain({ data: { id: SECTION, professor_id: PROF }, error: null })
      }
      if (table === 'quiz_questions') {
        const c = chain({ data: currentRow, error: null })
        questionChains.push(c)
        return c
      }
      return chain({ data: null, error: null })
    }),
  })
  return { questionChains }
}

const payloadOf = (c: Record<string, unknown>, method: 'insert' | 'update') =>
  (c[method] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<string, unknown> | undefined

/** updateQuestion opens TWO quiz_questions chains: the completeness read, then
 *  the write. Find the one that was actually written to. */
function writePayload(chains: Record<string, unknown>[]) {
  for (const c of chains) {
    const p = payloadOf(c, 'update')
    if (p) return p
  }
  return undefined
}

const explanationQuestion = (rubric: unknown) => ({
  questionText: 'Explain gradient descent.',
  content: { questionType: 'explanation' as const },
  difficulty: 'medium' as const,
  points: 5,
  rubric,
})

describe('createQuestion — is_complete', () => {
  beforeEach(() => {
    mockGetUser.mockReset()
    mockAdminClient.mockReset()
  })

  it('stores is_complete: false for an explanation question with no rubric', () => {
    // Ungradeable: without a rubric every answer scores 0. The DEFAULT true is
    // what made this land in the bank picker and clear publishQuiz's gate.
    const { questionChains } = mockDb({ id: QUESTION })

    return createQuestion(SECTION, explanationQuestion(null) as never).then(() => {
      expect(payloadOf(questionChains[0], 'insert')?.is_complete).toBe(false)
    })
  })

  it('stores is_complete: true once a rubric is supplied', async () => {
    const { questionChains } = mockDb({ id: QUESTION })

    await createQuestion(
      SECTION,
      explanationQuestion([{ concept: 'States the chain rule' }]) as never,
    )

    expect(payloadOf(questionChains[0], 'insert')?.is_complete).toBe(true)
  })

  it('stores is_complete: true for a well-formed multiple-choice question', async () => {
    const { questionChains } = mockDb({ id: QUESTION })

    await createQuestion(SECTION, {
      questionText: 'Which is compiled?',
      content: {
        questionType: 'multiple_choice',
        choices: [
          { id: 'c0', text: 'C', isCorrect: true },
          { id: 'c1', text: 'Python', isCorrect: false },
        ],
        allowMultiple: false,
      },
      difficulty: 'easy',
      points: 1,
    } as never)

    expect(payloadOf(questionChains[0], 'insert')?.is_complete).toBe(true)
  })
})

describe('updateQuestion — is_complete recomputed from MERGED state', () => {
  const storedComplete = {
    question_text: 'Explain gradient descent.',
    content: { questionType: 'explanation' },
    rubric: [{ concept: 'States the chain rule' }],
  }

  beforeEach(() => {
    mockGetUser.mockReset()
    mockAdminClient.mockReset()
  })

  it('flips to false when the rubric is EXPLICITLY cleared with null', async () => {
    // The trap: `parsed.data.rubric ?? current.rubric` treats an explicit null as
    // "not provided" and falls back to the stored rubric — computing completeness
    // from a rubric the same UPDATE is deleting, so the row is written
    // rubric: null + is_complete: true. That is the very bug this commit closes,
    // reintroduced by its own fix. The merge must use `!== undefined`.
    const { questionChains } = mockDb(storedComplete)

    await updateQuestion(SECTION, QUESTION, { rubric: null } as never)

    const payload = writePayload(questionChains)
    expect(payload?.rubric).toBeNull()
    expect(payload?.is_complete).toBe(false)
  })

  it('stays true when an unrelated field changes and the rubric is untouched', async () => {
    // Completeness must come from the merged state, not from the sparse input —
    // judging it from the payload alone would call this incomplete.
    const { questionChains } = mockDb(storedComplete)

    await updateQuestion(SECTION, QUESTION, {
      questionText: 'Explain gradient descent, briefly.',
      rubric: storedComplete.rubric,
    } as never)

    expect(writePayload(questionChains)?.is_complete).toBe(true)
  })

  it('does NOT touch fields the caller never sent', async () => {
    /* updateQuestionServerSchema is `.partial()` over defaulted fields, so zod
       materialises `rubric` and the IRT triple as null for a caller that never
       sent them — and the action used to write all four. The Question Bank dialog
       omits exactly those, so every edit through it silently deleted the
       professor's rubric (leaving an AI-graded question ungradeable) and wiped an
       adaptive question's calibration. Presence must come from the raw input. */
    const { questionChains } = mockDb(storedComplete)

    await updateQuestion(SECTION, QUESTION, { points: 3 } as never)

    const payload = writePayload(questionChains)
    expect(payload?.points).toBe(3)
    for (const wiped of ['rubric', 'irt_a', 'irt_b', 'irt_c']) {
      expect(payload).not.toHaveProperty(wiped)
    }
  })

  it('treats an explicitly-undefined key as NOT sent', async () => {
    /* hasOwnProperty alone is true for a key present with an undefined value, and
       zod then supplies that field's default — so `{...form, rubric: form.rubric}`
       with the field unset re-armed the rubric wipe even after the presence fix.
       Clearing a rubric on purpose is still possible: that is `null`, which is
       distinguishable from `undefined` (covered by the explicit-null test above). */
    const { questionChains } = mockDb(storedComplete)

    await updateQuestion(SECTION, QUESTION, {
      points: 3,
      rubric: undefined,
    } as never)

    const payload = writePayload(questionChains)
    expect(payload?.points).toBe(3)
    expect(payload).not.toHaveProperty('rubric')
  })

  it('skips the completeness recompute entirely for a metadata-only edit', () => {
    /* Now that `provided()` reports what the caller actually sent, points/tags
       genuinely cannot change completeness — so the extra read is skipped and the
       flag is left exactly as it was. Before the presence fix this could not be
       gated honestly: zod materialised `rubric: null`, which made every edit look
       like it touched completeness. */
    const { questionChains } = mockDb(storedComplete)

    return updateQuestion(SECTION, QUESTION, { points: 3 } as never).then(() => {
      const payload = writePayload(questionChains)
      expect(payload?.points).toBe(3)
      expect(payload).not.toHaveProperty('is_complete')
    })
  })
})
