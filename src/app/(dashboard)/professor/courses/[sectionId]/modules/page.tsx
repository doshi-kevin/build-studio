/**
 * Modules Page — every module for a section, with its items, on one page.
 *
 * Fetches items here rather than just counts: the board shows what each module
 * contains from its collapsed header, and search spans the whole course.
 * Wrapped in Suspense for useSearchParams() in the client tree.
 *
 * Type: Server Component
 * Route: /professor/courses/[sectionId]/modules
 */

import { Suspense } from 'react'
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { courseQueries } from '@/lib/supabase/queries'
import { signModuleItemContent } from '@/lib/supabase/signed-urls'
import { ModulesBoard } from '@/components/professor/modules/ModulesBoard'
import {
  MODULE_DIVIDER_COLUMNS,
  type ModuleDivider,
} from '@/components/shared/modules/module-rows'
import type { PrimerState } from '@/components/professor/modules/PrimerControl'
import { Skeleton } from '@/components/ui/skeleton'
import type { Module, ModuleItem } from '@/lib/supabase/types'

interface ModulesPageProps {
  params: Promise<{ sectionId: string }>
}

export default async function ModulesPage({ params }: ModulesPageProps) {
  const { sectionId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) return null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any
  const section = await courseQueries.getProfessorSectionDetail(adminDb, sectionId, user.id)

  if (!section) {
    notFound()
  }

  // Modules and module-level dividers share one position scale — they render as
  // a single reorderable list (see reorderModules).
  const [{ data: modules }, { data: dividers }] = await Promise.all([
    adminDb
      .from('modules')
      .select('*')
      .eq('section_id', sectionId)
      .order('position', { ascending: true }),
    adminDb
      .from('module_dividers')
      .select(MODULE_DIVIDER_COLUMNS)
      .eq('section_id', sectionId)
      .order('position', { ascending: true }),
  ])

  const moduleRows = (modules ?? []) as Module[]
  const moduleIds = moduleRows.map((m) => m.id)

  let items: ModuleItem[] = []
  if (moduleIds.length > 0) {
    const { data: moduleItems } = await adminDb
      .from('module_items')
      .select('*')
      .in('module_id', moduleIds)
      .order('position', { ascending: true })
    items = (moduleItems ?? []) as ModuleItem[]
  }

  /* course-materials is private (mig 48); legacy fileUrl values 404 at fetch
   * time. Mint short-lived signed URLs for the file and any extracted images
   * before handing items to the client — one batched round-trip for the page. */
  if (items.length > 0) {
    items = (await signModuleItemContent(items)) as ModuleItem[]
  }

  const itemsByModule: Record<string, ModuleItem[]> = {}
  for (const item of items) {
    ;(itemsByModule[item.module_id] ??= []).push(item)
  }

  // Pre-class primers: only surface the per-lecture control when the professor
  // has enabled the feature. When enabled, batch-read primer state for every
  // lecture on the page so each row shows its state without a client fetch.
  const enabledFeatures: string[] = Array.isArray(section.settings?.enabledFeatures)
    ? section.settings.enabledFeatures
    : []
  const primersEnabled = enabledFeatures.includes('pre-class-audio')

  let primerStates: Record<string, PrimerState> | undefined
  if (primersEnabled) {
    const lectureIds = items.filter((it) => it.item_type === 'lecture').map((it) => it.id)
    if (lectureIds.length > 0) {
      const { data: primers } = await adminDb
        .from('preclass_primers')
        .select('module_item_id, status, is_available')
        .in('module_item_id', lectureIds)
      primerStates = Object.fromEntries(
        (
          (primers ?? []) as Array<{
            module_item_id: string
            status: 'ready' | 'generating' | 'failed'
            is_available: boolean
          }>
        ).map((p) => [p.module_item_id, { status: p.status, available: p.is_available }]),
      )
    }
  }

  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-5xl space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-2">
              <Skeleton className="h-8 w-32 rounded-xl" />
              <Skeleton className="h-4 w-72 rounded-xl" />
            </div>
            <Skeleton className="h-9 w-32 rounded-xl" />
          </div>
          <Skeleton className="h-9 w-full rounded-xl" />
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-20 w-full rounded-2xl" />
            ))}
          </div>
        </div>
      }
    >
      <ModulesBoard
        sectionId={sectionId}
        modules={moduleRows}
        dividers={(dividers ?? []) as ModuleDivider[]}
        itemsByModule={itemsByModule}
        primersEnabled={primersEnabled}
        primerStates={primerStates}
      />
    </Suspense>
  )
}
