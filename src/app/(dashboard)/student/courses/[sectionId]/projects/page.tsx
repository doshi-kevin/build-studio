/**
 * Student Projects Page — list of project assignments for this section.
 *
 * Shows project assignment cards. For each project, determines if the
 * student is already in a team (passes userTeams map to client).
 *
 * Type: Server Component
 * Route: /student/courses/[sectionId]/projects
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { projectQueries } from '@/lib/supabase/queries'
import { logger } from '@/lib/logger'
import { StudentProjectList } from '@/components/student/projects/StudentProjectList'
import { verifyFeatureEnabled } from '@/lib/validations/features'

interface StudentProjectsPageProps {
  params: Promise<{ sectionId: string }>
}

export default async function StudentProjectsPage({ params }: StudentProjectsPageProps) {
  const { sectionId } = await params

  // Verify feature is enabled (also verifies enrollment and session)
  const { user } = await verifyFeatureEnabled(sectionId, 'projects')

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any

  // Fetch projects visible to this student
  const projects = await projectQueries.getStudentSectionProjects(adminDb, sectionId, user.id)

  // Build a map of projectId -> teamId for projects where the student has a team
  // Use Promise.all to parallelize instead of serial N+1 queries
  const userTeams: Record<string, string> = {}
  await Promise.all(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    projects.map(async (project: any) => {
      const teamId = await projectQueries.getStudentTeamInProject(adminDb, project.id, user.id)
      if (teamId) {
        userTeams[project.id] = teamId
      }
    })
  )

  logger.info('StudentProjectsPage: Loaded', {
    sectionId,
    count: projects.length,
    teamsJoined: Object.keys(userTeams).length,
  })

  return (
    <StudentProjectList
      sectionId={sectionId}
      projects={projects}
      userId={user.id}
      userTeams={userTeams}
    />
  )
}
