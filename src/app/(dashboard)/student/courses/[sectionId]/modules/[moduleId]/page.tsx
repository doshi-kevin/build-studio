/**
 * Redirect for student module deep links.
 *
 * This route never existed, so every student-facing citation link produced by
 * lib/extraction/citation.ts — `/student/courses/<id>/modules/<moduleId>?item=…`
 * — has been 404ing. The one-page board can serve them, so the shim both fixes
 * those links and matches the professor side.
 *
 * Type: Server Component
 * Route: /student/courses/[sectionId]/modules/[moduleId]
 */

import { redirect } from 'next/navigation'
import { buildModulesHref } from '@/components/shared/modules/module-href'

interface StudentModuleDeepLinkProps {
  params: Promise<{ sectionId: string; moduleId: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function StudentModuleDeepLink({
  params,
  searchParams,
}: StudentModuleDeepLinkProps) {
  const { sectionId, moduleId } = await params
  redirect(
    buildModulesHref(`/student/courses/${sectionId}/modules`, moduleId, await searchParams),
  )
}
