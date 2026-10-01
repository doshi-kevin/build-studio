// `getStudentSkillPerformance` feeds the student's own grades page. It is the
// only one of the four mastery surfaces a student sees about themselves, and the
// only one whose reader is not staff, so a wrong answer here is not a professor
// misreading a chart — it is a student being told something false about their
// own standing.
//
// The failures worth pinning:
//   - an excluded (professor dropped it) or suppressed (AI guess, uncorroborated)
//     skill reaching a student. Nothing has confirmed a suppressed skill is even
//     a real concept in this course, and the student has no way to know that.
//   - an unassessed skill arriving as a 0% bar, which reads as "you failed this"
//     rather than "nobody has marked this".
//   - the two empty states collapsing into one. "Your course tracks nothing" and
//     "nothing of yours has been marked" render the same blank list, and the page
//     picks between two different messages on `trackedCount` alone. Get it wrong
//     and an unmarked student is told their instructor tracks no topics.
//
// The aggregation maths has its own suite (skill-aggregate.test.ts). The real
// aggregator is used here on purpose, so this tests the COMPOSITION.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const SECTION = 'sec-1'
const STUDENT = 'stu-1'

type Row = Record<string, unknown>

let skills: Row[] = []
let masteryRows: Row[] = []
let enrolled = true

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: STUDENT } }, error: null }) },
  }),
}))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => {
      const chain: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in']) chain[m] = () => chain
      chain.single = async () => ({ data: enrolled ? { id: 'enr-1' } : null, error: null })
      return chain
    },
  }),
}))
vi.mock('@/lib/supabase/queries', () => ({
  skillQueries: {
    listSectionSkills: async () => skills,
    getStudentMasteryRows: async () => masteryRows,
  },
}))

const { getStudentSkillPerformance } = await import(
  '@/app/(dashboard)/student/courses/[sectionId]/grades/actions'
)

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
  student_id: STUDENT,
  skill_id: skillId,
  score: value,
  n: 1,
})

async function performance() {
  const res = await getStudentSkillPerformance(SECTION)
  expect(res.error).toBeUndefined()
  return res.data!
}

beforeEach(() => {
  skills = []
  masteryRows = []
  enrolled = true
})

describe('getStudentSkillPerformance — what a student is shown about themselves', () => {
  it('never shows an excluded or suppressed skill, even with a live score against it', async () => {
    skills = [
      main('t-ok', 'Recursion'),
      main('t-dropped', 'Dropped by professor', { excluded: true }),
      main('t-guess', 'Unconfirmed AI guess', { suppressed: true }),
    ]
    masteryRows = [score('t-ok', 70), score('t-dropped', 12), score('t-guess', 15)]

    const data = await performance()
    expect(data.skills.map((s) => s.name)).toEqual(['Recursion'])
    expect(data.trackedCount).toBe(1)
  })

  it('omits an unassessed skill rather than showing it as 0%', async () => {
    // A red 0% bar reads as "you failed this". Nobody has marked it.
    skills = [main('t-scored', 'Graded topic'), main('t-empty', 'Never assessed')]
    masteryRows = [score('t-scored', 64)]

    const data = await performance()
    expect(data.skills.map((s) => s.name)).toEqual(['Graded topic'])
    // Still tracked — that is what keeps the two empty states apart.
    expect(data.trackedCount).toBe(2)
  })

  it('distinguishes "course tracks nothing" from "nothing marked for you yet"', async () => {
    // Both render an empty list; the page picks its message on trackedCount.
    const nothingTracked = await performance()
    expect(nothingTracked.skills).toEqual([])
    expect(nothingTracked.trackedCount).toBe(0)

    skills = [main('t-a', 'Tracked but unmarked')]
    const nothingMarked = await performance()
    expect(nothingMarked.skills).toEqual([])
    expect(nothingMarked.trackedCount).toBe(1)
  })

  it('counts only main skills as tracked, so the count matches the list', async () => {
    // trackedCount drives "your instructor tracks N topics". Counting subtopics
    // would claim 3 while the list can only ever show the 1 main skill.
    skills = [
      main('t-main', 'Data structures'),
      main('t-sub-a', 'Stacks', { parent_id: 't-main' }),
      main('t-sub-b', 'Queues', { parent_id: 't-main' }),
    ]

    expect((await performance()).trackedCount).toBe(1)
  })

  it('refuses a caller who is not enrolled in the section', async () => {
    enrolled = false
    skills = [main('t-ok', 'Recursion')]
    masteryRows = [score('t-ok', 70)]

    const res = await getStudentSkillPerformance(SECTION)
    expect(res.error).toBe('Not enrolled in this section')
    expect(res.data).toBeUndefined()
  })
})
