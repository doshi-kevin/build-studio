// Shared verifier for institution-admin server actions.
//
// Replaces the 8 copies of `async function verifyAdmin()` previously duplicated
// across admin/*/actions.ts. Returns userId + institutionId so every action
// can scope its writes to the caller's tenant. RLS is not the primary control;
// this gate is.
//
// Returns either { userId, institutionId } on success, or { error } if the
// caller is not signed in / not an institution_admin / has no institution_id /
// the institution is suspended. The suspension check here is critical — without
// it, an admin with a stale tab can keep firing server actions after their
// tenant is paused, since DashboardLayout only blocks page renders.

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { profileQueries } from '@/lib/supabase/queries'
import { logger } from '@/lib/logger'

export type AdminContextSuccess = { userId: string; institutionId: string }
export type AdminContextError = { error: string }
export type AdminContext = AdminContextSuccess | AdminContextError

export async function verifyInstitutionAdmin(actionName?: string): Promise<AdminContext> {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return { error: 'Not authenticated' }
  }

  const profile = await profileQueries.getProfileById(supabase, user.id)
  if (!profile || profile.role !== 'institution_admin') {
    logger.warn('verifyInstitutionAdmin: Unauthorized', {
      userId: user.id,
      role: profile?.role,
      action: actionName,
    })
    return { error: 'Unauthorized — admin access required' }
  }

  const institutionId = profile.institution_id
  if (!institutionId) {
    logger.error('verifyInstitutionAdmin: Admin has no institution_id', null, {
      userId: user.id,
      action: actionName,
    })
    return { error: 'Your account is not linked to an institution. Contact support.' }
  }

  /* Suspension gate. Cheap path: read JWT app_metadata.institution_status,
   * synced by the institutions UPDATE trigger. Fallback path: DB query — covers
   * users whose JWT predates the trigger (one-time backfill handles existing
   * users, but defensive code is cheap). */
  const jwtStatus = (user.app_metadata as { institution_status?: string } | undefined)?.institution_status

  if (jwtStatus === 'suspended') {
    logger.warn('verifyInstitutionAdmin: Suspended institution blocked (JWT)', {
      userId: user.id,
      institutionId,
      action: actionName,
    })
    return { error: 'Your institution is suspended. Contact Scholera support.' }
  }

  if (jwtStatus !== 'active') {
    /* Fallback: hit DB. Should be rare post-backfill. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    const { data: institution, error: instErr } = await adminDb
      .from('institutions')
      .select('status')
      .eq('id', institutionId)
      .maybeSingle()

    if (instErr) {
      logger.error('verifyInstitutionAdmin: Institution status fetch failed', instErr, {
        userId: user.id,
        institutionId,
        action: actionName,
      })
      return { error: 'Could not verify institution status. Try again.' }
    }

    if (!institution) {
      logger.error('verifyInstitutionAdmin: Institution missing', null, {
        userId: user.id,
        institutionId,
        action: actionName,
      })
      return { error: 'Your institution record is missing. Contact support.' }
    }

    if (institution.status === 'suspended') {
      logger.warn('verifyInstitutionAdmin: Suspended institution blocked (DB fallback)', {
        userId: user.id,
        institutionId,
        action: actionName,
      })
      return { error: 'Your institution is suspended. Contact Scholera support.' }
    }
  }

  return { userId: user.id, institutionId }
}
