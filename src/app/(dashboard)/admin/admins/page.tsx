// Admin team page — institution_admin can grow their team up to 5 admins.
// Shows current admins (pending + accepted), an invite form when under cap,
// and inline Resend / Revoke controls for pending invites.

import { createAdminClient } from '@/lib/supabase/admin'
import { verifyInstitutionAdmin } from '@/lib/auth/admin-context'
import { logger } from '@/lib/logger'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { MAX_ADMINS_PER_INSTITUTION } from '@/lib/validations/admin-invite'
import { AdminTeamView } from '@/components/admin/admins/AdminTeamView'

export const dynamic = 'force-dynamic'

export default async function AdminTeamPage() {
  const auth = await verifyInstitutionAdmin('AdminTeamPage')
  if ('error' in auth) {
    return (
      <Card className="max-w-md mx-auto mt-16">
        <CardHeader><CardTitle>Access denied</CardTitle></CardHeader>
        <CardContent className="text-sm text-muted-foreground">{auth.error}</CardContent>
      </Card>
    )
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any

  const { data: admins, error } = await adminDb
    .from('profiles')
    .select('id, email, name, invite_status, invited_at, last_login_at, onboarding_completed')
    .eq('institution_id', auth.institutionId)
    .eq('role', 'institution_admin')
    .order('invited_at', { ascending: false, nullsFirst: false })

  if (error) {
    logger.error('AdminTeamPage: failed to load admins', error, { institutionId: auth.institutionId })
  }

  const adminList = (admins || []) as Array<{
    id: string
    email: string
    name: string | null
    invite_status: string | null
    invited_at: string | null
    last_login_at: string | null
    onboarding_completed: boolean | null
  }>

  logger.info('AdminTeamPage: loaded', {
    institutionId: auth.institutionId,
    count: adminList.length,
    cap: MAX_ADMINS_PER_INSTITUTION,
  })

  return (
    <div className="space-y-8 max-w-4xl mx-auto">
      <div>
        <p className="text-[11px] font-semibold text-muted-foreground tracking-[0.2em] uppercase mb-2">
          Administration
        </p>
        <h1 className="font-[family-name:var(--font-instrument-serif)] text-[32px] tracking-tight">
          Administrators
        </h1>
        <p className="text-[15px] text-muted-foreground mt-2">
          Up to {MAX_ADMINS_PER_INSTITUTION}{' '}institution administrators can manage your tenant.
          Invite teammates here; they&apos;ll receive a welcome email with a temporary password.
        </p>
      </div>

      <AdminTeamView admins={adminList} currentUserId={auth.userId} cap={MAX_ADMINS_PER_INSTITUTION} />
    </div>
  )
}
