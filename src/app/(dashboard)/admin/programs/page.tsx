/**
 * Programs Page — admin view of all academic programs.
 *
 * Fetches programs with department and director info, plus supporting
 * data for the create dialog dropdowns.
 *
 * Type: Server Component
 * Route: /admin/programs
 * Tables: programs, departments, profiles
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { verifyInstitutionAdmin } from '@/lib/auth/admin-context'
import { programQueries } from '@/lib/supabase/queries'
import { ProgramCardGrid } from '@/components/admin/programs/ProgramCardGrid'
import { logger } from '@/lib/logger'

export default async function ProgramsPage() {
  /* Re-check the role HERE, not only in the admin layout — layout and page segments
     render in PARALLEL and the admin layout denies by RETURNING a <DeadEnd/> rather
     than throwing, so relying on it let this page execute and stream the institution's
     department list plus every professor's name and email to any authenticated user.
     Returning null is correct here and is not the usual page pattern: the layout is
     already rendering the visible no-access dead end around this slot.

     This also closes a fail-open in the tenant filter. It used to read the institution
     from getCurrentInstitutionId() and apply the filters only `if (institutionId)` —
     so any caller whose profile carries no institution_id (a super_admin, or a profile
     missing the column) got EVERY department and EVERY professor across all
     institutions. verifyInstitutionAdmin returns institutionId from the verified
     profile and errors when it is absent, so the filters below are unconditional. */
  const auth = await verifyInstitutionAdmin('ProgramsPage')
  if ('error' in auth) {
    logger.warn('ProgramsPage: denied, skipping fetch', { reason: auth.error })
    return null
  }
  const institutionId = auth.institutionId

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any

  logger.debug('ProgramsPage: Fetching programs, departments, professors', { institutionId })
  /* The dropdowns inside ProgramCardGrid (department picker, director picker)
   * also need to be tenant-scoped or institution_admin would be able to assign
   * a UIUC professor to a Stevens program. Filter inline. */
  const deptListQuery = adminDb
    .from('departments')
    .select('id, name, code')
    .eq('institution_id', institutionId)
    .order('name')
  const profListQuery = adminDb
    .from('profiles')
    .select('id, name, email')
    .eq('role', 'professor')
    .eq('institution_id', institutionId)
    .order('name')
  const [programs, { data: departments }, { data: professors }] = await Promise.all([
    programQueries.getAllWithRelated(adminDb, institutionId),
    deptListQuery,
    profListQuery,
  ])
  logger.info('ProgramsPage: Loaded', { programs: programs.length })

  return (
    <div className="space-y-8">
      <div>
        <p className="text-[11px] font-semibold text-muted-foreground tracking-[0.2em] uppercase mb-2">Administration</p>
        <h1 className="font-[family-name:var(--font-instrument-serif)] text-[32px] tracking-tight">Programs</h1>
        <p className="text-[15px] text-muted-foreground mt-2">
          Manage academic programs, assign departments, and designate program directors.
        </p>
      </div>
      <ProgramCardGrid
        programs={programs}
        departments={departments || []}
        professors={professors || []}
      />
    </div>
  )
}
