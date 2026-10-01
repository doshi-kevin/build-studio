/**
 * Admin Staff Hub — single page combining the TA/Grader directory with
 * the pending-request approval queue. Tabs let admins audit existing
 * staff and triage incoming professor requests without bouncing between
 * sidebar entries.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { sectionStaffQueries, departmentQueries } from '@/lib/supabase/queries'
import { verifyInstitutionAdmin } from '@/lib/auth/admin-context'
import { logger } from '@/lib/logger'
import { StaffHub } from '@/components/admin/staff/StaffHub'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export default async function AdminStaffPage() {
  const auth = await verifyInstitutionAdmin('AdminStaffPage')
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

  const [assignments, departments, pendingRequests] = await Promise.all([
    sectionStaffQueries.listAllForAdmin(adminDb, auth.institutionId),
    departmentQueries.getAll(adminDb, auth.institutionId),
    sectionStaffQueries.listAllPendingRequests(adminDb, auth.institutionId),
  ])

  logger.info('AdminStaffPage: Loaded', {
    assignments: assignments.length,
    departments: departments.length,
    pendingRequests: pendingRequests.length,
  })

  return (
    <div className="space-y-8">
      <div>
        <p className="text-[11px] font-semibold text-muted-foreground tracking-[0.2em] uppercase mb-2">
          Administration
        </p>
        <h1 className="font-[family-name:var(--font-instrument-serif)] text-[32px] tracking-tight">
          Course Assistants
        </h1>
        <p className="text-[15px] text-muted-foreground mt-2">
          Manage approved course assistants (TAs and graders), and review new requests submitted by
          professors. Use the tabs below to switch between the directory and the pending queue.
        </p>
      </div>

      <StaffHub
        assignments={assignments}
        departments={departments}
        pendingRequests={pendingRequests}
      />
    </div>
  )
}
