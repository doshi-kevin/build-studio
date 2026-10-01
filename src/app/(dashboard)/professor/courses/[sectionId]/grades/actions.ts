// Server actions for the professor gradebook — fetches gradebook data,
// cross-quiz analytics, topic performance, and grade updates.
// Reads are allowed for the section's professor and active TAs/graders;
// writing final grades is gated to professor + TA (graders stay read-only
// for v1 per the TA access scope).
'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import { logEvent } from '@/lib/supabase/event-logger'
import { updateGradeSchema } from '@/lib/validations/grades'
import { skillQueries } from '@/lib/supabase/queries'
import { resolveSkillMasteryConfig, CLASS_METRIC_LABEL } from '@/lib/skills/config'
import { aggregateSectionMastery, aggregateStudentMastery, type MainSkillAgg, type StudentSkillScore, type MasteryDatum } from '@/lib/skills/aggregate'
import { gatherSectionRisk, type StudentRisk } from '@/lib/risk/gather'
import type { ProctoringSnapshot } from '@/lib/validations/proctoring'
import { ROLE_DENIED_MESSAGE, canGrade, verifySectionAccess } from '@/lib/auth/section-access'
import { fetchProjectRubric, fetchGradeSources, computeProjectGrades, gradePercent, fetchAllPages } from '@/lib/projects/grade'
import { areGradesPublished } from '@/lib/validations/assignment'

// --- Types ---

export interface GradebookStudent {
  id: string
  name: string
  email: string
  enrollmentId: string
  finalGrade: string | null
  finalScore: number | null
}

export interface GradebookQuiz {
  id: string
  title: string
  dueDate: string | null
  passThreshold: number
  status: string
}

export interface QuizScore {
  score: number | null
  earnedPoints: number | null
  totalPoints: number | null
  submittedAt: string | null
  attemptId: string
  status: string
}

export interface ClassStats {
  classAverage: number | null
  highestScore: number | null
  lowestScore: number | null
  totalStudents: number
  totalQuizzes: number
}

export interface GradebookData {
  students: GradebookStudent[]
  quizzes: GradebookQuiz[]
  scores: Record<string, Record<string, QuizScore>>
  classStats: ClassStats
}

// --- Helpers ---

async function getAuthUser() {
  const supabase = await createClient()
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) return null
  return user
}

// --- Actions ---

export async function getGradebookData(
  sectionId: string
): Promise<{ error?: string; data?: GradebookData }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const access = await verifySectionAccess(sectionId, user.id)
    if (!access.ok) return { error: 'You do not have access to this section' }
    const adminDb = access.adminDb

    // 1. Fetch enrolled students
    const { data: enrollments, error: enrollErr } = await adminDb
      .from('enrollments')
      .select('id, student_id, final_grade, final_score, status, student:profiles(id, name, email)')
      .eq('section_id', sectionId)
      .in('status', ['enrolled', 'completed', 'active'])

    if (enrollErr) {
      logger.error('getGradebookData: Failed to fetch enrollments', enrollErr, { sectionId })
      return { error: 'Failed to fetch enrollment data' }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resolveJoin = (val: any) => (Array.isArray(val) ? val[0] : val)

    const students: GradebookStudent[] = (enrollments || []).map(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (e: any) => {
        const profile = resolveJoin(e.student)
        return {
          id: e.student_id,
          name: profile?.name || 'Unknown',
          email: profile?.email || '',
          enrollmentId: e.id,
          finalGrade: e.final_grade,
          finalScore: e.final_score,
        }
      }
    )

    // 2. Fetch published quizzes
    const { data: quizRows, error: quizErr } = await adminDb
      .from('quizzes')
      .select('id, title, due_date, pass_threshold, status')
      .eq('section_id', sectionId)
      .eq('status', 'published')
      .order('created_at', { ascending: true })

    if (quizErr) {
      logger.error('getGradebookData: Failed to fetch quizzes', quizErr, { sectionId })
      return { error: 'Failed to fetch quiz data' }
    }

    const quizzes: GradebookQuiz[] = (quizRows || []).map(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (q: any) => ({
        id: q.id,
        title: q.title,
        dueDate: q.due_date,
        passThreshold: q.pass_threshold ?? 0,
        status: q.status,
      })
    )

    // 3. Fetch all submitted attempts for section
    const { data: attempts, error: attemptErr } = await adminDb
      .from('quiz_attempts')
      .select('id, student_id, quiz_id, score, earned_points, total_points, submitted_at, status')
      .eq('section_id', sectionId)
      .eq('status', 'submitted')

    if (attemptErr) {
      logger.error('getGradebookData: Failed to fetch attempts', attemptErr, { sectionId })
      return { error: 'Failed to fetch attempt data' }
    }

    // 4. Build scores matrix — keep best attempt per student per quiz
    const scores: Record<string, Record<string, QuizScore>> = {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const a of (attempts || []) as any[]) {
      if (!scores[a.student_id]) scores[a.student_id] = {}
      const existing = scores[a.student_id][a.quiz_id]
      if (!existing || (a.score ?? -1) > (existing.score ?? -1)) {
        scores[a.student_id][a.quiz_id] = {
          score: a.score,
          earnedPoints: a.earned_points,
          totalPoints: a.total_points,
          submittedAt: a.submitted_at,
          attemptId: a.id,
          status: a.status,
        }
      }
    }

    // 5. Calculate class stats
    const allScores: number[] = []
    for (const studentId of Object.keys(scores)) {
      for (const quizId of Object.keys(scores[studentId])) {
        const s = scores[studentId][quizId].score
        if (s != null) allScores.push(s)
      }
    }

    const classStats: ClassStats = {
      classAverage: allScores.length > 0
        ? parseFloat((allScores.reduce((a, b) => a + b, 0) / allScores.length).toFixed(1))
        : null,
      highestScore: allScores.length > 0 ? Math.max(...allScores) : null,
      lowestScore: allScores.length > 0 ? Math.min(...allScores) : null,
      totalStudents: students.length,
      totalQuizzes: quizzes.length,
    }

    return { data: { students, quizzes, scores, classStats } }
  } catch (error) {
    logger.error('getGradebookData: Unexpected error', error, { sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

// ── Project Gradebook ──────────────────────────────────────────
// Section-wide project grades for the professor Projects tab. This mirrors the
// student getStudentProjectGrades read but returns EVERY team's grade (the student
// version scopes to the caller's own teams).

export interface ProjectTeamGrade {
  teamId: string
  teamName: string
  score: number | null
  feedback: string | null
  gradedAt: string | null
}

export interface ProjectGradebookEntry {
  projectId: string
  projectTitle: string
  dueDate: string | null
  teams: ProjectTeamGrade[]
}

export async function getProjectGradebook(
  sectionId: string
): Promise<{ error?: string; data?: ProjectGradebookEntry[] }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const access = await verifySectionAccess(sectionId, user.id)
    if (!access.ok) return { error: 'You do not have access to this section' }
    const adminDb = access.adminDb

    // Paginated (stable order): a bounded limit would silently truncate a large
    // section's gradebook, dropping projects/teams from the averages with no error.
    const projects = await fetchAllPages(() =>
      adminDb
        .from('projects')
        .select('id, title, due_date')
        .eq('section_id', sectionId)
        .in('status', ['active', 'completed'])
        .order('id'),
    )
    if (!projects || projects.length === 0) return { data: [] }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const projectIds = (projects as any[]).map((p) => p.id)

    const teams = await fetchAllPages(() =>
      adminDb
        .from('project_teams')
        .select('id, name, project_id')
        .in('project_id', projectIds)
        .order('id'),
    )

    // Roster (studentId, teamId) per project, so we can compute each member's
    // grade and summarize a team by the average of its members' totals.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const teamRows = (teams || []) as any[]
    const teamProject = new Map<string, string>(teamRows.map((t) => [t.id, t.project_id]))
    // Paginated: a section's students × projects can clear PostgREST's 1000-row
    // cap, and a truncated roster silently drops students from team averages.
    const memberRows = await fetchAllPages(() =>
      adminDb
        .from('project_members')
        .select('id, user_id, team_id')
        .in('team_id', teamRows.map((t) => t.id))
        .order('id'),
    )

    const rosterByProject = new Map<string, { studentId: string; teamId: string }[]>()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const m of (memberRows || []) as any[]) {
      const pid = teamProject.get(m.team_id)
      if (!pid) continue
      const list = rosterByProject.get(pid) ?? []
      list.push({ studentId: m.user_id, teamId: m.team_id })
      rosterByProject.set(pid, list)
    }

    // Compute each project's grades, then average per team (staff see all —
    // no release gate). teamAgg: teamId → running { sum, n } of member percents.
    // Each project runs ~8 queries (several paginated), so cap the fan-out rather
    // than firing every project's pipeline at once and exhausting the pool.
    const gradeOne = async (p: { id: string }) => {
      const roster = rosterByProject.get(p.id) ?? []
      if (roster.length === 0) return []
      const rubric = await fetchProjectRubric(adminDb, p.id)
      if (rubric.length === 0) return []
      const sources = await fetchGradeSources(adminDb, sectionId, rubric, roster)
      const grades = computeProjectGrades(rubric, roster, sources)
      return roster.map(({ studentId, teamId }) => {
        const g = grades.get(studentId)
        return { teamId, pct: g ? gradePercent(g) : null }
      })
    }
    const CONCURRENCY = 4
    const projectList = projects as { id: string }[]
    const perProject: Awaited<ReturnType<typeof gradeOne>>[] = []
    for (let i = 0; i < projectList.length; i += CONCURRENCY) {
      perProject.push(...(await Promise.all(projectList.slice(i, i + CONCURRENCY).map(gradeOne))))
    }
    const teamAgg = new Map<string, { sum: number; n: number }>()
    for (const { teamId, pct } of perProject.flat()) {
      if (pct == null) continue
      const acc = teamAgg.get(teamId) ?? { sum: 0, n: 0 }
      acc.sum += pct
      acc.n += 1
      teamAgg.set(teamId, acc)
    }

    const teamsByProject = new Map<string, ProjectTeamGrade[]>()
    for (const t of teamRows) {
      const agg = teamAgg.get(t.id)
      const list = teamsByProject.get(t.project_id) ?? []
      list.push({
        teamId: t.id,
        teamName: t.name,
        score: agg && agg.n > 0 ? Math.round((agg.sum / agg.n) * 10) / 10 : null,
        feedback: null,
        gradedAt: null,
      })
      teamsByProject.set(t.project_id, list)
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: ProjectGradebookEntry[] = (projects as any[]).map((p) => ({
      projectId: p.id,
      projectTitle: p.title,
      dueDate: p.due_date,
      teams: teamsByProject.get(p.id) ?? [],
    }))

    return { data }
  } catch (error) {
    logger.error('getProjectGradebook: Unexpected error', error, { sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

// ── Assignment Gradebook ───────────────────────────────────────
// Student × assignment matrix for the professor Assignments tab. Staff see all
// scores (they authored the grades); `released` surfaces publish state per column.

export interface AssignmentGradebookColumn {
  assignmentId: string
  title: string
  points: number | null
  dueDate: string | null
  released: boolean
}

export interface AssignmentCell {
  status: 'graded' | 'submitted' | 'returned' | 'not_started'
  score: number | null
}

export interface AssignmentGradebookData {
  students: { id: string; name: string; email: string }[]
  assignments: AssignmentGradebookColumn[]
  scores: Record<string, Record<string, AssignmentCell>>
}

export async function getAssignmentGradebook(
  sectionId: string
): Promise<{ error?: string; data?: AssignmentGradebookData }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const access = await verifySectionAccess(sectionId, user.id)
    if (!access.ok) return { error: 'You do not have access to this section' }
    const adminDb = access.adminDb

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resolveJoin = (val: any) => (Array.isArray(val) ? val[0] : val)

    const { data: enrollments, error: enrollErr } = await adminDb
      .from('enrollments')
      .select('student_id, student:profiles(id, name, email)')
      .eq('section_id', sectionId)
      .in('status', ['enrolled', 'completed', 'active'])

    if (enrollErr) {
      logger.error('getAssignmentGradebook: Failed to fetch enrollments', enrollErr, { sectionId })
      return { error: 'Failed to fetch enrollment data' }
    }

    const students = (enrollments || []).map(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (e: any) => {
        const profile = resolveJoin(e.student)
        return { id: e.student_id, name: profile?.name || 'Unknown', email: profile?.email || '' }
      }
    )

    const { data: assignmentRows, error: aErr } = await adminDb
      .from('assignments')
      .select('id, title, points, due_at, settings')
      .eq('section_id', sectionId)
      .eq('is_graded', true)
      .in('status', ['published', 'closed'])
      .order('created_at', { ascending: true })

    if (aErr) {
      logger.error('getAssignmentGradebook: Failed to fetch assignments', aErr, { sectionId })
      return { error: 'Failed to fetch assignment data' }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const assignments: AssignmentGradebookColumn[] = (assignmentRows || []).map((a: any) => ({
      assignmentId: a.id,
      title: a.title,
      points: a.points,
      dueDate: a.due_at,
      released: areGradesPublished(a.settings),
    }))

    const scores: Record<string, Record<string, AssignmentCell>> = {}
    if (assignments.length > 0) {
      const assignmentIds = assignments.map((a) => a.assignmentId)
      const { data: subs } = await adminDb
        .from('assignment_submissions')
        .select('assignment_id, student_id, status, score')
        .in('assignment_id', assignmentIds)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const s of (subs || []) as any[]) {
        if (!scores[s.student_id]) scores[s.student_id] = {}
        scores[s.student_id][s.assignment_id] = {
          status: (s.status as AssignmentCell['status']) ?? 'not_started',
          score: s.status === 'graded' ? s.score : null,
        }
      }
    }

    return { data: { students, assignments, scores } }
  } catch (error) {
    logger.error('getAssignmentGradebook: Unexpected error', error, { sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

export async function updateStudentFinalGrade(
  sectionId: string,
  studentId: string,
  finalGrade: string | null,
  finalScore: number | null
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const access = await verifySectionAccess(sectionId, user.id)
    if (!access.ok) return { error: 'You do not have access to this section' }
    /* A final grade is a score write, so graders may set it (#746). */
    if (!canGrade(access.role)) return { error: ROLE_DENIED_MESSAGE }
    const adminDb = access.adminDb

    // Validate input
    const parsed = updateGradeSchema.safeParse({ finalGrade, finalScore })
    if (!parsed.success) {
      return { error: 'Invalid grade input' }
    }

    // Update enrollment
    const { error: updateError } = await adminDb
      .from('enrollments')
      .update({
        final_grade: parsed.data.finalGrade,
        final_score: parsed.data.finalScore,
      })
      .eq('section_id', sectionId)
      .eq('student_id', studentId)

    if (updateError) {
      logger.error('updateStudentFinalGrade: Update failed', updateError, { sectionId, studentId })
      return { error: 'Failed to update grade' }
    }

    logEvent({
      userId: user.id,
      eventType: 'grade.updated',
      sectionId,
      metadata: {
        studentId,
        finalGrade: parsed.data.finalGrade,
        finalScore: parsed.data.finalScore,
      },
    })

    revalidatePath(`/professor/courses/${sectionId}/grades`)
    revalidatePath(`/student/courses/${sectionId}/grades`)

    return { success: true }
  } catch (error) {
    logger.error('updateStudentFinalGrade: Unexpected error', error, { sectionId, studentId })
    return { error: 'An unexpected error occurred' }
  }
}

// --- Cross-Quiz Analytics Types ---

export interface QuizPerformance {
  quizId: string
  quizTitle: string
  averageScore: number
  passRate: number
  attemptCount: number
  dueDate: string | null
}

/** One flagged student. Re-exported from the shared risk engine so the
 *  gradebook, Athena's course snapshot and Athena's per-student tool cannot
 *  drift into three different answers again. */
export type AtRiskStudent = StudentRisk

export interface ClassAnalytics {
  summary: {
    totalStudents: number
    totalQuizzes: number
    classAverage: number | null
    averagePassRate: number | null
    totalAttempts: number
  }
  quizPerformance: QuizPerformance[]
  overallScoreDistribution: { range: string; count: number }[]
  /** Class standing per curated skill, weakest first. Skills with no evidence
   *  are omitted rather than shown as 0%. Same numbers the roadmap shows. */
  topicPerformance: MainSkillAgg[]
  /** What `classScore` means here, per the section's configured metric —
   *  "median" unless the professor changed it. Never hardcode the word. */
  metricLabel: string
  /** The section's own at-risk cutoff, for labelling `atRiskPct`. */
  atRiskThreshold: number
  /** Curated main skills. Distinguishes "no skills set up" from "skills set up,
   *  nothing assessed yet" — an empty topicPerformance means both otherwise. */
  trackedSkillCount: number
  /** True when the mastery read failed. Distinct from an empty course: the UI
   *  must say "couldn't load" rather than asserting there are no skills. */
  masteryUnavailable: boolean
  atRiskStudents: AtRiskStudent[]
  /** False when the section has too little closed work to judge anybody. An
   *  empty at-risk list then means "we cannot tell yet", NOT "everyone is
   *  fine" — the UI must not assert safety it has no evidence for. */
  riskHasEnoughSignal: boolean
}

// --- Cross-Quiz Analytics Action ---

export async function getClassAnalytics(
  sectionId: string
): Promise<{ error?: string; data?: ClassAnalytics }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const access = await verifySectionAccess(sectionId, user.id)
    if (!access.ok) return { error: 'You do not have access to this section' }
    const adminDb = access.adminDb

    /* Started here, awaited at step 7. These three depend only on sectionId, so
       starting them now lets them overlap the enrollment/quiz/attempt reads
       below instead of adding their latency after them. */
    const masteryReads = Promise.all([
      skillQueries.listSectionSkills(adminDb, sectionId),
      skillQueries.getSectionMasteryRows(adminDb, sectionId),
      adminDb.from('course_sections').select('settings').eq('id', sectionId).maybeSingle(),
    ]).catch((err) => {
      /* Must not reject: a promise started before an early return would surface
         as an unhandled rejection rather than a failed read. But the caller has
         to be able to tell failure from emptiness — see masteryUnavailable
         below. Returning empty arrays alone would make a failed read look like
         a course with no skills. */
      logger.error('getClassAnalytics: mastery reads failed', err, { sectionId })
      return null
    })

    // 1. Fetch enrolled students
    const { data: enrollments } = await adminDb
      .from('enrollments')
      .select('student_id, student:profiles(id, name, email)')
      .eq('section_id', sectionId)
      .in('status', ['enrolled', 'completed', 'active'])

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resolveJoin = (val: any) => (Array.isArray(val) ? val[0] : val)
    const studentMap = new Map<string, { name: string; email: string }>()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const e of (enrollments || []) as any[]) {
      const profile = resolveJoin(e.student)
      studentMap.set(e.student_id, {
        name: profile?.name || 'Unknown',
        email: profile?.email || '',
      })
    }

    // 2. Fetch published quizzes
    const { data: quizRows } = await adminDb
      .from('quizzes')
      .select('id, title, due_date, pass_threshold, status')
      .eq('section_id', sectionId)
      .eq('status', 'published')
      .order('created_at', { ascending: true })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const quizzes = (quizRows || []) as any[]

    // 3. Fetch all submitted attempts for section
    const { data: attempts } = await adminDb
      .from('quiz_attempts')
      .select('id, student_id, quiz_id, score, status')
      .eq('section_id', sectionId)
      .eq('status', 'submitted')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allAttempts = (attempts || []) as any[]

    // 4. Per-quiz performance
    const quizPerformance: QuizPerformance[] = quizzes.map((q) => {
      const qAttempts = allAttempts.filter((a) => a.quiz_id === q.id)
      // Best attempt per student
      const bestByStudent = new Map<string, number>()
      for (const a of qAttempts) {
        const prev = bestByStudent.get(a.student_id) ?? -1
        if ((a.score ?? -1) > prev) bestByStudent.set(a.student_id, a.score ?? 0)
      }
      const scores = Array.from(bestByStudent.values())
      const avg = scores.length > 0 ? Math.round(scores.reduce((s, v) => s + v, 0) / scores.length) : 0
      const passCount = scores.filter((s) => s >= (q.pass_threshold ?? 0)).length
      return {
        quizId: q.id,
        quizTitle: q.title,
        averageScore: avg,
        passRate: scores.length > 0 ? Math.round((passCount / scores.length) * 100) : 0,
        attemptCount: scores.length,
        dueDate: q.due_date,
      }
    })

    // 5. Overall score distribution
    const allBestScores: number[] = []
    const studentQuizScores = new Map<string, Map<string, number>>() // studentId → quizId → best score
    for (const a of allAttempts) {
      if (!studentQuizScores.has(a.student_id)) studentQuizScores.set(a.student_id, new Map())
      const qmap = studentQuizScores.get(a.student_id)!
      const prev = qmap.get(a.quiz_id) ?? -1
      if ((a.score ?? -1) > prev) qmap.set(a.quiz_id, a.score ?? 0)
    }
    for (const qmap of studentQuizScores.values()) {
      for (const score of qmap.values()) allBestScores.push(score)
    }

    const buckets = ['0-20%', '21-40%', '41-60%', '61-80%', '81-100%']
    const overallScoreDistribution = buckets.map((range, i) => {
      const lo = i * 20
      const hi = (i + 1) * 20
      const count = allBestScores.filter((s) =>
        i === 4 ? s >= lo && s <= hi : s >= lo && s < hi
      ).length
      return { range, count }
    })

    // 6. Summary
    const classAverage = allBestScores.length > 0
      ? parseFloat((allBestScores.reduce((a, b) => a + b, 0) / allBestScores.length).toFixed(1))
      : null
    const avgPassRate = quizPerformance.length > 0
      ? Math.round(quizPerformance.reduce((s, q) => s + q.passRate, 0) / quizPerformance.length)
      : null

    const summary = {
      totalStudents: studentMap.size,
      totalQuizzes: quizzes.length,
      classAverage,
      averagePassRate: avgPassRate,
      totalAttempts: allBestScores.length,
    }

    /* 7. Topic performance — the section's curated skills, not raw quiz tags.
       This used to count correct/total per raw `quiz_questions.tags[]` string.
       That is a different number from the one the roadmap's Class analytics and
       Athena both report for the same course: unnormalized, so casing variants
       split into separate topics; binary, so partial credit is thrown away;
       unweighted, so a 1-point item counts as much as a 20-point exam; and
       quiz-only, so an assignment-heavy course showed nothing. Two numbers for
       one question is the bug.

       Composes the shipped readers and the shipped pure aggregator rather than
       re-deriving the maths, the same way loadTopicMastery does in
       professor-assistant/context.ts. Deliberately not routed through the
       roadmap's getConceptAnalytics: that gates on verifyOwnership (professor
       only) while this action gates on verifySectionAccess, which TAs and
       graders pass. */
    /* A failed read is NOT an empty course. Collapsing the two would render
       "No skills set up yet" with a button inviting a professor to go create the
       forty skills they already have. Same rule the enrollment lookup below
       follows, and the same one .claude/rules/dead-ends.md states: a 404 asserts
       the thing does not exist, a failed fetch means we do not know. */
    const masteryResult = await masteryReads
    const masteryUnavailable = masteryResult === null
    const [skillRows, masteryRows, sectionSettingsRes] = masteryResult ?? [[], [] as MasteryDatum[], { data: null }]
    // Excluded (professor dropped it) and suppressed (AI-suggested, not yet
    // corroborated) skills are hidden everywhere else; this must not be the one
    // surface that resurrects them.
    const trackedSkills = (skillRows ?? []).filter((s) => !s.excluded && !s.suppressed)
    const masteryConfig = resolveSkillMasteryConfig(sectionSettingsRes?.data?.settings)
    const masteryView = aggregateSectionMastery(trackedSkills, masteryRows ?? [], masteryConfig)
    // `classScore` is null until a skill has real evidence. Dropping those is
    // what stops an unassessed skill rendering as a red 0% bar.
    const topicPerformance = masteryView.ranked.filter((t) => t.classScore != null)
    const trackedSkillCount = trackedSkills.filter((s) => s.parent_id === null).length

    /* 8. At-risk students, from the shared engine.
       The old rule lived here, was quiz-only, and was copied twice more into the
       professor assistant. A course that graded assignments and ran no quizzes
       flagged nobody, and the tab then rendered "All students are performing
       within acceptable thresholds" — safety asserted from zero evidence.
       gatherSectionRisk reads both kinds of work, waits out a 72h grace before
       counting anything missing, compares each score to that item's own class
       median so a brutal quiz indicts itself, and reports when it does not have
       enough closed work to judge at all. */
    const sectionRisk = await gatherSectionRisk(adminDb, sectionId)
    const atRiskStudents = sectionRisk.students.filter((s) => s.atRisk)

    return {
      data: {
        summary,
        quizPerformance,
        overallScoreDistribution,
        topicPerformance,
        metricLabel: CLASS_METRIC_LABEL[masteryConfig.classMetric] ?? masteryConfig.classMetric,
        atRiskThreshold: masteryConfig.atRiskThreshold,
        trackedSkillCount,
        masteryUnavailable,
        atRiskStudents,
        riskHasEnoughSignal: sectionRisk.hasEnoughSignal,
      },
    }
  } catch (error) {
    logger.error('getClassAnalytics: Unexpected error', error, { sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

// ── Per-Student Analytics ──────────────────────────────────────

export interface StudentAttemptDetail {
  attemptId: string
  quizId: string
  quizTitle: string
  score: number | null
  earnedPoints: number | null
  totalPoints: number | null
  submittedAt: string | null
  startedAt: string
  timeSpentSeconds: number | null
  status: string
  proctoringSummary: ProctoringSummary | null
}

interface ProctoringSummary {
  totalKeystrokes: number
  copyCount: number
  pasteCount: number
  cutCount: number
  tabSwitchCount: number
  multipleFaceCount: number
  phoneDetectedCount: number
  snapshotCount: number
  webcamDenied: boolean
  suspiciousFlags: string[]
}

export interface StudentAnalyticsData {
  student: { id: string; name: string; email: string; finalGrade: string | null; finalScore: number | null }
  attempts: StudentAttemptDetail[]
  /** This student's mastery per curated skill. Renamed from `topicInsights`,
   *  which meant raw quiz-tag accuracy and would keep reading that way. */
  skillMastery: StudentSkillScore[]
  /** Curated main skills, so the UI can tell "no skills set up" from "skills
   *  set up, nothing assessed for this student yet". */
  trackedSkillCount: number
  /** True when the mastery read failed — say so, do not claim there are none. */
  masteryUnavailable: boolean
  snapshots: ProctoringSnapshot[]
  quizCount: number
  classAverage: number | null
}

/**
 * Fetch comprehensive analytics for a single student in a section.
 * Combines quiz scores, proctoring summaries, and topic performance.
 */
export async function getStudentAnalytics(
  sectionId: string,
  studentId: string,
): Promise<{ data?: StudentAnalyticsData; error?: string; notFound?: true }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const access = await verifySectionAccess(sectionId, user.id)
    /* An access denial is NOT a transient failure — the page was rendering it as "try again in
       a moment", which a retry can never resolve. It is also NOT a 'no-access' DeadEnd:
       .claude/rules/dead-ends.md reserves that for role-AREA boundaries, and this is keyed by a
       resource id, where distinguishing "not yours" from "doesn't exist" is a cross-tenant
       existence oracle. So it fuses with not-found, exactly like a missing student. */
    if (!access.ok) return { notFound: true }
    const adminDb = access.adminDb

    /* Started here, awaited at step 4 — same reason as getClassAnalytics: these
       depend only on sectionId/studentId, so they overlap the reads below
       instead of stacking their latency on top. Access is already verified. */
    const studentMasteryReads = Promise.all([
      skillQueries.listSectionSkills(adminDb, sectionId),
      skillQueries.getStudentMasteryRows(adminDb, sectionId, studentId),
    ]).catch((err) => {
      // Must not reject: this function returns early on a missing enrollment,
      // and an unawaited rejected promise is an unhandled rejection. null rather
      // than empty arrays so a failed read is not mistaken for a course that
      // tracks no skills — see masteryUnavailable.
      logger.error('getStudentAnalytics: mastery reads failed', err, { sectionId, studentId })
      return null
    })

    // 1. Student profile + enrollment
    const { data: enrollment, error: enrollErr } = await adminDb
      .from('enrollments')
      .select('id, student_id, final_grade, final_score, student:profiles(id, name, email)')
      .eq('section_id', sectionId)
      .eq('student_id', studentId)
      .single()

    /* A failed query is NOT a missing student. `.single()` returns PGRST116 for no rows, which
       is the genuine not-found; anything else means the lookup broke and we do not know
       whether the student exists. Reporting "not found" for a broken query tells the professor
       something false about their roster (see .claude/rules/dead-ends.md — "a 404 asserts the
       thing doesn't exist; a failed fetch means we don't know"). */
    if (enrollErr && enrollErr.code !== 'PGRST116') {
      logger.error('getStudentAnalytics: enrollment lookup failed', enrollErr, { sectionId, studentId })
      return { error: 'Could not load this student. Please try again.' }
    }
    // Not enrolled here, or no such student — indistinguishable ON PURPOSE, so the page can
    // never be used to probe which studentIds exist in other sections.
    if (!enrollment) return { notFound: true }

    const profile = Array.isArray(enrollment.student) ? enrollment.student[0] : enrollment.student
    const student = {
      id: studentId,
      name: profile?.name || 'Unknown',
      email: profile?.email || '',
      finalGrade: enrollment.final_grade,
      finalScore: enrollment.final_score,
    }

    // 2. Published quizzes
    const { data: quizRows } = await adminDb
      .from('quizzes')
      .select('id, title, status, proctoring_enabled, video_proctoring_enabled')
      .eq('section_id', sectionId)
      .eq('status', 'published')
      .order('created_at', { ascending: true })

    const quizzes = quizRows || []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const quizMap = new Map(quizzes.map((q: any) => [q.id, q]))

    // 3. All attempts by this student
    const { data: attemptRows } = await adminDb
      .from('quiz_attempts')
      .select('id, quiz_id, score, earned_points, total_points, submitted_at, started_at, time_spent_seconds, status, proctoring_summary')
      .eq('section_id', sectionId)
      .eq('student_id', studentId)
      .order('submitted_at', { ascending: false })

    const attempts: StudentAttemptDetail[] = (attemptRows || [])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((a: any) => quizMap.has(a.quiz_id))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((a: any) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const quiz = quizMap.get(a.quiz_id) as any
        return {
          attemptId: a.id,
          quizId: a.quiz_id,
          quizTitle: quiz?.title || 'Unknown Quiz',
          score: a.score,
          earnedPoints: a.earned_points,
          totalPoints: a.total_points,
          submittedAt: a.submitted_at,
          startedAt: a.started_at,
          timeSpentSeconds: a.time_spent_seconds,
          status: a.status,
          proctoringSummary: a.proctoring_summary || null,
        }
      })

    /* 4. This student's mastery per curated skill. Was raw quiz-tag accuracy;
       see the note in getClassAnalytics for why that number disagreed with
       every other topic figure in the product. getStudentMasteryRows is the
       per-student reader, as opposed to the section-wide one used above. */
    const studentMasteryResult = await studentMasteryReads
    const masteryUnavailable = studentMasteryResult === null
    const [studentSkillRows, studentMasteryRows] = studentMasteryResult ?? [[], [] as MasteryDatum[]]
    const studentTracked = (studentSkillRows ?? []).filter((s) => !s.excluded && !s.suppressed)
    const skillMastery: StudentSkillScore[] = aggregateStudentMastery(studentTracked, studentMasteryRows ?? [])
    const trackedSkillCount = studentTracked.filter((s) => s.parent_id === null).length

    // 5. Class average (for context)
    const { data: allAttempts } = await adminDb
      .from('quiz_attempts')
      .select('score')
      .eq('section_id', sectionId)
      .eq('status', 'submitted')
      .not('score', 'is', null)

    let classAverage: number | null = null
    if (allAttempts && allAttempts.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const total = allAttempts.reduce((sum: number, a: any) => sum + (a.score || 0), 0)
      classAverage = Math.round(total / allAttempts.length)
    }

    // 6. Proctoring snapshots for this student. Bucket is private (mig 47);
    //    mint fresh 1-hour signed URLs at read time so review images render.
    const { data: snapshotRows } = await adminDb
      .from('proctoring_snapshots')
      .select('*')
      .eq('section_id', sectionId)
      .eq('student_id', studentId)
      .order('timestamp_offset', { ascending: true })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const snapshotArr = (snapshotRows || []) as any[]
    const snapshotPaths = snapshotArr.map((s) => s.storage_path).filter(Boolean) as string[]
    const signedByPath = new Map<string, string>()
    if (snapshotPaths.length > 0) {
      const { data: signed } = await adminDb.storage
        .from('proctoring-snapshots')
        .createSignedUrls(snapshotPaths, 60 * 60)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(signed || []).forEach((row: any) => {
        if (row?.path && row?.signedUrl) signedByPath.set(row.path, row.signedUrl)
      })
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const snapshots: ProctoringSnapshot[] = snapshotArr.map((s: any) => ({
      id: s.id,
      attemptId: s.attempt_id,
      studentId: s.student_id,
      quizId: s.quiz_id,
      sectionId: s.section_id,
      violationType: s.violation_type,
      storagePath: s.storage_path,
      snapshotUrl: signedByPath.get(s.storage_path) ?? s.snapshot_url,
      timestampOffset: s.timestamp_offset,
      questionIndex: s.question_index,
      faceCount: s.face_count ?? 0,
      createdAt: s.created_at,
    }))

    return {
      data: {
        student,
        attempts,
        skillMastery,
        trackedSkillCount,
        masteryUnavailable,
        snapshots,
        quizCount: quizzes.length,
        classAverage,
      },
    }
  } catch (error) {
    logger.error('getStudentAnalytics: Unexpected error', error, { sectionId, studentId })
    return { error: 'An unexpected error occurred' }
  }
}
