'use server'

/**
 * Super-admin entitlement actions: granting and revoking what an institution
 * has bought, and clearing its request queue.
 *
 * Same write discipline as ai-actions.ts. The RPC goes through the RLS-BOUND
 * USER client so Postgres re-verifies is_super_admin() even if this layer's
 * check regressed, the jsonb write is atomic, and an optimistic version guard
 * stops two admins overwriting each other.
 */

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { verifySuperAdmin } from '@/lib/auth/super-admin-context'
import { logEvent } from '@/lib/supabase/event-logger'
import { logger } from '@/lib/logger'
import { notifyPlanChange, notifyRequestDeclined } from '@/lib/notifications/entitlements'
import { sendFeatureGranted, sendFeatureRequestDeclined } from '@/lib/email'
import {
  ENTITLED_FEATURES,
  isEntitledFeatureKey,
  isSchedulableRevocationDate,
  parseEntitlementConfig,
  type EntitledFeatureKey,
} from '@/lib/entitlements/entitled-features'

const featureLabelFor = (key: string): string =>
  ENTITLED_FEATURES.find((f) => f.key === key)?.label ?? key

export interface EntitlementSaveInput {
  /** Features explicitly switched on, overriding a registry default of off. */
  granted: string[]
  /** Features switched off with immediate effect. */
  revoked: string[]
  /**
   * Feature key to the ISO timestamp its revocation takes effect. Absolute, not
   * derived from any section's end date: a school that does not want to lose a
   * feature would otherwise just create a section ending in 2099.
   */
  pendingRevocation: Record<string, string>
  expectedVersion: number
}

type SaveResult = { success: true; version: number } | { error: string }

function validate(
  input: EntitlementSaveInput,
): { granted: string[]; revoked: string[]; pendingRevocation: Record<string, string> } | { error: string } {
  if (
    !Array.isArray(input?.granted) ||
    !Array.isArray(input?.revoked) ||
    !input?.pendingRevocation ||
    typeof input.pendingRevocation !== 'object' ||
    Array.isArray(input.pendingRevocation) ||
    !Number.isInteger(input.expectedVersion) ||
    input.expectedVersion < 1
  ) {
    return { error: 'Invalid settings.' }
  }

  const granted = [...new Set(input.granted)]
  const revoked = [...new Set(input.revoked)]
  // An unknown key means the client and the registry disagree. Silently
  // dropping it would save a config the admin did not see on screen.
  if (!granted.every(isEntitledFeatureKey) || !revoked.every(isEntitledFeatureKey)) {
    return { error: 'Invalid settings.' }
  }
  if (granted.some((k) => revoked.includes(k))) {
    return { error: 'A feature cannot be both granted and revoked.' }
  }

  const pendingRevocation: Record<string, string> = {}
  for (const [key, value] of Object.entries(input.pendingRevocation)) {
    if (!isEntitledFeatureKey(key)) return { error: 'Invalid settings.' }
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
      return { error: 'Pick a valid date for the scheduled change.' }
    }
    // The same rule the card applies, enforced again because the client is
    // untrusted. Shared rather than restated so the two cannot disagree.
    if (!isSchedulableRevocationDate(value)) {
      return { error: 'Pick a date between today and ten years from now.' }
    }
    if (revoked.includes(key)) {
      return { error: 'A feature cannot be revoked now and scheduled at the same time.' }
    }
    pendingRevocation[key] = new Date(value).toISOString()
  }

  return { granted, revoked, pendingRevocation }
}

function mapRpcError(rpcError: { message?: string } | null, source: string): string {
  const msg = rpcError?.message ?? ''
  if (msg.includes('version_conflict')) {
    return 'These settings were changed by someone else. Refresh the page and try again.'
  }
  if (msg.includes('not_found')) return 'Institution not found.'
  logger.error(`${source}: rpc failed`, rpcError)
  return 'Could not save the plan. Please try again.'
}

/** Write one institution's entitlements. */
export async function updateInstitutionEntitlements(
  institutionId: string,
  input: EntitlementSaveInput,
  /** Reviewer note, when this save is an approval. Reaches the school's bell. */
  note?: string,
): Promise<SaveResult> {
  try {
    const auth = await verifySuperAdmin()
    if ('error' in auth) return { error: auth.error }

    const valid = validate(input)
    if ('error' in valid) return valid

    // Snapshot before the write so the notification can describe what actually
    // changed rather than restating the whole plan.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    const { data: beforeRow } = await adminDb
      .from('institutions')
      .select('settings')
      .eq('id', institutionId)
      .maybeSingle()
    const before = parseEntitlementConfig(beforeRow?.settings)

    const supabase = await createClient()
    const { data: newVersion, error: rpcError } = await supabase.rpc(
      'set_institution_entitlements',
      {
        p_institution_id: institutionId,
        p_config: {
          granted: valid.granted,
          revoked: valid.revoked,
          pendingRevocation: valid.pendingRevocation,
        },
        p_expected_version: input.expectedVersion,
      },
    )
    if (rpcError) return { error: mapRpcError(rpcError, 'updateInstitutionEntitlements') }

    await logEvent({
      eventType: 'institution.entitlements_updated',
      userId: auth.userId,
      metadata: {
        institutionId,
        granted: valid.granted,
        revoked: valid.revoked,
        pendingRevocation: valid.pendingRevocation,
      },
    })

    // Fire-and-forget, after the write. Never blocks or undoes the save.
    await notifyPlanChange(adminDb, {
      institutionId,
      actorId: auth.userId,
      before,
      after: {
        granted: valid.granted,
        revoked: valid.revoked,
        pendingRevocation: valid.pendingRevocation,
        version: newVersion as number,
      },
      note,
    })

    revalidatePath(`/super-admin/institutions/${institutionId}`)
    revalidatePath('/admin/settings')
    return { success: true, version: newVersion as number }
  } catch (error) {
    logger.error('updateInstitutionEntitlements: unexpected', error, { institutionId })
    return { error: 'Could not save the plan. Please try again.' }
  }
}

/**
 * Approve a pending request: grant the feature, then close the row.
 *
 * The grant runs FIRST. If it fails the request stays pending, which is the
 * recoverable direction; closing the row first would lose the ask on a failed
 * grant with nothing left to retry from.
 */
export async function approveFeatureRequest(
  requestId: string,
  note?: string,
): Promise<{ success: true } | { error: string }> {
  try {
    const auth = await verifySuperAdmin()
    if ('error' in auth) return { error: auth.error }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    const { data: request } = await adminDb
      .from('institution_feature_requests')
      .select('id, institution_id, feature_key, status, requested_by')
      .eq('id', requestId)
      .maybeSingle()
    if (!request) return { error: 'Request not found.' }
    if (request.status !== 'pending') return { error: 'Only pending requests can be approved.' }
    if (!isEntitledFeatureKey(request.feature_key)) {
      return { error: 'That feature is no longer part of the catalog.' }
    }
    const feature = request.feature_key as EntitledFeatureKey

    const { data: instRow } = await adminDb
      .from('institutions')
      .select('settings')
      .eq('id', request.institution_id)
      .maybeSingle()
    if (!instRow) return { error: 'Institution not found.' }
    const current = parseEntitlementConfig(instRow.settings)

    // Granting means: no longer revoked, no longer scheduled for revocation,
    // and explicitly on. All three, or a stale revoke would outrank the grant.
    const pendingRevocation = { ...current.pendingRevocation }
    delete pendingRevocation[feature]
    const saved = await updateInstitutionEntitlements(request.institution_id, {
      granted: [...new Set([...current.granted, feature])],
      revoked: current.revoked.filter((k) => k !== feature),
      pendingRevocation,
      expectedVersion: current.version,
    }, note)
    if ('error' in saved) return saved

    // Close the row only after the grant landed, and only if it is still
    // pending, so two admins approving at once cannot both write a review.
    const { data: closed } = await adminDb
      .from('institution_feature_requests')
      .update({
        status: 'approved',
        reviewed_by: auth.userId,
        reviewed_at: new Date().toISOString(),
        review_note: note?.trim() || null,
      })
      .eq('id', requestId)
      .eq('status', 'pending')
      .select('id')
    if (!closed?.length) {
      // The grant succeeded, which is the part that matters. Say so rather than
      // reporting a failure that would invite a retry.
      logger.warn('approveFeatureRequest: granted but request was already closed', { requestId })
    }

    /* Best-effort, after the grant landed. The bell reaches admins who happen
       to be signed in; a university administrator may sign in twice a year, so
       without this the upsell path ends in silence. */
    const { data: requester } = await adminDb
      .from('profiles')
      .select('email, first_name')
      .eq('id', request.requested_by)
      .maybeSingle()
    if (requester?.email) {
      await sendFeatureGranted(requester.email, requester.first_name || 'there', {
        featureLabel: featureLabelFor(feature),
        note: note?.trim() || null,
      })
    }

    revalidatePath('/super-admin/feature-requests')
    revalidatePath('/admin/settings')
    return { success: true }
  } catch (error) {
    logger.error('approveFeatureRequest: unexpected', error, { requestId })
    return { error: 'Could not approve the request. Please try again.' }
  }
}

/** Decline a pending request. Changes no entitlement. */
export async function declineFeatureRequest(
  requestId: string,
  note: string,
): Promise<{ success: true } | { error: string }> {
  try {
    const auth = await verifySuperAdmin()
    if ('error' in auth) return { error: auth.error }
    const reason = note?.trim()
    if (!reason) return { error: 'Add a short reason so the school knows why.' }
    if (reason.length > 2000) return { error: 'That reason is too long.' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    // Status in the WHERE rather than a read-then-write, so two admins acting
    // at once cannot both record a decision.
    const { data: closed, error } = await adminDb
      .from('institution_feature_requests')
      .update({
        status: 'declined',
        reviewed_by: auth.userId,
        reviewed_at: new Date().toISOString(),
        review_note: reason,
      })
      .eq('id', requestId)
      .eq('status', 'pending')
      .select('id, institution_id, feature_key, requested_by')
    if (error) {
      logger.error('declineFeatureRequest: update failed', error, { requestId })
      return { error: 'Could not decline the request. Please try again.' }
    }
    if (!closed?.length) return { error: 'Only pending requests can be declined.' }

    await notifyRequestDeclined(adminDb, {
      requesterId: closed[0].requested_by,
      actorId: auth.userId,
      featureKey: closed[0].feature_key,
      reason,
    })

    const { data: declinedRequester } = await adminDb
      .from('profiles')
      .select('email, first_name')
      .eq('id', closed[0].requested_by)
      .maybeSingle()
    if (declinedRequester?.email) {
      await sendFeatureRequestDeclined(
        declinedRequester.email,
        declinedRequester.first_name || 'there',
        { featureLabel: featureLabelFor(closed[0].feature_key), reason },
      )
    }

    await logEvent({
      eventType: 'institution.feature_request_declined',
      userId: auth.userId,
      metadata: {
        institutionId: closed[0].institution_id,
        featureKey: closed[0].feature_key,
      },
    })

    revalidatePath('/super-admin/feature-requests')
    revalidatePath('/admin/settings')
    return { success: true }
  } catch (error) {
    logger.error('declineFeatureRequest: unexpected', error, { requestId })
    return { error: 'Could not decline the request. Please try again.' }
  }
}
