/**
 * athena-core — the cost ledger for the student Athena surface.
 *
 * A thin wrapper over the shared `recordAiUsage` writer (that one IS shared
 * infrastructure — every AI feature in the app reports through it, and the
 * super-admin AI Costs page reads it). What core owns is the LABEL: every model
 * call this surface makes, including future sub-calls (decompose, rerank,
 * verifier), lands under one stable feature so §10's spend query is a single
 * WHERE clause. See docs/athena/analysis.md.
 */

import 'server-only'
import { recordAiUsage } from '@/lib/ai/usage'
import type { TokenUsage } from '@/lib/ai/cost'

/**
 * The `ai_usage_events.feature` label for everything the student surface spends.
 *
 * Renamed from 'ai_tutor' when the surface became Athena: the old label also
 * covers the retired full-context tutor, so cost-per-message before and after
 * retrieval are different populations and must not be averaged together. Rows
 * written before the rename keep the old label — analysis.md queries both.
 */
export const STUDENT_ASSISTANT_FEATURE = 'student_assistant'

/** Record one student-surface model call. Never throws — telemetry must never
 *  break the answer it is metering. */
export async function recordStudentUsage(params: {
  model: string
  sectionId: string
  userId: string
  usage: TokenUsage
  /** Which internal call this was, when a turn makes more than one. */
  metadata?: Record<string, unknown>
}): Promise<void> {
  await recordAiUsage({
    feature: STUDENT_ASSISTANT_FEATURE,
    model: params.model,
    sectionId: params.sectionId,
    userId: params.userId,
    usage: params.usage,
    metadata: params.metadata,
  })
}
