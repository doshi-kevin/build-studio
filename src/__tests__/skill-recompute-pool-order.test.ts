// recomputeSectionMastery must read the skill pool AFTER reconcileSectionSkills,
// not before.
//
// reconcile both mints new skills and promotes suppressed ones to tracked. The
// recompute derives `excludedIds` and `tagPool` from its own read of `skills`,
// so reading first means scoring against a pre-reconcile snapshot. That was
// invisible while the nightly sweep only visited sections that already had
// skills; widening the sweep to sections that merely have evidence is what makes
// a virgin section take this path on its first run.
//
// Both tests below pass trivially if reconcile is a no-op — which is why the
// sibling suite (skill-recompute.test.ts) could not catch this. Here the
// reconcile double MUTATES the fixture, exactly as the real one mutates the
// table, so the assertion is specifically about ordering.

import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// Only reconcileSectionSkills is replaced. canonicalizeName/matchInPool stay real
// so the tag→skill resolution under test is production's, not a restatement.
const reconcileMock = vi.fn()
vi.mock('@/lib/skills/reconcile', async () => {
  const actual = await vi.importActual<typeof import('@/lib/skills/reconcile')>('@/lib/skills/reconcile')
  return { ...actual, reconcileSectionSkills: (...a: unknown[]) => reconcileMock(...a) }
})

import { recomputeSectionMastery } from '@/lib/skills/recompute'

interface Skill {
  id: string
  name: string
  parent_id: string | null
  excluded: boolean
  suppressed: boolean
}
interface Fixture {
  course_sections: { institution_id: string; settings?: unknown } | null
  skills: Skill[]
  activity_skills: Array<{ activity_type: string; activity_id: string; skill_id: string }>
  quiz_attempts: Array<Record<string, unknown>>
  quiz_answers: Array<Record<string, unknown>>
  quiz_questions: Array<Record<string, unknown>>
}

/** Table-routed admin double. Resolves each table lazily, at from() time, so a
 *  fixture mutated by the reconcile double is visible to any read that happens
 *  after it — which is the whole point of these tests. */
function makeAdmin(fx: Fixture) {
  const inserts: Array<Record<string, unknown>> = []

  function chain(table: string) {
    const rowsFor = (): unknown => {
      switch (table) {
        case 'course_sections': return fx.course_sections
        case 'skills': return fx.skills
        case 'activity_skills': return fx.activity_skills
        case 'quiz_attempts': return fx.quiz_attempts
        case 'quiz_answers': return fx.quiz_answers
        case 'quiz_questions': return fx.quiz_questions
        default: return []
      }
    }
    const result = () => ({ data: rowsFor(), error: null })
    const self: Record<string, unknown> = {}
    for (const m of ['select', 'in', 'is', 'not', 'eq', 'order', 'limit']) self[m] = () => self
    self.range = async (from: number) => (from === 0 ? result() : { data: [], error: null })
    self.maybeSingle = async () => result()
    self.single = async () => result()
    self.then = (resolve: (v: unknown) => unknown) => resolve(result())
    self.delete = () => ({ eq: async () => ({ data: null, error: null }) })
    self.insert = async (rows: Array<Record<string, unknown>>) => {
      inserts.push(...rows)
      return { data: null, error: null }
    }
    return self
  }

  const rpc = async (name: string, params: Record<string, unknown>) => {
    if (name === 'replace_section_skill_mastery') {
      inserts.push(...((params?.p_rows as Array<Record<string, unknown>>) ?? []))
    }
    return { data: null, error: null }
  }

  return { admin: { from: (t: string) => chain(t), rpc }, inserts }
}

describe('recomputeSectionMastery reads the skill pool after reconcile', () => {
  it('scores a skill that reconcile promotes from suppressed to tracked', async () => {
    // Mirrors seedMaterialSkills writing suppressed:true, then a quiz tag
    // corroborating it and reconcile promoting it in the same pass.
    const fx: Fixture = {
      course_sections: { institution_id: 'inst-1' },
      skills: [{ id: 'sub-s', name: 'Limits', parent_id: null, excluded: false, suppressed: true }],
      activity_skills: [{ activity_type: 'quiz', activity_id: 'q1', skill_id: 'sub-s' }],
      quiz_attempts: [
        { id: 'a1', quiz_id: 'q1', student_id: 's1', earned_points: 8, total_points: 10, status: 'submitted', submitted_at: '2026-01-01T00:00:00Z' },
      ],
      quiz_answers: [],
      quiz_questions: [],
    }
    reconcileMock.mockImplementation(async () => {
      fx.skills[0].suppressed = false
      return { added: 0, mapped: 1 }
    })

    const { admin, inserts } = makeAdmin(fx)
    const res = await recomputeSectionMastery(admin, 'sec-1')

    // Reading the pool first would leave sub-s in excludedIds, drop its mapping,
    // and write nothing at all.
    expect(res.updated).toBe(1)
    expect(inserts).toHaveLength(1)
    expect(inserts[0].skill_id).toBe('sub-s')
  })

  it('splits a quiz per question on a section whose skills reconcile just minted', async () => {
    // The virgin-section case the widened sweep newly reaches. One quiz, two
    // questions, one aced and one failed. Per-question subscoring must give the
    // two skills DIFFERENT scores; an empty tagPool falls back to the whole-quiz
    // percentage and makes them identical, which is the smear subscoresBySkill
    // exists to prevent.
    const fx: Fixture = {
      course_sections: { institution_id: 'inst-1' },
      skills: [],
      activity_skills: [],
      quiz_attempts: [
        { id: 'a1', quiz_id: 'q1', student_id: 's1', earned_points: 10, total_points: 20, status: 'submitted', submitted_at: '2026-01-01T00:00:00Z' },
      ],
      quiz_answers: [
        { id: 'ans1', attempt_id: 'a1', question_id: 'qq1', earned_points: 10 },
        { id: 'ans2', attempt_id: 'a1', question_id: 'qq2', earned_points: 0 },
      ],
      quiz_questions: [
        { id: 'qq1', tags: ['Limits'], points: 10 },
        { id: 'qq2', tags: ['Derivatives'], points: 10 },
      ],
    }
    reconcileMock.mockImplementation(async () => {
      fx.skills.push(
        { id: 'sub-a', name: 'Limits', parent_id: null, excluded: false, suppressed: false },
        { id: 'sub-b', name: 'Derivatives', parent_id: null, excluded: false, suppressed: false },
      )
      fx.activity_skills.push(
        { activity_type: 'quiz', activity_id: 'q1', skill_id: 'sub-a' },
        { activity_type: 'quiz', activity_id: 'q1', skill_id: 'sub-b' },
      )
      return { added: 2, mapped: 2 }
    })

    const { admin, inserts } = makeAdmin(fx)
    await recomputeSectionMastery(admin, 'sec-1')

    const byId = new Map(inserts.map((r) => [r.skill_id as string, r.score as number]))
    expect(byId.size).toBe(2)
    // The aced skill must outrank the failed one. Equal scores mean the
    // whole-quiz fallback ran.
    expect(byId.get('sub-a')).toBeGreaterThan(byId.get('sub-b') as number)
  })
})
