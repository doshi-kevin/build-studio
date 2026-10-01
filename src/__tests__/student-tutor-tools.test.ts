// get_my_quiz_review hands the student their own answer key, per question. That
// is fine for a quiz they are done with and a leak for one they are sitting
// again: on a retake, the earlier attempt's review IS the key to the live
// attempt. /api/chat refuses outright while any attempt is open (see
// athena-chat-quiz-lock.test.ts), so this filter is the second lock — the one
// that still holds if these tools are ever wired to another caller.
//
// The pairing is what makes this real: the same fixture with no open attempt
// must return the key, so the exclusion is provably the gate and not the setup.

import { describe, it, expect } from 'vitest'
import { STUDENT_TOOLS } from '@/lib/ai/student-tutor/tools'
import { buildStudentTools } from '@/lib/ai/student-tutor/contract'

const SECTION = 'sec-1'
const STUDENT = 'student-1'
const RETAKEN = 'quiz-retaken'
const FINISHED = 'quiz-finished'

type Row = Record<string, unknown>

/** Row-aware Supabase double: filters actually filter, so a dropped `.eq()` or a
 *  missing `.not(...)` changes the rows the tool sees. */
function stubDb(
  tables: Record<string, Row[]>,
  /** Which query fails, judged by the filters it applied — the two reads of
   *  `quiz_attempts` differ only by their `status`. */
  failWhen: (table: string, eqs: Array<[string, unknown]>) => boolean = () => false,
) {
  const from = (table: string) => {
    let rows = [...(tables[table] ?? [])]
    const eqs: Array<[string, unknown]> = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: () => chain,
      order: () => chain,
      limit: (n: number) => {
        rows = rows.slice(0, n)
        return chain
      },
      eq: (col: string, val: unknown) => {
        eqs.push([col, val])
        rows = rows.filter((r) => r[col] === val)
        return chain
      },
      in: (col: string, vals: unknown[]) => {
        rows = rows.filter((r) => vals.includes(r[col]))
        return chain
      },
      // Only `not(col, 'in', '(a,b)')` is used; mirror PostgREST's list syntax.
      not: (col: string, op: string, val: string) => {
        expect(op).toBe('in')
        const excluded = val.replace(/^\(|\)$/g, '').split(',')
        rows = rows.filter((r) => !excluded.includes(String(r[col])))
        return chain
      },
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve(
          failWhen(table, eqs)
            ? { data: null, error: { message: 'connection reset' } }
            : { data: rows, error: null },
        ).then(resolve),
    }
    return chain
  }
  return { from }
}

const SUBMITTED = [
  {
    id: 'att-prev',
    quiz_id: RETAKEN,
    section_id: SECTION,
    student_id: STUDENT,
    status: 'submitted',
    score: 60,
    submitted_at: '2026-07-01',
    quiz: { title: 'Retaken Quiz' },
  },
  {
    id: 'att-done',
    quiz_id: FINISHED,
    section_id: SECTION,
    student_id: STUDENT,
    status: 'submitted',
    score: 90,
    submitted_at: '2026-06-01',
    quiz: { title: 'Finished Quiz' },
  },
]

const OPEN_ATTEMPT = {
  id: 'att-open',
  quiz_id: RETAKEN,
  section_id: SECTION,
  student_id: STUDENT,
  status: 'in_progress',
}

const ANSWERS = [
  { attempt_id: 'att-prev', question_id: 'q-leak', is_correct: false, earned_points: 0, text_answer: 'sigmoid' },
  { attempt_id: 'att-done', question_id: 'q-safe', is_correct: true, earned_points: 1, text_answer: 'BLEU' },
]

const QUESTIONS = [
  {
    id: 'q-leak',
    question_text: 'Which function normalizes attention scores?',
    question_type: 'short_answer',
    content: { acceptedAnswers: ['softmax'] },
    points: 1,
  },
  {
    id: 'q-safe',
    question_text: 'Which metric scores machine translation?',
    question_type: 'short_answer',
    content: { acceptedAnswers: ['BLEU'] },
    points: 1,
  },
]

function review(
  quizAttempts: Row[],
  failWhen?: (table: string, eqs: Array<[string, unknown]>) => boolean,
) {
  const tools = buildStudentTools(
    {
      adminDb: stubDb(
        {
          quiz_attempts: quizAttempts,
          quiz_answers: ANSWERS,
          quiz_questions: QUESTIONS,
        },
        failWhen,
      ),
      sectionId: SECTION,
      userId: STUDENT,
      institutionId: 'inst-1',
      conversationId: null,
      emit: () => {},
    },
    STUDENT_TOOLS,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ) as any
  return tools.get_my_quiz_review.execute({}, {}) as Promise<{
    count: number
    quizzes: Array<{ quiz: string }>
  }>
}

describe('get_my_quiz_review — retake exclusion', () => {
  it('withholds the review of a quiz the student has an attempt open on', async () => {
    const result = await review([OPEN_ATTEMPT, ...SUBMITTED])

    expect(result.count).toBe(1)
    expect(result.quizzes.map((q) => q.quiz)).toEqual(['Finished Quiz'])
    // The live quiz's answer key must not appear anywhere in the tool payload.
    const payload = JSON.stringify(result)
    expect(payload).not.toContain('softmax')
    expect(payload).not.toContain('Which function normalizes attention scores?')
  })

  it('returns that same review once nothing is open', async () => {
    const result = await review(SUBMITTED)

    expect(result.count).toBe(2)
    expect(result.quizzes.map((q) => q.quiz)).toEqual(['Retaken Quiz', 'Finished Quiz'])
    // Proves the exclusion above is the filter doing work, not a thin fixture.
    expect(JSON.stringify(result)).toContain('softmax')
  })

  it('serves no answer keys at all when it cannot tell what is open', async () => {
    // Fails CLOSED, which is the only safe direction: an errored open-attempts
    // read means every submitted attempt looks safe to hand over, including the
    // one the student is sitting right now. Losing the review costs them a
    // feature for one turn; the other way round hands over a live answer key.
    const result = await review([OPEN_ATTEMPT, ...SUBMITTED], (table, eqs) =>
      table === 'quiz_attempts' && eqs.some(([c, v]) => c === 'status' && v === 'in_progress'),
    )

    expect(result.count).toBe(0)
    expect(JSON.stringify(result)).not.toContain('softmax')
  })
})

// The professor's reveal gate (quizzes.show_explanations) is a real,
// per-question setting the HUMAN review honours (getUnifiedResult → canReveal).
// Athena's tool must honour the SAME predicate: right/wrong and points earned may
// reach the student regardless (the human surface shows them), but the correct
// answer is withheld until the gate opens — otherwise "what did I get wrong"
// hands over the answer key before after_due_date.
describe('get_my_quiz_review — professor reveal gate', () => {
  const FUTURE = '2099-01-01T00:00:00Z'
  const PAST = '2020-01-01T00:00:00Z'

  /** One submitted attempt on a quiz with the given reveal settings, sharing the
   *  q-leak question (correct answer 'softmax') so the redaction is visible. */
  const gatedAttempt = (over: Row) => ({
    id: 'att-gated',
    quiz_id: 'quiz-gated',
    section_id: SECTION,
    student_id: STUDENT,
    status: 'submitted',
    score: 40,
    submitted_at: '2026-07-15',
    quiz: { title: 'Gated Quiz', ...over },
  })

  async function reviewGated(quizOver: Row) {
    const tools = buildStudentTools(
      {
        adminDb: stubDb({
          quiz_attempts: [gatedAttempt(quizOver)],
          // The q-leak answer, re-pointed at this attempt so it hydrates.
          quiz_answers: [{ ...ANSWERS[0], attempt_id: 'att-gated' }],
          quiz_questions: [QUESTIONS[0]], // q-leak: acceptedAnswers ['softmax']
        }),
        sectionId: SECTION,
        userId: STUDENT,
        institutionId: 'inst-1',
        conversationId: null,
        emit: () => {},
      },
      STUDENT_TOOLS,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ) as any
    return tools.get_my_quiz_review.execute({}, {}) as Promise<{
      count: number
      quizzes: Array<{ quiz: string; questions: Array<{ correct: boolean; correctAnswer: string }> }>
    }>
  }

  it('withholds the correct answer before after_due_date, but keeps right/wrong', async () => {
    const result = await reviewGated({ show_explanations: 'after_due_date', due_date: FUTURE })

    // The quiz still appears and the student still learns they got it wrong…
    expect(result.count).toBe(1)
    expect(result.quizzes[0].questions[0].correct).toBe(false)
    // …but the answer key is not in the payload anywhere.
    expect(JSON.stringify(result)).not.toContain('softmax')
    expect(result.quizzes[0].questions[0].correctAnswer).not.toContain('softmax')
  })

  it('never reveals the answer when the setting is "never"', async () => {
    const result = await reviewGated({ show_explanations: 'never', due_date: PAST })
    expect(JSON.stringify(result)).not.toContain('softmax')
  })

  it('reveals once the due date has passed under after_due_date', async () => {
    const result = await reviewGated({ show_explanations: 'after_due_date', due_date: PAST })
    expect(result.quizzes[0].questions[0].correctAnswer).toContain('softmax')
  })

  it('reveals immediately under after_submission (the default)', async () => {
    const result = await reviewGated({ show_explanations: 'after_submission', due_date: FUTURE })
    expect(result.quizzes[0].questions[0].correctAnswer).toContain('softmax')
  })
})
