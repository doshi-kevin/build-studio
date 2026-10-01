/**
 * Bell notifications for AI kill-switch changes.
 *
 * One BATCHED insert per save (never one per feature): recipients are the
 * institution's admins + professors — the people whose workflows change.
 * Students deliberately get none (they see inline blocked states instead).
 *
 * Fire-and-forget like logEvent: runs AFTER the policy write succeeds, never
 * inside it, and never throws — a notification failure must not undo or block
 * a kill-switch change.
 */

import 'server-only'
import { logger } from '@/lib/logger'
import { AI_FEATURES, type AiFeatureKey, type AiPolicyLayer } from '@/lib/ai/ai-features'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminDb = any

const label = (key: string): string => AI_FEATURES.find((f) => f.key === key)?.label ?? key

/**
 * Human-readable diff of one layer change; null when nothing effective changed.
 * Diffs the EFFECTIVE per-feature off-sets (the allDisabled sentinel expanded
 * over the registry) — diffing raw sentinels claimed features were "re-enabled"
 * as the master switch killed them (caught in QA).
 */
export function describeAiPolicyChange(
  before: AiPolicyLayer,
  after: AiPolicyLayer,
): { title: string; body: string } | null {
  const effectiveOff = (layer: AiPolicyLayer): Set<string> =>
    new Set(layer.allDisabled ? AI_FEATURES.map((f) => f.key) : layer.disabledFeatures)
  const beforeOff = effectiveOff(before)
  const afterOff = effectiveOff(after)
  const disabled = [...afterOff].filter((k) => !beforeOff.has(k))
  const enabled = [...beforeOff].filter((k) => !afterOff.has(k))
  if (disabled.length === 0 && enabled.length === 0) return null

  const list = (keys: string[]) =>
    keys.length === AI_FEATURES.length ? 'All AI features' : keys.map(label).join(', ')
  const parts: string[] = []
  // Master ON reads as the sentence it is, not an enumeration of whichever
  // features weren't already off.
  if (disabled.length) parts.push(`Disabled: ${after.allDisabled ? 'All AI features' : list(disabled)}.`)
  if (enabled.length) parts.push(`Re-enabled: ${list(enabled)}.`)

  const title = disabled.length
    ? after.allDisabled
      ? 'All AI features were disabled'
      : 'Some AI features were disabled'
    : 'AI features were re-enabled'
  return { title, body: parts.join(' ') }
}

export async function notifyAiPolicyChange(
  adminDb: AdminDb,
  params: {
    institutionId: string
    actorId: string
    /** Who changed it — drives the attribution line in the body. */
    changedBy: 'scholera' | 'institution'
    before: AiPolicyLayer
    after: AiPolicyLayer
  },
): Promise<void> {
  try {
    const change = describeAiPolicyChange(params.before, params.after)
    if (!change) return

    const { data: recipients, error } = await adminDb
      .from('profiles')
      .select('id')
      .eq('institution_id', params.institutionId)
      .in('role', ['institution_admin', 'professor'])
    if (error || !recipients?.length) {
      if (error) logger.error('notifyAiPolicyChange: recipient query failed', error)
      return
    }

    const attribution =
      params.changedBy === 'scholera' ? 'Changed by Scholera.' : "Changed by your institution's administration."
    const rows = recipients.map((r: { id: string }) => ({
      recipient_id: r.id,
      actor_id: params.actorId,
      kind: 'ai_policy_changed',
      title: change.title,
      body: `${change.body} ${attribution}`,
      metadata: { institutionId: params.institutionId },
    }))
    const { error: insertError } = await adminDb.from('app_notifications').insert(rows)
    if (insertError) logger.error('notifyAiPolicyChange: insert failed', insertError)
  } catch (err) {
    logger.error('notifyAiPolicyChange: unexpected', err)
  }
}

/** Feature keys a layer currently disables, for diff/audit metadata. */
export function layerDisabledKeys(layer: AiPolicyLayer): AiFeatureKey[] | 'all' {
  return layer.allDisabled ? 'all' : (layer.disabledFeatures as AiFeatureKey[])
}
