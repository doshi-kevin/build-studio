/**
 * Students Page — admin view of all students in the institution.
 *
 * Fetches all students and departments, passes to StudentTable
 * for interactive search, filter, add, and delete.
 *
 * Type: Server Component
 * Route: /admin/students
 * Tables: profiles (role=student), departments
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { verifyInstitutionAdmin } from '@/lib/auth/admin-context'
import { studentQueries, departmentQueries } from '@/lib/supabase/queries'
import { getCurrentInstitutionId } from '@/lib/auth/tenant-context'
import { StudentCardGrid } from '@/components/admin/students/StudentCardGrid'
import { EnrollmentPolicyCard } from '@/components/admin/students/EnrollmentPolicyCard'
import { parseInstitutionSettings } from '@/lib/validations/institution-settings'
import { logger } from '@/lib/logger'

export default async function StudentsPage() {
  /* Re-check the role HERE, not only in the admin layout. Layout and page segments
     render in PARALLEL and the admin layout denies by RETURNING a <DeadEnd/> rather
     than throwing, so without this guard the page still executed and streamed its
     admin-only data into the response body for any authenticated user of this
     institution. Returning null is correct here and is not the usual page pattern —
     the layout is already rendering the visible no-access dead end around this slot. */
  const auth = await verifyInstitutionAdmin('StudentsPage')
  if ('error' in auth) {
    logger.warn('StudentsPage: denied, skipping fetch', { reason: auth.error })
    return null
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any
  const institutionId = await getCurrentInstitutionId()

  logger.debug('StudentsPage: Fetching students and departments', { institutionId })
  const [students, departments, institutionRes] = await Promise.all([
    studentQueries.getAll(adminDb, institutionId ?? undefined),
    departmentQueries.getAll(adminDb, institutionId ?? undefined),
    adminDb.from('institutions').select('settings').eq('id', auth.institutionId).maybeSingle(),
  ])
  const settings = parseInstitutionSettings(institutionRes?.data?.settings)
  logger.info('StudentsPage: Loaded', { students: students.length, departments: departments.length })

  return (
    <div className="space-y-8">
      <div>
        <p className="text-[11px] font-semibold text-muted-foreground tracking-[0.2em] uppercase mb-2">Administration</p>
        <h1 className="font-[family-name:var(--font-instrument-serif)] text-[32px] tracking-tight">Students</h1>
        <p className="text-[15px] text-muted-foreground mt-2">
          Manage students, add new students, and view enrollment details.
        </p>
      </div>
      <EnrollmentPolicyCard initialPolicy={settings.selfUnenroll} initialUpdatedAt={institutionRes?.data?.updated_at ?? null} />
      <StudentCardGrid students={students} departments={departments} />
    </div>
  )
}
