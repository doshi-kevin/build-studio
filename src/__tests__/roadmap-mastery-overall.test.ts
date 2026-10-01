// The HEADLINE mastery figure — one definition, two roles.
//
// `buildStudentMastery().overallByStudent` is the single source of the mastery
// percentage BOTH roles render: the professor's roster (getStudentJourneys →
// masteryPct, and the excelling/on_track/needs_support label derived from it)
// and the student's own page (getMyConceptScores → masteryPct). Before #493
// each role averaged roadmap NODE pcts through the journey engine, which
// returns null on a course whose module items carry no topic labels — so a
// professor read "—" for students who demonstrably had curated scores.
//
// journey-state.test.ts pins the engine's own averaging and
// roadmap-mastery-journey-refs.test.ts pins the node universe; skill-aggregate
// .test.ts pins one main skill's roll-up (parent pooling, childless leaf).
// What nothing covered is the step this change added on top: the mean ACROSS
// mains, its rounding, and which students land in which map. A silent move here
// moves the number both roles read, in lockstep and in production.

import { describe, it, expect } from 'vitest'
import { buildStudentMastery } from '@/lib/skills/roadmap-mastery'
import { buildFullChain, createTableRouter } from './helpers/mock-supabase'
import type { SkillRow } from '@/lib/validations/skill'

const SECTION = 'sec-1'

/** A curated topic row. All positions 0, so mains sort by name (deterministic). */
function skill(id: string, name: string, parentId: string | null = null): SkillRow {
  return {
    id,
    section_id: SECTION,
    institution_id: 'inst-1',
    parent_id: parentId,
    name,
    info: null,
    source: 'professor',
    placement_pinned: false,
    excluded: false,
    suppressed: false,
    library_skill_id: null,
    position: 0,
    created_at: '',
    updated_at: '',
  }
}

/** A `skill_mastery` row as the DB hands it back. `n` omitted → no `state` JSONB
 *  at all, the legacy shape the reader falls back on. `score` may arrive as a
 *  string because the column is Postgres `numeric`. */
type MasteryRow = {
  student_id: string
  skill_id: string
  score: number | string | null
  state: { n?: number } | null
}
const row = (
  studentId: string,
  skillId: string,
  score: number | string | null,
  n?: number,
): MasteryRow => ({
  student_id: studentId,
  skill_id: skillId,
  score,
  state: n === undefined ? null : { n },
})

/** An admin client serving `skills` and `skill_mastery`. */
function adminWith(skills: SkillRow[], mastery: MasteryRow[]) {
  const skillChain = buildFullChain({ data: skills, error: null })
  const masteryChain = buildFullChain({ data: mastery, error: null })
  const router = createTableRouter({ skills: skillChain, skill_mastery: masteryChain })
  return { router, skillChain, masteryChain }
}

// A two-main / three-sub course: A(A1, A2) and B(B1).
const A = skill('a', 'A')
const A1 = skill('a1', 'A1', 'a')
const A2 = skill('a2', 'A2', 'a')
const B = skill('b', 'B')
const B1 = skill('b1', 'B1', 'b')
const COURSE = [A, A1, A2, B, B1]

describe('buildStudentMastery — the overall roll-up both roles read', () => {
  it('averages MAIN roll-ups, so a subtopic never double-counts', async () => {
    const { router } = adminWith(COURSE, [
      row('s1', 'a1', 90),
      row('s1', 'a2', 30),
      row('s1', 'b1', 80),
    ])

    const { scoresByStudent, overallByStudent } = await buildStudentMastery(router, SECTION)

    // A rolls up to 60, B to 80 → the headline is the mean of the two MAINS.
    // A flat mean over every map entry would be 68; over the three subtopics
    // alone, 67. Both are wrong: subs fold into their main and vote once.
    expect(overallByStudent.get('s1')).toBe(70)

    // The node-colouring map still carries both levels, keyed by normalised name.
    expect([...(scoresByStudent.get('s1') ?? new Map<string, number>())].sort()).toEqual([
      ['a', 60], ['a1', 90], ['a2', 30], ['b', 80], ['b1', 80],
    ])
  })

  // Two different averages meet here and must not be confused: WITHIN a main,
  // subtopics pool by evidence count (avoids Simpson's paradox — see
  // rollUpScore); ACROSS mains, each main is one equal vote. If the outer mean
  // were also n-weighted, a heavily-quizzed main would swamp the headline.
  it('pools subtopics by evidence within a main, then gives each main one vote', async () => {
    const { router } = adminWith(COURSE, [
      row('s1', 'a1', 40, 3),
      row('s1', 'a2', 40, 3),
      row('s1', 'b1', 100, 1),
    ])

    const { overallByStudent } = await buildStudentMastery(router, SECTION)

    // A = 40 (6 observations), B = 100 (1) → (40 + 100) / 2 = 70.
    // Weighting the outer mean by evidence too would read 49.
    expect(overallByStudent.get('s1')).toBe(70)
  })

  it('reports a whole percent, rounding halves up', async () => {
    const C = skill('c', 'C')
    const C1 = skill('c1', 'C1', 'c')
    const three = await buildStudentMastery(
      adminWith([...COURSE, C, C1], [
        row('s1', 'a1', 90), row('s1', 'b1', 60), row('s1', 'c1', 50),
      ]).router,
      SECTION,
    )
    // 200 / 3 = 66.66… — the UI renders this raw, so it must not leak a float.
    expect(three.overallByStudent.get('s1')).toBe(67)

    const half = await buildStudentMastery(
      adminWith(COURSE, [row('s1', 'a1', 70), row('s1', 'b1', 75)]).router,
      SECTION,
    )
    expect(half.overallByStudent.get('s1')).toBe(73) // 72.5 → 73
  })

  // The #493 course shape: topics curated at the main level only, mastery landing
  // on the parent from a matching quiz tag. This is exactly the case the old
  // node-averaging path returned null for.
  it('counts a main scored directly, with no subtopics at all', async () => {
    const { router } = adminWith([skill('solo', 'Solo')], [row('s1', 'solo', 70, 2)])
    const { scoresByStudent, overallByStudent } = await buildStudentMastery(router, SECTION)

    expect(overallByStudent.get('s1')).toBe(70)
    expect(scoresByStudent.get('s1')?.get('solo')).toBe(70)
  })

  // Postgres `numeric` deserialises as a string. Untouched, it would flow into
  // the map as '90' and into the mean via string coercion — a headline that
  // renders right until two values are added.
  it('coerces numeric-as-string scores into real numbers', async () => {
    const { router } = adminWith(COURSE, [row('s1', 'a1', '90'), row('s1', 'b1', '70')])
    const { scoresByStudent, overallByStudent } = await buildStudentMastery(router, SECTION)

    expect(scoresByStudent.get('s1')?.get('a1')).toBe(90)
    expect(overallByStudent.get('s1')).toBe(80)
  })

  it('scores each student from their own rows only', async () => {
    const { router } = adminWith(COURSE, [
      row('s1', 'a1', 90), row('s1', 'b1', 90),
      row('s2', 'a1', 20), row('s2', 'b1', 20),
    ])
    const { overallByStudent } = await buildStudentMastery(router, SECTION)

    expect(overallByStudent.get('s1')).toBe(90)
    expect(overallByStudent.get('s2')).toBe(20)
    // A rostered student with no mastery rows is absent, not 0 — the roster
    // renders absence as "—" and must never punish an unassessed student.
    expect(overallByStudent.has('s3')).toBe(false)
    expect(overallByStudent.size).toBe(2)
  })

  it('omits a student whose every score is null', async () => {
    const { router } = adminWith(COURSE, [row('s1', 'a1', null), row('s1', 'b1', null)])
    const { scoresByStudent, overallByStudent } = await buildStudentMastery(router, SECTION)

    expect(overallByStudent.has('s1')).toBe(false)
    expect(scoresByStudent.has('s1')).toBe(false)
  })

  // The two maps are gated separately, and this is the input that separates
  // them: a score with zero evidence behind it (`state.n === 0`) still names a
  // topic, so it can colour a node — but rollUpScore refuses it, so the student
  // has no main roll-up and therefore no headline figure. Presence in
  // scoresByStudent must NOT be read as presence in overallByStudent.
  it('can colour a node for a student who still has no headline figure', async () => {
    const { router } = adminWith(COURSE, [row('s1', 'a1', 70, 0)])
    const { scoresByStudent, overallByStudent } = await buildStudentMastery(router, SECTION)

    expect(scoresByStudent.get('s1')?.get('a1')).toBe(70)
    expect(scoresByStudent.get('s1')?.has('a')).toBe(false)
    expect(overallByStudent.has('s1')).toBe(false)
  })

  // The whole point of #493: the figure comes from the curated scores DIRECTLY.
  // If this ever reads the roadmap's node tables again, the headline goes back
  // to depending on whether module items happen to carry topic labels.
  it('derives the figure without reading the roadmap node tables', async () => {
    const { router } = adminWith(COURSE, [row('s1', 'a1', 90), row('s1', 'b1', 90)])
    const { overallByStudent } = await buildStudentMastery(router, SECTION)

    expect(overallByStudent.get('s1')).toBe(90)
    expect(router.from).not.toHaveBeenCalledWith('modules')
    expect(router.from).not.toHaveBeenCalledWith('module_items')
  })

  it('returns empty maps without reading mastery when no topics are curated', async () => {
    const { router, masteryChain } = adminWith([], [row('s1', 'a1', 90)])
    const { scoresByStudent, overallByStudent } = await buildStudentMastery(router, SECTION)

    expect(scoresByStudent.size).toBe(0)
    expect(overallByStudent.size).toBe(0)
    // Nothing to score against, so the mastery read is skipped entirely rather
    // than pulling every row in the section through the admin client.
    expect(router.from).not.toHaveBeenCalledWith('skill_mastery')
    expect(masteryChain.select).not.toHaveBeenCalled()
  })

  it('scopes both reads to the requested section', async () => {
    const { router, skillChain, masteryChain } = adminWith(COURSE, [row('s1', 'a1', 90)])
    await buildStudentMastery(router, SECTION)

    // The admin client bypasses RLS, so these predicates are the only tenant
    // boundary between one section's mastery and another's.
    expect(skillChain.eq).toHaveBeenCalledWith('section_id', SECTION)
    expect(masteryChain.eq).toHaveBeenCalledWith('section_id', SECTION)
  })
})
