'use server'

/**
 * Institution Settings actions — the institution admin's AI kill switch.
 *
 * The write goes through the set_institution_ai_policy RPC via the RLS-BOUND
 * USER client (not the service-role client, deliberately): the function
 * re-verifies the caller's role at the DB layer, so even if the action-layer
 * check regressed, Postgres rejects the write. The RPC also does an atomic
 * jsonb_set of ONLY the institution layer with an optimistic version guard.
 *
 * Institution admins can only ever write the `institution` layer — the
 * platform/global layers (super admin) have no code path here at all.
 */

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { verifyInstitutionAdmin } from '@/lib/auth/admin-context'
import { logEvent } from '@/lib/supabase/event-logger'
import { logger } from '@/lib/logger'
import { isAiFeatureKey, parseInstitutionAiPolicy, type AiPolicyLayer } from '@/lib/ai/ai-features'
import { notifyAiPolicyChange } from '@/lib/notifications/ai-policy'

export async function updateInstitutionAiPolicy(input: {
  allDisabled: boolean
  disabledFeatures: string[]
  expectedVersion: number
}): Promise<{ success: true; version: number } | { error: string }> {
  try {
    const auth = await verifyInstitutionAdmin('updateInstitutionAiPolicy')
    if ('error' in auth) return { error: auth.error }

    // Validate against the TS registry (the single source of feature keys).
    if (
      typeof input?.allDisabled !== 'boolean' ||
      !Array.isArray(input.disabledFeatures) ||
      !Number.isInteger(input.expectedVersion) ||
      input.expectedVersion < 1
    ) {
      return { error: 'Invalid settings.' }
    }
    const disabledFeatures = [...new Set(input.disabledFeatures)].filter(isAiFeatureKey)
    if (disabledFeatures.length !== new Set(input.disabledFeatures).size) {
      return { error: 'Invalid settings.' }
    }

    // Snapshot the layer BEFORE the write for the audit log + notification diff.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    const { data: instRow } = await adminDb
      .from('institutions')
      .select('settings')
      .eq('id', auth.institutionId)
      .maybeSingle()
    const before = parseInstitutionAiPolicy(instRow?.settings).institution

    // The write — through the user's own client so RLS + the RPC's internal
    // role check both apply.
    const supabase = await createClient()
    const { data: newVersion, error: rpcError } = await supabase.rpc('set_institution_ai_policy', {
      p_institution_id: auth.institutionId,
      p_layer: 'institution',
      p_policy: { allDisabled: input.allDisabled, disabledFeatures },
      p_expected_version: input.expectedVersion,
    })
    if (rpcError) {
      const msg = rpcError.message ?? ''
      if (msg.includes('version_conflict')) {
        return { error: 'These settings were changed by someone else — refresh the page and try again.' }
      }
      logger.error('updateInstitutionAiPolicy: rpc failed', rpcError, { institutionId: auth.institutionId })
      return { error: 'Could not save AI settings. Please try again.' }
    }

    // The RPC's returned version is the single source of truth — a malformed
    // return would leave the client with a guessed version whose next save
    // falsely version-conflicts. Refuse instead.
    if (typeof newVersion !== 'number') {
      logger.error('updateInstitutionAiPolicy: rpc returned invalid version', undefined, {
        institutionId: auth.institutionId,
      })
      return { error: 'Could not save AI settings. Please try again.' }
    }
    const after: AiPolicyLayer = {
      allDisabled: input.allDisabled,
      disabledFeatures,
      version: newVersion,
    }

    void logEvent({
      userId: auth.userId,
      eventType: 'institution.ai_policy_updated',
      metadata: {
        layer: 'institution',
        before: { allDisabled: before.allDisabled, disabledFeatures: before.disabledFeatures },
        after: { allDisabled: after.allDisabled, disabledFeatures: after.disabledFeatures },
      },
    })
    void notifyAiPolicyChange(adminDb, {
      institutionId: auth.institutionId,
      actorId: auth.userId,
      changedBy: 'institution',
      before,
      after,
    })

    revalidatePath('/admin/settings')
    return { success: true, version: after.version }
  } catch (error) {
    logger.error('updateInstitutionAiPolicy: unexpected', error)
    return { error: 'An unexpected error occurred.' }
  }
}
