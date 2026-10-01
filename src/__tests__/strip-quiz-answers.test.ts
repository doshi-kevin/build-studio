// Anti-cheat strip: getRoomSnapshot runs this on every quiz before it goes to
// a student, so a regression here silently leaks correct answers. Pure logic —
// tested directly.
import { describe, it, expect } from 'vitest'
import { stripQuizAnswers } from '@/lib/live-classroom/snapshot-utils'
import type { SnapshotInteraction } from '@/lib/live-classroom/snapshot'

const quiz = (payload: Record<string, unknown>): SnapshotInteraction =>
  ({
    id: 'q1',
    room_id: 'r1',
    kind: 'quiz',
    payload,
    status: 'open',
    created_by: 'p1',
    created_at: '2026-06-10T00:00:00.000Z',
    opened_at: '2026-06-10T00:00:00.000Z',
    closed_at: null,
  }) as SnapshotInteraction

describe('stripQuizAnswers', () => {
  it('removes correctChoiceId + explanation from every question, keeps text/choices/id', () => {
    const out = stripQuizAnswers(
      quiz({
        title: 'T',
        questions: [
          { id: 'a', prompt: 'P1', choices: [{ id: 'c1', text: 'A' }], correctChoiceId: 'c1', explanation: 'why' },
          { id: 'b', prompt: 'P2', choices: [{ id: 'c2', text: 'B' }], correctChoiceId: 'c2', explanation: 'because' },
        ],
      }),
    )
    const qs = out.payload.questions as Array<Record<string, unknown>>
    for (const q of qs) {
      expect(q).not.toHaveProperty('correctChoiceId')
      expect(q).not.toHaveProperty('explanation')
    }
    expect(qs.map((q) => q.id)).toEqual(['a', 'b'])
    expect(qs[0].prompt).toBe('P1')
    expect(qs[0].choices).toEqual([{ id: 'c1', text: 'A' }])
  })

  it('drops the class report', () => {
    const out = stripQuizAnswers(quiz({ title: 'T', questions: [], report: { overallAccuracy: 90 } }))
    expect(out.payload).not.toHaveProperty('report')
  })

  it('leaves non-quiz interactions untouched (poll keeps its shape)', () => {
    const poll = { ...quiz({ choices: [{ id: 'c1', text: 'A' }] }), kind: 'poll' } as SnapshotInteraction
    expect(stripQuizAnswers(poll)).toBe(poll)
  })

  it('handles a quiz with no questions array without throwing, still drops report', () => {
    const out = stripQuizAnswers(quiz({ title: 'T', report: { x: 1 } }))
    expect(out.payload).not.toHaveProperty('report')
    expect(out.payload.title).toBe('T')
  })

  it('does not mutate the input (answers still present on the original)', () => {
    const input = quiz({
      title: 'T',
      report: { overallAccuracy: 90 },
      questions: [{ id: 'a', prompt: 'P', choices: [], correctChoiceId: 'c1', explanation: 'why' }],
    })
    stripQuizAnswers(input)
    const original = input.payload.questions as Array<Record<string, unknown>>
    expect(original[0].correctChoiceId).toBe('c1')
    expect(original[0].explanation).toBe('why')
    expect(input.payload.report).toEqual({ overallAccuracy: 90 })
  })
})
