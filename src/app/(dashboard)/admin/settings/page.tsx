/**
 * Institution Settings — institution-level controls for the admin.
 *
 * Today: the AI kill switch (Danger Zone). The card gets three inputs computed
 * here server-side: the institution's own layer (editable), plus which
 * features Scholera locked via the global/platform layers (rendered locked).
 *
 * Type: Server Component
 * Route: /admin/settings
 * Tables: institutions (settings), platform_settings
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { verifyInstitutionAdmin } from '@/lib/auth/admin-context'
import { getEffectiveAiPolicy } from '@/lib/ai/kill-switch'
import { AI_FEATURE_KEYS, type AiFeatureKey } from '@/lib/ai/ai-features'
import { AiPolicyEditor } from '@/components/shared/AiPolicyEditor'
import { updateInstitutionAiPolicy } from './actions'
import { InstitutionPlanCard } from '@/components/admin/InstitutionPlanCard'
import { getEntitlementConfig } from '@/lib/entitlements/check'
import { logger } from '@/lib/logger'

export default async function AdminSettingsPage() {
  /* Re-check the role HERE, not only in the admin layout — layout and page render
     in parallel, so the layout's <DeadEnd> alone would not stop this page from
     streaming its data (PR #555). Returning null is correct only because the
     layout renders the visible dead end around this slot. */
  const auth = await verifyInstitutionAdmin('AdminSettingsPage')
  if ('error' in auth) {
    logger.warn('AdminSettingsPage: denied, skipping fetch', { reason: auth.error })
    return null
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any
  // A policy-read failure renders a calm inline state, not error.tsx — this is
  // a settings page, and "couldn't load" is a state, not a crash.
  let policy: Awaited<ReturnType<typeof getEffectiveAiPolicy>> | null = null
  let institutionName = 'your institution'
  try {
    const [p, institutionRes] = await Promise.all([
      getEffectiveAiPolicy(adminDb, auth.institutionId),
      adminDb.from('institutions').select('name').eq('id', auth.institutionId).maybeSingle(),
    ])
    policy = p
    institutionName = (institutionRes?.data?.name as string | undefined) ?? institutionName
  } catch (error) {
    logger.error('AdminSettingsPage: policy read failed', error, { institutionId: auth.institutionId })
  }

  // The plan card. Its own read, deliberately not folded into the Promise.all
  // above: entitlements grant on a read error while the AI policy refuses on
  // one, so sharing a failure path would let one control's default leak into
  // the other.
  // Its own try/catch, NOT resolveAllEntitlements: on this screen a permissive
  // default would state as fact that the school has every product. The nav
  // filtering elsewhere keeps the permissive read, where erring toward showing
  // a paid feature is the safe direction.
  let entitlements: Awaited<ReturnType<typeof getEntitlementConfig>> | null = null
  try {
    entitlements = await getEntitlementConfig(adminDb, auth.institutionId)
  } catch (error) {
    logger.error('AdminSettingsPage: entitlement read failed', error, {
      institutionId: auth.institutionId,
    })
  }
  const { data: openRequestRows } = await adminDb
    .from('institution_feature_requests')
    .select('id, feature_key')
    .eq('institution_id', auth.institutionId)
    .eq('status', 'pending')
  const openRequests: Record<string, string> = {}
  for (const row of (openRequestRows ?? []) as { id: string; feature_key: string }[]) {
    openRequests[row.feature_key] = row.id
  }

  // What Scholera (global or per-institution platform layer) has locked.
  const lockedAll = policy
    ? policy.global.allDisabled || policy.institution.platform.allDisabled
    : false
  const lockedFeatures = policy
    ? AI_FEATURE_KEYS.filter(
        (key) =>
          policy.global.disabledFeatures.includes(key) ||
          policy.institution.platform.disabledFeatures.includes(key),
      )
    : []

  return (
    <div className="space-y-8 max-w-3xl">
      <div>
        <p className="text-[11px] font-semibold text-muted-foreground tracking-[0.2em] uppercase mb-2">
          Administration
        </p>
        <h1 className="font-[family-name:var(--font-instrument-serif)] text-[32px] tracking-tight">Settings</h1>
        <p className="text-[15px] text-muted-foreground mt-2">
          Institution-wide controls. Changes here apply to everyone at {institutionName}.
        </p>
      </div>
      {entitlements ? (
        <InstitutionPlanCard entitlements={entitlements} openRequests={openRequests} />
      ) : (
        <div className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">
          Couldn&apos;t load your plan — refresh the page to try again.
        </div>
      )}

      {policy ? (
        <AiPolicyEditor
          initial={{
            allDisabled: policy.institution.institution.allDisabled,
            disabledFeatures: policy.institution.institution.disabledFeatures as AiFeatureKey[],
            version: policy.institution.institution.version,
          }}
          lockedAll={lockedAll}
          lockedFeatures={lockedFeatures}
          lockedNote="Managed by Scholera"
          lockedBanner="All AI features have been disabled by Scholera. Your settings below are kept and will apply again if Scholera re-enables AI for your institution."
          partialLockNote="Some features are managed by Scholera. Your own settings for them are kept and resume if Scholera re-enables them."
          heading="AI features"
          description={`Turning a feature off takes effect immediately for every professor and student at ${institutionName}. Courses, grades, and materials are never affected, and everything comes back exactly as it was when you turn it on again.`}
          scopeLabel={`all professors and students at ${institutionName}`}
          save={updateInstitutionAiPolicy}
        />
      ) : (
        <div className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">
          Couldn&apos;t load your AI settings — refresh the page to try again.
        </div>
      )}
    </div>
  )
}
