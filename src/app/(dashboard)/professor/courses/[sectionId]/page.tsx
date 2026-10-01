/**
 * Course Landing Page — the About page builder is the default view
 * when a professor enters a course.
 *
 * Fetches section data server-side, parses about content from JSONB,
 * and renders the AboutPageBuilder client component.
 *
 * Type: Server Component
 * Route: /professor/courses/[sectionId]
 */

import { notFound } from 'next/navigation'
import { checkEntitlementBySection } from '@/lib/entitlements/check'
import { createAdminClient as createAthenaEntitlementDb } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { courseQueries } from '@/lib/supabase/queries'
import { logger } from '@/lib/logger'
import { parseAboutContent } from '@/lib/validations/course-about'
import { resolveAboutAssetUrls } from '@/lib/supabase/about-assets'
import { AboutPageBuilder } from '@/components/professor/about/AboutPageBuilder'
import { AssignmentAthenaProvider } from '@/components/professor/assignments/athena/AssignmentAthenaDock'

interface CourseRootPageProps {
  params: Promise<{ sectionId: string }>
}

export default async function CourseRootPage({ params }: CourseRootPageProps) {
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
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) return null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any
  const section = await courseQueries.getProfessorSectionDetail(adminDb, sectionId, user.id)

  if (!section) {
    notFound()
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resolveJoin = (val: any) => (Array.isArray(val) ? val[0] : val)
  const course = resolveJoin(section.course)
  const department = resolveJoin(course?.department)

  const aboutContent = await resolveAboutAssetUrls(adminDb, parseAboutContent(section.settings))

  // Fetch professor profile name for hero block prefill
  const { data: profile } = await adminDb
    .from('profiles')
    .select('name')
    .eq('id', user.id)
    .single()

  const semester = section.semester && section.year
    ? `${section.semester.charAt(0).toUpperCase() + section.semester.slice(1)} ${section.year}`
    : undefined

  logger.info('CourseRootPage: Loaded', { sectionId, course: course?.code })

  // The Athena provider wraps ONLY this page (never the [sectionId] layout —
  // that would put the dock on every course page). The builder registers itself
  // as the 'about' surface and mounts the ask-line trigger in edit mode.
  return (
    <AssignmentAthenaProvider sectionId={sectionId} entitled={athenaEntitled}>
      <AboutPageBuilder
        sectionId={sectionId}
        initialContent={aboutContent}
        courseInfo={{
          code: course?.code || '',
          title: course?.title || '',
          department: department?.name,
          credits: course?.credits,
          semester,
          instructor: profile?.name || undefined,
        }}
      />
    </AssignmentAthenaProvider>
  )
}
