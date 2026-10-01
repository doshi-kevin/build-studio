/**
 * Student Modules Page — published modules and their visible items.
 *
 * "Published" and "open" are different: a module behind a future `unlock_date` is
 * listed but empty (drawn dimmed, "Opens Aug 6"), so the student can see the course
 * continues; an unpublished one isn't listed at all. See `lib/modules/unlock.ts`.
 *
 * Selects an explicit column list rather than `*`: the rows are handed to a
 * client component, so every column fetched here ships to the browser in the
 * RSC payload. `instructor_note` is private teaching commentary and must not
 * be among them.
 *
 * Type: Server Component
 * Route: /student/courses/[sectionId]/modules
 */

import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import { signModuleItemContent } from '@/lib/supabase/signed-urls'
import { lockedModuleIds } from '@/lib/modules/unlock'
import { StudentModulesList } from '@/components/student/modules/StudentModulesList'
import { ModulesLoadError } from '@/components/student/modules/ModulesLoadError'
import {
  STUDENT_MODULE_COLUMNS,
  STUDENT_MODULE_ITEM_COLUMNS,
  type StudentModule,
  type StudentModuleItem,
} from '@/components/student/modules/types'
import {
  MODULE_DIVIDER_COLUMNS,
  mergeModuleRows,
  dropEmptyDividerGroups,
  type ModuleDivider,
} from '@/components/shared/modules/module-rows'

interface StudentModulesPageProps {
  params: Promise<{ sectionId: string }>
}

export default async function StudentModulesPage({ params }: StudentModulesPageProps) {
  const { sectionId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) return null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any

  /**
   * Verify enrollment HERE, not only in the section layout. This route has a
   * loading.tsx, which puts the page in its own Suspense boundary — so even though
   * the layout THROWS notFound() for a non-enrolled visitor, this segment still
   * resolves and its chunk is flushed into the response body. Everything below runs
   * on the admin client scoped only by the URL's sectionId, and signModuleItemContent
   * mints working storage URLs, so without this check any authenticated user holding
   * a section UUID could pull another institution's module titles AND download its
   * lecture PDFs. Confirmed by retrieving a cross-tenant PDF before the fix.
   *
   * Same inline-enrollment shape the discussions and announcements pages already use.
   */
  const { data: enrollment } = await adminDb
    .from('enrollments')
    .select('id')
    .eq('section_id', sectionId)
    .eq('student_id', user.id)
    .in('status', ['enrolled', 'completed'])
    .maybeSingle()

  /* notFound(), not `return null` (#740). A blank page reads as "the app is
     broken"; the dead-ends rule puts not-enrolled squarely in the notFound()
     column.

     I expected a 200 here — this route has a loading.tsx, and the Suspense note
     above is why streaming normally commits the status before a guard deeper in the
     page can change it. Measured in the browser it returns a real 404. Recorded
     because the reasoning is still worth knowing and the conclusion drawn from it
     was wrong. */
  if (!enrollment) {
    logger.warn('StudentModulesPage: not enrolled, skipping fetch', { sectionId, userId: user.id })
    notFound()
  }

  /* Dividers share the modules' position scale, so the breaks a student sees
     here are the same ones the roadmap draws. A divider is only a label —
     there is nothing on it to publish or hide. */
  const [
    { data: modules, error: modulesError },
    { data: dividers, error: dividersError },
  ] = await Promise.all([
    adminDb
      .from('modules')
      .select(STUDENT_MODULE_COLUMNS)
      .eq('section_id', sectionId)
      /* Unpublished is invisible; NOT-OPEN-YET is visible but empty. Only
         `is_published` filters here — a week behind a future `unlock_date` still
         comes back, so the list can draw it dimmed as "Opens Aug 6" and the student
         can see the course continues past today. What's withheld is its CONTENTS:
         the items read below is scoped to the open modules only (see `locked`), so
         no title, file or URL from an unopened week enters the payload. Clearing the
         date is how the professor opens it early (lib/modules/unlock.ts). */
      .eq('is_published', true)
      .order('position', { ascending: true }),
    adminDb
      .from('module_dividers')
      .select(MODULE_DIVIDER_COLUMNS)
      .eq('section_id', sectionId)
      .order('position', { ascending: true }),
  ])

  /* A failed query is NOT an empty course. Falling through to the empty state
     would tell the student their instructor has published nothing — a lie that
     sends them somewhere unhelpful instead of offering a retry. */
  if (modulesError) {
    logger.error('StudentModulesPage: Failed to load modules', modulesError, { sectionId })
    return <ModulesLoadError />
  }

  /* A missing divider is a missing heading, not missing coursework — log it and
     render the modules rather than blocking the whole page on a label. */
  if (dividersError) {
    logger.warn('StudentModulesPage: Failed to load module dividers', { sectionId, error: dividersError.message })
  }

  const moduleRows = (modules ?? []) as StudentModule[]
  /* The content gate. A locked week is ON the page (dimmed, "Opens Aug 6") but its
     items are never fetched — so its lecture titles, file paths and signed URLs
     don't reach the browser, and nothing downstream has to remember the rule. */
  const locked = lockedModuleIds(moduleRows)
  const openModuleIds = moduleRows.map((m) => m.id).filter((id) => !locked.has(id))

  /* Drop dividers heading an unpublished group — "Unit 2" with no Unit 2 under
     it reads as a bug. Done here rather than in the client so the payload
     matches what renders.

     NOT a confidentiality control: divider titles are deliberately visible to
     students (the roadmap ships all of them, stranded or not, and the divider
     dialog says so). Don't build an access decision on this filter. */
  const visibleDividers = dropEmptyDividerGroups(
    mergeModuleRows(moduleRows, (dividers ?? []) as ModuleDivider[]),
  )
    .filter((r) => r.kind === 'divider')
    .map((r) => (r as { divider: ModuleDivider }).divider)

  let items: StudentModuleItem[] = []
  if (openModuleIds.length > 0) {
    const { data: moduleItems, error: itemsError } = await adminDb
      .from('module_items')
      .select(STUDENT_MODULE_ITEM_COLUMNS)
      .in('module_id', openModuleIds)
      .eq('is_visible', true)
      .order('position', { ascending: true })

    if (itemsError) {
      logger.error('StudentModulesPage: Failed to load module items', itemsError, { sectionId })
      return <ModulesLoadError />
    }
    items = (moduleItems ?? []) as StudentModuleItem[]
  }

  /* Mint short-lived signed URLs for each item's file AND every extracted
   * image. course-materials is private (mig 48); legacy public URLs no
   * longer resolve. Shared helper keeps professor + student paths in sync. */
  if (items.length > 0) {
    items = (await signModuleItemContent(items)) as StudentModuleItem[]
  }

  const itemsByModule: Record<string, StudentModuleItem[]> = {}
  for (const item of items) {
    ;(itemsByModule[item.module_id] ??= []).push(item)
  }

  // Pre-class primers: when the professor has enabled the feature, find which
  // lecture items have an AVAILABLE primer (generated + toggled on) so the list
  // can show an inline "Listen before class" button on those rows.
  let availablePrimerItemIds: string[] = []
  const { data: section } = await adminDb
    .from('course_sections')
    .select('settings')
    .eq('id', sectionId)
    .maybeSingle()
  const enabledFeatures: string[] = Array.isArray(section?.settings?.enabledFeatures)
    ? section.settings.enabledFeatures
    : []
  if (enabledFeatures.includes('pre-class-audio')) {
    const lectureIds = items.filter((it) => it.item_type === 'lecture').map((it) => it.id)
    if (lectureIds.length > 0) {
      const { data: primers } = await adminDb
        .from('preclass_primers')
        .select('module_item_id, audio_path, is_available')
        .in('module_item_id', lectureIds)
        .eq('is_available', true)
      availablePrimerItemIds = ((primers ?? []) as Array<{ module_item_id: string; audio_path: string | null }>)
        .filter((p) => !!p.audio_path)
        .map((p) => p.module_item_id)
    }
  }

  logger.info('StudentModulesPage: Loaded', {
    sectionId,
    modules: moduleRows.length,
    items: items.length,
  })

  return (
    <StudentModulesList
      sectionId={sectionId}
      modules={moduleRows}
      dividers={visibleDividers}
      itemsByModule={itemsByModule}
      availablePrimerItemIds={availablePrimerItemIds}
    />
  )
}
