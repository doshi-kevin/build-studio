/**
 * Retired route — the module editor is now a section of the one-page board.
 *
 * Kept as a redirect because existing links point here: the roadmap canvas,
 * bookmarks, and the citation hrefs built by lib/extraction/citation.ts
 * (`…/modules/<moduleId>?item=<itemId>&page=N`).
 *
 * Type: Server Component
 * Route: /professor/courses/[sectionId]/modules/[moduleId]
 */

import { redirect } from 'next/navigation'
import { buildModulesHref } from '@/components/shared/modules/module-href'

interface RetiredModulePageProps {
  params: Promise<{ sectionId: string; moduleId: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function RetiredModulePage({
  params,
  searchParams,
}: RetiredModulePageProps) {
  const { sectionId, moduleId } = await params
  redirect(
    buildModulesHref(`/professor/courses/${sectionId}/modules`, moduleId, await searchParams),
  )
}
