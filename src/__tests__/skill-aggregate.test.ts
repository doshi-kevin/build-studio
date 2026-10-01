// Tests for Skill Mastery read-aggregation (pure): ranking, weighted roll-up,
// no-data handling, per-student distribution.

import { describe, it, expect } from 'vitest'
import {
  aggregateSectionMastery,
  aggregateStudentMastery,
  studentScoresForSkill,
  type MasteryDatum,
} from '@/lib/skills/aggregate'
import {
  rollUpScore,
  skillCoverage,
  masteryFillPct,
  masteryBarVisible,
  MASTERY_BAR_MIN_SCREEN_PX,
} from '@/lib/skills/mastery'
import { DEFAULT_TOPIC_MASTERY_CONFIG as CFG } from '@/lib/skills/config'
import type { SkillRow } from '@/lib/validations/skill'

let seq = 0
function skill(over: Partial<SkillRow> = {}): SkillRow {
  seq += 1
  return {
    id: over.id ?? `t-${seq}`,
    section_id: 'sec',
    institution_id: 'inst',
    parent_id: null,
    name: over.name ?? `T${seq}`,
    info: null,
    source: 'professor',
    placement_pinned: false,
    excluded: false,
    suppressed: false,
    library_skill_id: null,
    position: 0,
    created_at: '',
    updated_at: '',
    ...over,
  }
}
const m = (student_id: string, skill_id: string, score: number | null, n = 1): MasteryDatum => ({
  student_id,
  skill_id,
  score,
  n,
})

describe('rollUpScore', () => {
  it('weights by evidence count and ignores no-data children', () => {
    // (80*3 + 40*1) / (3+1) = 70
    expect(rollUpScore([{ score: 80, n: 3 }, { score: 40, n: 1 }, { score: null, n: 0 }])).toBe(70)
  })
  it('is null when no child has data', () => {
    expect(rollUpScore([{ score: null, n: 0 }])).toBeNull()
  })
})

describe('skillCoverage', () => {
  it('is the fraction of subtopics with data', () => {
    expect(skillCoverage([{ score: 50, n: 1 }, { score: null, n: 0 }])).toBe(0.5)
  })
})

describe('masteryFillPct', () => {
  it('rounds a score to an integer fill percentage', () => {
    expect(masteryFillPct(79.4)).toBe(79)
    expect(masteryFillPct(79.6)).toBe(80)
  })
  it('is 0 for no data', () => {
    expect(masteryFillPct(null)).toBe(0)
    expect(masteryFillPct(undefined)).toBe(0)
    expect(masteryFillPct(NaN)).toBe(0)
  })
  it('clamps out-of-range scores to 0–100', () => {
    expect(masteryFillPct(-5)).toBe(0)
    expect(masteryFillPct(140)).toBe(100)
  })
})

describe('masteryBarVisible', () => {
  const T = MASTERY_BAR_MIN_SCREEN_PX
  it('shows the bar once it renders at/above the screen-px threshold', () => {
    expect(masteryBarVisible(T, false)).toBe(true)
    expect(masteryBarVisible(T + 10, false)).toBe(true)
  })
  it('shows no mark (bar hidden) below the threshold', () => {
    expect(masteryBarVisible(T - 1, false)).toBe(false)
    expect(masteryBarVisible(0, false)).toBe(false)
  })
  it('always shows the bar on hover, regardless of rendered size', () => {
    expect(masteryBarVisible(0, true)).toBe(true)
    expect(masteryBarVisible(T - 1, true)).toBe(true)
  })
})

describe('aggregateSectionMastery', () => {
  const A = skill({ id: 'A', name: 'A', position: 0 })
  const a1 = skill({ id: 'a1', name: 'a1', parent_id: 'A', position: 0 })
  const a2 = skill({ id: 'a2', name: 'a2', parent_id: 'A', position: 1 })
  const B = skill({ id: 'B', name: 'B', position: 1 })
  const b1 = skill({ id: 'b1', name: 'b1', parent_id: 'B', position: 0 })
  const skills = [A, a1, a2, B, b1]
  const rows = [
    m('s1', 'a1', 80), m('s1', 'a2', 40),
    m('s2', 'a1', 90), m('s2', 'a2', 50),
    m('s2', 'b1', 30),
  ]

  it('rolls subtopics up per student then takes the class metric', () => {
    const { ranked, ordered, weakest } = aggregateSectionMastery(skills, rows, CFG)
    const aAgg = ordered.find((t) => t.skillId === 'A')!
    // students: s1 (80+40)/2=60, s2 (90+50)/2=70 → median 65
    expect(aAgg.classScore).toBe(65)
    // B: only s2 has b1=30 → median 30
    expect(ordered.find((t) => t.skillId === 'B')!.classScore).toBe(30)
    // ranked weakest first
    expect(ranked[0].skillId).toBe('B')
    expect(weakest?.skillId).toBe('B')
  })

  it('keeps course order in `ordered` and weakest-first in `ranked`', () => {
    const { ordered, ranked } = aggregateSectionMastery(skills, rows, CFG)
    expect(ordered.map((t) => t.skillId)).toEqual(['A', 'B'])
    expect(ranked.map((t) => t.skillId)).toEqual(['B', 'A'])
  })

  it('sinks no-data skills to the bottom of the ranking', () => {
    const { ranked, weakest } = aggregateSectionMastery(skills, [], CFG)
    expect(weakest).toBeNull()
    expect(ranked.every((t) => t.classScore === null)).toBe(true)
  })

  // Regression for issue #330: mastery legitimately lands on a PARENT (a quiz tag
  // matched the parent's name), so a parent with its own scores must still display
  // even after it gains an untested subtopic — its own rows must not be discarded.
  describe('parent with own mastery + an empty subtopic (issue #330)', () => {
    const P = skill({ id: 'P', name: 'P', position: 0 })
    const pSub = skill({ id: 'pSub', name: 'pSub', parent_id: 'P', position: 0 }) // never scored

    it('keeps the parent visible using its own scores', () => {
      const rows = [m('s1', 'P', 88), m('s2', 'P', 63), m('s3', 'P', 38)]
      const agg = aggregateSectionMastery([P, pSub], rows, CFG).ordered.find((t) => t.skillId === 'P')!
      expect(agg.classScore).toBe(63) // median(38,63,88) — not null
      expect(agg.coverage).toBe(0.5) // parent counts as a covered unit; pSub does not
    })

    it('pools the parent’s own scores with a scored subtopic', () => {
      // s1: own P=80 (n1) + pSub=40 (n1) → (80+40)/2 = 60
      const rows = [m('s1', 'P', 80, 1), m('s1', 'pSub', 40, 1)]
      const agg = aggregateSectionMastery([P, pSub], rows, CFG).ordered.find((t) => t.skillId === 'P')!
      expect(agg.classScore).toBe(60)
      expect(agg.coverage).toBe(1)
    })
  })
})

describe('studentScoresForSkill', () => {
  const A = skill({ id: 'A', name: 'A' })
  const a1 = skill({ id: 'a1', parent_id: 'A' })
  const roster = [{ id: 's1', name: 'One' }, { id: 's2', name: 'Two' }]

  it('rolls up a main skill and includes every student (null when untested)', () => {
    const rows = [m('s1', 'a1', 88)]
    const out = studentScoresForSkill([A, a1], rows, roster, 'A')
    expect(out.find((e) => e.id === 's1')!.score).toBe(88)
    expect(out.find((e) => e.id === 's2')!.score).toBeNull()
  })

  it('reads a subtopic directly', () => {
    const out = studentScoresForSkill([A, a1], [m('s2', 'a1', 55)], roster, 'a1')
    expect(out.find((e) => e.id === 's2')!.score).toBe(55)
  })

  it('uses a parent’s own score when its subtopic is untested (issue #330)', () => {
    // A has an untested child a1, but the student was scored on A directly.
    const out = studentScoresForSkill([A, a1], [m('s1', 'A', 88)], roster, 'A')
    expect(out.find((e) => e.id === 's1')!.score).toBe(88)
  })
})

describe('aggregateStudentMastery', () => {
  const P = skill({ id: 'P', name: 'P' })
  const pSub = skill({ id: 'pSub', name: 'pSub', parent_id: 'P' })

  it('keeps a parent’s own score when its subtopic is untested (issue #330)', () => {
    const [main] = aggregateStudentMastery([P, pSub], [m('s1', 'P', 88)])
    expect(main.classScore).toBe(88)
  })

  it('pools a parent’s own score with a scored subtopic', () => {
    const rows = [m('s1', 'P', 80, 1), m('s1', 'pSub', 40, 1)]
    const [main] = aggregateStudentMastery([P, pSub], rows)
    expect(main.classScore).toBe(60)
  })

  // Guards the childless-leaf path that replaced the old `subs.length === 0` branch.
  it('reads a childless main skill’s own score directly', () => {
    const leaf = skill({ id: 'L', name: 'L' })
    const [main] = aggregateStudentMastery([leaf], [m('s1', 'L', 72)])
    expect(main.classScore).toBe(72)
    expect(main.coverage).toBe(1)
  })
})
