/**
 * Supabase bill — HONEST CEILING: Supabase exposes NO billing/usage API
 * (verified 2026-07-09 against the live Management-API OpenAPI spec; invoices
 * and org usage are dashboard-only). What IS deterministic: the plan's fixed
 * price plus any project addons (retrievable via the Management API when
 * SUPABASE_MGMT_TOKEN is set). With the spend cap on / usage within included
 * quotas — true today — plan price IS the exact bill; past quota, real
 * overages will NOT appear here, which the UI labels via source: 'plan'.
 *
 * Env: SUPABASE_PLAN_USD (default 25 = Pro), optionally SUPABASE_MGMT_TOKEN +
 * SUPABASE_PROJECT_REF for addon line items.
 */
import 'server-only'
import { logger } from '@/lib/logger'
import { currentMonth, type ProviderBill } from './types'

export async function fetchSupabaseBill(): Promise<ProviderBill> {
  const planUsd = Number(process.env.SUPABASE_PLAN_USD ?? 25)
  const base: ProviderBill = {
    provider: 'supabase',
    month: currentMonth(),
    amountUsd: planUsd,
    source: 'plan',
    asOf: new Date().toISOString(),
    detail: { plan: planUsd },
  }
  const token = process.env.SUPABASE_MGMT_TOKEN
  const ref = process.env.SUPABASE_PROJECT_REF
  if (!token || !ref) return base
  try {
    const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/billing/addons`, {
      headers: { Authorization: `Bearer ${token}` },
      next: { revalidate: 3600 },
    })
    if (!res.ok) {
      logger.warn('fetchSupabaseBill: addons fetch failed', { status: res.status })
      return base
    }
    const data = (await res.json()) as {
      selected_addons?: Array<{ type?: string; variant?: { name?: string; price?: { amount?: number } } }>
    }
    const addons = (data.selected_addons ?? []).map((a) => ({
      type: a.type ?? 'addon',
      name: a.variant?.name ?? '',
      amount: Number(a.variant?.price?.amount ?? 0),
    }))
    const addonTotal = addons.reduce((s, a) => s + a.amount, 0)
    return {
      ...base,
      amountUsd: Math.round((planUsd + addonTotal) * 100) / 100,
      detail: { plan: planUsd, addons },
    }
  } catch (err) {
    logger.error('fetchSupabaseBill: exception', err)
    return base
  }
}
