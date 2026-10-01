// Skill Mastery — per-section configuration (the professor's knobs).
//
// Different courses want different behaviour (a lab weighting assignments
// harder; "median" vs "% proficient" for the class number). Config lives in
// course_sections.settings.topicMastery; the engine reads it with research-
// backed defaults, so a section with no config behaves sensibly.
// Defaults & rationale: docs/designs/roadmap-mastery/topic-mastery.md.

export type ClassMetricKind = 'median' | 'mean' | 'percent_proficient'

export interface SkillMasteryConfig {
  /** Base recency weight for the decaying average (Canvas 65/35 ≈ 0.6; range 0.5–0.9). */
  baseAlpha: number
  /** Which single number the professor sees per skill (median = the typical student). */
  classMetric: ClassMetricKind
  /** Score at/above which a student is "proficient" (Khan's 70 floor). */
  proficientThreshold: number
  /** Below this a student is "at risk" (drives the at-risk count + list). */
  atRiskThreshold: number
  /** How much harder higher-stakes activities pull the score. Challenges are
   *  motivating milestones, not standardized assessments, so they pull gently. */
  stakeMultipliers: { exam: number; assignment: number; quiz: number; challenge: number }
  /** Fold live-classroom quiz results in (deterministic, name-matched to subtopics). */
  includeLiveQuiz: boolean
}

export const DEFAULT_TOPIC_MASTERY_CONFIG: SkillMasteryConfig = {
  baseAlpha: 0.6,
  classMetric: 'median',
  proficientThreshold: 70,
  atRiskThreshold: 50,
  stakeMultipliers: { exam: 3, assignment: 2, quiz: 1, challenge: 0.5 },
  includeLiveQuiz: true,
}

const CLASS_METRICS: ClassMetricKind[] = ['median', 'mean', 'percent_proficient']

/** The word for the single class number, per the section's configured metric.
 *  Never hardcode "median" in a label — a section can be set to mean or
 *  % proficient, and then the label lies. Lives here next to ClassMetricKind
 *  because three surfaces need it: the roadmap's Class analytics, Athena's
 *  topic digest, and the gradebook's skill chart. */
export const CLASS_METRIC_LABEL: Record<ClassMetricKind, string> = {
  median: 'median',
  mean: 'average',
  percent_proficient: '% proficient',
}

function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback
}

/** Merge a section's stored settings JSON over the defaults. Never throws. */
export function resolveSkillMasteryConfig(settings: unknown): SkillMasteryConfig {
  const d = DEFAULT_TOPIC_MASTERY_CONFIG
  const raw =
    settings && typeof settings === 'object'
      ? ((settings as Record<string, unknown>).topicMastery as Record<string, unknown> | undefined)
      : undefined
  if (!raw) return d
  const sm = (raw.stakeMultipliers as Record<string, unknown>) || {}
  return {
    baseAlpha: clampNum(raw.baseAlpha, 0.05, 0.95, d.baseAlpha),
    classMetric: CLASS_METRICS.includes(raw.classMetric as ClassMetricKind)
      ? (raw.classMetric as ClassMetricKind)
      : d.classMetric,
    proficientThreshold: clampNum(raw.proficientThreshold, 0, 100, d.proficientThreshold),
    atRiskThreshold: clampNum(raw.atRiskThreshold, 0, 100, d.atRiskThreshold),
    stakeMultipliers: {
      exam: clampNum(sm.exam, 0.1, 10, d.stakeMultipliers.exam),
      assignment: clampNum(sm.assignment, 0.1, 10, d.stakeMultipliers.assignment),
      quiz: clampNum(sm.quiz, 0.1, 10, d.stakeMultipliers.quiz),
      challenge: clampNum(sm.challenge, 0.1, 10, d.stakeMultipliers.challenge),
    },
    includeLiveQuiz: typeof raw.includeLiveQuiz === 'boolean' ? raw.includeLiveQuiz : d.includeLiveQuiz,
  }
}
