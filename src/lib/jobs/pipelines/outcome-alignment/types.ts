import { z } from 'zod'

// The outcome_alignment pipeline's internal types + the LLM output schema.
// See harshil/outcomes-alignment/outcome-alignment-pipeline.md.

export type Level = 'I' | 'R' | 'M'

export function levelRank(l: Level): number {
  return l === 'M' ? 3 : l === 'R' ? 2 : 1
}
/** The higher of two levels. */
export function maxLevel(a: Level, b: Level): Level {
  return levelRank(a) >= levelRank(b) ? a : b
}
/** Clamp a level so it never exceeds `cap` (enforces "lectures cap at Reinforced"). */
export function capLevel(l: Level, cap: Level): Level {
  return levelRank(l) <= levelRank(cap) ? l : cap
}

/* 'module' is the module ITSELF — its title and description — as distinct from
   'module_item', which is one piece of material inside it. Added for #631: the gather step
   read only modules.id, so a module's own description was never a map input and editing it
   could not invalidate the analysis cache. */
export type EvidenceSourceType = 'clo' | 'assignment' | 'quiz' | 'module_item' | 'module'

export interface Indicator {
  id: string
  code: string // 'PI 1.1'
  description: string
  outcomeCode: string // 'SO-1'
}

/** A normalized unit the Map step reasons over. */
export interface EvidenceCandidate {
  sourceType: EvidenceSourceType
  sourceId: string | null // real artifact id; null for the section-level quiz aggregate
  title: string
  /** The distilled text handed to the LLM (summary/tags/instructions — not raw files). */
  signal: string
  /** Max level this artifact type can justify. Lecture & CLO cap at 'R'; graded work can reach 'M'. */
  cap: Level
}

/** One indicator match the LLM proposes for a candidate. */
export const mapOutputSchema = z.object({
  matches: z.array(
    z.object({
      indicatorCode: z.string(),
      level: z.enum(['I', 'R', 'M']),
      justification: z.string(),
      confidence: z.enum(['low', 'medium', 'high']),
    }),
  ),
})
export type MapMatch = z.infer<typeof mapOutputSchema>['matches'][number]

/** A reduced, ready-to-persist alignment row (before the persist RPC). */
export interface AlignmentRow {
  indicator_id: string
  level: Level
  evidence_source_type: EvidenceSourceType
  evidence_source_id: string | null
  evidence_text: string
  attainment: number | null
}

/** The compact rollup returned as the job's `result` (real rows go to the DB). */
export interface AlignmentRollup {
  standardId: string
  aligned: number // indicators with at least one match
  gaps: string[] // indicator codes with no evidence
  outcomeLevels: Record<string, Level | null> // SO-code → best level (null = gap)
  /** Fingerprint of the gathered course content — compared across runs to detect "nothing changed". */
  contentHash?: string
  /** Fingerprint of the quiz-mastery inputs (changes as students submit). */
  attainmentHash?: string
  /**
   * When the mapping in this rollup was actually computed, ISO-8601.
   *
   * NOT the same as the job's `completed_at`. An early abort returns the previous rollup
   * verbatim on a brand-new job row, so that row's `completed_at` is when we last CHECKED
   * the fingerprint, while this is when the LLM last read the course. Reporting
   * `completed_at` as the analysis age would tell a professor their September re-check was
   * a fresh September analysis of a mapping produced in January. Carried forward untouched
   * by the abort branch precisely because it travels inside the rollup.
   *
   * Optional: rollups written before this field existed have none, and readers fall back
   * to `completed_at` for those.
   */
  analyzedAt?: string
}

/**
 * The early-abort notice, prefixed to the summary when a re-run finds nothing changed.
 *
 * Lives here rather than in the pipeline because readers outside the pipeline need to
 * strip it: the persisted summary is quoted on Athena surfaces that never saw the run, and
 * "No changes since the last analysis" as an opening line is meaningless to someone who
 * just asked a fresh question on a different screen.
 */
export const UNCHANGED_NOTICE = 'No changes since the last analysis — the report is unchanged.'
