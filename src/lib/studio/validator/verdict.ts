/**
 * How check results become a stage's status, and how runs become a version's verdict.
 * Pure: the database is read elsewhere and passed in.
 *
 * A version may reach students only when, for its exact stored artifact hash, both a
 * static run and a runtime run passed (or every review on them was approved), at a
 * ruleset at or above the minimum. Anything failed, under review, errored, missing,
 * stale or mismatched blocks. There is no partial or best-effort pass.
 */
import { checkDefinition, type CheckStage } from './ruleset'
import type { CheckStatus } from './static-checks'

export type RunStatus = 'pending' | 'running' | 'passed' | 'failed' | 'needs_review' | 'error'

/** One stage's status from its checks. Warnings never block; a required check that
 * didn't produce a result is an error, never a pass. */
export function stageStatus(results: { checkId: string; status: CheckStatus }[], stage: CheckStage, required: readonly string[]): RunStatus {
  const byId = new Map(results.map((r) => [r.checkId, r.status]))
  let review = false
  let error = false
  for (const id of required) {
    const status = byId.get(id)
    const def = checkDefinition(id)
    if (!def || def.stage !== stage) return 'error'
    if (status === 'failed') return 'failed'
    if (status === 'needs_review') {
      if (!def.reviewable) return 'failed'
      review = true
    }
    if (status === undefined || status === 'error') error = true
  }
  // Skipped only happens beside a failure; on its own it means a check couldn't run.
  for (const id of required) if (byId.get(id) === 'skipped') error = true
  if (error) return 'error'
  return review ? 'needs_review' : 'passed'
}

export interface RunRow {
  id: string
  stage: CheckStage
  status: RunStatus
  artifactSha256: string
  rulesetVersion: number
  createdAt: string
}

export interface ReviewRow {
  validationId: string
  checkId: string
  decision: 'approved' | 'rejected'
}

export type VersionVerdict =
  | { status: 'passed'; staticRunId: string; runtimeRunId: string; rulesetVersion: number }
  | { status: 'failed'; reason: 'artifact_mismatch' | 'static_failed' | 'runtime_failed' | 'review_rejected' }
  | { status: 'needs_review'; runId: string; checkIds: string[] }
  | {
      status: 'unavailable'
      reason: 'not_checked' | 'checking' | 'validator_error' | 'runtime_not_checked' | 'runtime_error' | 'below_minimum_ruleset' | 'settings_unavailable'
    }

export interface VerdictInput {
  /** The artifact hash stored on the version, and the one recomputed from its content now. */
  storedHash: string | null
  recomputedHash: string
  runs: RunRow[]
  /** needs_review checks of each run, by run id. */
  reviewChecks: Record<string, string[]>
  reviews: ReviewRow[]
  /** Null when the settings can't be read: fail closed. */
  minRuleset: number | null
}

/** The run that counts for one stage: same artifact, ruleset at or above the minimum,
 * highest ruleset first, then newest. */
function pick(runs: RunRow[], stage: CheckStage, hash: string, min: number): RunRow | undefined {
  return runs
    .filter((r) => r.stage === stage && r.artifactSha256 === hash && r.rulesetVersion >= min)
    .sort((a, b) => b.rulesetVersion - a.rulesetVersion || b.createdAt.localeCompare(a.createdAt))[0]
}

/** A run's effective status once reviews are applied. */
function effective(run: RunRow, input: VerdictInput): { status: RunStatus | 'rejected'; pending: string[] } {
  if (run.status !== 'needs_review') return { status: run.status, pending: [] }
  const waiting = input.reviewChecks[run.id] ?? []
  const decided = new Map(input.reviews.filter((r) => r.validationId === run.id).map((r) => [r.checkId, r.decision]))
  if (waiting.length === 0) return { status: 'error', pending: [] }
  if (waiting.some((id) => decided.get(id) === 'rejected')) return { status: 'rejected', pending: [] }
  const pending = waiting.filter((id) => decided.get(id) !== 'approved')
  return pending.length === 0 ? { status: 'passed', pending } : { status: 'needs_review', pending }
}

export function versionVerdict(input: VerdictInput): VersionVerdict {
  if (input.minRuleset === null) return { status: 'unavailable', reason: 'settings_unavailable' }
  if (input.storedHash === null || input.storedHash !== input.recomputedHash) return { status: 'failed', reason: 'artifact_mismatch' }
  const hash = input.storedHash

  const anyAtAll = input.runs.some((r) => r.stage === 'static' && r.artifactSha256 === hash)
  const staticRun = pick(input.runs, 'static', hash, input.minRuleset)
  if (!staticRun) return { status: 'unavailable', reason: anyAtAll ? 'below_minimum_ruleset' : 'not_checked' }

  const s = effective(staticRun, input)
  if (s.status === 'pending' || s.status === 'running') return { status: 'unavailable', reason: 'checking' }
  if (s.status === 'error') return { status: 'unavailable', reason: 'validator_error' }
  if (s.status === 'failed') return { status: 'failed', reason: 'static_failed' }
  if (s.status === 'rejected') return { status: 'failed', reason: 'review_rejected' }
  if (s.status === 'needs_review') return { status: 'needs_review', runId: staticRun.id, checkIds: s.pending }

  // The runtime run must be at least as new a ruleset as the static run it follows.
  const runtimeRun = pick(input.runs, 'runtime', hash, Math.max(input.minRuleset, staticRun.rulesetVersion))
  if (!runtimeRun) return { status: 'unavailable', reason: 'runtime_not_checked' }
  const r = effective(runtimeRun, input)
  if (r.status === 'pending' || r.status === 'running') return { status: 'unavailable', reason: 'checking' }
  if (r.status === 'error') return { status: 'unavailable', reason: 'runtime_error' }
  if (r.status === 'failed' || r.status === 'rejected') return { status: 'failed', reason: 'runtime_failed' }
  if (r.status === 'needs_review') return { status: 'needs_review', runId: runtimeRun.id, checkIds: r.pending }

  return { status: 'passed', staticRunId: staticRun.id, runtimeRunId: runtimeRun.id, rulesetVersion: staticRun.rulesetVersion }
}
