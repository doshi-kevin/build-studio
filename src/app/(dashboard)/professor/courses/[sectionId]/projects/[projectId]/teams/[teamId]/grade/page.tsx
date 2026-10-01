/**
 * Professor Team Grading Page — a dedicated page (not a dialog) for grading one
 * team against the project's phase-weighted rubric. Two sections: Overall
 * (team-grained items + submission review) and Individual (per-student items +
 * live computed totals). Grades are computed on read by lib/projects/grade.ts.
 *
 * Type: Server Component
 * Route: /professor/courses/[sectionId]/projects/[projectId]/teams/[teamId]/grade
 */

import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { projectQueries } from '@/lib/supabase/queries'
import { verifySectionAccess, canWriteAsStaff } from '@/lib/auth/section-access'
import { TeamGradePage } from '@/components/professor/projects/TeamGradePage'
import {
  fetchProjectRubric,
  fetchGradeSources,
  computeProjectGrades,
  partitionItemScores,
  type StudentGrade,
} from '@/lib/projects/grade'

interface TeamGradePageProps {
  params: Promise<{ sectionId: string; projectId: string; teamId: string }>
}

export default async function ProfessorTeamGradePage({ params }: TeamGradePageProps) {
  const { sectionId, projectId, teamId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) notFound()

  const access = await verifySectionAccess(sectionId, user.id)
  if (!access.ok) notFound()
  const { adminDb } = access
  const canWrite = canWriteAsStaff(access.role)

  // Bind team -> project -> section before showing anything.
  const team = await projectQueries.getTeamDetail(adminDb, teamId)
  if (!team || team.project_id !== projectId) notFound()
  const project = Array.isArray(team.project) ? team.project[0] : team.project
  if (!project || project.section_id !== sectionId) notFound()

  const membersRaw = await projectQueries.getProjectMembers(adminDb, projectId, teamId)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resolveJoin = (val: any) => (Array.isArray(val) ? val[0] : val)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const members = (membersRaw as any[]).map((m) => ({
    id: m.id,
    user_id: m.user_id,
    role: m.role,
    profile: resolveJoin(m.profile),
  }))
  const roster = members.map((m) => ({ studentId: m.user_id, teamId }))

  // Rubric + computed grades (the engine).
  const rubric = await fetchProjectRubric(adminDb, projectId)
  const sources = await fetchGradeSources(adminDb, sectionId, rubric, roster)
  const gradesMap = computeProjectGrades(rubric, roster, sources)
  const grades: Record<string, StudentGrade> = Object.fromEntries(gradesMap)

  // Release state + persisted manual/level entries (for prefilling the inputs).
  // Scope the score read to THIS team's rows + its members: the whole-project set
  // grows with teams × items and could hit PostgREST's row cap, dropping this
  // team's prefill silently. partitionItemScores still enforces the team scoping.
  const memberIds = roster.map((r) => r.studentId)
  const scoreFilter =
    memberIds.length > 0
      ? `team_id.eq.${teamId},student_id.in.(${memberIds.join(',')})`
      : `team_id.eq.${teamId}`
  const [releaseRow, scoreRows] = await Promise.all([
    adminDb.from('project_grade_releases').select('released_at').eq('project_id', projectId).maybeSingle(),
    adminDb.from('project_item_scores').select('phase_item_id, team_id, student_id, earned, level_id').eq('project_id', projectId).or(scoreFilter),
  ])
  const released = Boolean(releaseRow.data)

  const { teamScores, studentScores } = partitionItemScores(scoreRows.data ?? [], teamId)

  return (
    <TeamGradePage
      sectionId={sectionId}
      projectId={projectId}
      projectTitle={project.title}
      team={team}
      teamId={teamId}
      members={members}
      rubric={rubric}
      grades={grades}
      teamScores={teamScores}
      studentScores={studentScores}
      released={released}
      canWrite={canWrite}
    />
  )
}
