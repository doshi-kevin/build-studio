// Tests for the quiz "results available" sweep: when an after-due-date quiz closes, notify
// everyone who submitted it — once per quiz, with attempters de-duplicated, and nothing when
// there's no due quiz or no attempters.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockEmitEvent = vi.fn()
vi.mock('@/lib/events/emit', () => ({ emitEvent: (...a: unknown[]) => mockEmitEvent(...a) }))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

import { runQuizResultsSweep } from '@/lib/notifications/quiz-results-sweep'

// A thenable query chain whose builder methods return itself and which resolves to a preset
// { data, error } when awaited — enough for the sweep's `await db.from(t)...` reads.
function routed(results: Record<string, { data: unknown; error: unknown }>) {
  return {
    from: vi.fn((table: string) => {
      const result = results[table] ?? { data: [], error: null }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {}
      for (const m of ['select', 'in', 'eq', 'gte', 'lte', 'lt', 'not', 'order', 'limit']) {
        chain[m] = () => chain
      }
      chain.then = (resolve: (v: unknown) => unknown) => resolve(result)
      return chain
    }),
  }
}

beforeEach(() => {
  mockEmitEvent.mockReset()
})

describe('runQuizResultsSweep', () => {
  it('emits once per due quiz to its de-duplicated attempters', async () => {
    const admin = routed({
      quizzes: {
        data: [
          { id: 'q1', section_id: 'sec-A', title: 'Quiz 1' },
          { id: 'q2', section_id: 'sec-B', title: 'Quiz 2' },
        ],
        error: null,
      },
      quiz_attempts: {
        data: [
          { quiz_id: 'q1', student_id: 's1' },
          { quiz_id: 'q1', student_id: 's2' },
          { quiz_id: 'q1', student_id: 's1' }, // same student, second attempt → deduped
          { quiz_id: 'q2', student_id: 's3' },
        ],
        error: null,
      },
    })

    const res = await runQuizResultsSweep(admin, { force: true })

    expect(res.dueQuizzes).toBe(2)
    expect(res.emitted).toBe(2)
    expect(mockEmitEvent).toHaveBeenCalledTimes(2)

    const byQuiz = Object.fromEntries(mockEmitEvent.mock.calls.map((c) => [c[0].entity.id, c[0]]))
    expect(byQuiz['q1']).toMatchObject({
      type: 'quiz_result_released',
      actorId: null,
      actionable: false,
      title: 'Results available: Quiz 1',
      linkUrl: '/student/courses/sec-A/quizzes/q1',
    })
    expect([...byQuiz['q1'].audience].sort()).toEqual(['s1', 's2']) // s1 deduped
    expect(byQuiz['q2']).toMatchObject({
      audience: ['s3'],
      linkUrl: '/student/courses/sec-B/quizzes/q2',
    })
  })

  it('emits nothing when no quiz is due in the window', async () => {
    const admin = routed({ quizzes: { data: [], error: null } })
    const res = await runQuizResultsSweep(admin, { force: true })
    expect(res.emitted).toBe(0)
    expect(res.skipped).toBe('no due quizzes in window')
    expect(mockEmitEvent).not.toHaveBeenCalled()
  })

  it('skips a due quiz that has no submitted attempts', async () => {
    const admin = routed({
      quizzes: { data: [{ id: 'q1', section_id: 'sec-A', title: 'Quiz 1' }], error: null },
      quiz_attempts: { data: [], error: null },
    })
    const res = await runQuizResultsSweep(admin, { force: true })
    expect(res.dueQuizzes).toBe(1)
    expect(res.emitted).toBe(0)
    expect(mockEmitEvent).not.toHaveBeenCalled()
  })
})
