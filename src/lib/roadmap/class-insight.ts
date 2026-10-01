// Class insight — the whole-class counterpart of the student dossier's facts
// snapshot (`dossier.ts`). Feeds the AI narrative at the top of the roadmap's
// Class analytics drawer, and is stored beside the prose in
// `class_insight_summaries` so Athena and the data-intelligence layer can read
// the same structured signals later. Bump `version` when the shape changes.
//
// GROUNDING RULE (inherited from the dossier card): every figure in here is a
// figure the drawer already shows underneath the prose — class mastery, quiz
// average, the standing split, the ranked skills, the roster. The model may
// quote nothing else, so the panel below the narrative is always its audit
// trail.
//
// Pure module: no client, no crypto, no 'server-only' — the drawer imports the
// types, the server action imports the builder, the unit tests exercise it.

import type { JourneyState } from '@/lib/roadmap/journey-state'

export const CLASS_FACTS_VERSION = 1
/** Named skills each way — enough to point somewhere, short enough to scan. */
export const CLASS_MAX_SKILLS = 4
/** Named students — a shortlist to act on, not a watchlist. */
export const CLASS_MAX_STUDENTS = 4

export interface ClassSkillFact {
  name: string
  /** Class score, 0–100. */
  score: number
  /** Rostered students scoring below the section's at-risk threshold. */
  atRisk: number
}

export interface ClassStudentFact {
  name: string
  masteryPct: number | null
  quizAvg: number | null
}

/** The stored snapshot — every number the class summary is allowed to use. */
export interface ClassInsightFacts {
  version: typeof CLASS_FACTS_VERSION
  totalStudents: number
  classMasteryPct: number | null
  classQuizAvg: number | null
  /** Standing split — the drawer's EXCELLING / NEEDS SUPPORT tiles plus the
   *  two the tiles leave implicit, so the four always sum to the roster. */
  excelling: number
  onTrack: number
  needsSupport: number
  noData: number
  /** Class-wide journey mix over the map's nodes (the drawer's donut). */
  journeyCounts: Record<JourneyState, number>
  /** Curated skills with a class score, weakest first / strongest first. */
  weakestSkills: ClassSkillFact[]
  strongestSkills: ClassSkillFact[]
  /** Curated skills nothing has been graded against yet — "not measured" is a
   *  different problem from "measured badly", and only this tells them apart. */
  skillsWithoutData: number
  /** TRUE totals — the lists above/below are capped for the prompt, these are
   *  not, so a class with 11 struggling students never reads as having 4. */
  needsAttentionCount: number
  /** Lowest-scoring students among those below the bar. */
  needsAttention: ClassStudentFact[]
  /** Students with no mastery signal at all yet (names, so they can be nudged). */
  noSignalStudents: string[]
}

export interface ClassRosterFact {
  name: string
  overall: 'excelling' | 'on_track' | 'needs_support' | 'not_started'
  masteryPct: number | null
  quizAvg: number | null
  counts: Record<JourneyState, number>
}

const JSTATES: JourneyState[] = ['mastered', 'review_next', 'in_progress', 'not_started']

/** Why the class narrative should not be written at all.
 *
 *  There was no sparse-data branch anywhere in the action or the drawer, so a
 *  section with an empty roster, or one where nothing has been graded, rendered
 *  zeroed tiles and an empty donut AND paid for a model call to narrate them.
 *  The only guard was a line in the prompt asking the model to mention
 *  sparseness, which is a request rather than a state.
 *
 *  Returns null when there IS something to say. Pure, so the rule is testable
 *  without standing up the whole facts pipeline. */
export function classInsightBlocker(
  facts: Pick<ClassInsightFacts, 'totalStudents' | 'classMasteryPct' | 'classQuizAvg'>,
): string | null {
  if (facts.totalStudents === 0) return 'No students are enrolled in this section yet.'
  if (facts.classMasteryPct == null && facts.classQuizAvg == null) {
    return 'Nothing has been graded yet, so there is no class picture to summarise.'
  }
  return null
}

/**
 * Roll the roster + ranked skills the drawer shows into the facts snapshot.
 * Pure: the caller owns the reads (and the ownership check before them).
 *
 * `skills` arrives ranked weakest-first with only scored skills in it — the
 * same filter the drawer's "By skill" tab applies — so strongest is just the
 * tail read backwards.
 */
export function buildClassInsightFacts(
  students: ClassRosterFact[],
  classStats: {
    classMastery: number | null
    classQuizAvg: number | null
    excelling: number
    needsSupport: number
    totalStudents: number
  },
  skills: ClassSkillFact[],
  skillsWithoutData: number,
): ClassInsightFacts {
  const journeyCounts: Record<JourneyState, number> = { mastered: 0, review_next: 0, in_progress: 0, not_started: 0 }
  for (const s of students) for (const k of JSTATES) journeyCounts[k] += s.counts[k]

  /* the name tiebreak is what makes the CAP deterministic: two students on the
     same score either side of the slice would otherwise swap on an equal-score
     sort and flip the facts hash for nothing (see the ordered roster read) */
  const behind = students
    .filter((s) => s.overall === 'needs_support')
    .sort((a, b) => (a.masteryPct ?? 0) - (b.masteryPct ?? 0) || a.name.localeCompare(b.name))

  return {
    version: CLASS_FACTS_VERSION,
    totalStudents: classStats.totalStudents,
    classMasteryPct: classStats.classMastery,
    classQuizAvg: classStats.classQuizAvg,
    excelling: classStats.excelling,
    onTrack: students.filter((s) => s.overall === 'on_track').length,
    needsSupport: classStats.needsSupport,
    noData: students.filter((s) => s.overall === 'not_started').length,
    journeyCounts,
    weakestSkills: skills.slice(0, CLASS_MAX_SKILLS),
    /* the tail reversed, and never the same rows as `weakest` — on a section
       with 3 scored skills, "strongest" and "weakest" would otherwise name the
       same skill and the prose would contradict itself */
    strongestSkills: skills.length > CLASS_MAX_SKILLS
      ? skills.slice(-Math.min(CLASS_MAX_SKILLS, skills.length - CLASS_MAX_SKILLS)).reverse()
      : [],
    skillsWithoutData,
    needsAttentionCount: behind.length,
    needsAttention: behind.slice(0, CLASS_MAX_STUDENTS).map((s) => ({
      name: s.name,
      masteryPct: s.masteryPct,
      quizAvg: s.quizAvg,
    })),
    /* sorted for the same reason `behind` is: this list is CAPPED, so without an
       order of its own it names whichever 4 the roster read happened to return
       first — and the snapshot is hashed, so a reshuffle with no change in the
       data behind it would flip the cache key and rebill the model. The roster
       read is ordered too; this keeps the invariant inside the builder, where
       the next consumer of it (Athena, the intelligence layer) can rely on it. */
    noSignalStudents: students
      .filter((s) => s.overall === 'not_started')
      .map((s) => s.name)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, CLASS_MAX_STUDENTS),
  }
}
