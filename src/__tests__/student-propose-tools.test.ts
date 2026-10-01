// The three `propose` tools are the first place Athena's output moves the app
// rather than just answering. The pure pieces underneath them are tested
// separately (challenge-match, class-question, booking-note); what is only
// testable here is the orchestration, and two properties of it matter:
//
//   1. A tool that has nothing to propose must NOT emit a directive. Every
//      reason code (`no_live_room`, `nothing_missed_yet`, `no_office_hours`,
//      `no_open_challenges`) is a path where the answer says "not right now"
//      while the app would still be navigating — Athena telling the student the
//      class isn't live as their browser lands in an empty live room. Nothing
//      throws; it just contradicts itself.
//   2. What the directive carries is server-built. The route comes from the
//      typed registry off ids resolved here, and no id reaches the tool result
//      the model reads.
//
// The Supabase double filters for real and the real query helpers run against
// it, so the fixtures below are also the scoping test: another student's
// mastery, another professor's office hours, a draft challenge and another
// section's rows are all present and all have to be filtered out by the code
// under test rather than by the fixture.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { STUDENT_TOOLS } from '@/lib/ai/student-tutor/tools'
import { buildStudentTools, type Directive } from '@/lib/ai/student-tutor/contract'
import type { AthenaRunEvent } from '@/lib/ai/athena-directive'

const SECTION = 'sec-1'
const OTHER_SECTION = 'sec-2'
const STUDENT = 'stu-1'
const PROF = 'prof-1'

// A Friday, so "the next day the professor is in" has to cross a weekend.
const NOW = new Date('2026-07-31T09:00:00.000Z')
const inDays = (n: number) => new Date(NOW.getTime() + n * 86_400_000).toISOString()

type Row = Record<string, unknown>

/** Read a PostgREST column reference, including an embedded one
 *  (`challenge.section_id`) — `getStudentClaims` filters through its join. */
function read(row: Row, col: string): unknown {
  if (!col.includes('.')) return row[col]
  return col.split('.').reduce<unknown>((value, key) => {
    if (value === null || typeof value !== 'object') return undefined
    const next = (value as Row)[key]
    return Array.isArray(next) ? next[0] : next
  }, row)
}

/** Row-aware Supabase double: filters actually filter, so a dropped `.eq()`
 *  changes the rows the tool sees rather than passing quietly. */
function stubDb(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      let rows = [...(tables[table] ?? [])]
      const settled = () => ({ data: rows, error: null })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {
        select: () => chain,
        // Ordering really orders: "the most recent thing you got wrong" is a
        // claim the draft makes out loud, and it rests entirely on this clause.
        order: (col: string, opts?: { ascending?: boolean }) => {
          const dir = opts?.ascending === false ? -1 : 1
          rows = [...rows].sort((a, b) => dir * String(read(a, col)).localeCompare(String(read(b, col))))
          return chain
        },
        limit: (n: number) => {
          rows = rows.slice(0, n)
          return chain
        },
        eq: (col: string, val: unknown) => {
          rows = rows.filter((r) => read(r, col) === val)
          return chain
        },
        in: (col: string, vals: unknown[]) => {
          rows = rows.filter((r) => vals.includes(read(r, col)))
          return chain
        },
        not: (col: string, op: string, val: string) => {
          expect(op).toBe('in')
          const excluded = val.replace(/^\(|\)$/g, '').split(',')
          rows = rows.filter((r) => !excluded.includes(String(read(r, col))))
          return chain
        },
        single: async () => ({ data: rows[0] ?? null, error: null }),
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(settled()).then(resolve),
      }
      return chain
    },
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SKILLS: Row[] = [
  { id: 'sk-graphs', section_id: SECTION, name: 'Graph Traversal', position: 0 },
  { id: 'sk-attn', section_id: SECTION, name: 'Attention', position: 1 },
  { id: 'sk-beam', section_id: SECTION, name: 'Beam Search', position: 2 },
  { id: 'sk-tok', section_id: SECTION, name: 'Tokenization', position: 3 },
]

/** Our student is strong on graphs only. `stu-other` has the inverted standing,
 *  so `.eq('student_id')` is load-bearing: drop it and Attention reads as
 *  mastered, which changes both the challenge match and the booking note. */
const MASTERY: Row[] = [
  { section_id: SECTION, student_id: STUDENT, skill_id: 'sk-graphs', score: 92 },
  { section_id: SECTION, student_id: STUDENT, skill_id: 'sk-attn', score: 41 },
  { section_id: SECTION, student_id: STUDENT, skill_id: 'sk-beam', score: 55 },
  { section_id: SECTION, student_id: STUDENT, skill_id: 'sk-tok', score: 70 },
  { section_id: SECTION, student_id: 'stu-other', skill_id: 'sk-attn', score: 99 },
]

const ACTIVITY_SKILLS: Row[] = [
  { id: 'as-1', section_id: SECTION, activity_id: 'ch-graphs', activity_type: 'challenge', skill_id: 'sk-graphs' },
  { id: 'as-2', section_id: SECTION, activity_id: 'ch-attn', activity_type: 'challenge', skill_id: 'sk-attn' },
  { id: 'as-3', section_id: SECTION, activity_id: 'ch-draft', activity_type: 'challenge', skill_id: 'sk-graphs' },
  // A quiz mapped to the skill our student is strong on. Only `challenge` links
  // may build the map — count this one and 'ch-attn' becomes a false match.
  { id: 'as-4', section_id: SECTION, activity_id: 'ch-attn', activity_type: 'quiz', skill_id: 'sk-graphs' },
]

const CHALLENGES: Row[] = [
  {
    id: 'ch-graphs',
    section_id: SECTION,
    visibility: 'published',
    title: 'Graph Traversal Sprint',
    points: 50,
    bonus_points: 10,
    due_at: inDays(3),
    difficulty: 'medium',
  },
  {
    id: 'ch-attn',
    section_id: SECTION,
    visibility: 'published',
    title: 'Attention Deep Dive',
    points: 30,
    bonus_points: 0,
    due_at: inDays(2),
    difficulty: 'hard',
  },
  // Unpublished, matched, and closing soonest — it would win if the published
  // filter ever came off.
  {
    id: 'ch-draft',
    section_id: SECTION,
    visibility: 'draft',
    title: 'Not Published Yet',
    points: 999,
    bonus_points: 0,
    due_at: inDays(1),
    difficulty: 'easy',
  },
  {
    id: 'ch-other-section',
    section_id: OTHER_SECTION,
    visibility: 'published',
    title: 'Another Course Entirely',
    points: 500,
    bonus_points: 0,
    due_at: inDays(1),
    difficulty: 'easy',
  },
]

const LIVE_ROOM: Row = {
  id: 'room-1',
  section_id: SECTION,
  status: 'live',
  name: 'Lecture 12',
  created_at: inDays(-0.1),
}

const OFFICE_HOURS: Row[] = [
  { id: 'oh-1', professor_id: PROF, day_of_week: 'monday', is_active: true },
  // Inactive, and lands on the Sunday — sooner than Monday, so the is_active
  // filter is what keeps the drive off it.
  { id: 'oh-2', professor_id: PROF, day_of_week: 'sunday', is_active: false },
  // Another professor's Saturday — sooner still.
  { id: 'oh-3', professor_id: 'prof-other', day_of_week: 'saturday', is_active: true },
]

const ATTEMPT: Row = {
  id: 'att-1',
  quiz_id: 'quiz-1',
  section_id: SECTION,
  student_id: STUDENT,
  status: 'submitted',
  score: 60,
  submitted_at: '2026-07-29',
  quiz: { title: 'Transformers Quiz 2' },
}

const ANSWERS: Row[] = [
  {
    attempt_id: 'att-1',
    question_id: 'q-right',
    is_correct: true,
    earned_points: 1,
    text_answer: 'softmax',
  },
  {
    attempt_id: 'att-1',
    question_id: 'q-wrong',
    is_correct: false,
    earned_points: 0,
    text_answer: 'Speed',
  },
]

const QUESTIONS: Row[] = [
  {
    id: 'q-right',
    question_text: 'Which function normalizes attention scores?',
    question_type: 'short_answer',
    content: { acceptedAnswers: ['softmax'] },
    points: 1,
  },
  {
    id: 'q-wrong',
    question_text: 'What is the title of the transformer paper?',
    question_type: 'short_answer',
    content: { acceptedAnswers: ['Attention Is All You Need'] },
    points: 1,
  },
]

const FULL: Record<string, Row[]> = {
  course_sections: [{ id: SECTION, professor_id: PROF }],
  skills: SKILLS,
  skill_mastery: MASTERY,
  activity_skills: ACTIVITY_SKILLS,
  challenges: CHALLENGES,
  challenge_claims: [],
  lc_rooms: [LIVE_ROOM],
  office_hours: OFFICE_HOURS,
  quiz_attempts: [ATTEMPT],
  quiz_answers: ANSWERS,
  quiz_questions: QUESTIONS,
}

// ── Harness ───────────────────────────────────────────────────────────────────

interface Run {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: any
  directives: Directive[]
  events: AthenaRunEvent[]
}

async function runTool(name: string, tables: Record<string, Row[]> = FULL): Promise<Run> {
  const directives: Directive[] = []
  const events: AthenaRunEvent[] = []
  const tools = buildStudentTools(
    {
      adminDb: stubDb(tables),
      sectionId: SECTION,
      userId: STUDENT,
      institutionId: 'inst-1',
      conversationId: null,
      emit: (d) => directives.push(d),
    },
    STUDENT_TOOLS,
    (e) => events.push(e),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ) as any
  const result = await tools[name].execute({}, {})
  return { result, directives, events }
}

/** The fixture set with one table emptied or replaced. */
const withTable = (table: string, rows: Row[]): Record<string, Row[]> => ({ ...FULL, [table]: rows })

beforeAll(() => {
  // Both rankers read the clock through their caller, so the tool's own
  // `new Date()` is the only unpinned input left.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterAll(() => {
  vi.useRealTimers()
})

// ── C14 · find_me_a_challenge ─────────────────────────────────────────────────

describe('find_me_a_challenge', () => {
  it('drives to the board on the challenge the ranking picked', async () => {
    const { result, directives } = await runTool('find_me_a_challenge')

    expect(result.matched).toBe(true)
    expect(result.challenge.title).toBe('Graph Traversal Sprint')
    expect(result.challenge.matchedSkills).toEqual(['Graph Traversal'])
    // Only the one challenge matches: 'ch-attn' is mapped to a skill they are
    // weak on, 'ch-draft' is unpublished and 'ch-other-section' is another
    // course. Any of those leaking in would show up here.
    expect(result.alsoOpen).toEqual([])
    expect(directives).toHaveLength(1)
    expect(directives[0]).toMatchObject({
      type: 'goto_page',
      route: '/student/courses/sec-1/challenges?challenge=ch-graphs',
      label: 'Challenges · Graph Traversal Sprint',
    })
    // The challenge id is short and harmless, so it rides the URL — deep-linkable
    // and refresh-proof (§14.8). Nothing needs to travel out of band here.
    expect(directives[0]).not.toHaveProperty('prefill')
  })

  it('keeps the challenge id out of the payload the model reads', async () => {
    // The id travels in the directive, which the route builds; the model gets
    // prose. If it could see an id it could write its own link to one.
    const { result } = await runTool('find_me_a_challenge')
    expect(JSON.stringify(result)).not.toContain('ch-graphs')
  })

  it('proposes nothing, and drives nowhere, when the board is empty', async () => {
    const { result, directives } = await runTool('find_me_a_challenge', withTable('challenges', []))

    expect(result).toEqual({ matched: false, reason: 'no_open_challenges' })
    // The answer says there is nothing open; a directive here would land the
    // student on a board contradicting it.
    expect(directives).toEqual([])
  })

  it('drives nowhere when nothing is at mastery yet', async () => {
    const { result, directives } = await runTool(
      'find_me_a_challenge',
      withTable('skill_mastery', [
        { section_id: SECTION, student_id: STUDENT, skill_id: 'sk-graphs', score: 41 },
        // The strong row belongs to someone else.
        { section_id: SECTION, student_id: 'stu-other', skill_id: 'sk-graphs', score: 99 },
      ]),
    )

    expect(result).toEqual({ matched: false, reason: 'no_strong_skills' })
    expect(directives).toEqual([])
  })

  it('drives nowhere when a claimed challenge is the only match', async () => {
    const { result, directives } = await runTool(
      'find_me_a_challenge',
      withTable('challenge_claims', [
        { id: 'cl-1', challenge_id: 'ch-graphs', user_id: STUDENT, challenge: { section_id: SECTION } },
      ]),
    )

    expect(result).toEqual({ matched: false, reason: 'no_matching_challenge' })
    expect(directives).toEqual([])
  })

  it('ignores another student’s claim on the challenge it proposes', async () => {
    const { result } = await runTool(
      'find_me_a_challenge',
      withTable('challenge_claims', [
        { id: 'cl-1', challenge_id: 'ch-graphs', user_id: 'stu-other', challenge: { section_id: SECTION } },
      ]),
    )
    expect(result.matched && result.challenge.title).toBe('Graph Traversal Sprint')
  })

  it('reports its declared plan and nothing else, so the two cards stay apart', async () => {
    const { events } = await runTool('find_me_a_challenge')

    // A propose tool is a plan card, never also a row on the lookup card —
    // `planPhase`/`phaseFromRun` split on exactly this field.
    expect(events.every((e) => e.group === 'plan')).toBe(true)
    expect(events.filter((e) => e.phase === 'done').map((e) => e.name)).toEqual([
      'Your strongest topics',
      "What's still open",
      'Best fit, soonest deadline',
    ])
    // Every step reported one is a step the definition declared — `plan.step`
    // throws otherwise, which is what stops the card drifting from the code.
    expect(events.filter((e) => e.phase === 'start')).toHaveLength(3)
  })
})

// ── C11 · draft_a_question_for_class ──────────────────────────────────────────

describe('draft_a_question_for_class', () => {
  it('pre-fills the live room’s question box with a draft built from a real miss', async () => {
    const { result, directives } = await runTool('draft_a_question_for_class')

    expect(result.drafted).toBe(true)
    expect(result.builtFrom).toEqual({
      quiz: 'Transformers Quiz 2',
      question: 'What is the title of the transformer paper?',
    })
    expect(directives).toHaveLength(1)
    const directive = directives[0]
    expect(directive.type).toBe('goto_page')
    if (directive.type !== 'goto_page') return
    expect(directive.route).toBe('/student/courses/sec-1/live-classroom/room-1')
    expect(directive.prefill?.kind).toBe('lc_question')
    // The text in the box is the composer's, not the model's — same string the
    // tool hands back, so the answer cannot describe a different draft.
    expect(directive.prefill?.text).toBe(result.draft)
    expect(directive.prefill?.text).toContain('What is the title of the transformer paper?')
  })

  it('draws on the freshest miss, which is the ordering and not the row order', async () => {
    // `mostRecentMiss` walks the quizzes in the order it is handed them and takes
    // the first wrong answer, so "the thing still on your mind" is entirely the
    // `submitted_at DESC` clause in the history read. Fixtures are listed
    // oldest-first here precisely so the sort has to do the work.
    const { result } = await runTool('draft_a_question_for_class', {
      ...FULL,
      quiz_attempts: [
        { ...ATTEMPT, id: 'att-old', quiz_id: 'quiz-0', submitted_at: '2026-07-01', quiz: { title: 'Week 1 Quiz' } },
        { ...ATTEMPT, id: 'att-new', submitted_at: '2026-07-29' },
      ],
      quiz_answers: [
        { attempt_id: 'att-old', question_id: 'q-right', is_correct: false, earned_points: 0, text_answer: 'x' },
        { attempt_id: 'att-new', question_id: 'q-wrong', is_correct: false, earned_points: 0, text_answer: 'Speed' },
      ],
    })

    expect(result.builtFrom.quiz).toBe('Transformers Quiz 2')
    expect(result.draft).not.toContain('Week 1 Quiz')
  })

  it('stops at the room check when class is not live, and drives nowhere', async () => {
    const { result, directives, events } = await runTool(
      'draft_a_question_for_class',
      withTable('lc_rooms', [{ ...LIVE_ROOM, status: 'ended' }]),
    )

    expect(result).toEqual({ drafted: false, reason: 'no_live_room' })
    // The whole point: she says the class isn't live, and the app stays put.
    expect(directives).toEqual([])
    // And the later steps are absent rather than shown as finished — the plan
    // card is a record of what ran.
    expect(events.filter((e) => e.phase === 'done').map((e) => e.name)).toEqual([
      'Whether class is live',
    ])
  })

  it('drives nowhere when the student has missed nothing to ask about', async () => {
    const { result, directives, events } = await runTool(
      'draft_a_question_for_class',
      withTable('quiz_answers', [ANSWERS[0]]),
    )

    expect(result).toEqual({ drafted: false, reason: 'nothing_missed_yet' })
    expect(directives).toEqual([])
    expect(events.filter((e) => e.phase === 'done')).toHaveLength(2)
  })

  it('inherits the retake guard — a live attempt’s answer key never becomes a draft', async () => {
    // The reason `fetchReviewableQuizzes` was extracted rather than copied. The
    // only miss on record is on a quiz this student is sitting again, so the
    // draft would quote the live quiz's own question back into a box they are
    // about to send to the whole class.
    const { result, directives } = await runTool(
      'draft_a_question_for_class',
      withTable('quiz_attempts', [
        ATTEMPT,
        {
          id: 'att-open',
          quiz_id: 'quiz-1',
          section_id: SECTION,
          student_id: STUDENT,
          status: 'in_progress',
        },
      ]),
    )

    expect(result).toEqual({ drafted: false, reason: 'nothing_missed_yet' })
    expect(directives).toEqual([])
  })
})

// ── C10 · draft_an_office_hours_booking ───────────────────────────────────────

describe('draft_an_office_hours_booking', () => {
  it('drives to the professor’s next open day with a note drafted from real evidence', async () => {
    const { result, directives } = await runTool('draft_an_office_hours_booking')

    expect(result.drafted).toBe(true)
    // Friday the 31st → the professor's Monday. Not the Sunday (that row is
    // inactive) and not the Saturday (that is another professor's).
    expect(result.onDate).toBe('2026-08-03')
    // Weakest first, capped at three, names not ids.
    expect(result.aboutTopics).toEqual(['Attention', 'Beam Search', 'Tokenization'])

    expect(directives).toHaveLength(1)
    const directive = directives[0]
    if (directive.type !== 'goto_page') throw new Error('expected a goto_page directive')
    expect(directive.route).toBe('/student/office-hours?professor=prof-1&date=2026-08-03')
    expect(directive.prefill).toEqual({ kind: 'booking_note', text: result.note })
    // The note is evidence the professor can act on, quoting what they answered.
    expect(result.note).toContain('Attention, Beam Search and Tokenization')
    expect(result.note).toContain('Transformers Quiz 2')
    expect(result.note).toContain('Speed')
  })

  it('drives nowhere when the professor has published no office hours', async () => {
    const { result, directives, events } = await runTool(
      'draft_an_office_hours_booking',
      withTable('office_hours', [{ ...OFFICE_HOURS[0], is_active: false }]),
    )

    expect(result).toEqual({ drafted: false, reason: 'no_office_hours' })
    expect(directives).toEqual([])
    // Bailed at the first step — no note was drafted for a page she isn't
    // sending them to.
    expect(events.filter((e) => e.phase === 'done').map((e) => e.name)).toEqual([
      'When your professor is free',
    ])
  })

  it('drives nowhere when the section has no professor assigned', async () => {
    const { result, directives } = await runTool(
      'draft_an_office_hours_booking',
      withTable('course_sections', [{ id: SECTION, professor_id: null }]),
    )

    expect(result).toEqual({ drafted: false, reason: 'no_office_hours' })
    expect(directives).toEqual([])
  })

  it('still books the meeting when there is no specific miss to quote', async () => {
    // Weak topics but a clean quiz record: the note degrades, the drive does not.
    const { result, directives } = await runTool(
      'draft_an_office_hours_booking',
      withTable('quiz_answers', [ANSWERS[0]]),
    )

    expect(result.drafted).toBe(true)
    expect(result.note).toBe("Hi — I'd like some help with Attention, Beam Search and Tokenization.")
    expect(directives).toHaveLength(1)
  })
})
