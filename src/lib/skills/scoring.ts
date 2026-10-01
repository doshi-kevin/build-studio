// Skill Mastery — per-student scoring engine (pure). Config-driven so a
// section's knobs (course_sections.settings.topicMastery) tune behaviour.
//
// NOTE: this file used to cite docs/designs/roadmap-mastery/topic-mastery.md for
// its defaults. That doc is not in the repo and may never have been. Until it is
// written, the reasoning behind the constants below — and the evidence that the
// previous estimator was reporting the most recent grade rather than mastery —
// lives in goals/mastery-algorithm-audit/audit.md.

import { DEFAULT_TOPIC_MASTERY_CONFIG, type SkillMasteryConfig } from '@/lib/skills/config'
import type { ActivityType } from '@/lib/validations/skill'

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n))

/** The baseAlpha the knob is measured against, so 0.6 means "as configured". */
const DEFAULT_BASE_ALPHA = DEFAULT_TOPIC_MASTERY_CONFIG.baseAlpha

/**
 * A cold prior (the seed) is a guess, not evidence, so it enters the pooled
 * average carrying only this much weight — real evidence outvotes it almost
 * immediately, but it stops a single data point from reading as a verdict.
 */
export const PRIOR_PSEUDO_WEIGHT = 3

/** Furthest one graded event may move a score that already has history. */
export const MAX_EVENT_DELTA = 20
/** Furthest the very first event may move the score off the seed. */
export const MAX_FIRST_EVENT_DELTA = 40

/** Half-life of evidence weight. Term-start work still counts, at roughly a
 *  third less than this week's. Applied over elapsed TIME, not fold position,
 *  so the answer does not depend on the order rows came back from Postgres. */
export const RECENCY_HALFLIFE_MS = 365 * 24 * 60 * 60 * 1000

/** Weight retained by evidence `dtMs` older than the event being folded. */
export function recencyDecay(dtMs: number): number {
  return Math.pow(0.5, Math.max(0, dtMs) / RECENCY_HALFLIFE_MS)
}

/**
 * Weight of one PASSED roadmap node check (§14) as mastery evidence — shared
 * by the incremental hook and the section recompute so the two can never
 * disagree. Deliberately tiny: a node check has unlimited retries and
 * evidences effort more than comprehension, so a pass is a nudge
 * (α = baseAlpha·⅛ ≈ +4 points from a 50), never a real assessment. The
 * boost is also structurally capped at one event per (student, item):
 * `node_check_attempts` is UNIQUE on that pair and `passed` never regresses.
 */
export const NODE_CHECK_MASTERY_WEIGHT = 0.25

export function stakeMultiplier(config: SkillMasteryConfig, type: ActivityType): number {
  return config.stakeMultipliers[type] ?? 1
}

/**
 * Weight one graded activity carries as evidence for one subtopic.
 *
 * Sub-linear in points on purpose. Evidence grows with the number of
 * independent judgements a grade rests on, not with the size of the rubric: a
 * 100-point essay is not twenty times the evidence of a 5-point exit ticket,
 * and treating it that way is what used to drive α straight into its ceiling.
 * log2 keeps the ordering (bigger still counts for more) while compressing the
 * range from 20:1 down to under 3:1. A 2-point quiz item still weighs 2.
 */
export function evidenceWeight(
  config: SkillMasteryConfig,
  type: ActivityType,
  assessedPoints: number,
): number {
  return stakeMultiplier(config, type) * (1 + Math.log2(Math.max(1, assessedPoints)))
}

/**
 * Next per-subtopic mastery after one graded evidence point.
 *
 * A weight-pooled average, not a fixed-rate decaying one. The old form was
 * `prior + (e − prior) × α` with `α = baseAlpha × weight / 2`; because
 * weight scaled linearly with points, α hit its 0.95 ceiling for essentially
 * every real activity and mastery collapsed into "the most recent grade wins".
 * One zero erased a term of work, and two recomputes of the same data could
 * disagree.
 *
 * Here the new event is pooled against however much evidence already stands
 * behind the score (`priorWeight`), so an outlier is outvoted by history rather
 * than replacing it, and the result converges on the student's actual average.
 * Movement is then capped, which is the rule we can state to a professor
 * plainly: one assignment never swings mastery by more than 20 points.
 *
 * `prev` null = cold start. The prior seeds to `seed` (the section average, else
 * 50) carrying only PRIOR_PSEUDO_WEIGHT, and the subtopic stays "not yet
 * assessed" upstream until this first real evidence arrives.
 */
export function nextMasteryTarget(
  prevTarget: number | null | undefined,
  evidenceScore: number,
  weight: number,
  config: SkillMasteryConfig,
  seed = 50,
  priorWeight?: number,
): number {
  const e = clamp(evidenceScore)
  const cold = prevTarget == null || Number.isNaN(prevTarget)
  const prior = cold ? clamp(seed) : prevTarget
  // baseAlpha survives as the professor's responsiveness knob: above the 0.6
  // default new evidence carries more weight, below it less.
  const responsiveness = config.baseAlpha / DEFAULT_BASE_ALPHA
  const w = Math.max(0, weight) * responsiveness
  const pw = cold ? PRIOR_PSEUDO_WEIGHT : Math.max(priorWeight ?? PRIOR_PSEUDO_WEIGHT, PRIOR_PSEUDO_WEIGHT)
  return pw + w === 0 ? prior : clamp((prior * pw + e * w) / (pw + w))
}

/**
 * Slew-rate limit on the number a human sees. Capping the ESTIMATE would throw
 * information away for good and make the answer depend on the order work
 * happened to be graded in; capping only the reported score keeps the estimate
 * honest while still letting us promise a professor that no single assignment
 * swings mastery by more than MAX_EVENT_DELTA points.
 */
export function capMasteryMove(prevScore: number | null | undefined, target: number, seed = 50): number {
  const cold = prevScore == null || Number.isNaN(prevScore)
  const from = cold ? clamp(seed) : prevScore
  const cap = cold ? MAX_FIRST_EVENT_DELTA : MAX_EVENT_DELTA
  return clamp(from + Math.max(-cap, Math.min(cap, target - from)))
}

/**
 * Estimate then cap, in one call — see nextMasteryTarget for the rationale.
 *
 * Callers that keep the running estimate (`state.t`) should use
 * nextMasteryTarget + capMasteryMove directly and pass the previous TARGET, so
 * the cap never eats evidence. This wrapper folds the previous SCORE in as its
 * own target, which is the best available answer when only the score is on hand.
 */
export function nextMasteryScore(
  prev: number | null | undefined,
  evidenceScore: number,
  weight: number,
  config: SkillMasteryConfig,
  seed = 50,
  priorWeight?: number,
): number {
  return capMasteryMove(prev, nextMasteryTarget(prev, evidenceScore, weight, config, seed, priorWeight), seed)
}

// ── Per-skill evidence from a multi-topic activity ──────────────

/** One graded question, with the skills its tag resolved to. */
export interface QuestionOutcome {
  skillIds: string[]
  earned: number
  possible: number
}

/** What one activity says about one skill: the score on that skill's items only. */
export interface SkillSubscore {
  skillId: string
  pct: number
  /** Points actually assessed for this skill, which is what its weight is built from. */
  points: number
}

/**
 * Split one activity's result into per-skill evidence.
 *
 * A quiz covering two topics used to record its OVERALL percentage against BOTH
 * of them, so a student who aced backpropagation and failed activation functions
 * read as mediocre at each. The feature exists to tell a professor which topic to
 * re-teach, and smeared like that it cannot: the two numbers are identical by
 * construction. Per-question data was already stored (`quiz_answers.earned_points`
 * plus `quiz_questions.tags`); the engine simply never read it.
 *
 * A question tagged with several skills counts toward each of them in full. That
 * is the honest reading of the tag: the professor said this question tests both.
 *
 * Questions whose tags resolve to nothing are dropped — they belong to no skill,
 * so they cannot be evidence about one.
 */
export function subscoresBySkill(outcomes: QuestionOutcome[]): SkillSubscore[] {
  const acc = new Map<string, { earned: number; possible: number }>()
  for (const o of outcomes) {
    for (const skillId of o.skillIds) {
      const cur = acc.get(skillId) ?? { earned: 0, possible: 0 }
      cur.earned += o.earned
      cur.possible += o.possible
      acc.set(skillId, cur)
    }
  }
  const out: SkillSubscore[] = []
  for (const [skillId, v] of acc) {
    if (v.possible <= 0) continue
    out.push({ skillId, pct: clamp((v.earned / v.possible) * 100), points: v.possible })
  }
  // Stable order so two runs over the same data fold in the same sequence.
  return out.sort((a, b) => a.skillId.localeCompare(b.skillId))
}

/**
 * Points to weight ONE skill by, for an activity graded as a single holistic
 * score across several skills — an assignment, where there is no per-question
 * breakdown to split by.
 *
 * Without this a 100-point assignment touching four skills weighs 15.3 against
 * each of them, while a precise 3-question quiz subscore weighs 2.6. The vaguest
 * evidence would outvote the sharpest six to one. Splitting the points first
 * drops it to 11.3, which still counts for more than a short quiz — an
 * assignment IS more work — without letting it drown the diagnostic signal.
 *
 * An equal split assumes the work covered each skill equally. It did not,
 * necessarily; we have no data saying otherwise, so this is the least-wrong
 * default rather than a correct one.
 */
export function splitPointsAcrossSkills(points: number, skillCount: number): number {
  return Math.max(1, points) / Math.max(1, skillCount)
}

// ── Class aggregation (the professor's numbers) ─────────────────

const withData = (scores: Array<number | null | undefined>): number[] =>
  scores.filter((s): s is number => s != null && !Number.isNaN(s))

export function meanScore(scores: Array<number | null | undefined>): number | null {
  const v = withData(scores)
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null
}

export function medianScore(scores: Array<number | null | undefined>): number | null {
  const v = withData(scores).sort((a, b) => a - b)
  if (!v.length) return null
  const mid = Math.floor(v.length / 2)
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2
}

export function percentProficient(
  scores: Array<number | null | undefined>,
  threshold: number,
): number | null {
  const v = withData(scores)
  return v.length ? (v.filter((s) => s >= threshold).length / v.length) * 100 : null
}

export function percentAtRisk(
  scores: Array<number | null | undefined>,
  threshold: number,
): number | null {
  const v = withData(scores)
  return v.length ? (v.filter((s) => s < threshold).length / v.length) * 100 : null
}

/** The single configured class number for a skill (default: median). */
export function classNumber(
  scores: Array<number | null | undefined>,
  config: SkillMasteryConfig,
): number | null {
  switch (config.classMetric) {
    case 'mean':
      return meanScore(scores)
    case 'percent_proficient':
      return percentProficient(scores, config.proficientThreshold)
    case 'median':
    default:
      return medianScore(scores)
  }
}

export interface ClassBands {
  atRisk: number // 0–49
  developing: number // 50–69
  proficient: number // 70–84
  advanced: number // 85–100
}

/** 4-band distribution counts for the dashboard histogram. */
export function classBands(scores: Array<number | null | undefined>): ClassBands {
  const v = withData(scores)
  return {
    atRisk: v.filter((s) => s < 50).length,
    developing: v.filter((s) => s >= 50 && s < 70).length,
    proficient: v.filter((s) => s >= 70 && s < 85).length,
    advanced: v.filter((s) => s >= 85).length,
  }
}

// ── The chronological fold (shared) ─────────────────────────────

/** One graded piece of evidence, ready to fold. */
export interface MasteryEvent {
  studentId: string
  skillId: string
  /** 0–100 achievement on this event. */
  pct: number
  /** Epoch ms the evidence was earned; 0 when the source row carries no date. */
  at: number
  weight: number
}

export interface MasteryState {
  score: number
  /** Count of events folded so far. Drives "has data" and coverage. */
  n: number
  /** Accumulated, recency-decayed evidence weight behind `score`. Roll-up reads
   *  this so one exam outranks eight node checks instead of the reverse. */
  w: number
  /** Timestamp of the newest event folded, for the next decay step. */
  lastAt: number
  /** The uncapped pooled estimate the reported `score` is converging toward. */
  t: number
}

/**
 * Fold a section's evidence into per-(student, skill) mastery, keyed
 * `${studentId}:${skillId}`.
 *
 * Lives here rather than inline in recompute.ts so the stress harness exercises
 * the same code production does — recompute.ts is `server-only` and cannot be
 * imported from a test.
 */
export function foldMasteryEvents(
  events: MasteryEvent[],
  config: SkillMasteryConfig,
  seed = 50,
): Map<string, MasteryState> {
  // Sorting on `at` alone left ties in whatever order Postgres happened to
  // return rows, and every missing date arrives as at = 0 — so two recomputes
  // of unchanged data could produce different numbers. The extra keys make the
  // order a total one, which is what makes a score reproducible.
  const ordered = [...events].sort(
    (a, b) =>
      a.at - b.at ||
      a.pct - b.pct ||
      a.weight - b.weight ||
      a.studentId.localeCompare(b.studentId) ||
      a.skillId.localeCompare(b.skillId),
  )
  const state = new Map<string, MasteryState>()
  for (const e of ordered) {
    const key = `${e.studentId}:${e.skillId}`
    const prev = state.get(key)
    const carried = prev ? prev.w * recencyDecay(e.at - prev.lastAt) : 0
    const target = nextMasteryTarget(prev?.t ?? null, e.pct, e.weight, config, seed, prev ? carried : undefined)
    state.set(key, {
      // Rounded to the 0.1 the column actually stores, so the folded value and
      // the persisted one are the same number and a replay cannot drift.
      score: Math.round(capMasteryMove(prev?.score ?? null, target, seed) * 10) / 10,
      t: target,
      n: (prev?.n ?? 0) + 1,
      w: carried + Math.max(0, e.weight),
      lastAt: prev ? Math.max(prev.lastAt, e.at) : e.at,
    })
  }
  return state
}
