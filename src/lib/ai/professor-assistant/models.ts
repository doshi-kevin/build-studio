/**
 * Athena model registry — the single source of truth for the composer's model
 * picker AND the server-side whitelist that routes a request to a provider.
 *
 * Client-safe by design: pure data + types, NO provider SDK import, so importing
 * this into the client console never pulls a provider SDK (or its API key) into
 * the browser bundle. The server resolves `provider` → an actual model client.
 *
 * Adding a model later = one entry here + one `case` in the route's provider
 * switch (and its SDK + key). No UI changes — the picker renders this array.
 */

import { AI_TUTOR_MODEL, PROFESSOR_ASSISTANT_PRO_MODEL } from '@/lib/ai/config'

export type AthenaModelId = 'gemini-flash' | 'gemini-pro'

/**
 * Per-model attachment limits. The single source of truth for BOTH the client
 * (file-picker `accept`, count gating, friendly errors) AND the server upload
 * route (the security whitelist — the client is never trusted). Office docs
 * (docx/pptx/xlsx) are converted to PDF server-side before the model sees them,
 * so they get a tighter size cap to keep that synchronous conversion fast.
 */
export interface AthenaAttachmentLimits {
  /** Max files attached to a single message. */
  maxFiles: number
  /** Max bytes for a PDF/image/text file. */
  maxBytesPerFile: number
  /** Max bytes for an Office doc (converted to PDF on upload). */
  maxOfficeBytes: number
  /** Lowercase extensions accepted (no dot). */
  acceptedExt: string[]
}

export interface AthenaModelDef {
  /** Stable id sent from the client and validated server-side. */
  id: AthenaModelId
  /** Display name in the picker, e.g. "Gemini Flash". */
  label: string
  /** One-line "best for…" blurb shown under the label. */
  description: string
  /** Which provider client the server builds. Widen the union per new provider. */
  provider: 'google'
  /** Underlying provider model string, e.g. 'gemini-3-flash-preview'. */
  model: string
  /** Attachment limits for this model. */
  attachments: AthenaAttachmentLimits
  /**
   * Max accepted user messages per user per rolling window for THIS model.
   * The single source of truth for the per-model daily rate limit, read by both
   * the server (enforcement, in rate-limit.ts) and the client (the usage UI).
   * Tune the limit by editing this one number — nothing else hardcodes it.
   */
  dailyCap: number
  /**
   * Gemini thinking level for this model. Gemini 3 defaults to 'high', whose
   * reasoning tokens add large, highly-variable latency — the dominant cost in
   * Athena's time-to-first-token. We pin each model to its LOWEST level to keep
   * replies fast: Flash supports 'minimal' (effectively no thinking for most
   * queries); Pro's floor is 'low' (it cannot be driven lower). Passed straight
   * to the Google provider's thinkingConfig in the route.
   */
  thinkingLevel: 'minimal' | 'low' | 'medium' | 'high'
}

/**
 * Fraction of a model's daily cap at which the quiet "nearing" usage UI appears
 * (e.g. 0.8 → surface once 80% of the cap is used). Shared source of truth read
 * by server status + client UI.
 */
export const ATHENA_NEARING_THRESHOLD = 0.8

/**
 * Rolling window (in hours) over which a model's accepted-request count
 * accumulates before resetting automatically. No cron — the window resets
 * implicitly on first use after it lapses (see athena_increment_rate_limit).
 */
export const ATHENA_RATE_LIMIT_WINDOW_HOURS = 24

/**
 * The Athena surfaces that each get their OWN independent pool of the caps above.
 * A professor who drains one surface still has full budget on the other three.
 *
 * Lives here rather than in rate-limit.ts because that file is `server-only` and
 * the client components need the type to ask for their own pool's usage.
 *
 * MUST stay in sync with the athena_rate_limits_scope_check CHECK constraint
 * (latest revision: supabase/migrations/20260915194440_athena_project_rate_limit_scope.sql).
 * Adding a surface is deliberately a migration: each new pool raises the per-user
 * daily cost ceiling by a full set of caps.
 */
export const ATHENA_LIMIT_SCOPES = ['console', 'assignment', 'quiz', 'grade', 'tutor', 'about', 'project'] as const
export type AthenaLimitScope = (typeof ATHENA_LIMIT_SCOPES)[number]

const MB = 1024 * 1024

// Both Gemini models accept the same files (same multimodal input + the same
// server-side Office→PDF conversion path), so they share one limits object.
const GEMINI_ATTACHMENTS: AthenaAttachmentLimits = {
  maxFiles: 5,
  maxBytesPerFile: 20 * MB,
  maxOfficeBytes: 10 * MB,
  acceptedExt: ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'txt', 'md', 'csv', 'docx', 'pptx', 'xlsx'],
}

export const ATHENA_MODELS: AthenaModelDef[] = [
  {
    id: 'gemini-flash',
    label: 'Gemini Flash',
    description: 'Fast and capable — great for everyday drafting',
    provider: 'google',
    model: AI_TUTOR_MODEL,
    attachments: GEMINI_ATTACHMENTS,
    dailyCap: 150,
    thinkingLevel: 'minimal',
  },
  {
    id: 'gemini-pro',
    label: 'Gemini Pro',
    description: 'Most capable — best for complex or nuanced work',
    provider: 'google',
    model: PROFESSOR_ASSISTANT_PRO_MODEL,
    attachments: GEMINI_ATTACHMENTS,
    dailyCap: 30,
    thinkingLevel: 'low',
  },
]

// Flash is the default: at 'minimal' thinking it answers in ~0.5s vs Pro's ~9s
// (Pro's thinking floor is 'low' and still reasons heavily). Most Athena turns
// are everyday drafting where Flash is plenty; professors can switch to Pro in
// the picker for complex/nuanced work.
export const DEFAULT_ATHENA_MODEL_ID: AthenaModelId = 'gemini-flash'

/**
 * Server whitelist: map a (client-supplied, untrusted) id to a known model def.
 * An unknown or missing id silently falls back to the default — the client
 * string never selects an arbitrary provider/model.
 */
export function resolveAthenaModelDef(id: string | undefined): AthenaModelDef {
  return (
    ATHENA_MODELS.find((m) => m.id === id) ??
    ATHENA_MODELS.find((m) => m.id === DEFAULT_ATHENA_MODEL_ID)!
  )
}

// ── Rate-limit status (provider-agnostic; counts internal, UI shows %) ──

/** Per-model usage snapshot. Raw `used`/`cap`/`remaining` stay internal — the
 *  UI renders only a percentage (see percentRemaining) + the nearing/exhausted
 *  flags, never a raw request count. */
export interface AthenaModelUsage {
  id: AthenaModelId
  used: number
  cap: number
  remaining: number
  /** used / cap ≥ ATHENA_NEARING_THRESHOLD (true once exhausted too). */
  nearing: boolean
  /** used ≥ cap — this model is out of budget for the current window. */
  exhausted: boolean
}

/** Usage across every Athena model for one user, plus when the limit frees up. */
export interface AthenaUsageStatus {
  models: AthenaModelUsage[]
  /** ISO time the earliest-exhausted model's window resets; null if none exhausted. */
  resets_at: string | null
}

/** Snapshot a model's usage from its raw accepted-request count this window. */
export function computeModelUsage(def: AthenaModelDef, used: number): AthenaModelUsage {
  const cap = def.dailyCap
  return {
    id: def.id,
    used,
    cap,
    remaining: Math.max(0, cap - used),
    nearing: used / cap >= ATHENA_NEARING_THRESHOLD,
    exhausted: used >= cap,
  }
}

/** Percentage of a model's budget still available (0–100), for the calm "X% left"
 *  framing. Raw counts never surface — only this derived percentage. */
export function percentRemaining(u: AthenaModelUsage): number {
  return Math.max(0, Math.min(100, Math.round((u.remaining / u.cap) * 100)))
}

/** Ordered failover candidates for a preferred model: the preferred model first,
 *  then every other registered model in registry order. Provider-agnostic and
 *  works for N models — never hardcodes "the other one". */
export function failoverCandidates(preferredId: AthenaModelId): AthenaModelDef[] {
  const preferred = ATHENA_MODELS.find((m) => m.id === preferredId)
  const rest = ATHENA_MODELS.filter((m) => m.id !== preferredId)
  return preferred ? [preferred, ...rest] : [...ATHENA_MODELS]
}
