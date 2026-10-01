/**
 * Student Course About Page — read-only block preview of the course about page.
 *
 * Reuses the professor's BlockPreview component directly, WITHOUT the
 * onEditBlock prop — that prop is the only thing that produces the click-to-edit
 * affordance, so a student's DOM never carries one.
 *
 * Type: Server Component
 * Route: /student/courses/[sectionId]
 */

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { studentCatalogQueries } from '@/lib/supabase/queries'
import { logger } from '@/lib/logger'
import { parseAboutContent } from '@/lib/validations/course-about'
import { resolveAboutAssetUrls, stripPrivateAssetFields } from '@/lib/supabase/about-assets'
import { BlockPreview } from '@/components/professor/about/BlockPreview'
import { StudentPastTools } from '@/components/student/courses/StudentPastTools'
import { studentPastTools } from '@/lib/studio/navigation'

interface StudentCourseRootPageProps {
  params: Promise<{ sectionId: string }>
}

export default async function StudentCourseRootPage({ params }: StudentCourseRootPageProps) {
  const { sectionId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) return null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any

  /* Re-verify enrollment here, not only in the layout. A layout and its page
     render in parallel, so a layout that calls notFound() does not stop this
     file's queries from running — the house rule after the PR #555 leak is that
     every page guards its own fetch. getStudentSectionDetail is the same
     enrollment check the layout uses. */
  const section = await studentCatalogQueries.getStudentSectionDetail(adminDb, sectionId, user.id)

  if (!section) {
    logger.warn('StudentCourseRootPage: Not found or not enrolled', { sectionId, userId: user.id })
    return (
      <div className="text-center py-12">
        <p className="text-sm text-muted-foreground">Course not found or you don&apos;t have access.</p>
      </div>
    )
  }

  const [aboutContent, pastTools] = await Promise.all([
    resolveAboutAssetUrls(adminDb, parseAboutContent(section.settings)).then(stripPrivateAssetFields),
    // Studio tools the professor removed after showing them: history, below the page.
    studentPastTools(sectionId),
  ])

  logger.info('StudentCourseRootPage: Loaded', { sectionId })

  /* No page heading of its own. The hero block already renders the course title
     as the page's <h1>; adding "About this Course" above it put two <h1>s on
     every course page, one of them saying less than the other. */
  return (
    <>
      <BlockPreview blocks={aboutContent.blocks} />
      <StudentPastTools sectionId={sectionId} tools={pastTools} />
    </>
  )
}
