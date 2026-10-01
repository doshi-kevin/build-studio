/**
 * AI Kill Switch — the server-side guard every AI entry point calls BEFORE
 * spending a model call (routes, server actions, and background pipeline
 * bodies alike). The admin write path is set_institution_ai_policy (RPC);
 * this module is the read path.
 *
 * FAIL-CLOSED: this is a compliance control, so an error while READING the
 * policy refuses the call ({ allowed: false, lockedBy: 'error' }) — the
 * inverse of reserveAthenaSlot's fail-open, deliberately: a rate limiter
 * failing open costs money, a kill switch failing open violates a promise
 * made to a customer. The refusal copy for the error path says "temporarily
 * unavailable", never "disabled by your institution" (aiUnavailable vs
 * aiDisabledMessage) — infra errors must not impersonate policy.
 *
 * Reads are fresh per call (two PK lookups) — no caching, staleness is the
 * one thing a kill switch cannot have. Both lookups are trivial next to the
 * multi-second model call they precede.
 */

import 'server-only'
import { logger } from '@/lib/logger'
import {
  parseAiPolicyLayer,
  parseInstitutionAiPolicy,
  evaluateAiFeature,
  AI_POLICY_LAYER_DEFAULT,
  type AiFeatureKey,
  type AiPolicyLayer,
  type InstitutionAiPolicy,
} from './ai-features'

// Loosely-typed admin client, same convention as rate-limit.ts / section-access.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminDb = any

export type AiGuardVerdict =
  | { allowed: true }
  | { allowed: false; lockedBy: 'global' | 'platform' | 'institution' | 'error' }

/** The full three-layer policy for one institution, as the admin UIs render it. */
export interface EffectiveAiPolicy {
  global: AiPolicyLayer
  institution: InstitutionAiPolicy
}

/**
 * Loads the global layer (platform_settings singleton) + the institution's two
 * layers. Throws on DB error — checkAiFeature catches and fails closed; the
 * admin UIs let it propagate to their own error handling.
 */
export async function getEffectiveAiPolicy(
  db: AdminDb,
  institutionId: string,
): Promise<EffectiveAiPolicy> {
  const [globalRes, instRes] = await Promise.all([
    db.from('platform_settings').select('settings').eq('id', true).maybeSingle(),
    db.from('institutions').select('settings').eq('id', institutionId).single(),
  ])
  if (globalRes.error) throw globalRes.error
  if (instRes.error || !instRes.data) throw instRes.error ?? new Error('institution not found')

  // The singleton row is created by the ai_kill_switch migration and nothing
  // deletes it — its absence is an ops anomaly worth shouting about, but per
  // the approved contract it is NOT a kill (absence of policy = default state;
  // only read ERRORS fail closed).
  if (!globalRes.data) {
    logger.warn('AiKillSwitch.getEffectiveAiPolicy: platform_settings singleton row missing')
  }
  const globalAi =
    globalRes.data?.settings && typeof globalRes.data.settings === 'object'
      ? (globalRes.data.settings as Record<string, unknown>).ai
      : undefined
  return {
    // A missing singleton row parses to the enabled default — the global kill
    // must come from an explicitly stored row, never from its absence.
    global: parseAiPolicyLayer(globalAi ?? AI_POLICY_LAYER_DEFAULT),
    institution: parseInstitutionAiPolicy(instRes.data.settings),
  }
}

/**
 * The guard. One call, one verdict; callers turn a refusal into their own
 * structured error ({ error } from actions, 403 JSON from routes, skipped
 * jobs in pipelines) — never a throw.
 */
export async function checkAiFeature(
  db: AdminDb,
  institutionId: string,
  feature: AiFeatureKey,
): Promise<AiGuardVerdict> {
  try {
    const policy = await getEffectiveAiPolicy(db, institutionId)
    return evaluateAiFeature(policy.global, policy.institution, feature)
  } catch (error) {
    logger.error('AiKillSwitch.checkAiFeature: policy read failed — refusing (fail-closed)', error, {
      institutionId,
      feature,
    })
    return { allowed: false, lockedBy: 'error' }
  }
}

/**
 * Section-scoped variant for the many call sites that know their section but
 * not its institution (same resolution recordAiUsage does). A missing section
 * refuses — an AI call we cannot attribute to a tenant must not run.
 */
export async function checkAiFeatureBySection(
  db: AdminDb,
  sectionId: string,
  feature: AiFeatureKey,
): Promise<AiGuardVerdict> {
  try {
    const { data, error } = await db
      .from('course_sections')
      .select('institution_id')
      .eq('id', sectionId)
      .single()
    if (error || !data?.institution_id) throw error ?? new Error('section not found')
    return checkAiFeature(db, data.institution_id, feature)
  } catch (error) {
    logger.error('AiKillSwitch.checkAiFeatureBySection: resolve failed — refusing (fail-closed)', error, {
      sectionId,
      feature,
    })
    return { allowed: false, lockedBy: 'error' }
  }
}
