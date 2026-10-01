/**
 * Mounts Athena around the whole quizzes area, so the dock is reachable from the quiz LIST
 * and not only from inside a studio.
 *
 * This was previously a per-page mount on quizzes/[quizId], specifically so that leaving the
 * studio destroyed the dock — that was the only thing stopping a fill from landing on an
 * editor that had already unmounted. The cost was that the quizzes list had no Athena at all.
 *
 * The dock now EXPIRES its retained registration shortly after the last surface unregisters
 * (see AssignmentAthenaDock). On a real navigation `active` goes null, so a fill hits the
 * no-host fallback and is reported to the model as applied:false instead of calling into a
 * dead component. With that guarantee in the dock, a longer-lived provider is safe, and this
 * layout is the right home for it.
 *
 * Type: Server Component
 */
import type { ReactNode } from 'react'
import { checkEntitlementBySection } from '@/lib/entitlements/check'
import { createAdminClient as createAthenaEntitlementDb } from '@/lib/supabase/admin'
import { AssignmentAthenaProvider } from '@/components/professor/assignments/athena/AssignmentAthenaDock'

export default async function QuizzesLayout({
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
