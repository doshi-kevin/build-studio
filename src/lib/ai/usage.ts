/**
 * recordAiUsage — append one row to the platform-wide AI cost ledger
 * (ai_usage_events). Call this from ANY AI feature's server code after a model
 * call to make its tokens + dollars visible on the super-admin AI Costs page.
 *
 * Server-only (uses the service-role admin client, which is the sole writer).
 * Never throws — telemetry must never break the feature that's logging it.
 */

import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import { billedOutputTokens, computeCostUsd, isPricedModel, type TokenUsage } from './cost'

/**
 * Where to attribute a model call's cost. Passed (optionally) into the shared
 * llm-client functions by their callers — institutionId may be omitted when
 * sectionId is set (recordAiUsage resolves it).
 */
export interface AiAttribution {
  institutionId?: string
  sectionId?: string | null
  userId?: string | null
}

export interface RecordAiUsageParams {
  /** Stable feature label, e.g. 'professor_assistant', 'quiz_generation', 'ai_tutor'. */
  feature: string
  model: string
  /** Omittable when sectionId is set — resolved from the section server-side. */
  institutionId?: string
  sectionId?: string | null
  userId?: string | null
  usage: TokenUsage
  /** Optional per-feature extras (free-form). */
  metadata?: Record<string, unknown>
}

export async function recordAiUsage(params: RecordAiUsageParams): Promise<void> {
  try {
    const admin = createAdminClient()
    // Most call sites know their section but not its institution — resolve it
    // here (one indexed lookup, off the critical path) instead of forcing
    // every caller to plumb institution_id through.
    let institutionId = params.institutionId
    if (!institutionId && params.sectionId) {
      const { data } = await admin
        .from('course_sections')
        .select('institution_id')
        .eq('id', params.sectionId)
        .single()
      institutionId = data?.institution_id ?? undefined
    }
    if (!institutionId) {
      logger.warn('recordAiUsage: missing institutionId — skipping', { feature: params.feature })
      return
    }
    const costUsd = computeCostUsd(params.model, params.usage)
    // output_tokens includes reasoning tokens (billing-consistent), which hides
    // the split — persist it here so the ledger can answer "how much of this
    // call was thinking?" (the dominant quiz-generation cost, design §10).
    const reasoning = params.usage.reasoningTokens ?? 0
    // image_tokens: the table has no image column, and image tokens bill at
    // their own rate — without this stamp a multimodal row's cost_usd can't be
    // recomputed from its stored columns (the audit invariant).
    const image = params.usage.imageTokens ?? 0
    // Same audit invariant as image_tokens above: a per-REQUEST-billed call
    // (the reranker) writes zeros in every token column, so without this stamp
    // its cost_usd can't be recomputed from the stored row.
    const requests = params.usage.requests ?? 0
    const metadata = {
      ...(params.metadata ?? {}),
      // reasoning_in_output marks rows written after the 2026-10 fix, whose
      // output_tokens holds the reasoning once; older thinking rows hold it
      // twice (docs/reference/athena-cost-analysis.md corrects them by this).
      ...(reasoning > 0 ? { reasoning_tokens: reasoning, reasoning_in_output: true } : {}),
      ...(requests > 0 ? { requests } : {}),
      ...(image > 0 ? { image_tokens: image } : {}),
      ...(isPricedModel(params.model) ? {} : { unpriced_model: true }),
    }
    const { error } = await admin.from('ai_usage_events').insert({
      feature: params.feature,
      institution_id: institutionId,
      section_id: params.sectionId ?? null,
      user_id: params.userId ?? null,
      model: params.model,
      input_tokens: params.usage.inputTokens ?? 0,
      cached_input_tokens: params.usage.cachedInputTokens ?? 0,
      // The same output count the cost was computed from, so a row's cost_usd
      // recomputes from its own columns.
      output_tokens: billedOutputTokens(params.usage),
      cost_usd: costUsd,
      metadata,
    })
    if (error) logger.error('recordAiUsage: insert failed', error, { feature: params.feature })
  } catch (error) {
    logger.error('recordAiUsage: exception', error, { feature: params.feature })
  }
}
