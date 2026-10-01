/**
 * One provider's platform-level bill for one month. `source` is the
 * provenance and drives honest labeling on the Cost Analysis page:
 *  - 'billed'   — the provider's own billing data (GCP BigQuery export,
 *                 ElevenLabs invoice API): the real number.
 *  - 'plan'     — a fixed plan price; the provider has no usage/billing API
 *                 (Supabase). Exact while usage stays within included quotas.
 *  - 'computed' — our own metered count × the provider's published pricing
 *                 (Resend). Deterministic, but not provider-confirmed.
 */
export interface ProviderBill {
  provider: 'gcp' | 'elevenlabs' | 'supabase' | 'resend' | 'pinecone'
  /** 'YYYY-MM' invoice month. */
  month: string
  amountUsd: number
  source: 'billed' | 'plan' | 'computed'
  /** When the underlying data was fetched/valid. */
  asOf: string
  /** True when the connector isn't configured (env missing) — amount is 0. */
  unconfigured?: boolean
  /** Per-service / diagnostic detail for the UI. */
  detail?: Record<string, unknown>
}

export function currentMonth(): string {
  return new Date().toISOString().slice(0, 7)
}
