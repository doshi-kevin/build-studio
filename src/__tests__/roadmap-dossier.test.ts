// Student dossier aggregations (src/lib/roadmap/dossier.ts) — the pure logic
// behind the roadmap's floating student card and the stored facts snapshot.

import { describe, it, expect } from 'vitest'
import {
  aggregateFumbles,
  collectLateAssignments,
  collectLateQuizzes,
  collectWeakestSkills,
  materialOpenRates,
} from '@/lib/roadmap/dossier'

describe('aggregateFumbles', () => {
  it('groups per question, keeps only wrong-at-least-once, most-wrong first', () => {
    const rows = [
      { questionId: 'q1', isCorrect: false, questionText: 'Softmax temperature', quizTitle: 'Quiz 4' },
      { questionId: 'q1', isCorrect: false, questionText: 'Softmax temperature', quizTitle: 'Quiz 4' },
      { questionId: 'q1', isCorrect: true, questionText: 'Softmax temperature', quizTitle: 'Quiz 4' },
      { questionId: 'q2', isCorrect: true, questionText: 'BPE merges', quizTitle: 'Quiz 3' },
      { questionId: 'q3', isCorrect: false, questionText: 'Positional encoding', quizTitle: 'Quiz 4' },
    ]
    const out = aggregateFumbles(rows)
    expect(out).toEqual([
      { questionText: 'Softmax temperature', quizTitle: 'Quiz 4', wrongCount: 2, attempts: 3 },
      { questionText: 'Positional encoding', quizTitle: 'Quiz 4', wrongCount: 1, attempts: 1 },
    ])
  })

  it('breaks wrong-count ties toward more attempts (kept fumbling)', () => {
    const rows = [
      { questionId: 'a', isCorrect: false, questionText: 'A', quizTitle: 'Q' },
      { questionId: 'b', isCorrect: false, questionText: 'B', quizTitle: 'Q' },
      { questionId: 'b', isCorrect: true, questionText: 'B', quizTitle: 'Q' },
    ]
    expect(aggregateFumbles(rows).map((f) => f.questionText)).toEqual(['B', 'A'])
  })

  it('drops rows whose question no longer resolves and honours max', () => {
    const rows = [
      { questionId: 'gone', isCorrect: false, questionText: null, quizTitle: null },
      ...Array.from({ length: 8 }, (_, i) => ({
        questionId: `q${i}`, isCorrect: false as const, questionText: `T${i}`, quizTitle: 'Q',
      })),
    ]
    expect(aggregateFumbles(rows, 5)).toHaveLength(5)
  })
})

describe('collectLateAssignments', () => {
  it('keeps only genuinely late submissions with computed lateness, most-late first', () => {
    const out = collectLateAssignments([
      { title: 'A1', dueAt: '2026-03-01T00:00:00Z', submittedAt: '2026-02-28T00:00:00Z' }, // early
      { title: 'A2', dueAt: '2026-03-01T00:00:00Z', submittedAt: '2026-03-01T04:00:00Z' }, // +4h
      { title: 'A3', dueAt: '2026-03-01T00:00:00Z', submittedAt: '2026-03-03T00:00:00Z' }, // +2d
      { title: 'A4', dueAt: null, submittedAt: '2026-03-05T00:00:00Z' },                   // no deadline
    ])
    expect(out).toEqual([
      { title: 'A3', kind: 'assignment', lateBySeconds: 2 * 86400 },
      { title: 'A2', kind: 'assignment', lateBySeconds: 4 * 3600 },
    ])
  })
})

describe('collectLateQuizzes', () => {
  it('keeps one entry per quiz — the worst attempt — and only late ones', () => {
    const out = collectLateQuizzes([
      { title: 'Quiz 1', isLate: true, lateBySeconds: 120 },
      { title: 'Quiz 1', isLate: true, lateBySeconds: 900 },
      { title: 'Quiz 2', isLate: false, lateBySeconds: 0 },
    ])
    expect(out).toEqual([{ title: 'Quiz 1', kind: 'quiz', lateBySeconds: 900 }])
  })
})

describe('collectWeakestSkills', () => {
  it('filters excluded/suppressed topics and unscored rows, lowest scores first, rounded', () => {
    const topics = [
      { id: 't1', name: 'Self-attention' },
      { id: 't2', name: 'Hidden topic', excluded: true },
      { id: 't3', name: 'Suppressed topic', suppressed: true },
      { id: 't4', name: 'Word embeddings' },
      { id: 't5', name: 'HMM tagging' },
    ]
    const mastery = [
      { skill_id: 't1', score: 31.4 },
      { skill_id: 't2', score: 5 },     // excluded topic must not surface
      { skill_id: 't3', score: 8 },     // suppressed topic must not surface
      { skill_id: 't4', score: 55.6 },
      { skill_id: 't5', score: null },  // no signal yet
      { skill_id: 'missing', score: 12 }, // stale row for a deleted topic
    ]
    expect(collectWeakestSkills(topics, mastery, 3)).toEqual([
      { name: 'Self-attention', score: 31 },
      { name: 'Word embeddings', score: 56 },
    ])
  })
})

describe('materialOpenRates', () => {
  const roster = ['s1', 's2', 's3']
  const items = ['i1', 'i2', 'i3', 'i4']

  it('counts DISTINCT opens per student and averages over the whole roster', () => {
    const { byStudent, classPct } = materialOpenRates(
      [
        { studentId: 's1', itemId: 'i1' },
        { studentId: 's1', itemId: 'i1' }, // revisit — must not double-count
        { studentId: 's1', itemId: 'i2' },
        { studentId: 's2', itemId: 'i1' },
        // s3 opened nothing
      ],
      items,
      roster,
    )
    expect(byStudent.get('s1')).toEqual({ opened: 2, total: 4, pct: 50 })
    expect(byStudent.get('s2')).toEqual({ opened: 1, total: 4, pct: 25 })
    // A student with no events is a 0, not an absence — otherwise the average
    // the card compares against is inflated. (50 + 25 + 0) / 3 = 25.
    expect(byStudent.get('s3')).toEqual({ opened: 0, total: 4, pct: 0 })
    expect(classPct).toBe(25)
  })

  it('ignores events for items that are no longer openable, so nobody exceeds 100%', () => {
    const { byStudent } = materialOpenRates(
      [
        { studentId: 's1', itemId: 'i1' },
        { studentId: 's1', itemId: 'deleted' },  // item removed since
        { studentId: 's1', itemId: 'locked-wk' }, // week not open yet
      ],
      ['i1', 'i2'],
      ['s1'],
    )
    expect(byStudent.get('s1')).toEqual({ opened: 1, total: 2, pct: 50 })
  })

  it('reports null rather than 0% when the section has nothing to open', () => {
    const { byStudent, classPct } = materialOpenRates([], [], ['s1'])
    expect(byStudent.get('s1')).toEqual({ opened: 0, total: 0, pct: null })
    expect(classPct).toBeNull()
  })

  it('leaves non-roster students out of the map and the average', () => {
    const { byStudent, classPct } = materialOpenRates(
      [{ studentId: 'dropped-student', itemId: 'i1' }, { studentId: 's1', itemId: 'i1' }],
      ['i1', 'i2'],
      ['s1'],
    )
    expect(byStudent.has('dropped-student')).toBe(false)
    expect(classPct).toBe(50)
  })
})
