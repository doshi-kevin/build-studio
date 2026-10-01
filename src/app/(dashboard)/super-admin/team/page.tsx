// Super admin team page — invite and manage other super_admins, transfer
// platform ownership. Cap of MAX_SUPER_ADMINS (5).

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { profileQueries } from '@/lib/supabase/queries'
import { logger } from '@/lib/logger'
import { MAX_SUPER_ADMINS } from '@/lib/validations/super-admin-invite'
import {
  SuperAdminTeamView,
  type SuperAdminRow,
} from '@/components/super-admin/team/SuperAdminTeamView'

export const dynamic = 'force-dynamic'

export default async function SuperAdminTeamPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const profile = await profileQueries.getProfileById(supabase, user.id)
  if (!profile || profile.role !== 'super_admin') {
    redirect('/dashboard')
  }
  const currentUserIsOwner =
    (profile as { is_platform_owner?: boolean }).is_platform_owner === true

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any

  const { data: rows, error } = await adminDb
    .from('profiles')
    .select('id, email, name, invite_status, invited_at, last_login_at, is_platform_owner, onboarding_completed')
    .eq('role', 'super_admin')
    .order('is_platform_owner', { ascending: false })
    .order('invited_at', { ascending: false, nullsFirst: false })

  if (error) {
    logger.error('SuperAdminTeamPage: failed to load super admins', error)
  }

  const superAdmins = (rows || []) as SuperAdminRow[]

  logger.info('SuperAdminTeamPage: loaded', {
    count: superAdmins.length,
    cap: MAX_SUPER_ADMINS,
    currentUserIsOwner,
  })

  return (
    <div className="space-y-8 max-w-5xl mx-auto">
      <div>
        <p className="text-[11px] font-semibold text-muted-foreground tracking-[0.2em] uppercase mb-2">
          Platform
        </p>
        <h1 className="font-[family-name:var(--font-instrument-serif)] text-[32px] tracking-tight">
          Super admins
        </h1>
        <p className="text-[15px] text-muted-foreground mt-2">
          Up to {MAX_SUPER_ADMINS} super admins can operate Scholera. The platform owner is the
          topmost role — they can transfer ownership but cannot be removed by anyone else.
        </p>
      </div>

      <SuperAdminTeamView
        superAdmins={superAdmins}
        currentUserId={user.id}
        currentUserIsOwner={currentUserIsOwner}
        cap={MAX_SUPER_ADMINS}
      />
    </div>
  )
}
