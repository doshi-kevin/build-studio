// The Athenamite background-jobs foundation — shared contract.
//
// A feature plugs in a *pipeline* (implements `BackgroundPipeline`) and the
// foundation owns everything else: the durable queue, the atomic claim, the
// route-kicked worker, progress plumbing, and the completion nudge. The
// contract makes ZERO assumptions about what a pipeline does (LLM, pure
// computation, external API). See docs in harshil/outcomes-alignment/.

import type { SupabaseClient } from '@supabase/supabase-js'

export type JobStatus = 'pending' | 'running' | 'done' | 'failed' | 'partial'

/** Per-sub-worker status for the live roster (blinking yellow / green / red). */
export type WorkerStatus = 'running' | 'done' | 'error'

/**
 * One entry in a job's live "Athenamite roster". Written only on DISCRETE
 * transitions (a sub-worker starts / finishes / errors) — never on a timer.
 * The client renders the blink via CSS and computes elapsed from `startedAt`.
 */
export interface ProgressEntry {
  /** Stable id for this sub-worker (e.g. an artifact id or a step label). */
  label: string
  status: WorkerStatus
  /** ISO timestamp when this sub-worker started. */
  startedAt: string
}

export interface BackgroundJobRow {
  id: string
  type: string
  params: Record<string, unknown>
  status: JobStatus
  progress: ProgressEntry[]
  result: unknown | null
  summary: string | null
  error: string | null
  institution_id: string
  section_id: string | null
  created_by: string | null
  attempts: number
  max_attempts: number
  claimed_by: string | null
  claim_expires_at: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
}

export interface PipelineContext {
  adminDb: SupabaseClient
  job: BackgroundJobRow
  /** Never aborted by the generic worker today; a pipeline that needs Stop or a time
   * limit keeps its own (the Studio builder reads its run row). */
  signal: AbortSignal
  /** When the drain running this job stops claiming work (unix ms). A pipeline that does
   * long work in steps checks it between steps and hands off before it. */
  deadline?: number
  /** Report a discrete progress transition; persisted for the live roster. */
  reportProgress: (entry: ProgressEntry) => Promise<void>
}

export interface PipelineResult {
  /** Compact rollup ONLY — the real output belongs in the feature's own tables. */
  result: unknown
  /** One-line, human-readable completion summary (feeds the nudge). */
  summary: string
}

/** A background task plugs in by implementing this; the foundation does the rest. */
export interface BackgroundPipeline {
  type: string
  /** A drain with less time left than this doesn't claim jobs of this type, so a job
   * claimed late in a drain isn't started with seconds to spare. */
  minBudgetMs?: number
  run: (params: Record<string, unknown>, ctx: PipelineContext) => Promise<PipelineResult>
  /** Optional housekeeping the kick runs before each drain (after the reaper), so work it
   * requeues is claimed by the same drain. Errors are caught and logged by the worker. */
  upkeep?: (ctx: { adminDb: SupabaseClient }) => Promise<void>
}
