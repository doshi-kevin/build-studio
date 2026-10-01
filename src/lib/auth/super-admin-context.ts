// Shared auth helper for super_admin server actions.
// Verifies the caller is a super_admin (read profile via cookie-bound
// client, check role). Used by the institutions/* actions and the new
// team-management actions in /super-admin/team/*. Does NOT use the
// admin client — RLS isn't the primary control here, this gate is.

import { createClient } from '@/lib/supabase/server'
import { profileQueries } from '@/lib/supabase/queries'

export type SuperAdminContext =
  | { userId: string; isPlatformOwner: boolean }
  | { error: string }

export async function verifySuperAdmin(): Promise<SuperAdminContext> {
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) {
    return { error: 'Unauthorized — not signed in' }
  }
  const profile = await profileQueries.getProfileById(supabase, user.id)
  if (!profile || profile.role !== 'super_admin') {
    return { error: 'Unauthorized — super_admin access required' }
  }
  // is_platform_owner is loaded via getProfileById; cast to boolean for
  // legacy profile shapes that don't include it yet.
  const isPlatformOwner =
    (profile as { is_platform_owner?: boolean }).is_platform_owner === true
  return { userId: user.id, isPlatformOwner }
}
