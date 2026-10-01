// Tests for fetchClassRecaps (N4) — the shaping that turns the PII-free study
// pack + the caller's OWN rows into a recap. The assertions that matter: the
// per-student joins are self-scoped and correct (my result, my misses, my
// notes, my attendance), suppression-nulled class accuracy passes through
// untouched, and the empty cases return [] rather than a hedge.

import { describe, expect, it, vi } from 'vitest'
import { fetchClassRecaps } from '@/lib/ai/student-tutor/class-recap'

const SECTION = 'a1b2c3d4-1111-4111-8111-000000000003'
const USER = 'a1b2c3d4-1111-4111-8111-000000000009'
const ROOM = 'a1b2c3d4-1111-4111-8111-00000000000c'
const QUIZ = 'a1b2c3d4-1111-4111-8111-00000000000f'
/** A classmate in the same room — the row that must never reach our student. */
const OTHER = 'a1b2c3d4-1111-4111-8111-00000000000a'

function packContent(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    empty: false,
    extrasPending: false,
    noMaterials: false,
    meta: { durationMinutes: 50, slideCount: 30, slidesWithTranscript: 20, deckCount: 1 },
    quizzes: [
      {
        interactionId: QUIZ,
        title: 'Attention check',
        questions: [
          {
            id: 'q1',
            prompt: 'What do attention weights sum to?',
            choices: [
              { id: 'c1', text: 'One' },
              { id: 'c2', text: 'Zero' },
            ],
            correctChoiceId: 'c1',
            concept: 'attention',
            explanation: 'softmax',
          },
          {
            id: 'q2',
            prompt: 'Which layer normalizes?',
            choices: [
              { id: 'c3', text: 'LayerNorm' },
              { id: 'c4', text: 'Dropout' },
            ],
            correctChoiceId: 'c3',
            concept: 'layernorm',
            explanation: 'ln',
          },
        ],
        respondentCount: 12,
        classAccuracy: 75,
        comparisonSuppressed: false,
      },
    ],
    concepts: [{ concept: 'attention', correctRate: 70, respondentCount: 12, suppressed: false }],
    summary: 'The class covered attention.',
    summaryFailed: false,
    flashcards: null,
    flashcardsFailed: false,
    practiceQuiz: null,
    practiceQuizFailed: false,
    ...overrides,
  }
}

/** Thenable table-keyed fake admin client that really APPLIES `.eq`/`.in`
 *  (dotted paths included, for the `lc_rooms.section_id` embed filter). A
 *  filter-blind double would serve every row regardless of narrowing, so
 *  dropping `.eq('student_id', userId)` — another student's notes and answers
 *  landing in this student's recap — would pass silently. Verified: removing
 *  those three filters from class-recap.ts fails the self-scoping test below. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const read = (row: any, col: string): unknown =>
  col.split('.').reduce((v, k) => (v === null || v === undefined ? v : Array.isArray(v) ? v[0]?.[k] : v[k]), row)

function makeDb(tables: Record<string, unknown[]>) {
  return {
    from: vi.fn((table: string) => {
      let rows = [...(tables[table] ?? [])]
      const chain: Record<string, unknown> = {}
      chain.select = vi.fn(() => chain)
      chain.order = vi.fn(() => chain)
      chain.limit = vi.fn((n: number) => {
        rows = rows.slice(0, n)
        return chain
      })
      chain.eq = vi.fn((col: string, val: unknown) => {
        rows = rows.filter((r) => read(r, col) === val)
        return chain
      })
      chain.in = vi.fn((col: string, vals: unknown[]) => {
        rows = rows.filter((r) => vals.includes(read(r, col)))
        return chain
      })
      chain.then = (resolve: (v: { data: unknown; error: null }) => void) => resolve({ data: rows, error: null })
      return chain
    }),
  }
}

const packRow = (content: unknown, room: Record<string, unknown> = {}) => ({
  room_id: ROOM,
  status: 'ready',
  content,
  lc_rooms: {
    name: 'Lecture 6 live',
    status: 'ended',
    ended_at: '2026-08-04T15:00:00Z',
    created_at: '2026-08-04T14:00:00Z',
    section_id: SECTION,
    lecture_summary_enabled: true,
    ...room,
  },
})

describe('fetchClassRecaps', () => {
  it('shapes my result, my misses (theirs vs correct), attendance and notes — all self-scoped', async () => {
    const db = makeDb({
      lc_class_insights_student: [packRow(packContent())],
      lc_attendance: [], // no row → they missed it
      lc_notes: [{ room_id: ROOM, student_id: USER, content: 'remember: softmax rows' }],
      lc_responses: [{ interaction_id: QUIZ, student_id: USER, response: { answers: { q1: 'c2', q2: 'c3' } } }],
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [recap] = await fetchClassRecaps(db as any, SECTION, USER)
    expect(recap).toMatchObject({
      inClass: 'Lecture 6 live',
      onDate: '2026-08-04',
      attended: false,
      summary: 'The class covered attention.',
      concepts: ['attention'],
      myNotes: 'remember: softmax rows',
    })
    expect(recap.quizzes[0]).toMatchObject({ title: 'Attention check', myResult: '1/2 correct', classAccuracy: 75 })
    expect(recap.quizzes[0].missed).toEqual([
      { question: 'What do attention weights sum to?', myAnswer: 'Zero', correctAnswer: 'One' },
    ])
  })

  it('says "not answered" instead of inventing a zero, and passes a suppressed class accuracy through as null', async () => {
    const db = makeDb({
      lc_class_insights_student: [
        packRow(packContent({ quizzes: [{ ...packContent().quizzes[0], classAccuracy: null, comparisonSuppressed: true }] })),
      ],
      lc_attendance: [{ room_id: ROOM, student_id: USER }],
      lc_notes: [],
      lc_responses: [], // never responded
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [recap] = await fetchClassRecaps(db as any, SECTION, USER)
    expect(recap.attended).toBe(true)
    expect(recap.quizzes[0]).toMatchObject({ myResult: 'not answered', classAccuracy: null, missed: [] })
  })

  it('never reads another student — their notes, answers and attendance stay out of my recap', async () => {
    // The classmate sat in the same room, aced the quiz and took notes. Every
    // per-student read is filtered on the verified caller, so none of it is
    // mine: drop any `.eq('student_id', userId)` and this recap starts
    // reporting a classmate's record back to the student as their own.
    const db = makeDb({
      lc_class_insights_student: [packRow(packContent())],
      lc_attendance: [{ room_id: ROOM, student_id: OTHER }],
      lc_notes: [{ room_id: ROOM, student_id: OTHER, content: "the classmate's private notes" }],
      lc_responses: [
        { interaction_id: QUIZ, student_id: OTHER, response: { answers: { q1: 'c1', q2: 'c3' } } },
      ],
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [recap] = await fetchClassRecaps(db as any, SECTION, USER)
    expect(recap.attended).toBe(false)
    expect(recap.myNotes).toBeNull()
    expect(recap.quizzes[0].myResult).toBe('not answered')
  })

  it('only recaps this section — another section’s finished class is filtered out at the join', async () => {
    const db = makeDb({
      lc_class_insights_student: [
        packRow(packContent(), {
          name: 'Someone else’s class',
          section_id: 'a1b2c3d4-1111-4111-8111-0000000000ff',
        }),
      ],
      lc_attendance: [],
      lc_notes: [],
      lc_responses: [],
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await fetchClassRecaps(db as any, SECTION, USER)).toEqual([])
  })

  it('skips empty sessions and returns [] when nothing has a pack yet', async () => {
    const emptyDb = makeDb({ lc_class_insights_student: [] })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await fetchClassRecaps(emptyDb as any, SECTION, USER)).toEqual([])

    const emptyPack = makeDb({
      lc_class_insights_student: [packRow(packContent({ empty: true }))],
      lc_attendance: [],
      lc_notes: [],
      lc_responses: [],
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await fetchClassRecaps(emptyPack as any, SECTION, USER)).toEqual([])
  })
})

describe('fetchClassRecaps and the replay toggle (G14)', () => {
  it('drops the transcript-derived summary when the professor turned replay off — the rest of the recap stays', async () => {
    const db = makeDb({
      lc_class_insights_student: [packRow(packContent(), { lecture_summary_enabled: false })],
      lc_attendance: [],
      lc_notes: [],
      lc_responses: [{ interaction_id: QUIZ, student_id: USER, response: { answers: { q1: 'c1' } } }],
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [recap] = await fetchClassRecaps(db as any, SECTION, USER)
    expect(recap.summary).toBeNull() // his words, his call
    // Quiz review, concepts and the student's OWN answers are not his speech.
    expect(recap.concepts).toEqual(['attention'])
    expect(recap.quizzes[0].myResult).toBe('1/1 correct')
  })

  it('a null toggle predates the column and means on', async () => {
    const db = makeDb({
      lc_class_insights_student: [packRow(packContent(), { lecture_summary_enabled: null })],
      lc_attendance: [],
      lc_notes: [],
      lc_responses: [],
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [recap] = await fetchClassRecaps(db as any, SECTION, USER)
    expect(recap.summary).toBe('The class covered attention.')
  })
})
