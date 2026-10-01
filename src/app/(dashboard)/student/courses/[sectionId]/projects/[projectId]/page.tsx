/**
 * Student Project Detail Page — assignment view with optional team workspace.
 *
 * Determines if the student has a team in this project:
 * - If yes: fetches team data (members, phases) and renders team workspace
 * - If no: shows assignment info with create-team option and team list
 *
 * Type: Server Component
 * Route: /student/courses/[sectionId]/projects/[projectId]
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { projectQueries } from '@/lib/supabase/queries'
import { logger } from '@/lib/logger'
import { notFound } from 'next/navigation'
import { StudentProjectDetail } from '@/components/student/projects/StudentProjectDetail'
import { getMyJoinRequests } from '../actions'
import { verifyFeatureEnabled } from '@/lib/validations/features'
import { fetchProjectRubric } from '@/lib/projects/grade'
import { areGradesPublished } from '@/lib/validations/assignment'

interface StudentProjectDetailPageProps {
  params: Promise<{ sectionId: string; projectId: string }>
}

export default async function StudentProjectDetailPage({ params }: StudentProjectDetailPageProps) {
  const { sectionId, projectId } = await params
  
  // Verify feature is enabled (also verifies enrollment and session)
  const { user } = await verifyFeatureEnabled(sectionId, 'projects')

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any

  // Fetch project detail and all teams
  const [project, allTeams] = await Promise.all([
    projectQueries.getProjectDetail(adminDb, projectId),
    projectQueries.getProjectTeams(adminDb, projectId),
  ])

  /**
   * `teams` is the roster list — name, status, member count. Strip the private
   * per-team columns before it crosses into the client component.
   *
   * getProjectTeams selects `project_teams.*`; on this page those rows are peer
   * data. Since the whole array is handed to a 'use client' component it is
   * serialized into the RSC payload, so every other team's submitted coursework
   * (`submission`) and private `planning_doc` were readable in DevTools even
   * though the UI renders none of it. The TeamInfo interface omits most of them,
   * but a TypeScript type does not affect runtime serialization.
   *
   * The viewer's OWN team is unaffected: `team` below is fetched separately by
   * teamId and passed as its own prop.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const teams = (allTeams as any[]).map((t) => {
    const rest = { ...t }
    delete rest.submission
    delete rest.planning_doc
    return rest
  })

  if (!project) {
    logger.warn('StudentProjectDetailPage: Project not found', { sectionId, projectId })
    notFound()
  }

  if (project.section_id !== sectionId) {
    logger.warn('StudentProjectDetailPage: Section mismatch', { sectionId, projectId })
    notFound()
  }

  // Fetch the student's join requests for this project
  const myRequestsResult = await getMyJoinRequests(projectId, sectionId)
  const myJoinRequests = myRequestsResult.data ?? []

  // Check if student has a team in this project
  const teamId = await projectQueries.getStudentTeamInProject(adminDb, projectId, user.id)

  let team = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let members: any[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let phases: any[] = []
  let userRole: string | null = null

  if (teamId) {
    // Fetch team data in parallel
    const [teamDetail, teamMembers, teamPhases, role] = await Promise.all([
      projectQueries.getTeamDetail(adminDb, teamId),
      projectQueries.getProjectMembers(adminDb, projectId, teamId),
      projectQueries.getProjectPhases(adminDb, projectId, teamId),
      projectQueries.getProjectAccess(adminDb, projectId, user.id, teamId),
    ])

    team = teamDetail
    members = teamMembers
    phases = teamPhases
    userRole = role
  }

  // Professor-defined roadmap (read-only for students): the master phases with
  // their placed items, resolved to titles. Note: the rubric config (weights,
  // levels, manual titles) IS readable by enrolled students via RLS on
  // project_phase_items — a deliberate transparency choice, not a leak. We simply
  // don't surface weights/levels in this roadmap payload.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let masterPhases: any[] = []
  if (teamId) {
    const [rubricItems, phaseRows] = await Promise.all([
      fetchProjectRubric(adminDb, projectId),
      adminDb.from('project_master_phases').select('id, name, start_date, end_date, position').eq('project_id', projectId).order('position'),
    ])

    // The student's own grades for the linked assignments/quizzes, so a chip can
    // show a score. Assignment grades honor the professor's publish flag.
    const assignmentIds = [...new Set(rubricItems.filter((i) => i.itemType === 'assignment' && i.assignmentId).map((i) => i.assignmentId as string))]
    const quizIds = [...new Set(rubricItems.filter((i) => i.itemType === 'quiz' && i.quizId).map((i) => i.quizId as string))]
    const [assnMeta, subs, attempts] = await Promise.all([
      assignmentIds.length ? adminDb.from('assignments').select('id, points, settings').in('id', assignmentIds) : Promise.resolve({ data: [] }),
      assignmentIds.length ? adminDb.from('assignment_submissions').select('assignment_id, score, status').eq('student_id', user.id).in('assignment_id', assignmentIds) : Promise.resolve({ data: [] }),
      quizIds.length ? adminDb.from('quiz_attempts').select('quiz_id, score, total_points').eq('student_id', user.id).in('quiz_id', quizIds) : Promise.resolve({ data: [] }),
    ])
    const assnMeta2 = new Map<string, { points: number; published: boolean }>()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const a of (assnMeta.data ?? []) as any[]) assnMeta2.set(a.id, { points: Number(a.points) || 0, published: areGradesPublished(a.settings) })
    const subByAssn = new Map<string, { score: number | null; status: string }>()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const s of (subs.data ?? []) as any[]) subByAssn.set(s.assignment_id, { score: s.score == null ? null : Number(s.score), status: s.status })
    const quizBest = new Map<string, { score: number | null; total: number | null }>()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const t of (attempts.data ?? []) as any[]) {
      const prev = quizBest.get(t.quiz_id)
      const score = t.score == null ? null : Number(t.score)
      if (!prev || (score ?? -1) > (prev.score ?? -1)) quizBest.set(t.quiz_id, { score, total: t.total_points == null ? null : Number(t.total_points) })
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    masterPhases = ((phaseRows.data ?? []) as any[]).map((p) => ({
      id: p.id,
      name: p.name,
      startDate: p.start_date,
      endDate: p.end_date,
      items: rubricItems
        .filter((i) => i.phaseId === p.id)
        .map((i) => {
          let href: string | null = null
          let grade: { score: number; possible: number | null } | null = null
          if (i.itemType === 'assignment' && i.assignmentId) {
            href = `/student/courses/${sectionId}/assignments/${i.assignmentId}`
            const meta = assnMeta2.get(i.assignmentId)
            const sub = subByAssn.get(i.assignmentId)
            if (meta?.published && sub && (sub.status === 'graded' || sub.status === 'returned') && sub.score != null) {
              grade = { score: sub.score, possible: meta.points }
            }
          } else if (i.itemType === 'quiz' && i.quizId) {
            href = `/student/courses/${sectionId}/quizzes/${i.quizId}`
            const att = quizBest.get(i.quizId)
            if (att && att.score != null) grade = { score: att.score, possible: att.total }
          }
          return { title: i.title, type: i.itemType, href, grade }
        }),
    }))
  }

  logger.info('StudentProjectDetailPage: Loaded', {
    sectionId,
    projectId,
    hasTeam: !!team,
    teamId,
    userRole,
  })

  return (
    <StudentProjectDetail
      sectionId={sectionId}
      project={project}
      teams={teams}
      team={team}
      members={members}
      phases={phases}
      userRole={userRole as 'owner' | 'member' | 'viewer' | null}
      userId={user.id}
      myJoinRequests={myJoinRequests}
      masterPhases={masterPhases}
    />
  )
}
