// `loadStudentPerformance` is what Athena quotes when a professor asks "how is
// Priya doing?". Unlike the three chart surfaces, this one does not hand the
// reader a number next to a bar — it turns a score into the WORDS "strength" and
// "needs work" about a named student. So the failures that matter are:
//
//  - a strength reported as a weakness, or the reverse. A miscoloured bar next
//    to a correct number is survivable; "Priya is weak on recursion" when she
//    scored 88 is a professor acting on a false statement.
//  - a middling skill claimed as either. Only 'strong' and 'weak' are reportable;
//    'shaky' is deliberately neither, and a filter that used >= or < instead of
//    an explicit tier check would sweep it into one side.
//  - an excluded (professor dropped it) or suppressed (AI guess, uncorroborated)
//    skill being named. Every other surface hides those. Athena naming one puts
//    a concept the professor deleted back in their face as fact.
//
// The tier thresholds themselves live in skill-scoring.test.ts and the
// aggregation maths in skill-aggregate.test.ts. The real aggregator and the real
// masteryTier are used here on purpose, so this tests the COMPOSITION.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const SECTION = 'sec-1'

type Row = Record<string, unknown>

let skills: Row[] = []
let masteryRows: Row[] = []

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('@/lib/supabase/queries', () => ({
  skillQueries: {
    listSectionSkills: async () => skills,
    getSectionMasteryRows: async () => masteryRows,
    getStudentMasteryRows: async () => masteryRows,
  },
}))

const { loadStudentPerformance } = await import('@/lib/ai/professor-assistant/context')

/* One enrolled student with one submitted quiz. The quiz axis is only here to
   get past the "has not submitted any graded quizzes yet" early return; its own
   numbers are covered elsewhere. The skill reads go through mocked skillQueries. */
function db() {
  const rows: Record<string, Row[]> = {
    enrollments: [{ student_id: 'stu-1' }],
    profiles: [{ id: 'stu-1', name: 'Priya Raman' }],
    projects: [],
    quizzes: [{ id: 'qz-1', title: 'Quiz 1', status: 'published', pass_threshold: 60, due_date: null }],
    quiz_attempts: [
      { quiz_id: 'qz-1', student_id: 'stu-1', score: 72, submitted_at: '2026-01-01T00:00:00Z', is_late: false },
    ],
  }
  return {
    from(table: string) {
      const chain: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'is', 'not', 'order', 'limit', 'neq', 'gt', 'lte']) chain[m] = () => chain
      // enrollments is also read as a single row for the final grade.
      chain.maybeSingle = async () => ({
        data: table === 'enrollments' ? { final_grade: null, final_score: null } : null,
        error: null,
      })
      chain.single = chain.maybeSingle
      chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: rows[table] ?? [], error: null })
      return chain
    },
  }
}

const main = (id: string, name: string, extra: Row = {}): Row => ({
  id,
  name,
  parent_id: null,
  position: 0,
  source: 'professor',
  excluded: false,
  suppressed: false,
  ...extra,
})

/** This student's score on one main skill (no subtopics, so the roll-up is it). */
const score = (skillId: string, value: number): Row => ({
  student_id: 'stu-1',
  skill_id: skillId,
  score: value,
  n: 1,
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const perf = () => loadStudentPerformance(db() as any, SECTION, 'Priya')

beforeEach(() => {
  skills = []
  masteryRows = []
})

describe('loadStudentPerformance — what Athena is allowed to say about one student', () => {
  it('calls a strong skill a strength and a weak one a weakness, and claims neither for a middling one', async () => {
    // 88 is strong, 41 is weak, 70 is shaky. Reporting the 70 as either, or
    // swapping the 88 and the 41, is Athena stating the opposite of the truth.
    skills = [main('t-rec', 'Recursion'), main('t-ptr', 'Pointers'), main('t-gph', 'Graphs')]
    masteryRows = [score('t-rec', 88), score('t-ptr', 41), score('t-gph', 70)]

    const res = await perf()
    expect(res.resolution).toBe('found')
    expect(res.topics?.strengths).toEqual(['Recursion'])
    expect(res.topics?.weaknesses).toEqual([{ tag: 'Pointers', score: 41 }])
  })

  it('never names an excluded or suppressed skill, even with a live weak score against it', async () => {
    // Both are hidden on the roadmap, the gradebook and the class digest. Athena
    // must not be the one surface that resurrects a concept the professor
    // dropped, or an AI guess nothing has corroborated.
    skills = [
      main('t-ok', 'Recursion'),
      main('t-dropped', 'Dropped by professor', { excluded: true }),
      main('t-guess', 'Unconfirmed AI guess', { suppressed: true }),
    ]
    masteryRows = [score('t-ok', 88), score('t-dropped', 12), score('t-guess', 15)]

    const res = await perf()
    expect(res.topics?.strengths).toEqual(['Recursion'])
    expect(res.topics?.weaknesses).toEqual([])
  })
})
