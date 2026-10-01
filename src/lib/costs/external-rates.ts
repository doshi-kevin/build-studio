/**
 * External (non-LLM) usage rate table — the companion of src/lib/ai/cost.ts
 * for paid vendors billed in non-token units (audio seconds, characters,
 * emails). Cost is computed and STORED at write time (recordExternalUsage),
 * so historical ledger rows stay accurate after a rate change here.
 *
 * Rates are keyed by (provider, feature) so a vendor swap (e.g. a different
 * TTS provider) is a new row + call-site constant, never a schema change.
 * Per-unit USD, DATED — re-verify against the provider's live pricing page
 * and bump EXTERNAL_RATES_DATED when you do.
 */

export const EXTERNAL_RATES_DATED = '2026-07-30'

export interface ExternalRate {
  /** Billing unit the quantity is expressed in. */
  unit: 'audio_seconds' | 'characters' | 'emails' | 'queries' | 'read_units' | 'write_units'
  /** USD per single unit (per second / per character / per email). */
  usdPerUnit: number
  /**
   * False when the vendor's published price could not be fully verified —
   * rows priced from an unverified rate carry metadata.unverified_rate=true
   * so the dashboard can flag them instead of silently mispricing.
   */
  verified: boolean
}

export const EXTERNAL_RATES: Record<string, ExternalRate> = {
  // ElevenLabs Scribe v2 realtime — $0.39/hour (elevenlabs.io/pricing/api,
  // verified 2026-07-06). Billed per connection time, metered per second.
  'elevenlabs:live_transcription': { unit: 'audio_seconds', usdPerUnit: 0.39 / 3600, verified: true },
  // ElevenLabs Scribe v1 batch (verbal-assessment audio). Official API page
  // lists batch STT near the realtime rate; exact batch figure pending
  // reconciliation against the ElevenLabs dashboard → unverified.
  'elevenlabs:verbal_stt': { unit: 'audio_seconds', usdPerUnit: 0.4 / 3600, verified: false },
  // ElevenLabs TTS turbo/flash — $0.05 per 1k characters (verified 2026-07-06).
  'elevenlabs:primer_tts': { unit: 'characters', usdPerUnit: 0.05 / 1000, verified: true },
  'elevenlabs:verbal_tts': { unit: 'characters', usdPerUnit: 0.05 / 1000, verified: true },
  // Resend Pro — $20/mo for 50k emails → $0.0004 effective marginal per email
  // (resend.com/pricing, verified 2026-07-06). "computed" provenance: Resend
  // has no usage API; the platform bill is plan-priced, this line just makes
  // per-institution email volume comparable in dollars.
  'resend:email': { unit: 'emails', usdPerUnit: 0.0004, verified: true },
  // Google Search grounding on Gemini 3.x — $14 per 1,000 search queries
  // (ai.google.dev/gemini-api/docs/pricing, verified 2026-07-30). Billed per
  // query the model executes, NOT per grounded prompt. 5,000 queries/mo are
  // free (shared across Gemini 3.x models); we bill the marginal rate anyway —
  // same "comparable in dollars" stance as the Resend row — so per-institution
  // grounding volume is visible. The allowance, if ever modeled, belongs at
  // the bill-snapshot/reconciliation layer, never per-row (sequence-dependent
  // billing + a concurrent shared counter). NOTE: metered under provider
  // 'google' but the real charge lands on the GCP invoice — an expected
  // metered-vs-billed category asymmetry, not a reconciliation gap.
  'google:search_grounding': { unit: 'queries', usdPerUnit: 14 / 1000, verified: true },
  // Pinecone serverless (Standard). pinecone.io/pricing publishes $16–18/1M
  // RUs and $4–4.50/1M WUs varying by cloud/region with no per-region table
  // (2026-07-30) — priced at the range floor, unverified until the first bill
  // reconciliation pins gcp/us-central1 exactly. Queries return exact RUs
  // (usage.readUnits); upserts/deletes don't report WUs, so those quantities
  // are estimated from binary record size (metadata.estimated).
  'pinecone:material_query': { unit: 'read_units', usdPerUnit: 16 / 1_000_000, verified: false },
  'pinecone:material_list': { unit: 'read_units', usdPerUnit: 16 / 1_000_000, verified: false },
  'pinecone:material_upsert': { unit: 'write_units', usdPerUnit: 4 / 1_000_000, verified: false },
  'pinecone:material_delete': { unit: 'write_units', usdPerUnit: 4 / 1_000_000, verified: false },
  // Transcript vectors (N1) — same serverless WU pricing, separate line so the
  // ledger can answer "what does indexing class speech cost".
  'pinecone:transcript_upsert': { unit: 'write_units', usdPerUnit: 4 / 1_000_000, verified: false },
  'pinecone:transcript_delete': { unit: 'write_units', usdPerUnit: 4 / 1_000_000, verified: false },
}

export interface ExternalCost {
  costUsd: number
  rateVerified: boolean
}

/** USD cost for a quantity of (provider, feature) units, 6dp (numeric(12,6)). */
export function computeExternalCostUsd(
  provider: string,
  feature: string,
  quantity: number,
): ExternalCost | null {
  const rate = EXTERNAL_RATES[`${provider}:${feature}`]
  if (!rate) return null
  const cost = Math.round(quantity * rate.usdPerUnit * 1_000_000) / 1_000_000
  return { costUsd: cost, rateVerified: rate.verified }
}
