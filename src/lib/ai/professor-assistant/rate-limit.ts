/**
 * Athena per-model daily rate limiting — server-side enforcement (Issue #268).
 *
 * Counters are keyed per (institution, user, SCOPE, model), where a scope is one
 * Athena surface — console / assignment / quiz / grade. Each surface therefore has
 * its OWN pool at the same caps, so draining one never locks the others. Every
 * function here takes the scope explicitly; nothing infers or defaults it.
 *
 * Authoritative; the client never decides. Two pieces:
 *  - reserveAthenaSlot: atomically claim one accepted-request slot for the
 *    professor's preferred model, failing over through the registry's ordered
 *    candidates when a model is at its cap. Only the model that ACCEPTS is ever
 *    incremented — the increment is a single guarded statement (the
 *    athena_increment_rate_limit RPC), so two concurrent sends can never both
 *    push a model past its cap.
 *  - getAthenaUsageStatus: read-only per-model usage for the usage UI.
 *
 * Provider-agnostic: everything iterates ATHENA_MODELS / reads AthenaModelDef
 * fields — no branching on a literal model id or provider. The caps and window
 * come from the registry (models.ts); nothing is hardcoded here.
 */

import 'server-only'
import { logger } from '@/lib/logger'
import {
  ATHENA_MODELS,
  ATHENA_RATE_LIMIT_WINDOW_HOURS,
  computeModelUsage,
  failoverCandidates,
  type AthenaLimitScope,
  type AthenaModelDef,
  type AthenaModelId,
  type AthenaUsageStatus,
} from './models'

// The admin Supabase client is intentionally loosely typed across the codebase
// (section-access.ts does the same) — the generated types don't cover our RPCs.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminDb = any

interface ReserveParams {
  institutionId: string
  userId: string
  /** Default true. False = cap means refuse, never spend on the pricier fallback. */
  allowFailover?: boolean
  /**
   * Which surface's pool to draw from. REQUIRED on purpose — a default would let
   * a future caller silently pool into `console` instead of forcing the decision
   * at the call site. Callers must derive it server-side, never from the client.
   */
  scope: AthenaLimitScope
  preferredModelId: AthenaModelId
}

export type ReserveResult =
  | { accepted: true; modelDef: AthenaModelDef }
  | { accepted: false; resetsAt: string | null }

/**
 * Reserve one slot, failing over through the ordered candidate list. Returns the
 * model that actually accepted (may differ from the preferred one), or a rejected
 * result with resets_at when every model is exhausted.
 */
export async function reserveAthenaSlot(db: AdminDb, params: ReserveParams): Promise<ReserveResult> {
  /* Failover walks to the next registry model when the preferred one is capped.
     A surface can opt out: for the STUDENT tutor the fallback is Pro, ~6x the
     latency and materially dearer per call, and at pilot scale that tail is the
     very cost this cap exists to bound. Refusing is the honest answer there. */
  const candidates = params.allowFailover === false
    ? failoverCandidates(params.preferredModelId).slice(0, 1)
    : failoverCandidates(params.preferredModelId)
  for (const def of candidates) {
    const { data, error } = await db.rpc('athena_increment_rate_limit', {
      p_institution_id: params.institutionId,
      p_user_id: params.userId,
      p_scope: params.scope,
      p_model_id: def.id,
      p_cap: def.dailyCap,
      p_window_hours: ATHENA_RATE_LIMIT_WINDOW_HOURS,
    })

    if (error) {
      // Fail OPEN on an enforcement-layer error: a counter glitch must never take
      // Athena down for the professor. The cost ledger still records real spend.
      logger.error('reserveAthenaSlot: increment rpc failed', error, { modelId: def.id })
      return { accepted: true, modelDef: def }
    }

    // RPC returns table rows; supabase-js surfaces them as an array.
    const row = Array.isArray(data) ? data[0] : data
    if (row?.accepted) return { accepted: true, modelDef: def }
    // Not accepted → this model is at cap; fall over to the next candidate.
  }

  // Every model is exhausted. Surface when the soonest one frees up.
  const status = await getAthenaUsageStatus(db, params)
  return { accepted: false, resetsAt: status.resets_at }
}

/**
 * Read-only per-model usage for the current rolling window. A row whose window
 * has lapsed reports 0 used (the limit resets implicitly — no cron). resets_at
 * is the earliest window expiry among EXHAUSTED models (when Send re-enables).
 */
export async function getAthenaUsageStatus(
  db: AdminDb,
  params: { institutionId: string; userId: string; scope: AthenaLimitScope },
): Promise<AthenaUsageStatus> {
  const { data, error } = await db
    .from('athena_rate_limits')
    .select('model_id, request_count, window_start')
    .eq('institution_id', params.institutionId)
    .eq('user_id', params.userId)
    .eq('scope', params.scope)

  if (error) logger.error('getAthenaUsageStatus: query failed', error)

  const rows: Array<{ model_id: string; request_count: number; window_start: string }> = data ?? []
  const now = Date.now()
  const windowMs = ATHENA_RATE_LIMIT_WINDOW_HOURS * 3_600_000

  let earliestReset: number | null = null
  const models = ATHENA_MODELS.map((def) => {
    const row = rows.find((r) => r.model_id === def.id)
    let used = 0
    if (row) {
      const start = new Date(row.window_start).getTime()
      const lapsed = now - start >= windowMs
      used = lapsed ? 0 : row.request_count
      if (!lapsed && used >= def.dailyCap) {
        const reset = start + windowMs
        if (earliestReset === null || reset < earliestReset) earliestReset = reset
      }
    }
    return computeModelUsage(def, used)
  })

  return { models, resets_at: earliestReset === null ? null : new Date(earliestReset).toISOString() }
}
