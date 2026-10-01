/**
 * Pinecone bill — COMPUTED with a plan floor: Pinecone exposes no invoice API
 * (2026-07-30), so the bill is our own metered RU/WU spend (external_usage_events,
 * priced from external-rates.ts) with the Standard plan's $50/month usage
 * minimum applied — we pay the floor even when usage is below it. Deterministic,
 * but not provider-confirmed → source: 'computed'. Storage GB/month is NOT
 * metered per-op (no exact per-tenant measure), so past the floor this can
 * under-state the real invoice — reconcile against the Pinecone dashboard.
 *
 * Env: PINECONE_PLAN_MINIMUM_USD (default 50 = Standard).
 */
import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import { currentMonth, type ProviderBill } from './types'

export async function fetchPineconeBill(): Promise<ProviderBill> {
  // Guard the parse: a typo'd env var must not write a NaN bill snapshot
  // (JSON.stringify(NaN) → null — the dashboard would silently lose the line).
  const parsed = Number(process.env.PINECONE_PLAN_MINIMUM_USD)
  const minimumUsd = Number.isFinite(parsed) && parsed >= 0 ? parsed : 50
  if (process.env.PINECONE_PLAN_MINIMUM_USD !== undefined && minimumUsd !== parsed) {
    logger.warn('fetchPineconeBill: PINECONE_PLAN_MINIMUM_USD is not a number — using $50 default')
  }
  const month = currentMonth()
  const base: ProviderBill = {
    provider: 'pinecone',
    month,
    amountUsd: minimumUsd,
    source: 'computed',
    asOf: new Date().toISOString(),
  }
  try {
    const admin = createAdminClient()
    const monthStart = `${month}-01T00:00:00Z`
    const { data, error, count } = await admin
      .from('external_usage_events')
      .select('cost_usd', { count: 'exact' })
      .eq('provider', 'pinecone')
      .gte('created_at', monthStart)
      .limit(50_000)
    if (error) {
      logger.warn('fetchPineconeBill: usage read failed', { error: error.message })
      return { ...base, detail: { meteredUsd: null, minimum: minimumUsd } }
    }
    // A truncated read must never quietly under-state the bill — flag it so
    // the dashboard's provenance stays honest (and it's the cue to move this
    // to a sum() RPC once volume gets there).
    const rows = data ?? []
    const truncated = (count ?? rows.length) > rows.length
    if (truncated) {
      logger.warn('fetchPineconeBill: usage rows truncated at 50k — computed bill under-states', {
        count,
      })
    }
    const meteredUsd = rows.reduce((s, r) => s + Number(r.cost_usd ?? 0), 0)
    return {
      ...base,
      amountUsd: Math.round(Math.max(minimumUsd, meteredUsd) * 100) / 100,
      detail: {
        meteredUsd: Math.round(meteredUsd * 10_000) / 10_000,
        minimum: minimumUsd,
        ...(truncated ? { truncated: true } : {}),
      },
    }
  } catch (err) {
    logger.error('fetchPineconeBill: exception', err)
    return base
  }
}
