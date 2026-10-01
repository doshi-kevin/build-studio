import type { MappedCandidate } from './map'
import {
  maxLevel,
  type AlignmentRollup,
  type AlignmentRow,
  type EvidenceSourceType,
  type Indicator,
  type Level,
} from './types'

/** Fewer than this many scored answers → attainment is "not enough data yet", not a number. */
export const MIN_QUIZ_RESPONSES = 5

interface Best {
  level: Level
  sourceType: EvidenceSourceType
  sourceId: string | null
  text: string
}

export interface ReduceInput {
  mapped: MappedCandidate[]
  indicators: Indicator[]
  outcomeCodes: string[] // ordered SO codes
  masteryBySkill: Record<string, number>
  quizResponseCount: number
  standardId: string
}

/**
 * Stage 3 — deterministic reduce. Groups matches by indicator (highest justified
 * level wins), attaches quiz attainment only to graded (Mastered, quiz-evidenced)
 * indicators with enough responses, rolls indicators up to outcomes, and detects
 * gaps. No AI — trustworthy, no hallucination. (Levels are already capped in Map.)
 */
export function reduceAlignments(input: ReduceInput): { rows: AlignmentRow[]; rollup: AlignmentRollup } {
  // Sort candidates by a stable key before reducing: when two artifacts tie on
  // level for the same indicator, the FIRST one seen keeps the representative
  // evidence — without this sort, that winner flips with DB row order.
  const sortedMapped = [...input.mapped].sort((a, b) => {
    const t = a.candidate.sourceType.localeCompare(b.candidate.sourceType)
    if (t !== 0) return t
    const ids = (a.candidate.sourceId ?? '').localeCompare(b.candidate.sourceId ?? '')
    if (ids !== 0) return ids
    return a.candidate.title.localeCompare(b.candidate.title)
  })
  const best = new Map<string, Best>()
  for (const mc of sortedMapped) {
    for (const m of mc.matches) {
      const id = m.indicator.id
      const cur = best.get(id)
      if (!cur) {
        best.set(id, { level: m.level, sourceType: mc.candidate.sourceType, sourceId: mc.candidate.sourceId, text: m.justification })
        continue
      }
      const lvl = maxLevel(cur.level, m.level)
      // If this match raises the level, its evidence becomes the representative one.
      if (lvl !== cur.level) {
        best.set(id, { level: lvl, sourceType: mc.candidate.sourceType, sourceId: mc.candidate.sourceId, text: m.justification })
      }
    }
  }

  // Coarse v1 attainment: average per-tag quiz mastery, gated on enough responses.
  const tagVals = Object.values(input.masteryBySkill)
  const overallAttainment =
    input.quizResponseCount >= MIN_QUIZ_RESPONSES && tagVals.length > 0
      ? Math.round((tagVals.reduce((a, b) => a + b, 0) / tagVals.length) * 100) / 100
      : null

  const rows: AlignmentRow[] = []
  for (const [indicatorId, b] of best) {
    const attainment = b.sourceType === 'quiz' && b.level === 'M' ? overallAttainment : null
    rows.push({
      indicator_id: indicatorId,
      level: b.level,
      evidence_source_type: b.sourceType,
      evidence_source_id: b.sourceId,
      evidence_text: b.text,
      attainment,
    })
  }

  // Rollup: gaps + per-outcome best level.
  const gaps = input.indicators.filter((ind) => !best.has(ind.id)).map((ind) => ind.code)
  const outcomeLevels: Record<string, Level | null> = {}
  for (const so of input.outcomeCodes) {
    let lvl: Level | null = null
    for (const ind of input.indicators.filter((i) => i.outcomeCode === so)) {
      const b = best.get(ind.id)
      if (b) lvl = lvl ? maxLevel(lvl, b.level) : b.level
    }
    outcomeLevels[so] = lvl
  }

  return { rows, rollup: { standardId: input.standardId, aligned: best.size, gaps, outcomeLevels } }
}

/** Deterministic one-line completion summary (feeds the job's `summary`/nudge). */
/** Human labels for evidence source types, for the "Analysed …" sentence below. */
const ARTIFACT_LABEL: Record<string, string> = {
  assignment: 'assignment',
  quiz: 'quiz',
  module_item: 'course material',
  clo: 'course learning outcome',
}

export function buildSummary(
  rollup: AlignmentRollup,
  indicators: Indicator[],
  /** How many artifacts of each kind were actually analysed, by sourceType. */
  analysedByType?: Record<string, number>,
): string {
  const covered = Object.entries(rollup.outcomeLevels).filter(([, l]) => l !== null).length
  const total = Object.keys(rollup.outcomeLevels).length
  const gapOutcomes = Object.entries(rollup.outcomeLevels)
    .filter(([, l]) => l === null)
    .map(([so]) => so)
  const gapNote =
    gapOutcomes.length > 0 ? ` No evidence for ${gapOutcomes.join(', ')}.` : ' Every outcome has some evidence.'

  /* State what WAS analysed, not just what produced no evidence (#633). This summary
     is what Athena narrates, and given only "no evidence for SO-1…" the model filled
     the gap itself — telling a professor their course "doesn't have any modules or
     assignments built out yet" on a section that has a published assignment. The
     numbers were never wrong; the absence of them is what invited the invention.
     Naming the counts leaves nothing to infer. */
  const analysed = analysedByType
    ? Object.entries(analysedByType)
        .filter(([, n]) => n > 0)
        .map(([type, n]) => `${n} ${ARTIFACT_LABEL[type] ?? type}${n === 1 ? '' : 's'}`)
        .join(', ')
    : ''
  const analysedNote = analysed
    ? ` Analysed ${analysed} — anything with no evidence was examined and did not map, rather than being absent.`
    : ''

  return `Covered ${covered} of ${total} outcomes (${rollup.aligned}/${indicators.length} indicators).${gapNote}${analysedNote}`
}
