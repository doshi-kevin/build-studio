'use server'

/**
 * Super-admin AI kill-switch actions — the two layers only Scholera controls:
 *   - 'platform'  → one institution (institutions.settings.ai.platform)
 *   - 'global'    → every institution, current and future (platform_settings.settings.ai)
 *
 * Same write discipline as the institution admin's action: the RPC is called
 * via the RLS-BOUND USER client so Postgres re-verifies is_super_admin() even
 * if this layer's check regressed; atomic jsonb_set; optimistic version guard.
 * The institution's OWN layer is never touched — their choices survive a lock.
 */

import { revalidatePath } from 'next/cache'
import { after } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { verifySuperAdmin } from '@/lib/auth/super-admin-context'
import { logEvent } from '@/lib/supabase/event-logger'
import { logger } from '@/lib/logger'
import {
  isAiFeatureKey,
  parseAiPolicyLayer,
  parseInstitutionAiPolicy,
  type AiPolicyLayer,
} from '@/lib/ai/ai-features'
import { notifyAiPolicyChange } from '@/lib/notifications/ai-policy'

interface PolicyInput {
  allDisabled: boolean
  disabledFeatures: string[]
  expectedVersion: number
}

function validatePolicyInput(input: PolicyInput): { disabledFeatures: string[] } | { error: string } {
  if (
    typeof input?.allDisabled !== 'boolean' ||
    !Array.isArray(input.disabledFeatures) ||
    !Number.isInteger(input.expectedVersion) ||
    input.expectedVersion < 1
  ) {
    return { error: 'Invalid settings.' }
  }
  const disabledFeatures = [...new Set(input.disabledFeatures)].filter(isAiFeatureKey)
  if (disabledFeatures.length !== new Set(input.disabledFeatures).size) return { error: 'Invalid settings.' }
  return { disabledFeatures }
}

function mapRpcError(rpcError: { message?: string } | null, source: string): string {
  const msg = rpcError?.message ?? ''
  if (msg.includes('version_conflict')) {
    return 'These settings were changed by someone else — refresh the page and try again.'
  }
  logger.error(`${source}: rpc failed`, rpcError)
  return 'Could not save AI settings. Please try again.'
}

/** Super admin: set ONE institution's platform layer. */
export async function updateInstitutionPlatformAiPolicy(
  institutionId: string,
  input: PolicyInput,
): Promise<{ success: true; version: number } | { error: string }> {
  try {
    const auth = await verifySuperAdmin()
    if ('error' in auth) return { error: auth.error }
    const valid = validatePolicyInput(input)
    if ('error' in valid) return valid

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    const { data: instRow } = await adminDb
      .from('institutions')
      .select('settings')
      .eq('id', institutionId)
      .maybeSingle()
    if (!instRow) return { error: 'Institution not found.' }
    const before = parseInstitutionAiPolicy(instRow.settings).platform

    const supabase = await createClient()
    const { data: newVersion, error: rpcError } = await supabase.rpc('set_institution_ai_policy', {
      p_institution_id: institutionId,
      p_layer: 'platform',
      p_policy: { allDisabled: input.allDisabled, disabledFeatures: valid.disabledFeatures },
      p_expected_version: input.expectedVersion,
    })
    if (rpcError) return { error: mapRpcError(rpcError, 'updateInstitutionPlatformAiPolicy') }
    if (typeof newVersion !== 'number') {
      logger.error('updateInstitutionPlatformAiPolicy: rpc returned invalid version', undefined, { institutionId })
      return { error: 'Could not save AI settings. Please try again.' }
    }

    const after: AiPolicyLayer = {
      allDisabled: input.allDisabled,
      disabledFeatures: valid.disabledFeatures,
      version: newVersion,
    }
    void logEvent({
      userId: auth.userId,
      eventType: 'institution.ai_policy_updated',
      metadata: {
        layer: 'platform',
        institutionId,
        before: { allDisabled: before.allDisabled, disabledFeatures: before.disabledFeatures },
        after: { allDisabled: after.allDisabled, disabledFeatures: after.disabledFeatures },
      },
    })
    void notifyAiPolicyChange(adminDb, {
      institutionId,
      actorId: auth.userId,
      changedBy: 'scholera',
      before,
      after,
    })

    revalidatePath(`/super-admin/institutions/${institutionId}`)
    revalidatePath('/super-admin/ai-controls')
    revalidatePath('/admin/settings')
    return { success: true, version: newVersion }
  } catch (error) {
    logger.error('updateInstitutionPlatformAiPolicy: unexpected', error)
    return { error: 'An unexpected error occurred.' }
  }
}

/** Super admin: set the GLOBAL layer — every institution, current and future. */
export async function updateGlobalAiPolicy(
  input: PolicyInput,
): Promise<{ success: true; version: number } | { error: string }> {
  try {
    const auth = await verifySuperAdmin()
    if ('error' in auth) return { error: auth.error }
    const valid = validatePolicyInput(input)
    if ('error' in valid) return valid

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    const { data: platformRow } = await adminDb
      .from('platform_settings')
      .select('settings')
      .eq('id', true)
      .maybeSingle()
    const before = parseAiPolicyLayer(
      (platformRow?.settings as Record<string, unknown> | null | undefined)?.ai,
    )

    const supabase = await createClient()
    const { data: newVersion, error: rpcError } = await supabase.rpc('set_institution_ai_policy', {
      p_institution_id: null,
      p_layer: 'global',
      p_policy: { allDisabled: input.allDisabled, disabledFeatures: valid.disabledFeatures },
      p_expected_version: input.expectedVersion,
    })
    if (rpcError) return { error: mapRpcError(rpcError, 'updateGlobalAiPolicy') }
    if (typeof newVersion !== 'number') {
      logger.error('updateGlobalAiPolicy: rpc returned invalid version', undefined, { newVersion })
      return { error: 'Could not save AI settings. Please try again.' }
    }

    const afterLayer: AiPolicyLayer = {
      allDisabled: input.allDisabled,
      disabledFeatures: valid.disabledFeatures,
      version: newVersion,
    }
    void logEvent({
      userId: auth.userId,
      eventType: 'platform.ai_policy_updated',
      metadata: {
        layer: 'global',
        before: { allDisabled: before.allDisabled, disabledFeatures: before.disabledFeatures },
        after: { allDisabled: afterLayer.allDisabled, disabledFeatures: afterLayer.disabledFeatures },
      },
    })

    // Bell every affected tenant (admins + professors). after() — not a bare
    // void IIFE — so Cloud Run keeps the instance alive until the fanout
    // finishes; this is the emergency lever, partial delivery is worst here.
    after(async () => {
      const { data: institutions } = await adminDb.from('institutions').select('id').eq('status', 'active')
      for (const inst of institutions ?? []) {
        await notifyAiPolicyChange(adminDb, {
          institutionId: inst.id,
          actorId: auth.userId,
          changedBy: 'scholera',
          before,
          after: afterLayer,
        })
      }
    })

    revalidatePath('/super-admin/ai-controls')
    revalidatePath('/admin/settings')
    return { success: true, version: newVersion }
  } catch (error) {
    logger.error('updateGlobalAiPolicy: unexpected', error)
    return { error: 'An unexpected error occurred.' }
  }
}

/**
 * Super admin: bulk master kill/restore across selected institutions — flips
 * each institution's PLATFORM-layer `allDisabled` while preserving its
 * per-feature platform list. Institutions already in the target state are
 * skipped (no version bump, no notification noise).
 */
export async function bulkSetInstitutionsAiMaster(
  institutionIds: string[],
  disable: boolean,
): Promise<{ success: true; updated: number; skipped: number; failures: string[] } | { error: string }> {
  try {
    const auth = await verifySuperAdmin()
    if ('error' in auth) return { error: auth.error }
    if (!Array.isArray(institutionIds) || institutionIds.length === 0) {
      return { error: 'Select at least one institution.' }
    }
    if (institutionIds.length > 200 || institutionIds.some((id) => typeof id !== 'string')) {
      return { error: 'Invalid selection.' }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    const { data: rows, error: readError } = await adminDb
      .from('institutions')
      .select('id, name, settings')
      .in('id', institutionIds)
    if (readError) {
      logger.error('bulkSetInstitutionsAiMaster: read failed', readError)
      return { error: 'Could not load the selected institutions.' }
    }

    const supabase = await createClient()
    let updated = 0
    let skipped = 0
    const failures: string[] = []
    for (const row of rows ?? []) {
      const before = parseInstitutionAiPolicy(row.settings).platform
      if (before.allDisabled === disable) {
        skipped++
        continue
      }
      const { data: newVersion, error: rpcError } = await supabase.rpc('set_institution_ai_policy', {
        p_institution_id: row.id,
        p_layer: 'platform',
        p_policy: { allDisabled: disable, disabledFeatures: before.disabledFeatures },
        p_expected_version: before.version,
      })
      if (rpcError || typeof newVersion !== 'number') {
        logger.error('bulkSetInstitutionsAiMaster: rpc failed for institution', rpcError, { id: row.id })
        failures.push(row.name as string)
        continue
      }
      updated++
      const after: AiPolicyLayer = {
        allDisabled: disable,
        disabledFeatures: before.disabledFeatures,
        version: newVersion,
      }
      void logEvent({
        userId: auth.userId,
        eventType: 'institution.ai_policy_updated',
        metadata: {
          layer: 'platform',
          institutionId: row.id,
          bulk: true,
          before: { allDisabled: before.allDisabled, disabledFeatures: before.disabledFeatures },
          after: { allDisabled: after.allDisabled, disabledFeatures: after.disabledFeatures },
        },
      })
      void notifyAiPolicyChange(adminDb, {
        institutionId: row.id,
        actorId: auth.userId,
        changedBy: 'scholera',
        before,
        after,
      })
    }

    revalidatePath('/super-admin')
    revalidatePath('/super-admin/ai-controls')
    revalidatePath('/admin/settings')
    return { success: true, updated, skipped, failures }
  } catch (error) {
    logger.error('bulkSetInstitutionsAiMaster: unexpected', error)
    return { error: 'An unexpected error occurred.' }
  }
}
