// Tenant context helper. Returns the institution_id of the currently
// authenticated user. Reads from auth.users.app_metadata first (cheap, no DB
// hop — kept in sync by the sync_institution_to_auth_metadata trigger from
// migration 044). Falls back to a profiles lookup if the JWT field is
// missing for some reason (e.g. user created before the trigger landed).
//
// Use this anywhere you're calling a queries.ts function that needs to be
// tenant-scoped — pass the result as the institutionId argument.

import { createClient } from '@/lib/supabase/server'
import { profileQueries } from '@/lib/supabase/queries'
import { logger } from '@/lib/logger'

/**
 * Returns the institution_id of the currently authenticated user, or null if
 * not signed in. Intended for use in server components and server actions.
 */
export async function getCurrentInstitutionId(): Promise<string | null> {
  const supabase = await createClient()
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) return null

  /* JWT fast path — set by the sync trigger on every profile insert/update. */
  const jwtInst = (user.app_metadata as { institution_id?: unknown } | null)?.institution_id
  if (typeof jwtInst === 'string' && jwtInst.length > 0) return jwtInst

  /* DB fallback — slower, but correct for users that pre-date the trigger. */
  const profile = await profileQueries.getProfileById(supabase, user.id)
  if (!profile?.institution_id) {
    logger.warn('getCurrentInstitutionId: User has no institution_id', { userId: user.id })
    return null
  }
  return profile.institution_id
}
