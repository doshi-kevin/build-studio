/**
 * Resend bill — COMPUTED: Resend has no usage/billing API (verified
 * 2026-07-09 against the full API reference index), so the bill is our own
 * webhook-counted sends applied to the published plan rules: plan base fee,
 * overage $0.90 per 1,000 emails past the included quota (billed in 1k
 * buckets). Deterministic, but not provider-confirmed → source: 'computed'.
 *
 * Env: RESEND_PLAN_USD (default 20 = Pro), RESEND_PLAN_INCLUDED (default 50000).
 */
import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import { currentMonth, type ProviderBill } from './types'

export async function fetchResendBill(): Promise<ProviderBill> {
  const planUsd = Number(process.env.RESEND_PLAN_USD ?? 20)
  const included = Number(process.env.RESEND_PLAN_INCLUDED ?? 50_000)
  const month = currentMonth()
  const base: ProviderBill = {
    provider: 'resend',
    month,
    amountUsd: planUsd,
    source: 'computed',
    asOf: new Date().toISOString(),
  }
  try {
    const admin = createAdminClient()
    const monthStart = `${month}-01T00:00:00Z`
    const { count, error } = await admin
      .from('external_usage_events')
      .select('id', { count: 'exact', head: true })
      .eq('provider', 'resend')
      .gte('created_at', monthStart)
    if (error) {
      logger.warn('fetchResendBill: count failed', { error: error.message })
      return { ...base, detail: { emailsSent: null, plan: planUsd } }
    }
    const sent = count ?? 0
    const overage = Math.max(0, Math.ceil((sent - included) / 1000)) * 0.9
    return {
      ...base,
      amountUsd: Math.round((planUsd + overage) * 100) / 100,
      detail: { emailsSent: sent, included, plan: planUsd, overage },
    }
  } catch (err) {
    logger.error('fetchResendBill: exception', err)
    return base
  }
}
