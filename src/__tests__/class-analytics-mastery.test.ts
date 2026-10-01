// getClassAnalytics' topic performance — the gradebook's "Skill mastery" chart.
//
// This used to count correct/total per raw quiz-question tag. It now reads the
// section's curated skills and skill_mastery, so the gradebook, the roadmap's
// class lens and Athena all quote one number for a course instead of three.
//
// The failures worth pinning are not crashes. They are numbers that are
// confidently wrong, or skills that silently appear or vanish:
//   - quoting a mean while the section is configured for a median;
//   - an excluded (professor dropped it) or suppressed (AI guess, uncorroborated)
//     skill resurfacing here when every other surface hides it;
//   - an unassessed skill rendering as 0%, which reads as "the class failed it"
//     rather than "nobody has measured it";
//   - ranking that is not weakest-first, since the chart no longer sorts;
//   - "no skills set up" being indistinguishable from "nothing graded yet",
//     which is what makes an empty chart unreadable.
//
// The aggregation maths has its own suite (skill-aggregate.test.ts). The real
// aggregator and the real config resolver are used here on purpose, so this
// tests the COMPOSITION rather than restating it.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const SECTION = 'sec-1'
const USER = 'prof-1'

type Row = Record<string, unknown>

let skills: Row[] = []
let masteryRows: Row[] = []
let sectionSettings: unknown = null
/** Make the skill read blow up, to exercise the failed-read path. */
let skillReadFails = false

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) } }),
}))
/* The mocks assert their arguments rather than ignoring them. A mock that
   returns the fixture no matter what it is asked for would stay green if the
   action started querying the wrong section, which is the failure most worth
   catching in a read that is scoped by section id. */
function assertSection(id: string) {
  if (id !== SECTION) throw new Error(`queried the wrong section: ${id}`)
}
vi.mock('@/lib/supabase/queries', () => ({
  skillQueries: {
    listSectionSkills: async (_db: unknown, id: string) => {
      assertSection(id)
      if (skillReadFails) throw new Error('boom')
      return skills
    },
    getSectionMasteryRows: async (_db: unknown, id: string) => { assertSection(id); return masteryRows },
    getStudentMasteryRows: async (_db: unknown, id: string) => { assertSection(id); return masteryRows },
  },
}))

/* Every non-skill read in getClassAnalytics (enrollments, quizzes, attempts,
   answers) resolves empty. This test is about the topic axis; the quiz axis has
   its own coverage. `course_sections.settings` is the one direct read that must
   return something, since it carries the mastery config. */
function chain(table: string) {
  const self: Record<string, unknown> = {}
  for (const m of ['select', 'in', 'is', 'not', 'order', 'limit', 'neq', 'gt', 'lte']) self[m] = () => self
  /* `eq` is not a blanket passthrough: the settings read is scoped by section
     id, and a double that ignored it would pass even if the action asked for
     the wrong section. */
  self.eq = (col: string, val: unknown) => {
    if (table === 'course_sections' && col === 'id' && val !== SECTION) {
      throw new Error(`queried settings for the wrong section: ${String(val)}`)
    }
    return self
  }
  const result = table === 'course_sections' ? { data: { settings: sectionSettings }, error: null } : { data: [], error: null }
  self.maybeSingle = async () => result
  self.single = async () => result
  self.then = (resolve: (v: unknown) => unknown) => resolve(result)
  return self
}

vi.mock('@/lib/auth/section-access', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/section-access')>('@/lib/auth/section-access')
  return {
    ...actual,
    verifySectionAccess: async () => ({ ok: true, adminDb: { from: (t: string) => chain(t) }, role: 'professor' }),
  }
})

const { getClassAnalytics } = await import('@/app/(dashboard)/professor/courses/[sectionId]/grades/actions')

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

/** One student's score on one main skill (no subtopics, so the roll-up is it). */
const score = (studentId: string, skillId: string, value: number | null): Row => ({
  student_id: studentId,
  skill_id: skillId,
  score: value,
  n: value == null ? 0 : 1,
})

async function analytics() {
  const res = await getClassAnalytics(SECTION)
  expect(res.error).toBeUndefined()
  return res.data!
}

beforeEach(() => {
  skills = []
  masteryRows = []
  sectionSettings = null
  skillReadFails = false
})

describe('getClassAnalytics — the gradebook skill chart', () => {
  it('reports the number the section is configured to report, and labels it', async () => {
    // 10 / 20 / 90 — median 20, mean 40. Showing 40 on a median section, or
    // labelling 40 "median", both put a wrong number in front of a professor.
    skills = [main('t-a', 'Hypothesis testing')]
    masteryRows = [score('s1', 't-a', 10), score('s2', 't-a', 20), score('s3', 't-a', 90)]

    const byMedian = await analytics()
    expect(byMedian.metricLabel).toBe('median')
    expect(byMedian.topicPerformance[0]).toMatchObject({ name: 'Hypothesis testing', classScore: 20 })

    sectionSettings = { topicMastery: { classMetric: 'mean' } }
    const byMean = await analytics()
    expect(byMean.metricLabel).toBe('average')
    expect(byMean.topicPerformance[0]).toMatchObject({ classScore: 40 })
  })

  it('never surfaces an excluded or suppressed skill, even with live mastery rows against it', async () => {
    // Both are hidden on the roadmap and in Athena. The gradebook must not be
    // the one surface that resurrects a concept the professor dropped, or an
    // AI guess nothing has corroborated.
    skills = [
      main('t-ok', 'Recursion'),
      main('t-dropped', 'Dropped by professor', { excluded: true }),
      main('t-guess', 'Unconfirmed AI guess', { suppressed: true }),
    ]
    masteryRows = [
      score('s1', 't-ok', 70),
      score('s1', 't-dropped', 12),
      score('s1', 't-guess', 15),
    ]

    const data = await analytics()
    expect(data.topicPerformance.map((t) => t.name)).toEqual(['Recursion'])
    expect(data.trackedSkillCount).toBe(1)
  })

  it('omits an unassessed skill rather than charting it as 0%', async () => {
    // A red bar at 0% reads as "the class failed this". Nobody has measured it.
    skills = [main('t-scored', 'Graded topic'), main('t-empty', 'Never assessed')]
    masteryRows = [score('s1', 't-scored', 64)]

    const data = await analytics()
    expect(data.topicPerformance.map((t) => t.name)).toEqual(['Graded topic'])
    // Still counted as tracked — that is what separates the two empty states.
    expect(data.trackedSkillCount).toBe(2)
  })

  it('ranks weakest first, because the chart does not sort', async () => {
    skills = [main('t-hi', 'Strong topic'), main('t-lo', 'Weak topic'), main('t-mid', 'Middling topic')]
    masteryRows = [score('s1', 't-hi', 91), score('s1', 't-lo', 22), score('s1', 't-mid', 58)]

    const data = await analytics()
    expect(data.topicPerformance.map((t) => t.name)).toEqual(['Weak topic', 'Middling topic', 'Strong topic'])
  })

  it('distinguishes "no skills set up" from "skills set up, nothing graded"', async () => {
    // Both render an empty chart. Without trackedSkillCount the UI cannot tell
    // the professor which one it is, and the two need different next steps.
    const noSkills = await analytics()
    expect(noSkills.topicPerformance).toEqual([])
    expect(noSkills.trackedSkillCount).toBe(0)

    skills = [main('t-a', 'Tracked but ungraded')]
    masteryRows = []
    const nothingGraded = await analytics()
    expect(nothingGraded.topicPerformance).toEqual([])
    expect(nothingGraded.trackedSkillCount).toBe(1)
  })

  it('reports a failed mastery read as unavailable, not as a course with no skills', async () => {
    /* The two collapse into the same empty list, and the UI branches on
       trackedSkillCount === 0 to say "No skills set up yet" with a button
       inviting the professor to create skills they may already have. A failed
       fetch means we do not know, which is a different sentence. */
    skillReadFails = true

    const data = await analytics()
    expect(data.masteryUnavailable).toBe(true)
    expect(data.topicPerformance).toEqual([])

    skillReadFails = false
    skills = [main('t-a', 'Recursion')]
    expect((await analytics()).masteryUnavailable).toBe(false)
  })

  it('counts only main skills as tracked, not subtopics', async () => {
    // trackedSkillCount drives the empty-state copy and the "N of M" caption.
    // Counting subtopics would claim more skills than the chart can ever show.
    skills = [
      main('t-main', 'Trees'),
      main('t-sub', 'AVL rotation', { parent_id: 't-main' }),
    ]
    masteryRows = [score('s1', 't-sub', 42)]

    const data = await analytics()
    expect(data.trackedSkillCount).toBe(1)
    expect(data.topicPerformance.map((t) => t.name)).toEqual(['Trees'])
  })

  it('carries the section at-risk threshold so the chart can label its own bands', async () => {
    skills = [main('t-a', 'Recursion')]
    masteryRows = [score('s1', 't-a', 40)]

    expect((await analytics()).atRiskThreshold).toBe(50) // default

    sectionSettings = { topicMastery: { atRiskThreshold: 65 } }
    expect((await analytics()).atRiskThreshold).toBe(65)
  })
})
