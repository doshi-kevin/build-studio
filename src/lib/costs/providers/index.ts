/**
 * Fetch all platform provider bills and persist them into
 * provider_bill_snapshots (upsert on provider+month). Snapshots matter
 * because ElevenLabs/Supabase APIs only expose the CURRENT billing cycle —
 * without persisting, history is lost at each cycle reset. Reads then return
 * snapshots, so past months keep rendering even when a connector is down.
 */
import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import { fetchGcpBills } from './gcp'
import { fetchElevenLabsBill } from './elevenlabs'
import { fetchSupabaseBill } from './supabase'
import { fetchResendBill } from './resend'
import { fetchPineconeBill } from './pinecone'
import type { ProviderBill } from './types'

export type { ProviderBill } from './types'

/** Live-fetch every provider, snapshot configured results, return the merged
 *  view (snapshots for months the live fetch didn't cover). */
export async function getProviderBills(): Promise<ProviderBill[]> {
  const [gcp, elevenlabs, supabase, resend, pinecone] = await Promise.all([
    fetchGcpBills(),
    fetchElevenLabsBill(),
    fetchSupabaseBill(),
    fetchResendBill(),
    fetchPineconeBill(),
  ])
  const live = [...gcp, elevenlabs, supabase, resend, pinecone]

  const admin = createAdminClient()
  const configured = live.filter((b) => !b.unconfigured)
  if (configured.length > 0) {
    const { error } = await admin.from('provider_bill_snapshots').upsert(
      configured.map((b) => ({
        provider: b.provider,
        month: b.month,
        amount_usd: b.amountUsd,
        source: b.source,
        as_of: b.asOf,
        metadata: b.detail ?? {},
      })),
      { onConflict: 'provider,month' },
    )
    if (error) logger.error('getProviderBills: snapshot upsert failed', error)
  }

  // Merge in snapshot months the live fetch didn't return (history).
  const seen = new Set(live.map((b) => `${b.provider}:${b.month}`))
  const { data: snaps } = await admin
    .from('provider_bill_snapshots')
    .select('provider, month, amount_usd, source, as_of, metadata')
    .order('month', { ascending: false })
    .limit(60)
  for (const s of snaps ?? []) {
    if (seen.has(`${s.provider}:${s.month}`)) continue
    live.push({
      provider: s.provider,
      month: s.month,
      amountUsd: Number(s.amount_usd),
      source: s.source,
      asOf: s.as_of,
      detail: (s.metadata ?? {}) as Record<string, unknown>,
    })
  }
  return live
}
