/**
 * Departments Page — admin view of all departments in the institution.
 *
 * Fetches all departments with counts (programs, courses, faculty)
 * and passes to DepartmentTable for interactive CRUD.
 *
 * Type: Server Component
 * Route: /admin/departments
 * Tables: departments, programs, courses, department_faculty
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { verifyInstitutionAdmin } from '@/lib/auth/admin-context'
import { departmentQueries } from '@/lib/supabase/queries'
import { getCurrentInstitutionId } from '@/lib/auth/tenant-context'
import { DepartmentCardGrid } from '@/components/admin/departments/DepartmentCardGrid'
import { logger } from '@/lib/logger'

export default async function DepartmentsPage() {
  /* Re-check the role HERE, not only in the admin layout. Layout and page segments
     render in PARALLEL and the admin layout denies by RETURNING a <DeadEnd/> rather
     than throwing, so without this guard the page still executed and streamed its
     admin-only data into the response body for any authenticated user of this
     institution. Returning null is correct here and is not the usual page pattern —
     the layout is already rendering the visible no-access dead end around this slot. */
  const auth = await verifyInstitutionAdmin('DepartmentsPage')
  if ('error' in auth) {
    logger.warn('DepartmentsPage: denied, skipping fetch', { reason: auth.error })
    return null
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any
  const institutionId = await getCurrentInstitutionId()

  logger.debug('DepartmentsPage: Fetching departments with counts', { institutionId })
  const departments = await departmentQueries.getAllWithCounts(adminDb, institutionId ?? undefined)
  logger.info('DepartmentsPage: Loaded', { count: departments.length })

  return (
    <div className="space-y-8">
      <div>
        <p className="text-[11px] font-semibold text-muted-foreground tracking-[0.2em] uppercase mb-2">Administration</p>
        <h1 className="font-[family-name:var(--font-instrument-serif)] text-[32px] tracking-tight">Departments</h1>
        <p className="text-[15px] text-muted-foreground mt-2">
          Manage academic departments, their programs, and faculty assignments.
        </p>
      </div>
      <DepartmentCardGrid departments={departments} />
    </div>
  )
}
