/**
 * AI cost rate table + cost computation, shared by every AI feature.
 *
 * Per-MTok USD rates, DATED — provider pricing changes often, so re-verify
 * against the provider's live pricing page and bump RATES_DATED when you do.
 * Cost is computed and STORED at write time (see recordAiUsage), so historical
 * ledger rows stay accurate even after a rate change here.
 */

export interface ModelRate {
  inputPerMTok: number
  cachedInputPerMTok: number
  outputPerMTok: number
  /** Image-input rate for multimodal models that bill images at their own
   *  per-token rate (gemini-embedding-2: text $0.20/MTok, images $0.45/MTok).
   *  Omit for text-only models. */
  imageInputPerMTok?: number
  /** Flat per-CALL price for models billed by request rather than by token
   *  (hosted rerank: a flat rate per query regardless of how many documents it
   *  ranks or how long they are). Omit for token-billed models. */
  perRequestUsd?: number
}

export const RATES_DATED = '2026-07-30'

// Keyed by the exact model id passed to the provider. Add a row per model as
// new AI features adopt new models. Unknown models fall back to FALLBACK_RATE.
export const MODEL_RATES_USD: Record<string, ModelRate> = {
  // Google Gemini — used across Scholera AI features (quiz gen, tutor, assistant…)
  // Verified against Google's live pricing 2026-07-06: $0.50/$3.00 per MTok
  // in/out, cached = 10% of input. (Previous $0.30/$2.50 row was stale and
  // under-reported Flash input spend ~40%.)
  'gemini-3-flash-preview': { inputPerMTok: 0.5, cachedInputPerMTok: 0.05, outputPerMTok: 3.0 },
  // Athena's Pro model. Without its own row it fell back to the Flash rate and
  // under-reported spend ~5.5×. Verified against Google's live pricing:
  // $2/$12 per MTok in/out, cached = 10% of input. These are the ≤200k-prompt
  // rates; prompts >200k tokens bill at $4/$18 (not modeled — Athena prompts
  // stay well under 200k).
  'gemini-3.1-pro-preview': { inputPerMTok: 2.0, cachedInputPerMTok: 0.2, outputPerMTok: 12.0 },
  // Roadmap node checks. Verified against Google's live pricing 2026-07-30:
  // $0.25/$1.50 per MTok in/out, cached = 10% of input. Was silently falling
  // back to Flash rates (2× over-report on input, 2× on output).
  'gemini-3.1-flash-lite-preview': { inputPerMTok: 0.25, cachedInputPerMTok: 0.025, outputPerMTok: 1.5 },
  // Embedding models bill input tokens only — the returned vector is free.
  // Retained for historical ledger rows: nothing calls 001 since the pgvector
  // layer was retired (#435) and quiz dedup moved to gemini-embedding-2, but
  // rows written before that must still recompute to the price they were
  // charged at. Verified 2026-07-30: $0.15/MTok.
  'gemini-embedding-001': { inputPerMTok: 0.15, cachedInputPerMTok: 0, outputPerMTok: 0 },
  // Pinecone materials index + search queries (multimodal: page image + text).
  // Verified 2026-07-30: $0.20/MTok text, $0.45/MTok images (~258 tok/image).
  'gemini-embedding-2': { inputPerMTok: 0.2, cachedInputPerMTok: 0, outputPerMTok: 0, imageInputPerMTok: 0.45 },
  // Vertex AI Ranking API cross-encoder (student-qa-v1 rerank). Billed per
  // REQUEST, not per token: $1 per 1,000 queries, where one query covers up to
  // 100 documents — our pool is 40, so a message is one unit at $0.001 no
  // matter how many pages it ranks. Half Pinecone's $2/1k for the same job.
  'semantic-ranker-default-004': {
    inputPerMTok: 0,
    cachedInputPerMTok: 0,
    outputPerMTok: 0,
    perRequestUsd: 0.001,
  },
}

const FALLBACK_RATE: ModelRate = { inputPerMTok: 0.5, cachedInputPerMTok: 0.05, outputPerMTok: 3.0 }

/**
 * Whether the model has an explicit rate row. Unknown models still get a
 * fallback-priced cost (aggregates must never drop calls), but the ledger row
 * is flagged (metadata.unpriced_model) and the dashboard shows a warning —
 * a provider/model swap must never silently misprice.
 */
export function isPricedModel(model: string): boolean {
  return model in MODEL_RATES_USD
}

/**
 * One call's usage, in the AI SDK v6 `LanguageModelUsage` shape, so a call's
 * `usage` / `totalUsage` passes straight through. Totals contain their parts:
 * cached input is part of inputTokens, reasoning is part of outputTokens.
 */
export interface TokenUsage {
  /** The whole prompt, cached tokens included (Google promptTokenCount). */
  inputTokens?: number
  /** The cached share of inputTokens, billed at the cached rate. */
  cachedInputTokens?: number
  /**
   * All billed output, thinking included: Google candidatesTokenCount +
   * thoughtsTokenCount, which is what the SDK's `outputTokens` already is.
   * A caller holding visible output and thinking separately passes their sum.
   */
  outputTokens?: number
  /**
   * The thinking share of outputTokens. Informational (stored as
   * metadata.reasoning_tokens); never added to outputTokens again.
   */
  reasoningTokens?: number
  /**
   * Image-input tokens for multimodal calls whose model bills images at a
   * separate rate (imageInputPerMTok). Pass the IMAGE share only — inputTokens
   * stays the text share, so the two never double-count.
   */
  imageTokens?: number
  /**
   * Number of billable CALLS, for providers that price per request instead of
   * per token (the hosted reranker). Defaults to 0 so no token-billed call
   * accidentally picks up a flat charge.
   */
  requests?: number
}

/**
 * The output tokens a call is billed for. Reasoning is part of outputTokens,
 * so it only acts as a floor (reasoning > output is malformed usage, the same
 * clamp as cached vs input). A caller passing visible output alone is
 * malformed too and still under-bills by its text share; it must pass the sum.
 * Adding the two double-counted every thinking call until 2026-10
 * (docs/reference/athena-cost-analysis.md).
 */
export function billedOutputTokens(usage: TokenUsage): number {
  return Math.max(usage.outputTokens ?? 0, usage.reasoningTokens ?? 0)
}

/** Compute USD cost for a single call, rounded to 6 dp (matches numeric(12,6)). */
export function computeCostUsd(model: string, usage: TokenUsage): number {
  const rate = MODEL_RATES_USD[model] ?? FALLBACK_RATE
  // The AI SDK reports inputTokens as the TOTAL prompt (Google's
  // promptTokenCount), which already contains cachedInputTokens — so cached
  // tokens are billed only at the cached rate, and only the non-cached
  // remainder at the full input rate. Charging both would double-count.
  const input = usage.inputTokens ?? 0
  const cached = Math.min(usage.cachedInputTokens ?? 0, input)
  const output = billedOutputTokens(usage)
  // Image tokens bill at the model's image rate (0 for text-only models —
  // a caller passing imageTokens for one is a bug, not a hidden charge).
  const image = usage.imageTokens ?? 0
  // Per-request pricing is additive, not an alternative branch: a model billed
  // both ways would otherwise silently lose one of the two charges.
  const perRequest = (usage.requests ?? 0) * (rate.perRequestUsd ?? 0)
  const cost =
    ((input - cached) * rate.inputPerMTok +
      cached * rate.cachedInputPerMTok +
      output * rate.outputPerMTok +
      image * (rate.imageInputPerMTok ?? 0)) /
      1_000_000 +
    perRequest
  return Math.round(cost * 1_000_000) / 1_000_000
}
