/**
 * Super Admin Dashboard / Institutions List
 *
 * Landing page for the super_admin tier. Shows every institution with its
 * profile counts and admin-presence badge, plus a CTA to create a new one.
 *
 * Type: Server Component
 * Route: /super-admin
 */

import Link from 'next/link'
import { Plus } from 'lucide-react'
import { createAdminClient } from '@/lib/supabase/admin'
import { verifySuperAdmin } from '@/lib/auth/super-admin-context'
import { institutionQueries } from '@/lib/supabase/queries'
import { logger } from '@/lib/logger'
import { InstitutionsTable, type InstitutionRow } from '@/components/super-admin/institutions/InstitutionsTable'

export const dynamic = 'force-dynamic'

export default async function SuperAdminPage() {
  /**
   * Re-check the role HERE, not just in the layout. The App Router renders layout
   * and page segments in PARALLEL, and the super-admin layout denies by RETURNING a
   * <DeadEnd/> rather than throwing — which stops the page from being DISPLAYED but
   * does not stop it from executing and streaming its data into the response. Without
   * this guard an ordinary student GETting /super-admin received a 200 whose body
   * carried every institution on the platform with its user counts.
   *
   * Returning null is correct in this one case and is not the usual page pattern: the
   * layout is already rendering the visible no-access dead end around this slot, so
   * the user never sees a blank screen — the concern behind the never-return-null rule.
   */
  const auth = await verifySuperAdmin()
  if ('error' in auth) {
    logger.warn('SuperAdminPage: denied, skipping fetch', { reason: auth.error })
    return null
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any

  const institutions = (await institutionQueries.getAllWithCounts(adminDb)) as InstitutionRow[]
  logger.info('SuperAdminPage: Loaded', { count: institutions.length })

  const noAdminCount = institutions.filter((i) => i.admin_count === 0).length

  return (
    <div className="space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
        <div>
          <p className="text-[11px] font-semibold text-muted-foreground tracking-[0.2em] uppercase mb-2">
            Platform
          </p>
          <h1 className="font-[family-name:var(--font-instrument-serif)] text-[32px] tracking-tight">
            Institutions
          </h1>
          <p className="text-[15px] text-muted-foreground mt-2">
            Every university and tenant on Scholera. Provision a new institution to invite an
            institution admin who will manage their own departments, professors, and students.
          </p>
          {noAdminCount > 0 && (
            <p className="text-[13px] text-warning-muted-foreground mt-2">
              {noAdminCount === 1
                ? '1 institution has no admin assigned.'
                : `${noAdminCount} institutions have no admin assigned.`}
            </p>
          )}
        </div>

        <Link
          href="/super-admin/institutions/new"
          className="inline-flex items-center gap-2 rounded-full bg-primary text-primary-foreground px-5 py-2.5 text-sm font-semibold hover:scale-[1.02] active:scale-95 transition-transform shrink-0"
        >
          <Plus className="h-4 w-4" />
          Create Institution
        </Link>
      </div>

      <InstitutionsTable institutions={institutions} />
    </div>
  )
}
