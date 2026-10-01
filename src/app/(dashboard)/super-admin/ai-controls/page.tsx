/**
 * AI Controls (super_admin) — the platform's AI kill switch.
 *
 * Two sections:
 *  1. Global controls — the GLOBAL layer: per-feature + master, applying to
 *     EVERY institution, current and future. The highest authority; nothing
 *     can re-enable under it.
 *  2. Per-institution bulk — checkbox-select institutions (+ select-all) and
 *     master-kill/restore their PLATFORM layer. Per-feature per-institution
 *     lives on each institution's detail page.
 *
 * Also: the global Studio kill switch (StudioKillSwitchCard), the same kind of
 * platform-wide stop for Studio plugins.
 *
 * Type: Server Component
 * Route: /super-admin/ai-controls
 * Tables: platform_settings, institutions
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { verifySuperAdmin } from '@/lib/auth/super-admin-context'
import { parseAiPolicyLayer, parseInstitutionAiPolicy, type AiFeatureKey } from '@/lib/ai/ai-features'
import { AiPolicyEditor } from '@/components/shared/AiPolicyEditor'
import { AiBulkKillTable, type BulkInstitutionRow } from '@/components/super-admin/AiBulkKillTable'
import { StudioKillSwitchCard } from '@/components/super-admin/StudioKillSwitchCard'
import { readStudioKillSwitch } from '@/lib/studio/access'
import { updateGlobalAiPolicy } from '../institutions/ai-actions'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'

export default async function AiControlsPage() {
  /* Re-check the role HERE, not only in the layout — layout and page render in
     parallel (PR #555). Returning null is correct only because the layout
     renders the visible no-access dead end around this slot. */
  const auth = await verifySuperAdmin()
  if ('error' in auth) {
    logger.warn('AiControlsPage: denied, skipping fetch', { reason: auth.error })
    return null
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any
  const [platformRes, institutionsRes, studioState] = await Promise.all([
    adminDb.from('platform_settings').select('settings').eq('id', true).maybeSingle(),
    adminDb.from('institutions').select('id, name, settings').eq('status', 'active').order('name'),
    readStudioKillSwitch(),
  ])
  const globalLayer = parseAiPolicyLayer(
    (platformRes?.data?.settings as Record<string, unknown> | null | undefined)?.ai,
  )
  const institutions: BulkInstitutionRow[] = ((institutionsRes?.data ?? []) as Array<{
    id: string
    name: string
    settings: unknown
  }>).map((inst) => {
    const policy = parseInstitutionAiPolicy(inst.settings)
    return {
      id: inst.id,
      name: inst.name,
      platformAllDisabled: policy.platform.allDisabled,
      platformFeatureCount: policy.platform.disabledFeatures.length,
      institutionAllDisabled: policy.institution.allDisabled,
    }
  })

  return (
    <div className="space-y-8 max-w-4xl mx-auto">
      <div>
        <p className="text-[11px] font-semibold text-muted-foreground tracking-[0.2em] uppercase mb-2">
          Platform
        </p>
        <h1 className="font-[family-name:var(--font-instrument-serif)] text-[32px] tracking-tight">
          AI Controls
        </h1>
        <p className="text-[15px] text-muted-foreground mt-2">
          Scholera&apos;s kill switch. Global controls apply to every institution — current and future —
          and cannot be overridden by anyone below. The Studio card below stops every Studio tool.
        </p>
      </div>

      <AiPolicyEditor
        initial={{
          allDisabled: globalLayer.allDisabled,
          disabledFeatures: globalLayer.disabledFeatures as AiFeatureKey[],
          version: globalLayer.version,
        }}
        heading="Global AI features"
        description="Applies to every institution on Scholera, including ones created later. Institution-level settings are kept underneath and resume when a feature is re-enabled here."
        scopeLabel="every professor and student at every institution on Scholera"
        idPrefix="ai-global"
        save={updateGlobalAiPolicy}
      />

      {/* Studio's own switch: tools, not AI, but the same "stop it everywhere" control.
          Above the per-institution table, which grows with every institution. */}
      <StudioKillSwitchCard state={studioState} />

      <div>
        <h2 className="text-sm font-semibold text-foreground mb-1">Per-institution kill switch</h2>
        <p className="text-[13px] text-muted-foreground mb-3">
          Disable or restore all AI for specific institutions. For feature-level control of one
          institution, open it and use its AI Controls card.
          {(globalLayer.allDisabled || globalLayer.disabledFeatures.length > 0) && (
            <span className="block mt-1">
              Note: the global controls above additionally disable{' '}
              {globalLayer.allDisabled ? 'ALL AI features' : `${globalLayer.disabledFeatures.length} feature${globalLayer.disabledFeatures.length === 1 ? '' : 's'}`}{' '}
              for every institution listed here.
            </span>
          )}
        </p>
        <AiBulkKillTable institutions={institutions} />
      </div>

    </div>
  )
}
