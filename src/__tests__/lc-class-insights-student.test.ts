// Unit tests for the PII-free student Class Insights computation.
// The two things that MUST hold: (1) class aggregates are suppressed below
// STUDENT_MIN_RESPONDENTS so the few who answered can't be de-anonymised,
// and (2) the blob never carries student identities.

import { describe, it, expect } from 'vitest'
import { computeStudentInsights } from '@/lib/live-classroom/insights/compute-student'
import { hasLectureMaterials } from '@/lib/live-classroom/insights/generate'
import { STUDENT_MIN_RESPONDENTS } from '@/lib/validations/lc-class-insights'
import type { SessionReportInput } from '@/lib/live-classroom/report/compute'

const ROOM_START = '2026-06-14T10:00:00.000Z'
const ROOM_END = '2026-06-14T11:00:00.000Z'

const quizPayload = {
  title: 'Trees Quiz',
  questions: [
    { id: 'q1', prompt: 'What is a BST?', choices: [{ id: 'a', text: 'Sorted tree' }, { id: 'b', text: 'Random tree' }], correctChoiceId: 'a', concept: 'BST', explanation: 'Left < node < right.' },
    { id: 'q2', prompt: 'Splay rotation?', choices: [{ id: 'a', text: 'Yes' }, { id: 'b', text: 'No' }], correctChoiceId: 'b', concept: 'Splay Trees', explanation: 'Splays move accessed node to root.' },
  ],
}

// Five questions sharing ONE concept — enough answers from a single student to
// cross STUDENT_MIN_RESPONDENTS if suppression counts answers instead of people.
const oneConceptPayload = {
  title: 'KNN Drill',
  questions: Array.from({ length: STUDENT_MIN_RESPONDENTS }, (_, i) => ({
    id: `k${i}`,
    prompt: `KNN question ${i}`,
    choices: [{ id: 'a', text: 'Yes' }, { id: 'b', text: 'No' }],
    correctChoiceId: 'a',
    concept: 'KNN',
    explanation: 'Nearest neighbours.',
  })),
}

// The same topic spelled two ways — mergeConcepts() folds these into one row.
const caseVariantPayload = {
  title: 'Splay Quiz',
  questions: [
    { id: 'v1', prompt: 'Splay A?', choices: [{ id: 'a', text: 'Yes' }, { id: 'b', text: 'No' }], correctChoiceId: 'a', concept: 'Splay Trees', explanation: '.' },
    { id: 'v2', prompt: 'Splay B?', choices: [{ id: 'a', text: 'Yes' }, { id: 'b', text: 'No' }], correctChoiceId: 'a', concept: 'splay trees', explanation: '.' },
  ],
}

function input(overrides: Partial<SessionReportInput> = {}): SessionReportInput {
  return {
    room: { createdAt: ROOM_START, endedAt: ROOM_END },
    decks: [
      { id: 'deck-1', title: 'Lecture', position: 1, pageCount: 10, maxSlideShown: 0, transcriptions: [{ page_number: 0, text: 'Trees.' }] },
    ],
    interactions: [
      { id: 'quiz1', kind: 'quiz', payload: quizPayload, status: 'closed', created_by: 'prof' },
    ],
    responses: [],
    enrolledStudents: Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, name: `Student ${i}` })),
    attendance: [],
    ...overrides,
  }
}

function answers(n: number) {
  // n students each answer both questions correctly.
  return Array.from({ length: n }, (_, i) => ({
    interaction_id: 'quiz1',
    student_id: `s${i}`,
    response: { answers: { q1: 'a', q2: 'b' } },
  }))
}

describe('computeStudentInsights', () => {
  it('keeps full quiz review content (questions, correct answers, explanations)', () => {
    const out = computeStudentInsights(input({ responses: answers(6) }))
    expect(out.quizzes).toHaveLength(1)
    const q = out.quizzes[0]
    expect(q.title).toBe('Trees Quiz')
    expect(q.questions).toHaveLength(2)
    expect(q.questions[0].correctChoiceId).toBe('a')
    expect(q.questions[0].explanation).toContain('Left < node')
    // Non-empty session → LLM extras still pending after deterministic compute.
    expect(out.extrasPending).toBe(true)
  })

  it('suppresses class accuracy below the respondent threshold', () => {
    const out = computeStudentInsights(input({ responses: answers(STUDENT_MIN_RESPONDENTS - 1) }))
    const q = out.quizzes[0]
    expect(q.respondentCount).toBe(STUDENT_MIN_RESPONDENTS - 1)
    expect(q.comparisonSuppressed).toBe(true)
    expect(q.classAccuracy).toBeNull()
  })

  it('reveals class accuracy at or above the respondent threshold', () => {
    const out = computeStudentInsights(input({ responses: answers(STUDENT_MIN_RESPONDENTS) }))
    const q = out.quizzes[0]
    expect(q.comparisonSuppressed).toBe(false)
    expect(q.classAccuracy).toBe(100) // all answered correctly
  })

  it('suppresses per-concept accuracy below the threshold', () => {
    const out = computeStudentInsights(input({ responses: answers(3) }))
    // 3 answers per concept (< 5) → suppressed
    expect(out.concepts.length).toBeGreaterThan(0)
    for (const c of out.concepts) {
      expect(c.suppressed).toBe(true)
      expect(c.correctRate).toBeNull()
    }
  })

  // Suppression must count PEOPLE, not answers. Counting answers means one student
  // who answers enough questions on a topic un-suppresses that topic — publishing
  // what is really just their own accuracy to the whole class.
  it('keeps a concept suppressed when one student supplied all its answers', () => {
    const out = computeStudentInsights(
      input({
        interactions: [{ id: 'quiz1', kind: 'quiz', payload: oneConceptPayload, status: 'closed', created_by: 'prof' }],
        // A single student, five answers, all tagged 'KNN'.
        responses: [
          {
            interaction_id: 'quiz1',
            student_id: 's0',
            response: { answers: { k0: 'a', k1: 'a', k2: 'a', k3: 'a', k4: 'a' } },
          },
        ],
      }),
    )
    const knn = out.concepts.find((c) => c.concept === 'KNN')
    expect(knn).toBeDefined()
    expect(knn?.respondentCount).toBe(1)
    expect(knn?.suppressed).toBe(true)
    expect(knn?.correctRate).toBeNull()
  })

  // mergeConcepts() folds case/whitespace variants of one label together AFTER the
  // tally. So a per-variant respondent count that is merely SUMMED reintroduces the
  // same bug one layer up: the same student, counted once per spelling.
  it('counts a student once across case variants of the same concept label', () => {
    const out = computeStudentInsights(
      input({
        interactions: [{ id: 'quiz1', kind: 'quiz', payload: caseVariantPayload, status: 'closed', created_by: 'prof' }],
        // 4 distinct students — below the threshold — each answering both spellings.
        responses: Array.from({ length: 4 }, (_, i) => ({
          interaction_id: 'quiz1',
          student_id: `s${i}`,
          response: { answers: { v1: 'a', v2: 'a' } },
        })),
      }),
    )
    // Both spellings collapse to one concept…
    expect(out.concepts).toHaveLength(1)
    // …backed by 4 people, not 8 answers, so it stays suppressed.
    expect(out.concepts[0].respondentCount).toBe(4)
    expect(out.concepts[0].suppressed).toBe(true)
    expect(out.concepts[0].correctRate).toBeNull()
  })

  it('never leaks any student identity into the blob (PII-free guarantee)', () => {
    const out = computeStudentInsights(input({ responses: answers(6) }))
    const serialized = JSON.stringify(out)
    // No enrolled student id or name should appear anywhere in the blob.
    for (let i = 0; i < 30; i++) {
      expect(serialized).not.toContain(`"s${i}"`)
      expect(serialized).not.toContain(`Student ${i}`)
    }
  })

  it('flags an empty session (no transcript, no interactions)', () => {
    const out = computeStudentInsights(
      input({
        decks: [{ id: 'deck-1', title: 'Lecture', position: 1, pageCount: 10, maxSlideShown: 0, transcriptions: [] }],
        interactions: [],
        responses: [],
      }),
    )
    expect(out.empty).toBe(true)
    expect(out.extrasPending).toBe(false) // empty session has no extras to wait on
    expect(out.summary).toBeNull()
    expect(out.practiceQuiz).toBeNull()
  })

  it('defaults noMaterials false — the orchestrator sets it after building context', () => {
    const out = computeStudentInsights(input({ responses: answers(6) }))
    expect(out.noMaterials).toBe(false)
  })

  /* #563 loosened the PROFESSOR's empty gate so a transcription-less class still gets a
     report. This gate is deliberately left strict, and these two say why in executable
     form: attendance is an operational fact, not study material, and the student's empty
     branch already offers the recording and their own notes. If someone later
     "harmonises" the two gates, the first of these fails. */
  describe('the student gate stays stricter than the professor gate (#563)', () => {
    const silent = {
      decks: [{ id: 'deck-1', title: 'Lecture', position: 1, pageCount: 10, maxSlideShown: 0, transcriptions: [] }],
      interactions: [],
      responses: [],
    }

    it('a well-attended class with nothing transcribed still has nothing to study', () => {
      const out = computeStudentInsights(
        input({
          ...silent,
          attendance: Array.from({ length: 24 }, (_, i) => ({
            student_id: `s${i}`,
            joined_at: ROOM_START,
            last_seen_at: ROOM_END,
          })),
        }),
      )
      expect(out.empty).toBe(true)
    })

    it('slides having been advanced is not study material either', () => {
      const out = computeStudentInsights(
        input({
          ...silent,
          decks: [{ id: 'deck-1', title: 'Lecture', position: 1, pageCount: 10, maxSlideShown: 7, transcriptions: [] }],
        }),
      )
      expect(out.empty).toBe(true)
    })
  })

  /* extrasPending is a promise to the client: it keeps polling while this is true, and
     its own give-up counter only trips on fetch FAILURES — so a successful "still
     pending" spins forever. It used to be `!empty`, which promised extras for a
     quiz-only session that `generate.ts` would never produce. */
  describe('extrasPending only promises extras that can actually arrive (#563)', () => {
    it('is false for a quiz-only session with no deck at all', () => {
      // No decks → buildSessionLectureContext iterates nothing and returns empty
      // strings, so hasLectureMaterials is provably false. Safe to predict.
      const out = computeStudentInsights(input({ decks: [] }))
      expect(out.empty).toBe(false) // the quiz alone is worth studying
      expect(out.extrasPending).toBe(false) // …but no summary or flashcards are coming
    })

    it('stays true when a deck exists but has no transcript', () => {
      /* The under-prediction trap. Slide TEXT lives in `lc_decks.extraction`, a column
         this function is never handed, so a deck with extracted text but no audio DOES
         get extras. Guessing false here would stop the client polling and the student
         would never see them. */
      const out = computeStudentInsights({
        ...input(),
        decks: [{ id: 'deck-1', title: 'Lecture', position: 1, pageCount: 10, maxSlideShown: 0, transcriptions: [] }],
      })
      expect(out.extrasPending).toBe(true)
    })
  })
})

describe('hasLectureMaterials', () => {
  // The bug this guards: a quiz-only room (no transcript, no slide text) reached
  // the LLM with an empty context and hallucinated. Only real material may pass.
  it('is false when both slide content and transcription are empty/whitespace', () => {
    expect(hasLectureMaterials('', '')).toBe(false)
    expect(hasLectureMaterials('   \n  ', '\t\n')).toBe(false)
  })

  it('is true when either slide content or transcription has real text', () => {
    expect(hasLectureMaterials('Binary search trees…', '')).toBe(true)
    expect(hasLectureMaterials('', 'The professor explained recursion.')).toBe(true)
  })
})
