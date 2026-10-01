/**
 * Projects layout — mounts the single generalized Athena dock across every
 * projects page (list and detail). The project detail screen registers what
 * Athena can act on via useAthenaSurface; the dock lives here so it persists
 * across navigation within the feature, exactly as the assignments layout does.
 */

import type { ReactNode } from 'react'
import { checkEntitlementBySection } from '@/lib/entitlements/check'
import { createAdminClient as createAthenaEntitlementDb } from '@/lib/supabase/admin'
import { AssignmentAthenaProvider } from '@/components/professor/assignments/athena/AssignmentAthenaDock'

export default async function ProjectsLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ sectionId: string }>
}) {
  const { sectionId } = await params
  /* Whether this school has Athena at all, distinct from whether AI is safe to
     run right now. Without it the ask bar is offered and the API refuses, which
     is a request the professor can never complete. */
  const athenaEntitled = (
    await checkEntitlementBySection(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createAthenaEntitlementDb() as any,
      sectionId,
      'athena',
    )
  ).allowed
  return (
    <AssignmentAthenaProvider sectionId={sectionId} entitled={athenaEntitled}>
      {children}
    </AssignmentAthenaProvider>
  )
}
