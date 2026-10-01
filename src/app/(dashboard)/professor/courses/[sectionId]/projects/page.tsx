/**
 * Professor Projects Page — server component that fetches projects
 * and renders the ProjectList client component.
 *
 * Type: Server Component
 * Route: /professor/courses/[sectionId]/projects
 */

import { notFound } from 'next/navigation'
import { verifyEntitled } from '@/lib/entitlements/check'
import { createAdminClient as createEntitlementDb } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { projectQueries, enrollmentQueries } from '@/lib/supabase/queries'
import { verifySectionAccess } from '@/lib/auth/section-access'
import { ProjectList } from '@/components/professor/projects/ProjectList'

interface ProjectsPageProps {
  params: Promise<{ sectionId: string }>
}

export default async function ProjectsPage({ params }: ProjectsPageProps) {
  const { sectionId } = await params

  /* The institution ceiling. A feature the school has not bought is a dead end,
     not a page with buttons that fail (.claude/rules/dead-ends.md). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await verifyEntitled(createEntitlementDb() as any, sectionId, 'projects')
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) notFound()

  const access = await verifySectionAccess(sectionId, user.id)
  if (!access.ok) notFound()
  const { adminDb } = access

  const projects = await projectQueries.getSectionProjects(adminDb, sectionId)
  const enrollments = await enrollmentQueries.getSectionEnrollments(adminDb, sectionId)

  return (
    <ProjectList
      sectionId={sectionId}
      projects={projects}
      enrolledCount={enrollments?.length ?? 0}
    />
  )
}
