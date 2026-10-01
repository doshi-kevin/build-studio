// Unit tests for the post-session report computation (pure function).
// Covers: quiz fallback math when no stored report, poll aggregation,
// active-participation union, attendance split + late joins, struggle
// threshold, unanswered questions, and the empty-session flag.

import { describe, it, expect } from 'vitest'
import {
  computeSessionStats,
  type SessionReportInput,
} from '@/lib/live-classroom/report/compute'

const ROOM_START = '2026-06-12T10:00:00.000Z'
const ROOM_END = '2026-06-12T11:00:00.000Z'

function baseInput(overrides: Partial<SessionReportInput> = {}): SessionReportInput {
  return {
    room: { createdAt: ROOM_START, endedAt: ROOM_END },
    decks: [
      {
        id: 'deck-1',
        title: 'Deck 1',
        position: 1,
        pageCount: 20,
        maxSlideShown: 0,
        transcriptions: [{ page_number: 0, text: 'Welcome to gradient descent.' }],
      },
    ],
    interactions: [],
    responses: [],
    enrolledStudents: [
      { id: 's1', name: 'Alice' },
      { id: 's2', name: 'Bob' },
      { id: 's3', name: 'Cara' },
    ],
    attendance: [],
    ...overrides,
  }
}

describe('computeSessionStats', () => {
  it('computes meta from the room row', () => {
    const report = computeSessionStats(baseInput())
    expect(report.meta.durationMinutes).toBe(60)
    expect(report.meta.slideCount).toBe(20)
    expect(report.meta.slidesWithTranscript).toBe(1)
    expect(report.empty).toBe(false)
  })

  it('flags an empty session (no transcript, no interactions) and never narrates it', () => {
    const report = computeSessionStats(
      baseInput({
        decks: [{ id: 'deck-1', title: 'Deck 1', position: 1, pageCount: 20, maxSlideShown: 0, transcriptions: [] }],
      }),
    )
    expect(report.empty).toBe(true)
    expect(report.aiNarrative).toBeNull()
  })

  /* #563. `empty` used to mean "nothing was transcribed", so a real class taught with
     transcription off was reported as having no data at all — throwing away the
     attendance, duration and deck figures this function computes for every session
     regardless. These four pin the redefinition: what now counts as the class having
     happened, and what still does not. */
  describe('empty means nothing happened, not nothing was transcribed (#563)', () => {
    const silent = {
      decks: [{ id: 'deck-1', title: 'Deck 1', position: 1, pageCount: 20, maxSlideShown: 0, transcriptions: [] }],
      interactions: [],
      responses: [],
    }

    it('attendance alone is enough — the case the issue was filed for', () => {
      const report = computeSessionStats(
        baseInput({
          ...silent,
          attendance: [{ student_id: 's1', joined_at: ROOM_START, last_seen_at: ROOM_END }],
        }),
      )
      expect(report.empty).toBe(false)
      // And the figures that were being discarded are really there to show.
      expect(report.attendance.attendedCount).toBe(1)
      expect(report.meta.durationMinutes).toBe(60)
    })

    it('advancing the deck is enough, with nobody in the room', () => {
      const report = computeSessionStats(
        baseInput({
          ...silent,
          attendance: [],
          decks: [{ id: 'deck-1', title: 'Deck 1', position: 1, pageCount: 20, maxSlideShown: 7, transcriptions: [] }],
        }),
      )
      expect(report.empty).toBe(false)
    })

    it('a room nobody joined, with nothing shown, is still empty', () => {
      // The accidentally-opened room. Deliberately NOT gated on duration as well:
      // this session ran a full hour and is still correctly empty.
      const report = computeSessionStats(baseInput({ ...silent, attendance: [] }))
      expect(report.empty).toBe(true)
      expect(report.meta.durationMinutes).toBe(60)
    })
  })

  /* The high-water mark is 0-INDEXED and defaults to 0, so 0 cannot distinguish "never
     opened" from "showed slide 1". Reporting "1 of 20 slides" for an untouched deck
     would be a lie, so the count stays null at the floor. */
  describe('slidesShown converts the 0-indexed mark to a count (#563)', () => {
    const deck = (maxSlideShown: number) => ({
      decks: [{ id: 'deck-1', title: 'Deck 1', position: 1, pageCount: 20, maxSlideShown, transcriptions: [] }],
    })

    it('reports mark + 1, so a mark of 7 is 8 slides shown', () => {
      const report = computeSessionStats(baseInput(deck(7)))
      expect(report.decks[0].slidesShown).toBe(8)
      expect(report.meta.slidesShown).toBe(8)
      // The file's length is a different fact and must not move.
      expect(report.decks[0].pageCount).toBe(20)
    })

    it('stays null at the mark floor rather than claiming one slide', () => {
      const report = computeSessionStats(baseInput(deck(0)))
      expect(report.decks[0].slidesShown).toBeNull()
      expect(report.meta.slidesShown).toBeNull()
    })

    it('sums across decks, skipping the ones never opened', () => {
      const report = computeSessionStats(
        baseInput({
          decks: [
            { id: 'd1', title: 'A', position: 1, pageCount: 10, maxSlideShown: 4, transcriptions: [] },
            { id: 'd2', title: 'B', position: 2, pageCount: 10, maxSlideShown: 0, transcriptions: [] },
          ],
        }),
      )
      expect(report.meta.slidesShown).toBe(5)
    })
  })

  it('groups transcript coverage per deck, and decks share no page-number space', () => {
    const report = computeSessionStats(
      baseInput({
        decks: [
          {
            id: 'deck-1',
            title: 'Lecture',
            position: 1,
            pageCount: 10,
        maxSlideShown: 0,
            transcriptions: [
              { page_number: 0, text: 'lecture intro' },
              { page_number: 1, text: 'lecture body' },
            ],
          },
          {
            id: 'deck-2',
            title: 'Handout',
            position: 2,
            pageCount: 5,
        maxSlideShown: 0,
            // Same page_number 0 as deck-1 — must NOT collide or double-count.
            transcriptions: [{ page_number: 0, text: 'handout note' }],
          },
        ],
      }),
    )
    expect(report.meta.deckCount).toBe(2)
    expect(report.meta.slideCount).toBe(15) // 10 + 5
    expect(report.meta.slidesWithTranscript).toBe(3) // 2 + 1
    expect(report.decks.map((d) => d.title)).toEqual(['Lecture', 'Handout'])
    expect(report.decks[0].slidesWithTranscript).toBe(2)
    expect(report.decks[1].slidesWithTranscript).toBe(1)
  })

  describe('attendance', () => {
    it('splits attended vs absent and flags late joins', () => {
      const report = computeSessionStats(
        baseInput({
          attendance: [
            // on time, stayed 55 min
            { student_id: 's1', joined_at: ROOM_START, last_seen_at: '2026-06-12T10:55:00.000Z' },
            // 15 min late (> 10 min threshold)
            { student_id: 's2', joined_at: '2026-06-12T10:15:00.000Z', last_seen_at: ROOM_END },
          ],
        }),
      )
      expect(report.attendance.tracked).toBe(true)
      expect(report.attendance.attendedCount).toBe(2)
      expect(report.attendance.rate).toBe(67) // 2 of 3
      expect(report.attendance.absent).toEqual([{ id: 's3', name: 'Cara' }])

      const alice = report.attendance.attendees.find((a) => a.id === 's1')!
      expect(alice.lateJoin).toBe(false)
      expect(alice.minutes).toBe(55)
      const bob = report.attendance.attendees.find((a) => a.id === 's2')!
      expect(bob.lateJoin).toBe(true)
    })

    // #186: the room is created (and the deck uploaded) before class actually
    // starts, so created_at marks on-time students late. started_at is the real
    // baseline; both the attendee list and the per-student table must use it.
    it('measures late joins from started_at, not room creation, when present', () => {
      const attendance = [
        // Joined 20 min after the room was OPENED, but 5 min after class STARTED.
        { student_id: 's1', joined_at: '2026-06-12T10:20:00.000Z', last_seen_at: ROOM_END },
      ]

      const fromCreation = computeSessionStats(baseInput({ attendance }))
      expect(fromCreation.attendance.attendees[0].lateJoin).toBe(true)

      const fromRealStart = computeSessionStats(
        baseInput({
          room: { createdAt: ROOM_START, startedAt: '2026-06-12T10:15:00.000Z', endedAt: ROOM_END },
          attendance,
        }),
      )
      expect(fromRealStart.attendance.attendees[0].lateJoin).toBe(false)
      expect(fromRealStart.students.find((s) => s.id === 's1')!.lateJoin).toBe(false)
    })

    /* This case used to assert tracked=false whenever the attendance list was empty, which
       is the #645 part 2 bug rather than the contract: a class nobody attended reported
       "Attendance wasn't tracked" while the per-student table on the same page listed
       everyone as Absent. "Was it captured?" and "did anyone come?" are different
       questions. lc_attendance shipped 2026-06-12, so the room's own date answers the
       first one. */
    it('reports a real zero for a captured session nobody attended', () => {
      const report = computeSessionStats(baseInput())
      expect(report.attendance.tracked).toBe(true)
      expect(report.attendance.attendedCount).toBe(0)
    })

    it('reports not-tracked for a room that predates attendance capture', () => {
      const report = computeSessionStats(
        baseInput({
          room: { createdAt: '2026-05-01T10:00:00.000Z', endedAt: '2026-05-01T11:00:00.000Z' },
        }),
      )
      expect(report.attendance.tracked).toBe(false)
      expect(report.attendance.attendedCount).toBe(0)
    })
  })

  describe('active participation', () => {
    it('unions responders with non-anonymous askers, excluding anonymous askers', () => {
      const report = computeSessionStats(
        baseInput({
          interactions: [
            {
              id: 'q-anon',
              kind: 'question',
              payload: { text: 'What is X?', anonymous: true, upvotes: 0, answered: false },
              status: 'open',
              created_by: 's3', // anonymous — must NOT count
            },
            {
              id: 'q-named',
              kind: 'question',
              payload: { text: 'Why Y?', anonymous: false, upvotes: 2, answered: true },
              status: 'open',
              created_by: 's2',
            },
          ],
          responses: [{ interaction_id: 'i1', student_id: 's1', response: {} }],
        }),
      )
      // s1 responded, s2 asked non-anonymously, s3 only asked anonymously
      expect(report.participation.activeCount).toBe(2)
      expect(report.participation.rate).toBe(67)
    })
  })

  describe('quizzes', () => {
    const quizPayload = {
      title: 'Check 1',
      questions: [
        { id: 'q1', correctChoiceId: 'a', concept: 'Gradients' },
        { id: 'q2', correctChoiceId: 'b', concept: 'Learning Rate' },
      ],
    }

    it('falls back to computing accuracy from raw responses when no stored report', () => {
      const report = computeSessionStats(
        baseInput({
          interactions: [
            { id: 'quiz1', kind: 'quiz', payload: quizPayload, status: 'closed', created_by: 'prof' },
          ],
          responses: [
            // s1: both right; s2: one right
            { interaction_id: 'quiz1', student_id: 's1', response: { answers: { q1: 'a', q2: 'b' } } },
            { interaction_id: 'quiz1', student_id: 's2', response: { answers: { q1: 'a', q2: 'x' } } },
          ],
        }),
      )
      expect(report.quizzes).toHaveLength(1)
      const quiz = report.quizzes[0]
      expect(quiz.title).toBe('Check 1')
      expect(quiz.submissions).toBe(2)
      expect(quiz.accuracy).toBe(75) // 3 of 4 answers
      expect(quiz.nonResponderCount).toBe(1) // 3 enrolled − 2 responded
      const lr = quiz.concepts.find((c) => c.concept === 'Learning Rate')!
      expect(lr.correctRate).toBe(50)
    })

    it('builds per-student rows: accuracy, attendance, and at-risk flagging', () => {
      const report = computeSessionStats(
        baseInput({
          interactions: [
            { id: 'quiz1', kind: 'quiz', payload: quizPayload, status: 'closed', created_by: 'prof' },
          ],
          responses: [
            { interaction_id: 'quiz1', student_id: 's1', response: { answers: { q1: 'a', q2: 'b' } } }, // 100%
            { interaction_id: 'quiz1', student_id: 's2', response: { answers: { q1: 'x', q2: 'x' } } }, // 0%
          ],
          attendance: [
            { student_id: 's1', joined_at: ROOM_START, last_seen_at: ROOM_END },
            { student_id: 's2', joined_at: ROOM_START, last_seen_at: ROOM_END },
          ],
        }),
      )
      expect(report.students).toHaveLength(3) // Alice, Bob, Cara enrolled
      const s1 = report.students.find((s) => s.id === 's1')!
      expect(s1.quizAccuracy).toBe(100)
      expect(s1.quizzesAnswered).toBe(1)
      expect(s1.attended).toBe(true)
      expect(s1.atRisk).toBe(false)
      const s2 = report.students.find((s) => s.id === 's2')!
      expect(s2.quizAccuracy).toBe(0)
      expect(s2.atRisk).toBe(true) // scored below threshold
      const s3 = report.students.find((s) => s.id === 's3')! // Cara: absent, no answers
      expect(s3.attended).toBe(false)
      expect(s3.quizAccuracy).toBeNull()
      expect(s3.atRisk).toBe(true)
      // At-risk students sort first.
      expect(report.students[0].atRisk).toBe(true)
    })

    it('prefers the stored QuizReport snapshot when present', () => {
      const stored = {
        closedAt: ROOM_END,
        totalStudents: 9,
        overallAccuracy: 42,
        concepts: [{ concept: 'Gradients', correctCount: 3, totalCount: 9, correctRate: 33 }],
        questions: [],
        nonResponders: [{ id: 's3', name: 'Cara' }],
      }
      const report = computeSessionStats(
        baseInput({
          interactions: [
            {
              id: 'quiz1',
              kind: 'quiz',
              payload: { ...quizPayload, report: stored },
              status: 'closed',
              created_by: 'prof',
            },
          ],
          // Deliberately contradictory raw responses — must be ignored
          responses: [
            { interaction_id: 'quiz1', student_id: 's1', response: { answers: { q1: 'a', q2: 'b' } } },
          ],
        }),
      )
      expect(report.quizzes[0].accuracy).toBe(42)
      expect(report.quizzes[0].submissions).toBe(9)
      expect(report.quizzes[0].nonResponderCount).toBe(1)
    })
  })

  it('aggregates polls per choice', () => {
    const report = computeSessionStats(
      baseInput({
        interactions: [
          {
            id: 'poll1',
            kind: 'poll',
            payload: {
              question: 'Ready to move on?',
              choices: [
                { id: 'yes', text: 'Yes' },
                { id: 'no', text: 'No' },
              ],
            },
            status: 'closed',
            created_by: 'prof',
          },
        ],
        responses: [
          { interaction_id: 'poll1', student_id: 's1', response: { choiceIds: ['yes'] } },
          { interaction_id: 'poll1', student_id: 's2', response: { choiceIds: ['yes'] } },
          { interaction_id: 'poll1', student_id: 's3', response: { choiceIds: ['no'] } },
        ],
      }),
    )
    const poll = report.polls[0]
    expect(poll.total).toBe(3)
    expect(poll.choices.find((c) => c.id === 'yes')!.count).toBe(2)
    expect(poll.choices.find((c) => c.id === 'no')!.count).toBe(1)
  })

  it('lists unanswered questions explicitly, sorted by upvotes', () => {
    const report = computeSessionStats(
      baseInput({
        interactions: [
          {
            id: 'qa1',
            kind: 'question',
            payload: { text: 'Low-vote open question', anonymous: true, upvotes: 1, answered: false },
            status: 'open',
            created_by: 's1',
          },
          {
            id: 'qa2',
            kind: 'question',
            payload: { text: 'Popular open question', anonymous: false, upvotes: 5, answered: false },
            status: 'open',
            created_by: 's2',
          },
          {
            id: 'qa3',
            kind: 'question',
            payload: { text: 'Answered question', anonymous: false, upvotes: 0, answered: true },
            status: 'closed',
            created_by: 's3',
          },
        ],
      }),
    )
    expect(report.qa.total).toBe(3)
    expect(report.qa.answeredCount).toBe(1)
    expect(report.qa.unanswered.map((q) => q.text)).toEqual([
      'Popular open question',
      'Low-vote open question',
    ])
  })

  it('aggregates struggle concepts across quizzes under the 60% threshold', () => {
    const mkQuiz = (id: string, concept: string, correct: number, total: number) => ({
      id,
      kind: 'quiz' as const,
      payload: {
        title: id,
        questions: [],
        report: {
          closedAt: ROOM_END,
          totalStudents: total,
          overallAccuracy: 0,
          concepts: [{ concept, correctCount: correct, totalCount: total, correctRate: Math.round((correct / total) * 100) }],
          questions: [],
          nonResponders: [],
        },
      },
      status: 'closed' as const,
      created_by: 'prof',
    })
    const report = computeSessionStats(
      baseInput({
        interactions: [
          mkQuiz('quizA', 'Gradients', 2, 10), // 20% — struggle
          mkQuiz('quizB', 'Gradients', 3, 10), // combined 25% — struggle
          mkQuiz('quizC', 'Backprop', 9, 10), // 90% — fine
        ],
      }),
    )
    expect(report.struggleConcepts).toHaveLength(1)
    expect(report.struggleConcepts[0].concept).toBe('Gradients')
    expect(report.struggleConcepts[0].correctRate).toBe(25)
  })

  it('merges concept labels that differ only by case or whitespace', () => {
    const mkQuiz = (id: string, concept: string, correct: number, total: number) => ({
      id,
      kind: 'quiz' as const,
      payload: {
        title: id,
        questions: [],
        report: {
          closedAt: ROOM_END,
          totalStudents: total,
          overallAccuracy: 0,
          concepts: [{ concept, correctCount: correct, totalCount: total, correctRate: Math.round((correct / total) * 100) }],
          questions: [],
          nonResponders: [],
        },
      },
      status: 'closed' as const,
      created_by: 'prof',
    })
    const report = computeSessionStats(
      baseInput({
        interactions: [
          mkQuiz('quizA', 'Splay Trees', 0, 3),
          mkQuiz('quizB', 'Splay trees', 0, 1), // case variant — same topic
          mkQuiz('quizC', 'Splay  Trees', 0, 1), // repeated whitespace — same topic
        ],
      }),
    )
    expect(report.struggleConcepts).toHaveLength(1)
    const splay = report.struggleConcepts[0]
    expect(splay.totalCount).toBe(5)
    expect(splay.correctCount).toBe(0)
    expect(splay.correctRate).toBe(0)
    // Display label comes from the variant with the most answers (3).
    expect(splay.concept).toBe('Splay Trees')
  })

  it('merges concept variants within a single quiz card, not just the aggregate', () => {
    const report = computeSessionStats(
      baseInput({
        interactions: [
          {
            id: 'quiz1',
            kind: 'quiz' as const,
            payload: {
              title: 'Trees',
              questions: [],
              report: {
                closedAt: ROOM_END,
                totalStudents: 4,
                overallAccuracy: 50,
                concepts: [
                  { concept: 'Splay Trees', correctCount: 2, totalCount: 3, correctRate: 67 },
                  { concept: 'splay trees', correctCount: 1, totalCount: 1, correctRate: 100 },
                ],
                questions: [],
                nonResponders: [],
              },
            },
            status: 'closed' as const,
            created_by: 'prof',
          },
        ],
      }),
    )
    // The variants collapse on the quiz card itself (stored-report path), not
    // only when re-merged in the cross-quiz struggle aggregate.
    expect(report.quizzes[0].concepts).toHaveLength(1)
    expect(report.quizzes[0].concepts[0].concept).toBe('Splay Trees')
    expect(report.quizzes[0].concepts[0].totalCount).toBe(4)
  })
})
