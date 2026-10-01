/**
 * recordExternalUsage — append (or, for cumulative meters, upsert) one row to
 * the non-LLM paid-usage ledger (external_usage_events). The counterpart of
 * recordAiUsage for vendors billed in audio seconds / characters / emails.
 *
 * Server-only (service-role admin client is the sole writer). Never throws —
 * telemetry must never break the feature that's logging it. Call it
 * fire-and-forget (`void recordExternalUsage(...)`) so it stays off the
 * user-facing critical path.
 */

import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import { computeExternalCostUsd, EXTERNAL_RATES } from './external-rates'

export interface RecordExternalUsageParams {
  provider: string
  feature: string
  quantity: number
  /** Null/undefined ONLY for platform-level acts no tenant owns (auth emails). */
  institutionId?: string | null
  sectionId?: string | null
  userId?: string | null
  /**
   * Idempotency / cumulative-meter key. Plain events omit it. Webhook events
   * pass the provider event id (duplicate deliveries become no-ops). Cumulative
   * meters (live Scribe heartbeat) pass a per-session key: the row's quantity
   * is REPLACED with the new cumulative total on each beat.
   */
  dedupKey?: string
  metadata?: Record<string, unknown>
}

export async function recordExternalUsage(params: RecordExternalUsageParams): Promise<void> {
  try {
    const cost = computeExternalCostUsd(params.provider, params.feature, params.quantity)
    if (!cost) {
      logger.warn('recordExternalUsage: no rate for provider/feature — recording at $0', {
        provider: params.provider,
        feature: params.feature,
      })
    }
    const rate = cost ?? { costUsd: 0, rateVerified: false }
    const admin = createAdminClient()
    // Resolve institution from the section when the caller didn't have it
    // (mirrors recordAiUsage) — per-institution aggregation needs it set.
    let institutionId = params.institutionId
    if (!institutionId && params.sectionId) {
      const { data } = await admin
        .from('course_sections')
        .select('institution_id')
        .eq('id', params.sectionId)
        .single()
      institutionId = data?.institution_id ?? null
    }
    const row = {
      provider: params.provider,
      feature: params.feature,
      unit: EXTERNAL_RATES[`${params.provider}:${params.feature}`]?.unit ?? 'units',
      quantity: params.quantity,
      cost_usd: rate.costUsd,
      institution_id: institutionId ?? null,
      section_id: params.sectionId ?? null,
      user_id: params.userId ?? null,
      dedup_key: params.dedupKey ?? null,
      metadata: {
        ...(params.metadata ?? {}),
        ...(rate.rateVerified ? {} : { unverified_rate: true }),
        ...(cost ? {} : { unpriced: true }),
      },
      updated_at: new Date().toISOString(),
    }

    if (params.dedupKey) {
      // Cumulative meters replace quantity/cost on each beat; duplicate
      // webhook deliveries land on the same key and are harmlessly rewritten
      // with identical values.
      const { error } = await admin
        .from('external_usage_events')
        .upsert(row, { onConflict: 'dedup_key' })
      if (error) logger.error('recordExternalUsage: upsert failed', error, { feature: params.feature })
    } else {
      const { error } = await admin.from('external_usage_events').insert(row)
      if (error) logger.error('recordExternalUsage: insert failed', error, { feature: params.feature })
    }
  } catch (error) {
    logger.error('recordExternalUsage: exception', error, { feature: params.feature })
  }
}
