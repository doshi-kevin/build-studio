// Server actions for student per-course grades — fetches quiz scores
// and topic performance for the authenticated student in a given section.
'use server'

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import { skillQueries } from '@/lib/supabase/queries'
import { aggregateStudentMastery, type StudentSkillScore } from '@/lib/skills/aggregate'
import { areGradesPublished } from '@/lib/validations/assignment'
import { fetchProjectRubric, fetchGradeSources, computeProjectGrades, gradePercent } from '@/lib/projects/grade'

export interface StudentQuizScore {
  quizId: string
  quizTitle: string
  score: number | null
  earnedPoints: number | null
  totalPoints: number | null
  passThreshold: number
  passed: boolean
  submittedAt: string | null
  attemptId: string | null
  dueDate: string | null
}

export async function getStudentQuizScores(
  sectionId: string
): Promise<{ error?: string; data?: StudentQuizScore[] }> {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) return { error: 'Not authenticated' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    // Verify enrollment
    const { data: enrollment } = await adminDb
      .from('enrollments')
      .select('id')
      .eq('section_id', sectionId)
      .eq('student_id', user.id)
      .in('status', ['enrolled', 'completed', 'active'])
      .single()

    if (!enrollment) return { error: 'Not enrolled in this section' }

    // Fetch published quizzes
    const { data: quizRows, error: quizErr } = await adminDb
      .from('quizzes')
      .select('id, title, due_date, pass_threshold, status')
      .eq('section_id', sectionId)
      .eq('status', 'published')
      .order('created_at', { ascending: true })

    if (quizErr) {
      logger.error('getStudentQuizScores: Failed to fetch quizzes', quizErr, { sectionId })
      return { error: 'Failed to fetch quizzes' }
    }

    // Fetch student's submitted attempts
    const { data: attempts, error: attemptErr } = await adminDb
      .from('quiz_attempts')
      .select('id, quiz_id, score, earned_points, total_points, submitted_at, status')
      .eq('section_id', sectionId)
      .eq('student_id', user.id)
      .eq('status', 'submitted')

    if (attemptErr) {
      logger.error('getStudentQuizScores: Failed to fetch attempts', attemptErr, { sectionId })
      return { error: 'Failed to fetch attempts' }
    }

    // Build best attempt per quiz
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bestAttempts: Record<string, any> = {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const a of (attempts || []) as any[]) {
      const existing = bestAttempts[a.quiz_id]
      if (!existing || (a.score ?? -1) > (existing.score ?? -1)) {
        bestAttempts[a.quiz_id] = a
      }
    }

    // Join quiz metadata with best attempt
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: StudentQuizScore[] = (quizRows || []).map((q: any) => {
      const attempt = bestAttempts[q.id]
      const threshold = q.pass_threshold ?? 0
      const score = attempt?.score ?? null
      return {
        quizId: q.id,
        quizTitle: q.title,
        score,
        earnedPoints: attempt?.earned_points ?? null,
        totalPoints: attempt?.total_points ?? null,
        passThreshold: threshold,
        passed: score != null ? score >= threshold : false,
        submittedAt: attempt?.submitted_at ?? null,
        attemptId: attempt?.id ?? null,
        dueDate: q.due_date,
      }
    })

    return { data }
  } catch (error) {
    logger.error('getStudentQuizScores: Unexpected error', error, { sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

export interface StudentProjectGrade {
  projectId: string
  projectTitle: string
  teamName: string
  score: number
  feedback: string | null
  gradedAt: string | null
  dueDate: string | null
}

export async function getStudentProjectGrades(
  sectionId: string
): Promise<{ error?: string; data?: StudentProjectGrade[] }> {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) return { error: 'Not authenticated' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    // Verify enrollment — same gate as the sibling grades actions. Without it, a
    // stale project_members row (e.g. a since-unenrolled student) could still read
    // this section's project grades.
    const { data: enrollment } = await adminDb
      .from('enrollments')
      .select('id')
      .eq('section_id', sectionId)
      .eq('student_id', user.id)
      .in('status', ['enrolled', 'completed', 'active'])
      .single()

    if (!enrollment) return { error: 'Not enrolled in this section' }

    // Fetch all projects in this section
    const { data: projects, error: projErr } = await adminDb
      .from('projects')
      .select('id, title, due_date')
      .eq('section_id', sectionId)
      .in('status', ['active', 'completed'])
      .order('created_at', { ascending: true })

    if (projErr) {
      logger.error('getStudentProjectGrades: Failed to fetch projects', projErr, { sectionId })
      return { error: 'Failed to fetch projects' }
    }

    if (!projects || projects.length === 0) return { data: [] }

    // Find teams the student is a member of
    const { data: memberships } = await adminDb
      .from('project_members')
      .select('team_id')
      .eq('user_id', user.id)

    if (!memberships || memberships.length === 0) return { data: [] }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const teamIds = (memberships as any[]).map((m) => m.team_id).filter(Boolean)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const projectIds = (projects as any[]).map((p) => p.id)

    // The student's team (with name) per project in this section.
    const { data: teams } = await adminDb
      .from('project_teams')
      .select('id, name, project_id')
      .in('id', teamIds)
      .in('project_id', projectIds)

    if (!teams) return { data: [] }

    const studentTeam = new Map<string, { teamId: string; teamName: string }>()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const t of teams as any[]) {
      if (projectIds.includes(t.project_id)) studentTeam.set(t.project_id, { teamId: t.id, teamName: t.name })
    }

    // Only RELEASED projects are visible to students. Unreleased → not returned,
    // so an in-progress grade never reaches the client.
    const { data: releases } = await adminDb
      .from('project_grade_releases')
      .select('project_id, released_at')
      .in('project_id', [...studentTeam.keys()])
    const releasedAt = new Map<string, string>()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const r of (releases ?? []) as any[]) releasedAt.set(r.project_id, r.released_at)

    // Compute THIS student's grade per released project (own grade only — the
    // engine is handed a one-student roster, so no teammate's individual score
    // is ever computed or returned).
    const computed = await Promise.all(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (projects as any[]).map(async (p): Promise<StudentProjectGrade | null> => {
        const st = studentTeam.get(p.id)
        if (!st || !releasedAt.has(p.id)) return null
        const rubric = await fetchProjectRubric(adminDb, p.id)
        if (rubric.length === 0) return null
        const roster = [{ studentId: user.id, teamId: st.teamId }]
        // Students must not see an unpublished assignment grade bleed into the total.
        const sources = await fetchGradeSources(adminDb, sectionId, rubric, roster, { respectAssignmentPublish: true })
        const grade = computeProjectGrades(rubric, roster, sources).get(user.id)
        const pct = grade ? gradePercent(grade) : null
        if (pct == null) return null // nothing graded yet
        return {
          projectId: p.id,
          projectTitle: p.title,
          teamName: st.teamName,
          score: pct,
          feedback: null,
          gradedAt: releasedAt.get(p.id) ?? null,
          dueDate: p.due_date,
        }
      }),
    )
    const data = computed.filter((x): x is StudentProjectGrade => x !== null)

    return { data }
  } catch (error) {
    logger.error('getStudentProjectGrades: Unexpected error', error, { sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

export interface StudentAssignmentGrade {
  assignmentId: string
  title: string
  points: number | null
  dueDate: string | null
  status: 'graded' | 'submitted' | 'returned' | 'not_started'
  released: boolean
  // score/feedback/gradedAt are populated ONLY when the professor has published
  // grades for the assignment AND this submission is graded. They are stripped
  // server-side otherwise, so an unpublished score never reaches the client payload.
  score: number | null
  feedback: string | null
  gradedAt: string | null
}

export async function getStudentAssignmentGrades(
  sectionId: string
): Promise<{ error?: string; data?: StudentAssignmentGrade[] }> {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) return { error: 'Not authenticated' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    // Verify enrollment — same gate as the sibling grades actions. We read with the
    // admin client (bypasses RLS), so we must re-scope visibility ourselves below.
    const { data: enrollment } = await adminDb
      .from('enrollments')
      .select('id')
      .eq('section_id', sectionId)
      .eq('student_id', user.id)
      .in('status', ['enrolled', 'completed', 'active'])
      .single()

    if (!enrollment) return { error: 'Not enrolled in this section' }

    // Only graded assignments the student can see (RLS would normally limit students
    // to published/closed — replicated here because the admin client skips RLS).
    const { data: assignments, error: aErr } = await adminDb
      .from('assignments')
      .select('id, title, points, due_at, settings')
      .eq('section_id', sectionId)
      .eq('is_graded', true)
      .in('status', ['published', 'closed'])
      .order('created_at', { ascending: true })

    if (aErr) {
      logger.error('getStudentAssignmentGrades: Failed to fetch assignments', aErr, { sectionId })
      return { error: 'Failed to fetch assignments' }
    }

    if (!assignments || assignments.length === 0) return { data: [] }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const assignmentIds = (assignments as any[]).map((a) => a.id)

    // The student's own submissions only.
    const { data: subs } = await adminDb
      .from('assignment_submissions')
      .select('assignment_id, status, score, feedback, graded_at')
      .in('assignment_id', assignmentIds)
      .eq('student_id', user.id)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const subByAssignment = new Map<string, any>()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const s of (subs || []) as any[]) subByAssignment.set(s.assignment_id, s)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: StudentAssignmentGrade[] = (assignments as any[]).map((a) => {
      const sub = subByAssignment.get(a.id)
      const status = (sub?.status as StudentAssignmentGrade['status']) ?? 'not_started'
      const released = areGradesPublished(a.settings)
      // Grade-leak guard: only expose score/feedback once published AND graded.
      const revealed = released && status === 'graded'
      return {
        assignmentId: a.id,
        title: a.title,
        points: a.points,
        dueDate: a.due_at,
        status,
        released,
        score: revealed ? sub.score : null,
        feedback: revealed ? sub.feedback : null,
        gradedAt: revealed ? sub.graded_at : null,
      }
    })

    return { data }
  } catch (error) {
    logger.error('getStudentAssignmentGrades: Unexpected error', error, { sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

export interface StudentSkillPerformance {
  /** Skills with real evidence, main level. Never includes an unassessed skill. */
  skills: StudentSkillScore[]
  /** Curated main skills. Separates "course tracks nothing" from "nothing
   *  assessed for you yet" — an empty `skills` means both otherwise. */
  trackedCount: number
}

export async function getStudentSkillPerformance(
  sectionId: string
): Promise<{ error?: string; data?: StudentSkillPerformance }> {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) return { error: 'Not authenticated' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    // Verify enrollment
    const { data: enrollment } = await adminDb
      .from('enrollments')
      .select('id')
      .eq('section_id', sectionId)
      .eq('student_id', user.id)
      .in('status', ['enrolled', 'completed', 'active'])
      .single()

    if (!enrollment) return { error: 'Not enrolled in this section' }

    /* The student's mastery on the section's curated skills, not raw quiz-tag
       accuracy. The tag version counted correct/total per unnormalized tag
       string and saw quizzes only, so it disagreed with the number the same
       student sees on their own roadmap. */
    const [skillRows, masteryRows] = await Promise.all([
      skillQueries.listSectionSkills(adminDb, sectionId),
      skillQueries.getStudentMasteryRows(adminDb, sectionId, user.id),
    ])
    const tracked = (skillRows ?? []).filter((s) => !s.excluded && !s.suppressed)
    const skills = aggregateStudentMastery(tracked, masteryRows ?? [])

    /* trackedCount is what separates "this course tracks nothing" from "nothing
       assessed for you yet". Without it an empty list reads as "you have no
       weaknesses", which congratulates a student who simply has not been
       marked. */
    return {
      data: {
        skills: skills.filter((s) => s.classScore != null),
        trackedCount: tracked.filter((s) => s.parent_id === null).length,
      },
    }
  } catch (error) {
    logger.error('getStudentSkillPerformance: Unexpected error', error, { sectionId })
    return { error: 'An unexpected error occurred' }
  }
}
