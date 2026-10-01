// Skill Mastery — pure read-aggregation. Turns flat skill rows + per-(student,
// subtopic) mastery into the models the dashboard / roadmap / student view read,
// using the engine (scoring.ts) + roll-up (mastery.ts). No DB / React.

import type { SkillRow } from '@/lib/validations/skill'
import type { SkillMasteryConfig } from '@/lib/skills/config'
import { classNumber, classBands, percentProficient, percentAtRisk, type ClassBands } from '@/lib/skills/scoring'
import { rollUpScore } from '@/lib/skills/mastery'

/** One per-(student, subtopic) mastery datum. `n` = evidence count (drives "has
 *  data" and coverage); `w` = accumulated evidence weight (drives roll-up
 *  weighting). `w` is absent on rows written before the engine recorded it, and
 *  roll-up falls back to `n` for those. */
export interface MasteryDatum {
  student_id: string
  skill_id: string
  score: number | null
  n: number
  w?: number | null
}

export interface SubskillAgg {
  skillId: string
  name: string
  source: 'ai' | 'professor'
  classScore: number | null
  proficientPct: number | null
  atRiskPct: number | null
}

export interface MainSkillAgg {
  skillId: string
  name: string
  source: 'ai' | 'professor'
  classScore: number | null
  coverage: number // 0–1, share of subtopics with any data
  proficientPct: number | null
  atRiskPct: number | null
  bands: ClassBands
  subtopics: SubskillAgg[]
}

export interface SectionMasteryView {
  /** Main skills, weakest first; "no data" sinks to the bottom (dashboard). */
  ranked: MainSkillAgg[]
  /** Main skills in course order (position) — for the roadmap. */
  ordered: MainSkillAgg[]
  weakest: MainSkillAgg | null
}

const sortRows = (a: SkillRow, b: SkillRow) => a.position - b.position || a.name.localeCompare(b.name)

/** Map of skillId -> (studentId -> datum). */
function indexMastery(rows: MasteryDatum[]): Map<string, Map<string, MasteryDatum>> {
  const m = new Map<string, Map<string, MasteryDatum>>()
  for (const r of rows) {
    let inner = m.get(r.skill_id)
    if (!inner) m.set(r.skill_id, (inner = new Map()))
    inner.set(r.student_id, r)
  }
  return m
}

/** Class-level dashboard view: ranked main skills with rolled-up class scores. */
export function aggregateSectionMastery(
  skills: SkillRow[],
  rows: MasteryDatum[],
  config: SkillMasteryConfig,
): SectionMasteryView {
  const bySkill = indexMastery(rows)
  const mains = skills.filter((t) => t.parent_id === null).sort(sortRows)
  const subsByParent = new Map<string, SkillRow[]>()
  for (const t of skills) {
    if (t.parent_id) {
      const list = subsByParent.get(t.parent_id) ?? []
      list.push(t)
      subsByParent.set(t.parent_id, list)
    }
  }

  const ordered: MainSkillAgg[] = mains.map((main) => {
    const subs = (subsByParent.get(main.id) ?? []).sort(sortRows)

    const subAggs: SubskillAgg[] = subs.map((s) => {
      const scores = [...(bySkill.get(s.id)?.values() ?? [])].map((d) => d.score)
      return {
        skillId: s.id,
        name: s.name,
        source: s.source,
        classScore: classNumber(scores, config),
        proficientPct: percentProficient(scores, config.proficientThreshold),
        atRiskPct: percentAtRisk(scores, config.atRiskThreshold),
      }
    })

    // Per student: pool the main skill's OWN mastery with its subtopics' scores.
    // Mastery legitimately lands on a parent when a quiz tag matches the parent's
    // name (recompute + tag auto-map), so its own rows must count — not only its
    // children's, which would drop a scored parent to blank the moment it gains a
    // subtopic (issue #330).
    const ownByStudent = bySkill.get(main.id)
    const ownHasData = (ownByStudent?.size ?? 0) > 0
    const studentIds = new Set<string>()
    for (const s of subs) for (const sid of bySkill.get(s.id)?.keys() ?? []) studentIds.add(sid)
    for (const sid of ownByStudent?.keys() ?? []) studentIds.add(sid)

    const mainScores: Array<number | null> = [...studentIds].map((sid) => {
      const own = ownByStudent?.get(sid)
      return rollUpScore([
        { score: own?.score ?? null, n: own?.n ?? 0, w: own?.w ?? null },
        ...subs.map((s) => {
          const d = bySkill.get(s.id)?.get(sid)
          return { score: d?.score ?? null, n: d?.n ?? 0, w: d?.w ?? null }
        }),
      ])
    })

    // Coverage counts the parent itself as an assessable unit when it has direct data.
    const testedSubs = subs.filter((s) => (bySkill.get(s.id)?.size ?? 0) > 0).length
    const denom = subs.length + (ownHasData ? 1 : 0)
    const coverage = denom === 0 ? 0 : (testedSubs + (ownHasData ? 1 : 0)) / denom

    return {
      skillId: main.id,
      name: main.name,
      source: main.source,
      classScore: classNumber(mainScores, config),
      coverage,
      proficientPct: percentProficient(mainScores, config.proficientThreshold),
      atRiskPct: percentAtRisk(mainScores, config.atRiskThreshold),
      bands: classBands(mainScores),
      subtopics: subAggs,
    }
  })

  // Weakest first; nulls (no data) to the bottom.
  const ranked = [...ordered].sort((a, b) => {
    if (a.classScore == null && b.classScore == null) return 0
    if (a.classScore == null) return 1
    if (b.classScore == null) return -1
    return a.classScore - b.classScore
  })

  const weakest = ranked.find((r) => r.classScore != null) ?? null
  return { ranked, ordered, weakest }
}

/** Per-student score on one skill (rolls up children for a main skill), for the
 *  drill-down distribution. Includes every rostered student (null = no data). */
export function studentScoresForSkill(
  skills: SkillRow[],
  rows: MasteryDatum[],
  roster: Array<{ id: string; name: string }>,
  skillId: string,
): Array<{ id: string; name: string; score: number | null }> {
  const children = skills.filter((t) => t.parent_id === skillId)
  const byKey = new Map<string, MasteryDatum>()
  for (const r of rows) byKey.set(`${r.student_id}:${r.skill_id}`, r)
  return roster.map((s) => {
    // Pool the skill's own mastery with its children's (issue #330).
    const own = byKey.get(`${s.id}:${skillId}`)
    const score = rollUpScore([
      { score: own?.score ?? null, n: own?.n ?? 0, w: own?.w ?? null },
      ...children.map((c) => {
        const d = byKey.get(`${s.id}:${c.id}`)
        return { score: d?.score ?? null, n: d?.n ?? 0, w: d?.w ?? null }
      }),
    ])
    return { id: s.id, name: s.name, score }
  })
}

export interface StudentSkillScore {
  skillId: string
  name: string
  classScore: number | null // here: the student's own score (reuses the field name for the bar)
  subtopics: Array<{ skillId: string; name: string; score: number | null }>
  coverage: number
}

/** One student's own mastery, main skills with their rolled-up score. */
export function aggregateStudentMastery(
  skills: SkillRow[],
  rows: MasteryDatum[],
): StudentSkillScore[] {
  const bySkill = new Map<string, MasteryDatum>()
  for (const r of rows) bySkill.set(r.skill_id, r)

  const mains = skills.filter((t) => t.parent_id === null).sort(sortRows)
  const subsByParent = new Map<string, SkillRow[]>()
  for (const t of skills) {
    if (t.parent_id) {
      const list = subsByParent.get(t.parent_id) ?? []
      list.push(t)
      subsByParent.set(t.parent_id, list)
    }
  }

  return mains.map((main) => {
    const subs = (subsByParent.get(main.id) ?? []).sort(sortRows)
    const own = bySkill.get(main.id)
    const ownHasData = own != null
    // Pool the parent's own mastery with its subtopics (issue #330): a quiz tag
    // that matches a parent writes mastery to the parent, not its children.
    const children = [
      { score: own?.score ?? null, n: own?.n ?? 0, w: own?.w ?? null },
      ...subs.map((s) => ({
        score: bySkill.get(s.id)?.score ?? null,
        n: bySkill.get(s.id)?.n ?? 0,
        w: bySkill.get(s.id)?.w ?? null,
      })),
    ]
    const testedSubs = subs.filter((s) => bySkill.get(s.id) != null).length
    const denom = subs.length + (ownHasData ? 1 : 0)
    return {
      skillId: main.id,
      name: main.name,
      classScore: rollUpScore(children),
      coverage: denom === 0 ? 0 : (testedSubs + (ownHasData ? 1 : 0)) / denom,
      subtopics: subs.map((s) => ({ skillId: s.id, name: s.name, score: bySkill.get(s.id)?.score ?? null })),
    }
  })
}
