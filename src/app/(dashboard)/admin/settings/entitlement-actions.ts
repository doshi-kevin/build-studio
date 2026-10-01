'use server'

/**
 * Institution admin side of feature entitlements: see the plan, ask for what is
 * missing, withdraw an ask.
 *
 * An admin here can never change their own entitlements. The only write is a
 * row in institution_feature_requests, and even that goes through the
 * RLS-BOUND USER client so Postgres re-verifies the role and the tenant. The
 * grant itself is super-admin-only and lives in
 * super-admin/institutions/entitlement-actions.ts.
 */

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { verifyInstitutionAdmin } from '@/lib/auth/admin-context'
import { logEvent } from '@/lib/supabase/event-logger'
import { logger } from '@/lib/logger'
import { ENTITLED_FEATURES, isEntitledFeatureKey } from '@/lib/entitlements/entitled-features'
import { createAdminClient } from '@/lib/supabase/admin'
import { sendFeatureRequestReceived } from '@/lib/email'

const featureLabelFor = (key: string): string =>
  ENTITLED_FEATURES.find((f) => f.key === key)?.label ?? key

export async function requestFeature(
  featureKey: string,
  message?: string,
): Promise<{ success: true } | { error: string }> {
  try {
    const auth = await verifyInstitutionAdmin('requestFeature')
    if ('error' in auth) return { error: auth.error }

    if (!isEntitledFeatureKey(featureKey)) return { error: 'Unknown feature.' }
    const note = message?.trim() || null
    if (note && note.length > 2000) return { error: 'That message is too long.' }

    // The RLS-bound client, on purpose: the insert policy re-checks that the
    // caller is an institution_admin of this tenant and is inserting as
    // themselves, so a forged institution_id cannot get through this action.
    const supabase = await createClient()
    const { error } = await supabase.from('institution_feature_requests').insert({
      institution_id: auth.institutionId,
      feature_key: featureKey,
      requested_by: auth.userId,
      message: note,
    })

    if (error) {
      // The partial unique index on (institution_id, feature_key) where status
      // is pending. A second ask is not a failure worth an error banner.
      if (error.code === '23505') return { error: 'You already have an open request for this.' }
      logger.error('requestFeature: insert failed', error, {
        institutionId: auth.institutionId,
        featureKey,
      })
      return { error: 'Could not send the request. Please try again.' }
    }

    await logEvent({
      eventType: 'institution.feature_requested',
      userId: auth.userId,
      metadata: { institutionId: auth.institutionId, featureKey },
    })

    /* Best-effort, and AFTER the row is committed. A mail failure must never
       undo a request the school successfully made — sendFeatureRequestReceived
       returns false rather than throwing when Resend is unconfigured. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mailDb = createAdminClient() as any
    const { data: me } = await mailDb
      .from('profiles')
      .select('email, first_name')
      .eq('id', auth.userId)
      .maybeSingle()
    if (me?.email) {
      await sendFeatureRequestReceived(me.email, me.first_name || 'there', {
        featureLabel: featureLabelFor(featureKey),
        message: note,
      })
    }

    revalidatePath('/admin/settings')
    revalidatePath('/super-admin/feature-requests')
    return { success: true }
  } catch (error) {
    logger.error('requestFeature: unexpected', error, { featureKey })
    return { error: 'Could not send the request. Please try again.' }
  }
}

export async function withdrawFeatureRequest(
  requestId: string,
): Promise<{ success: true } | { error: string }> {
  try {
    const auth = await verifyInstitutionAdmin('withdrawFeatureRequest')
    if ('error' in auth) return { error: auth.error }

    // The delete policy allows only the requester's own pending rows, so this
    // needs no ownership read of its own: a row that does not match the policy
    // simply is not deleted.
    const supabase = await createClient()
    const { data, error } = await supabase
      .from('institution_feature_requests')
      .delete()
      .eq('id', requestId)
      .select('id')

    if (error) {
      logger.error('withdrawFeatureRequest: delete failed', error, { requestId })
      return { error: 'Could not withdraw the request. Please try again.' }
    }
    if (!data?.length) return { error: 'That request is no longer open.' }

    revalidatePath('/admin/settings')
    revalidatePath('/super-admin/feature-requests')
    return { success: true }
  } catch (error) {
    logger.error('withdrawFeatureRequest: unexpected', error, { requestId })
    return { error: 'Could not withdraw the request. Please try again.' }
  }
}
