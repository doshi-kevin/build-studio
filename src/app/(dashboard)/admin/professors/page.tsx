/**
 * Professors Page — lists all professors with search, filter, and invite.
 *
 * Type: Server Component
 * Route: /admin/professors
 * Tables: profiles, department_faculty, departments
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { verifyInstitutionAdmin } from '@/lib/auth/admin-context'
import { professorQueries, departmentQueries } from '@/lib/supabase/queries'
import { getCurrentInstitutionId } from '@/lib/auth/tenant-context'
import { ProfessorCardGrid } from '@/components/admin/professors/ProfessorCardGrid'
import { logger } from '@/lib/logger'

export default async function ProfessorsPage() {
  /* Re-check the role HERE, not only in the admin layout. Layout and page segments
     render in PARALLEL and the admin layout denies by RETURNING a <DeadEnd/> rather
     than throwing, so without this guard the page still executed and streamed its
     admin-only data into the response body for any authenticated user of this
     institution. Returning null is correct here and is not the usual page pattern —
     the layout is already rendering the visible no-access dead end around this slot. */
  const auth = await verifyInstitutionAdmin('ProfessorsPage')
  if ('error' in auth) {
    logger.warn('ProfessorsPage: denied, skipping fetch', { reason: auth.error })
    return null
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any
  const institutionId = await getCurrentInstitutionId()

  logger.debug('ProfessorsPage: Fetching professors and departments', { institutionId })
  const [professors, departments] = await Promise.all([
    professorQueries.getAllWithDepartments(adminDb, institutionId ?? undefined),
    departmentQueries.getAll(adminDb, institutionId ?? undefined),
  ])
  logger.info('ProfessorsPage: Loaded', { professors: professors.length, departments: departments.length })

  return (
    <div className="space-y-8">
      <div>
        <p className="text-[11px] font-semibold text-muted-foreground tracking-[0.2em] uppercase mb-2">Administration</p>
        <h1 className="font-[family-name:var(--font-instrument-serif)] text-[32px] tracking-tight">Professors</h1>
        <p className="text-[15px] text-muted-foreground mt-2">
          Manage professors and their department assignments.
        </p>
      </div>
      <ProfessorCardGrid professors={professors} departments={departments} />
    </div>
  )
}
