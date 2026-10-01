/**
 * Data access for the Cost Analysis pages (server-only). Both pages read via
 * the two aggregation RPCs (EXECUTE revoked from client roles — only the
 * service-role admin client can call them) instead of shipping raw ledger
 * rows to Node.
 */
import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'

export interface SummaryRow {
  institution_id: string | null
  category: string
  feature: string
  cost_usd: number
  calls: number
  tokens: number | null
  quantity: number | null
}

export interface DailyRow {
  day: string
  category: string
  cost_usd: number
}

/** Parse a `?month=YYYY-MM` param (falling back to the current UTC month) into
 *  [from, to) timestamps plus the canonical month string. */
export function monthRange(monthParam?: string): { month: string; from: string; to: string } {
  const now = new Date()
  const fallback = now.toISOString().slice(0, 7)
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(monthParam ?? '') ? (monthParam as string) : fallback
  const [y, m] = month.split('-').map(Number)
  const from = new Date(Date.UTC(y, m - 1, 1)).toISOString()
  const to = new Date(Date.UTC(y, m, 1)).toISOString()
  return { month, from, to }
}

export async function fetchCostSummary(from: string, to: string): Promise<SummaryRow[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any
  const { data, error } = await adminDb.rpc('cost_summary_by_institution', { p_from: from, p_to: to })
  if (error) {
    logger.error('fetchCostSummary: RPC failed', error)
    return []
  }
  return (data ?? []) as SummaryRow[]
}

export async function fetchDailySeries(from: string, to: string, institutionId?: string): Promise<DailyRow[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any
  const { data, error } = await adminDb.rpc('cost_daily_series', {
    p_from: from,
    p_to: to,
    p_institution_id: institutionId ?? null,
  })
  if (error) {
    logger.error('fetchDailySeries: RPC failed', error)
    return []
  }
  return (data ?? []) as DailyRow[]
}

/** Dollar total of external-ledger rows priced from an UNVERIFIED vendor rate
 *  (metadata.unverified_rate — e.g. Pinecone RU/WU at the published range
 *  floor). Surfaced as a banner so estimate-priced spend never renders as
 *  exact — the rate table promises the dashboard flags these. */
export async function fetchUnverifiedRateSpend(
  from: string,
  to: string,
): Promise<{ costUsd: number; rows: number }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any
  const { data, error } = await adminDb
    .from('external_usage_events')
    .select('cost_usd')
    .eq('metadata->>unverified_rate', 'true')
    .gte('created_at', from)
    .lt('created_at', to)
    .limit(50_000)
  if (error) {
    logger.error('fetchUnverifiedRateSpend: failed', error)
    return { costUsd: 0, rows: 0 }
  }
  const rows = (data ?? []) as Array<{ cost_usd: number }>
  return {
    costUsd: rows.reduce((s, r) => s + Number(r.cost_usd ?? 0), 0),
    rows: rows.length,
  }
}

/** Count of ledger rows whose model had no rate row (metadata.unpriced_model)
 *  — surfaced as a warning so a model/provider swap can't silently misprice. */
export async function fetchUnpricedCount(from: string, to: string): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any
  const { count, error } = await adminDb
    .from('ai_usage_events')
    .select('id', { count: 'exact', head: true })
    .eq('metadata->>unpriced_model', 'true')
    .gte('created_at', from)
    .lt('created_at', to)
  if (error) {
    logger.error('fetchUnpricedCount: failed', error)
    return 0
  }
  return count ?? 0
}
