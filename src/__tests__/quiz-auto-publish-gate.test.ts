// The eligibility gate for scheduled quiz publishing (#311).
//
// Scheduled publish has three writers — the professor quiz list, the student quiz
// list, and a pg_cron job. The "must have questions" rule originally lived in only
// one of them, so a question-less scheduled quiz still went live to students by
// whichever path ran first. These tests pin the shared TypeScript copy; the cron
// path enforces the same rule in SQL and is not covered here.
import { describe, it, expect, vi } from 'vitest'
import { selectPublishableScheduledQuizIds } from '@/lib/quiz/auto-publish'

type Result = { data: unknown; error?: unknown }

/**
 * Minimal Supabase double. Both queries in the gate end on a list filter and are
 * awaited directly, so each chain must be thenable — see agent-memory:
 * quiz-action-mock-chain for why the shared buildChain deliberately is not.
 */
function fakeDb(results: { quizzes: Result; quiz_question_assignments?: Result }) {
  const tables: string[] = []
  const from = vi.fn((table: string) => {
    tables.push(table)
    const result =
      table === 'quizzes'
        ? results.quizzes
        : (results.quiz_question_assignments ?? { data: [], error: null })
    const chain: Record<string, unknown> = {}
    for (const method of ['select', 'eq', 'not', 'lte', 'in']) {
      chain[method] = vi.fn().mockReturnValue(chain)
    }
    chain.then = (resolve: (v: unknown) => unknown) => resolve(result)
    return chain
  })
  return { db: { from }, tables }
}

const due = (...ids: string[]) => ({ data: ids.map((id) => ({ id })), error: null })
const withQuestion = (quizId: string, isComplete: boolean) => ({
  quiz_id: quizId,
  question: { is_complete: isComplete },
})

const NOW = '2026-12-31T12:00:00.000Z'

describe('selectPublishableScheduledQuizIds (#311)', () => {
  it('holds back a due draft that has NO questions at all', async () => {
    // The reported bug: a scheduled quiz the professor never filled in went live.
    const { db } = fakeDb({
      quizzes: due('q-empty'),
      quiz_question_assignments: { data: [], error: null },
    })

    const { eligibleIds, heldBack } = await selectPublishableScheduledQuizIds(db, 'section-1', NOW)

    expect(eligibleIds).toEqual([])
    expect(heldBack).toBe(1)
  })

  it('holds back a draft with an INCOMPLETE question even when others are complete', async () => {
    // Mirrors publishQuiz: one placeholder question blocks the whole quiz.
    const { db } = fakeDb({
      quizzes: due('q-partial'),
      quiz_question_assignments: {
        data: [withQuestion('q-partial', true), withQuestion('q-partial', false)],
        error: null,
      },
    })

    const { eligibleIds, heldBack } = await selectPublishableScheduledQuizIds(db, 'section-1', NOW)

    expect(eligibleIds).toEqual([])
    expect(heldBack).toBe(1)
  })

  it('publishes only the ready quiz out of a mixed due batch', async () => {
    const { db } = fakeDb({
      quizzes: due('q-ready', 'q-empty', 'q-partial'),
      quiz_question_assignments: {
        data: [
          withQuestion('q-ready', true),
          withQuestion('q-ready', true),
          withQuestion('q-partial', false),
        ],
        error: null,
      },
    })

    const { eligibleIds, heldBack } = await selectPublishableScheduledQuizIds(db, 'section-1', NOW)

    // One bad quiz in the batch must not take the good one down with it, and must
    // not ride along with it either.
    expect(eligibleIds).toEqual(['q-ready'])
    expect(heldBack).toBe(2)
  })

  it('honors an incomplete question that Supabase returned as an ARRAY join', async () => {
    // Supabase returns a single embedded relation as an object OR a one-element
    // array depending on context. Reading only the object shape would see "no
    // is_complete flag" and publish the placeholder quiz.
    const { db } = fakeDb({
      quizzes: due('q-partial'),
      quiz_question_assignments: {
        data: [{ quiz_id: 'q-partial', question: [{ is_complete: false }] }],
        error: null,
      },
    })

    const { eligibleIds } = await selectPublishableScheduledQuizIds(db, 'section-1', NOW)

    expect(eligibleIds).toEqual([])
  })

  it('treats a null/missing question join as present-but-unknown, not incomplete', async () => {
    // is_complete is only ever false for a KNOWN placeholder. A join that came back
    // null must not silently block a real quiz forever — it still counts as a
    // question, so the quiz publishes.
    const { db } = fakeDb({
      quizzes: due('q-joinless'),
      quiz_question_assignments: { data: [{ quiz_id: 'q-joinless', question: null }], error: null },
    })

    const { eligibleIds } = await selectPublishableScheduledQuizIds(db, 'section-1', NOW)

    expect(eligibleIds).toEqual(['q-joinless'])
  })

  it('skips the assignments fan-out entirely when nothing is due', async () => {
    // The overwhelmingly common case — this runs on EVERY quiz-list load for every
    // professor and student. Zero due quizzes must cost exactly one query.
    const { db, tables } = fakeDb({ quizzes: { data: [], error: null } })

    const { eligibleIds, heldBack } = await selectPublishableScheduledQuizIds(db, 'section-1', NOW)

    expect(eligibleIds).toEqual([])
    expect(heldBack).toBe(0)
    expect(tables).toEqual(['quizzes'])
  })

  it('throws when the due-quiz read fails instead of reporting "nothing due"', async () => {
    // Fail loud: swallowing the error here would look identical to "no quizzes are
    // due", so every scheduled quiz in the section would silently never publish.
    // Both callers catch this, log, and skip the write for that load.
    const { db } = fakeDb({ quizzes: { data: null, error: { message: 'boom' } } })

    await expect(selectPublishableScheduledQuizIds(db, 'section-1', NOW)).rejects.toMatchObject({
      message: 'boom',
    })
  })
})
