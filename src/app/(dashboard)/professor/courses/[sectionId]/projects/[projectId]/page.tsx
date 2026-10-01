/**
 * Professor Project Detail Page — server component that fetches project,
 * team, phases-board, and pulse data, then renders ProjectDetail.
 *
 * Type: Server Component
 * Route: /professor/courses/[sectionId]/projects/[projectId]
 */

import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { projectQueries, enrollmentQueries } from '@/lib/supabase/queries'
import { verifySectionAccess, canWriteAsStaff } from '@/lib/auth/section-access'
import { ProjectDetail } from '@/components/professor/projects/ProjectDetail'
import type { BoardPhase, PhaseCard } from '@/components/professor/projects/ProjectPhasesTab'
import { fetchProjectRubric } from '@/lib/projects/grade'

interface ProjectDetailPageProps {
  params: Promise<{ sectionId: string; projectId: string }>
}

export default async function ProjectDetailPage({ params }: ProjectDetailPageProps) {
  const { sectionId, projectId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) notFound()

  const access = await verifySectionAccess(sectionId, user.id)
  if (!access.ok) notFound()
  const { adminDb } = access
  const canWrite = canWriteAsStaff(access.role)

  const project = await projectQueries.getProjectDetail(adminDb, projectId)
  if (!project || project.section_id !== sectionId) {
    notFound()
  }

  const [teams, masterPhases, catalog, postsThisWeek, enrollments, rubricItems] = await Promise.all([
    projectQueries.getProjectTeams(adminDb, projectId),
    projectQueries.getMasterPhases(adminDb, projectId),
    projectQueries.getSectionPhaseLibrary(adminDb, sectionId),
    projectQueries.getProjectPostsThisWeek(adminDb, projectId),
    enrollmentQueries.getSectionEnrollments(adminDb, sectionId),
    fetchProjectRubric(adminDb, projectId),
  ])

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const phaseList = (masterPhases as any[]).map((p) => ({ id: p.id, name: p.name }))

  // Catalog of everything placeable, keyed by "type_id"
  const cards = new Map<string, PhaseCard>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const a of catalog.assignments as any[]) {
    cards.set(`assignment_${a.id}`, {
      type: 'assignment',
      itemId: a.id,
      title: a.title,
      status: a.status,
      points: a.points,
      due: a.due_at,
    })
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const q of catalog.quizzes as any[]) {
    cards.set(`quiz_${q.id}`, {
      type: 'quiz',
      itemId: q.id,
      title: q.title,
      status: q.status,
      points: null,
      due: q.due_date,
    })
  }

  // A placed item can fall outside the library's row cap; without this it would
  // resolve to no card and silently vanish from the board. Backfill by id so a
  // placed assignment/quiz always renders regardless of catalog size.
  const missingAssignmentIds: string[] = []
  const missingQuizIds: string[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const phase of masterPhases as any[]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const item of (phase.project_phase_items || []) as any[]) {
      const key = `${item.item_type}_${item.assignment_id ?? item.quiz_id}`
      if (cards.has(key)) continue
      if (item.item_type === 'assignment' && item.assignment_id) missingAssignmentIds.push(item.assignment_id)
      else if (item.item_type === 'quiz' && item.quiz_id) missingQuizIds.push(item.quiz_id)
    }
  }
  if (missingAssignmentIds.length || missingQuizIds.length) {
    const [extraA, extraQ] = await Promise.all([
      missingAssignmentIds.length
        ? adminDb.from('assignments').select('id, title, points, status, due_at').in('id', missingAssignmentIds)
        : Promise.resolve({ data: [] }),
      missingQuizIds.length
        ? adminDb.from('quizzes').select('id, title, status, due_date').in('id', missingQuizIds)
        : Promise.resolve({ data: [] }),
    ])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const a of (extraA.data ?? []) as any[]) {
      cards.set(`assignment_${a.id}`, { type: 'assignment', itemId: a.id, title: a.title, status: a.status, points: a.points, due: a.due_at })
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const q of (extraQ.data ?? []) as any[]) {
      cards.set(`quiz_${q.id}`, { type: 'quiz', itemId: q.id, title: q.title, status: q.status, points: null, due: q.due_date })
    }
  }

  const placed = new Set<string>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const boardPhases: BoardPhase[] = (masterPhases as any[]).map((phase) => ({
    id: phase.id,
    name: phase.name,
    startDate: phase.start_date,
    endDate: phase.end_date,
    items: (phase.project_phase_items || [])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((item: any) => {
        const key = `${item.item_type}_${item.assignment_id ?? item.quiz_id}`
        const card = cards.get(key)
        if (!card) return null
        placed.add(key)
        return { ...card, rowId: item.id }
      })
      .filter(Boolean) as PhaseCard[],
  }))

  const boardLibrary = [...cards.entries()]
    .filter(([key]) => !placed.has(key))
    .map(([, card]) => card)

   
  const studentsOnTeams = new Set(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (teams as any[]).flatMap((t) => (t.project_members || []).map((m: any) => m.user_id)),
  ).size

  const pulse = {
    teams: teams.length,
    studentsOnTeams,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    enrolled: (enrollments as any[]).filter((e) => e.status === 'active' || e.status === 'enrolled').length,
    postsThisWeek,
  }

  /* Whether Athena may propose a RESTRUCTURE, or only additive rows. Both are
     re-read inside apply_project_proposal's transaction as well — this pair is
     for the prompt and the UI, not the guarantee. */
  const [{ count: scoreCount }, { data: releaseRow }] = await Promise.all([
    adminDb
      .from('project_item_scores')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', projectId),
    adminDb.from('project_grade_releases').select('project_id').eq('project_id', projectId).maybeSingle(),
  ])
  const anyScored = (scoreCount ?? 0) > 0
  const gradesReleased = !!releaseRow

  return (
    <ProjectDetail
      anyScored={anyScored}
      gradesReleased={gradesReleased}
      sectionId={sectionId}
      project={project}
      teams={teams}
      pulse={pulse}
      boardPhases={boardPhases}
      boardLibrary={boardLibrary}
      rubricItems={rubricItems}
      phaseList={phaseList}
      canWrite={canWrite}
    />
  )
}
