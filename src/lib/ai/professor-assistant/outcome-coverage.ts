/**
 * Outcome-coverage loader for the professor AI assistant.
 *
 * Server-only. Called from the /api/professor-assistant route (which already
 * authenticated the caller + verified section access) with the admin client.
 * Read-only and section-scoped. Reads the ABET reference tables + the section's
 * persisted alignments (written by the background pipeline) and rolls them up
 * into ONE compact object that (a) renders as the OutcomeCoverageCard and (b) is
 * persisted in athena_messages so Athena keeps the findings in context for the
 * whole conversation. Degrades to an empty rollup rather than throwing.
 */

import 'server-only'
import { logger } from '@/lib/logger'
import { UNCHANGED_NOTICE } from '@/lib/jobs/pipelines/outcome-alignment/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminDb = any

type Level = 'I' | 'R' | 'M'
const LEVEL_RANK: Record<Level, number> = { I: 1, R: 2, M: 3 }

export interface CoverageIndicator {
  code: string
  description: string
  /** null = no supporting evidence found in the course (a gap). */
  level: Level | null
  evidence: string | null
  attainment: number | null
}
export interface CoverageOutcome {
  code: string
  name: string
  /** Highest level reached across this outcome's covered indicators; null = full gap. */
  bestLevel: Level | null
  covered: number
  total: number
  indicators: CoverageIndicator[]
}
/**
 * What the numbers below ARE. Deliberately says nothing about current activity.
 *
 *  - `never_run`: no analysis has completed for this section. Every count is zero because
 *    nothing was MEASURED, not because the course covers nothing. The two read as
 *    identical in the payload, which is why this field exists.
 *  - `ready`: the numbers are the result of a completed analysis.
 *
 * "A run is happening right now" is a SEPARATE fact (`runInFlight`) because the two are
 * orthogonal and folding them into one enum got the important case backwards: a professor's
 * FIRST analysis is both never-run and in-flight, and when in-flight won, the payload said
 * `running`, every never_run guard downstream missed it, and the card drew a full
 * "0 of 19 covered, all seven a Gap" report for a course that had simply never been
 * measured. That is the precise misreport this whole field exists to prevent, surfacing in
 * the moment a professor is most likely to look.
 */
export type AnalysisState = 'never_run' | 'ready'

export interface OutcomeCoverage {
  /** The ABET reference data is seeded and readable. Says nothing about this course. */
  available: boolean
  standard: string | null
  analysisState: AnalysisState
  /** An analysis is running right now. Orthogonal to `analysisState`: both can be true on a
   *  professor's very first run, and the numbers are still unmeasured while it goes. */
  runInFlight: boolean
  /** When the mapping behind these numbers was computed. Null when nothing has run. */
  lastAnalyzedAt: string | null
  /** The pipeline's own one-line summary of the last run, with its re-run notice stripped. */
  lastSummary: string | null
  overall: {
    outcomesCovered: number
    outcomesTotal: number
    indicatorsCovered: number
    indicatorsTotal: number
    gapCount: number
  }
  outcomes: CoverageOutcome[]
  /** Outcome codes with zero covered indicators — the headline gaps. Always empty when
   *  `analysisState` is `never_run`: an unmeasured course has no KNOWN gaps, and emitting
   *  all seven here invited "your course covers none of the ABET outcomes". */
  gapOutcomes: string[]
}

const EMPTY: OutcomeCoverage = {
  available: false,
  standard: null,
  analysisState: 'never_run',
  runInFlight: false,
  lastAnalyzedAt: null,
  lastSummary: null,
  overall: { outcomesCovered: 0, outcomesTotal: 0, indicatorsCovered: 0, indicatorsTotal: 0, gapCount: 0 },
  outcomes: [],
  gapOutcomes: [],
}

function bestOf(levels: Level[]): Level | null {
  if (levels.length === 0) return null
  return levels.reduce((a, b) => (LEVEL_RANK[b] > LEVEL_RANK[a] ? b : a))
}

/**
 * Strip the pipeline's re-run notice off a stored summary.
 *
 * A run that finds nothing changed prepends UNCHANGED_NOTICE to the previous summary and
 * stores the result. That sentence is addressed to someone who just asked for a re-run. On
 * every other surface it opens the answer with "No changes since the last analysis" to a
 * professor who asked a plain question and never requested one, so it comes off here and
 * the age is carried by lastAnalyzedAt instead.
 */
function cleanSummary(summary: string | null): string | null {
  if (!summary) return null
  const stripped = summary.split(UNCHANGED_NOTICE).join(' ').replace(/\s+/g, ' ').trim()
  return stripped || null
}

export async function loadOutcomeCoverage(adminDb: AdminDb, sectionId: string): Promise<OutcomeCoverage> {
  try {
    const { data: std } = await adminDb
      .from('accreditation_standards')
      .select('id, name, version')
      .eq('name', 'ABET Engineering')
      .eq('version', 'EAC 2025-2026')
      .is('institution_id', null)
      .maybeSingle()
    if (!std) return EMPTY

    const { data: outs } = await adminDb
      .from('accreditation_outcomes')
      .select('id, code, name, order_index, accreditation_indicators(id, code, description, order_index)')
      .eq('standard_id', std.id)
      .order('order_index')

    /* Jobs BEFORE alignments, deliberately. These are two reads against a table the worker
       is writing, and the worker persists alignment rows first and marks the job done
       second. Reading the job first means any rows read afterwards are at least as fresh as
       the status observed — so a 'done' can never be paired with rows from before that run.
       The reverse order allowed exactly that: stale coverage stamped with the new run's
       date and summary.
       One query, four questions: has anything ever completed, is a run in flight, when was
       the mapping produced, and what did the pipeline say about it. Failed rows are filtered
       out rather than fetched and discarded, so a burst of failures cannot push the last
       good run out of the window. The window cannot be starved by queued work either: the
       partial unique index uq_background_jobs_active permits at most ONE pending-or-running
       row per (institution, section, type). */
    const { data: jobRows } = await adminDb
      .from('background_jobs')
      .select('status, summary, completed_at, result')
      .eq('section_id', sectionId)
      .eq('type', 'outcome_alignment')
      .in('status', ['pending', 'running', 'done'])
      .order('created_at', { ascending: false })
      .limit(10)

    type JobRow = {
      status: string
      summary: string | null
      completed_at: string | null
      result: { analyzedAt?: string } | null
    }
    const jobs = (jobRows ?? []) as JobRow[]
    const runInFlight = jobs.some((j) => j.status === 'pending' || j.status === 'running')
    const lastDone = jobs.find((j) => j.status === 'done') ?? null

    const { data: al } = await adminDb
      .from('course_outcome_alignments')
      .select('indicator_id, level, evidence_text, attainment, source')
      .eq('section_id', sectionId)

    /* AI rows are the fallback proof that an analysis once ran: the job window is bounded,
       so a section analysed long enough ago can age out of it while its persisted rows
       remain. Trusting those keeps that course out of the never-run branch.
       It must be source='ai' specifically. A professor can enter alignments BY HAND, and
       counting one of those as proof would report a section with a single manual indicator
       as fully analysed — then present every other indicator as a measured gap, which is
       the exact misrepresentation this state exists to prevent. */
    const hasEverCompleted =
      lastDone !== null ||
      ((al ?? []) as Array<{ source?: string }>).some((a) => a.source === 'ai')

    const byIndicator = new Map(
      ((al ?? []) as Array<{ indicator_id: string; level: Level; evidence_text: string | null; attainment: number | null }>).map((a) => [a.indicator_id, a]),
    )

    let indicatorsCovered = 0
    let indicatorsTotal = 0
    const outcomes: CoverageOutcome[] = (
      (outs ?? []) as Array<{ id: string; code: string; name: string; accreditation_indicators: Array<{ id: string; code: string; description: string; order_index: number }> }>
    ).map((o) => {
      const inds = [...(o.accreditation_indicators ?? [])].sort((a, b) => a.order_index - b.order_index)
      const indicators: CoverageIndicator[] = inds.map((i) => {
        const a = byIndicator.get(i.id)
        indicatorsTotal += 1
        if (a) indicatorsCovered += 1
        return {
          code: i.code,
          description: i.description,
          level: a ? a.level : null,
          evidence: a?.evidence_text ?? null,
          attainment: a?.attainment ?? null,
        }
      })
      const covered = indicators.filter((i) => i.level).length
      return {
        code: o.code,
        name: o.name,
        bestLevel: bestOf(indicators.map((i) => i.level).filter(Boolean) as Level[]),
        covered,
        total: indicators.length,
        indicators,
      }
    })

    const outcomesCovered = outcomes.filter((o) => o.covered > 0).length
    /* Only what the numbers ARE. Activity is reported separately, so a first run in flight
       stays `never_run` and every downstream guard still fires. */
    const analysisState: AnalysisState = hasEverCompleted ? 'ready' : 'never_run'

    return {
      available: true,
      standard: `${std.name} · ${std.version}`,
      analysisState,
      runInFlight,
      /* The rollup's own stamp first. The job row's completed_at is when the fingerprint
         was last CHECKED, and a re-run that changed nothing gets a fresh one while still
         carrying an older mapping. Older rollups predate the stamp, so fall back. */
      lastAnalyzedAt: hasEverCompleted
        ? (lastDone?.result?.analyzedAt ?? lastDone?.completed_at ?? null)
        : null,
      lastSummary: hasEverCompleted ? cleanSummary(lastDone?.summary ?? null) : null,
      overall: {
        outcomesCovered,
        outcomesTotal: outcomes.length,
        indicatorsCovered,
        indicatorsTotal,
        // Nothing measured means no KNOWN gaps, not nineteen of them.
        gapCount: hasEverCompleted ? indicatorsTotal - indicatorsCovered : 0,
      },
      outcomes,
      gapOutcomes: hasEverCompleted
        ? outcomes.filter((o) => o.covered === 0).map((o) => o.code)
        : [],
    }
  } catch (err) {
    logger.error('loadOutcomeCoverage failed', err instanceof Error ? err : new Error(String(err)), { sectionId })
    return EMPTY
  }
}
