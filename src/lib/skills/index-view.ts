/**
 * Skill-index builder — pure, testable. Turns raw section rows into the two-pane
 * "skill index" model: a 2-level skill tree where each skill carries its coverage
 * (which quizzes assess it, which lectures teach it) and class mastery. Lets the
 * professor sort to surface orphan/untested skills — the #1 value of the view.
 *
 * Coverage sources: quizzes, assignments, and live-classroom quizzes via
 * `activity_skills` (canonical FK, discriminated by activity_type); lectures via
 * name-matching a lecture's free-text `content.topics` to the skill name (the
 * roadmap's existing bridge). A skill touched by none is surfaced honestly as zero.
 *
 * No DB/server imports — client-safe + unit-testable.
 */

import type { SkillRow } from '@/lib/validations/skill'
import { normalizeTopicKey } from '@/lib/roadmap/journey-state'
import { aggregateSectionMastery, type MasteryDatum } from '@/lib/skills/aggregate'
import { DEFAULT_TOPIC_MASTERY_CONFIG, type SkillMasteryConfig } from '@/lib/skills/config'

export interface CoverageResource { id: string; title: string }

export interface SkillCoverage {
  /** Quizzes + exams that assess this skill (via activity_skills). */
  quizzes: CoverageResource[]
  /** Lectures teaching this skill (name-matched content.topics). */
  lectures: CoverageResource[]
  /** Assignments assessing this skill (via activity_skills). */
  assignments: CoverageResource[]
  /** Live-classroom quizzes assessing this skill (via activity_skills, live_quiz). */
  live: CoverageResource[]
}

export interface SkillIndexNode {
  id: string
  name: string
  parentId: string | null
  excluded: boolean
  /** Class-average mastery 0–100 for this skill, or null if never assessed. */
  masteryPct: number | null
  coverage: SkillCoverage
  /** Total distinct resources touching this skill (quizzes + lectures). */
  coverageCount: number
  children: SkillIndexNode[]
}

export interface SkillIndexData {
  /** Main skills (parent_id null) with their sub-skills attached. */
  tree: SkillIndexNode[]
  /** Every skill, flat — for the coverage matrix + global sorting. */
  flat: SkillIndexNode[]
  /** Class mastery change per skill since the trend baseline, rounded to a whole
   *  point. Absent for a skill with too little history to compare. Read from the
   *  uncapped estimate, so it reports the week the learning happened rather than
   *  the week the capped score caught up. */
  trendBySkillId?: Record<string, number>
  /** Set when the AI kill switch is refusing `roadmap-skills-ai`. Mastery still
   *  scores from the professor's own tags and skills, but automatic concept
   *  extraction and AI parent placement are off, and the professor should be told
   *  why rather than left wondering. Carries the shared refusal copy. */
  aiNotice?: string
  /** True when the refusal is a deliberate policy choice, false when it is the
   *  fail-closed infra path. The two need different words and a different icon:
   *  "temporarily unavailable, try again shortly" must not be dressed as a
   *  padlock, and must not carry advice about what will keep working. */
  aiNoticeIsPolicy?: boolean
}

export interface RawActivitySkill { activity_id: string; skill_id: string; activity_type: string }
export interface RawCoverageActivity { id: string; title: string }
export interface RawLectureItem { id: string; title: string; topics: string[] }
/** One per-(student, skill) mastery row, as the aggregate reads it. `student_id`
 *  and `state` are load-bearing: without them this file cannot roll subtopics up
 *  to their parent, and cannot honour the section's chosen class metric. */
export interface RawSkillMastery {
  student_id: string
  skill_id: string
  score: number | null
  state?: { n?: number; w?: number } | null
}

/**
 * Build the skill-index model from raw rows.
 */
export function buildSkillIndex(input: {
  skills: SkillRow[]
  activitySkills: RawActivitySkill[]
  quizzes: RawCoverageActivity[]
  assignments: RawCoverageActivity[]
  liveQuizzes: RawCoverageActivity[]
  lectures: RawLectureItem[]
  mastery: RawSkillMastery[]
  /** The section's Topic Mastery knobs. Omitted falls back to the shipped
   *  defaults, which is what the tests do — but a real section must pass its own,
   *  or the list silently ignores the professor's chosen class metric. */
  config?: SkillMasteryConfig
}): SkillIndexData {
  const quizById = new Map(input.quizzes.map((q) => [q.id, q]))
  const assignmentById = new Map(input.assignments.map((a) => [a.id, a]))
  const liveById = new Map(input.liveQuizzes.map((l) => [l.id, l]))

  // skill_id → assessing activities (via activity_skills). Quizzes AND exams
  // count as "quizzes" coverage; assignments and live quizzes are their own
  // dimensions.
  const quizzesBySkill = new Map<string, CoverageResource[]>()
  const assignmentsBySkill = new Map<string, CoverageResource[]>()
  const liveBySkill = new Map<string, CoverageResource[]>()
  for (const a of input.activitySkills) {
    if (a.activity_type === 'quiz' || a.activity_type === 'exam') {
      const q = quizById.get(a.activity_id)
      if (!q) continue
      const list = quizzesBySkill.get(a.skill_id) ?? []
      if (!list.some((x) => x.id === q.id)) list.push({ id: q.id, title: q.title })
      quizzesBySkill.set(a.skill_id, list)
    } else if (a.activity_type === 'assignment') {
      const asn = assignmentById.get(a.activity_id)
      if (!asn) continue
      const list = assignmentsBySkill.get(a.skill_id) ?? []
      if (!list.some((x) => x.id === asn.id)) list.push({ id: asn.id, title: asn.title })
      assignmentsBySkill.set(a.skill_id, list)
    } else if (a.activity_type === 'live_quiz') {
      const lq = liveById.get(a.activity_id)
      if (!lq) continue
      const list = liveBySkill.get(a.skill_id) ?? []
      if (!list.some((x) => x.id === lq.id)) list.push({ id: lq.id, title: lq.title })
      liveBySkill.set(a.skill_id, list)
    }
  }

  // normalised skill name → lectures whose topics mention it.
  const lecturesByNormName = new Map<string, CoverageResource[]>()
  for (const lec of input.lectures) {
    for (const topic of lec.topics) {
      const key = normalizeTopicKey(topic)
      if (!key) continue
      const list = lecturesByNormName.get(key) ?? []
      if (!list.some((x) => x.id === lec.id)) list.push({ id: lec.id, title: lec.title })
      lecturesByNormName.set(key, list)
    }
  }

  /* skill_id → the class number, from the SAME function the concept panel and
     Class analytics use.

     This used to compute its own `Math.round(sum / n)` — always the mean, and it
     took no config. So the drawer row printed the mean while the panel that row
     opens printed the configured median, and 11 of 13 skills in one test section
     disagreed by up to 4 points, one click apart, with the drawer's own gear
     displaying "CLASS NUMBER: Median" two rows above the list. It was invisible
     while the row rendered a colour-only dot, because two values in the same tier
     band paint the same colour; printing the number exposed it.

     Calling aggregateSectionMastery rather than re-deriving means the two surfaces
     agree by construction, not by two implementations happening to match. It also
     rolls subtopics up to their parent, so a main skill stops reading "not
     assessed yet" beside a panel reporting a real score for it. */
  /* `state` has to be unpacked into the top-level n and w the aggregate reads.
     Casting the raw rows straight across type-checks and then silently returns
     null for everything, because rollUpScore skips any child with n === 0. Same
     fallback the incremental hook uses: a row with a score but no recorded count
     is worth one event. */
  const data: MasteryDatum[] = input.mastery.map((m) => {
    const score = m.score == null ? null : Number(m.score)
    const st = m.state ?? {}
    return {
      student_id: m.student_id,
      skill_id: m.skill_id,
      score,
      n: typeof st.n === 'number' ? st.n : score != null ? 1 : 0,
      w: typeof st.w === 'number' ? st.w : null,
    }
  })
  const view = aggregateSectionMastery(input.skills, data, input.config ?? DEFAULT_TOPIC_MASTERY_CONFIG)
  const classScoreBySkill = new Map<string, number | null>()
  for (const main of view.ordered) {
    classScoreBySkill.set(main.skillId, main.classScore)
    for (const sub of main.subtopics) classScoreBySkill.set(sub.skillId, sub.classScore)
  }

  const build = (s: SkillRow): SkillIndexNode => {
    const quizzes = quizzesBySkill.get(s.id) ?? []
    const assignments = assignmentsBySkill.get(s.id) ?? []
    const live = liveBySkill.get(s.id) ?? []
    const lectures = lecturesByNormName.get(normalizeTopicKey(s.name)) ?? []
    const classScore = classScoreBySkill.get(s.id) ?? null
    return {
      id: s.id,
      name: s.name,
      parentId: s.parent_id,
      excluded: s.excluded,
      masteryPct: classScore == null ? null : Math.round(classScore),
      coverage: { quizzes, lectures, assignments, live },
      coverageCount: quizzes.length + lectures.length + assignments.length + live.length,
      children: [],
    }
  }

  const nodes = input.skills.map(build)
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const tree: SkillIndexNode[] = []
  for (const n of nodes) {
    if (n.parentId && byId.has(n.parentId)) byId.get(n.parentId)!.children.push(n)
    else tree.push(n)
  }

  // A category (e.g. "Foundations") is never itself tagged on a quiz/lecture —
  // only its children are — so build() above always gives it zero coverage.
  // Roll children's coverage up post-order, same idea aggregateSectionMastery
  // already applies to masteryPct above, just not previously done for coverage.
  const rollUpCoverage = (n: SkillIndexNode): void => {
    for (const child of n.children) rollUpCoverage(child)
    if (n.children.length === 0) return
    const seen: Record<keyof SkillCoverage, Set<string>> = {
      quizzes: new Set(n.coverage.quizzes.map((r) => r.id)),
      lectures: new Set(n.coverage.lectures.map((r) => r.id)),
      assignments: new Set(n.coverage.assignments.map((r) => r.id)),
      live: new Set(n.coverage.live.map((r) => r.id)),
    }
    const merged: SkillCoverage = {
      quizzes: [...n.coverage.quizzes],
      lectures: [...n.coverage.lectures],
      assignments: [...n.coverage.assignments],
      live: [...n.coverage.live],
    }
    for (const child of n.children) {
      for (const key of ['quizzes', 'lectures', 'assignments', 'live'] as const) {
        for (const res of child.coverage[key]) {
          if (seen[key].has(res.id)) continue
          seen[key].add(res.id)
          merged[key].push(res)
        }
      }
    }
    n.coverage = merged
    n.coverageCount = merged.quizzes.length + merged.lectures.length + merged.assignments.length + merged.live.length
  }
  for (const root of tree) rollUpCoverage(root)

  return { tree, flat: nodes }
}

export type SkillIndexSort = 'name' | 'least-covered' | 'most-covered'

/** Sort a flat skill list for the left pane. `least-covered` surfaces orphans first. */
export function sortSkillIndex(nodes: SkillIndexNode[], sort: SkillIndexSort): SkillIndexNode[] {
  const copy = [...nodes]
  if (sort === 'name') copy.sort((a, b) => a.name.localeCompare(b.name))
  else if (sort === 'least-covered') copy.sort((a, b) => a.coverageCount - b.coverageCount || a.name.localeCompare(b.name))
  else copy.sort((a, b) => b.coverageCount - a.coverageCount || a.name.localeCompare(b.name))
  return copy
}
