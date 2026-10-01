/**
 * Centralized Supabase Query Utilities — all database reads and writes go through here.
 *
 * This file is the single source of truth for database operations. By funneling
 * all queries through these functions, we get:
 * - Consistent error handling and logging across the app
 * - Type-safe return values derived from the Supabase schema
 * - Easy auditing of which tables/columns are accessed
 * - A single place to optimize queries or add caching later
 *
 * Organization:
 * - dashboardQueries:          Aggregate counts for the dashboard metric cards
 * - profileQueries:            CRUD operations on the profiles table
 * - courseQueries:             Read operations for courses and sections
 * - enrollmentQueries:         Read operations for enrollment records
 * - departmentQueries:         CRUD + aggregate queries for department management
 * - courseAdminQueries:        CRUD + aggregate queries for course management (admin)
 * - professorQueries:          CRUD + aggregate queries for professor management (admin)
 * - courseAssignmentQueries:   CRUD for course section assignments (admin)
 * - studentQueries:            CRUD + aggregate queries for student management (admin)
 *
 * Every function receives a SupabaseClient instance as the first parameter
 * (dependency injection) so it works with both server and client Supabase instances.
 *
 * Error strategy: Each function catches errors, logs them via logger.error(),
 * and returns a safe fallback (null, 0, or []) so callers don't need try/catch.
 *
 * Tables: profiles, departments, programs, courses, course_sections, enrollments, department_faculty
 *
 * Student management uses profiles (role='student') + enrollments.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// Server-only: this module imports the server + admin Supabase clients, so it must
// never be bundled into a client component. This guard turns any such value-import
// into a build error rather than a silent server-code (and near-secret) leak.
import 'server-only'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import { readAllPages } from '@/lib/supabase/paged-read'
import type { SkillRow, ActivityType, ActivitySkillRow } from '@/lib/validations/skill'
import type { LcRoom } from '@/lib/validations/live-classroom'
import type { MasteryDatum } from '@/lib/skills/aggregate'
import { aggregateStudentMastery } from '@/lib/skills/aggregate'
import { MASTERY_THRESHOLDS } from '@/lib/skills/mastery'
import { getOwnMasteryTrend } from '@/lib/roadmap/engagement'
import { resolveJoin } from '@/lib/supabase/resolve-join'
import { DEFAULT_ENABLED_FEATURES } from '@/lib/course-features'
import type { ProjectDeliverableInput } from '@/lib/dashboard/todos'
import type {
  ProfessorTodoSources,
  ProfessorAssessment,
  FailedSlideRoom,
} from '@/lib/dashboard/professor-todos'
import type { RawAssignment, RawQuiz, RawSession, RawSessionChild } from '@/lib/roadmap/auto-roadmap-helpers'
import { flattenRubricCriteria } from '@/lib/roadmap/node-drawer'
import { parseRubric } from '@/lib/validations/assignment'
import { signMany } from '@/lib/supabase/signed-urls'
import { COURSE_RESOURCES_BUCKET } from '@/lib/supabase/storage'

/** Type alias for the Supabase client — inferred from the async createClient factory */
type SupabaseClient = Awaited<ReturnType<typeof createClient>>

/** Raw resource rows for the roadmap, returned by roadmapQueries.getSectionResources. */
interface RoadmapResourceRaw {
  quizzes: RawQuiz[]
  /** quizId → canonical skill names mapped to it via activity_skills. */
  quizSkillNames: Map<string, string[]>
  assignments: RawAssignment[]
  sessions: RawSession[]
  polls: RawSessionChild[]
  liveQuizzes: RawSessionChild[]
}

/**
 * Dashboard Queries — aggregate counts for the metric cards on /dashboard.
 *
 * Each role (institution_admin, professor, student) has its own count function
 * that returns a Record<string, number> matching the card keys in page.tsx.
 */
export const dashboardQueries = {
  /**
   * Fetches total counts for institution admins: departments, professors, students.
   * Runs counts in parallel via Promise.all for speed.
   * Uses { count: 'exact', head: true } to get counts without fetching rows.
   *
   * institutionId — when provided, scopes counts to a single tenant. Required
   * by every institution_admin page to prevent cross-tenant leakage. Omit only
   * for super_admin / platform-wide counts (none today).
   */
  async getInstitutionAdminCounts(supabase: SupabaseClient, institutionId?: string) {
    try {
      const deptQuery = supabase.from('departments').select('id', { count: 'exact', head: true })
      const profQuery = supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'professor')
      const studQuery = supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'student')
      /* section_staff_with_institution is a view that joins section_staff →
       * course_sections to expose institution_id (the base table doesn't carry
       * one). Lets us filter the active-staff count by tenant without an
       * inner-join workaround in PostgREST. */
      const staffQuery = (supabase as any)
        .from('section_staff_with_institution')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'active')
        .gt('ends_at', new Date().toISOString())

      if (institutionId) {
        deptQuery.eq('institution_id', institutionId)
        profQuery.eq('institution_id', institutionId)
        studQuery.eq('institution_id', institutionId)
        staffQuery.eq('institution_id', institutionId)
      }

      const [departments, professors, students, staff] = await Promise.all([
        deptQuery,
        profQuery,
        studQuery,
        staffQuery,
      ])

      if (departments.error) logger.error('dashboardQueries.getInstitutionAdminCounts', departments.error, { query: 'departments' })
      if (professors.error) logger.error('dashboardQueries.getInstitutionAdminCounts', professors.error, { query: 'professors' })
      if (students.error) logger.error('dashboardQueries.getInstitutionAdminCounts', students.error, { query: 'students' })
      if (staff.error) logger.error('dashboardQueries.getInstitutionAdminCounts', staff.error, { query: 'staff' })

      return {
        departments: departments.count || 0,
        professors: professors.count || 0,
        students: students.count || 0,
        staff: staff.count || 0,
      }
    } catch (error) {
      logger.error('dashboardQueries.getInstitutionAdminCounts', error)
      return { departments: 0, professors: 0, students: 0, staff: 0 }
    }
  },

  /**
   * Fetches counts for a student: enrolled courses + average grade.
   *
   * Average grade: mean of enrollments' non-null final_score, 2dp (null if none graded,
   * so the dashboard can show "—" rather than a misleading 0 that reads as failing).
   *
   * The dashboard's "To-Dos" metric is derived from the to-do list sources (feed +
   * project deliverables) in the page itself, not here, so the card and the list
   * below it always show the same number.
   */
  async getStudentCounts(supabase: SupabaseClient, studentId: string) {
    try {
      const [enrollmentsResult, gradesResult] = await Promise.all([
        supabase.from('enrollments').select('id', { count: 'exact', head: true }).eq('student_id', studentId),
        supabase.from('enrollments').select('final_score').eq('student_id', studentId).not('final_score', 'is', null),
      ])

      if (enrollmentsResult.error) logger.error('dashboardQueries.getStudentCounts', enrollmentsResult.error, { studentId, query: 'enrollments' })
      if (gradesResult.error) logger.error('dashboardQueries.getStudentCounts', gradesResult.error, { studentId, query: 'grades' })

      const grades = (gradesResult.data || [])
        .map((e) => e.final_score)
        .filter((s): s is number => s !== null)

      const averageGrade: number | null =
        grades.length > 0
          ? parseFloat((grades.reduce((a, b) => a + b, 0) / grades.length).toFixed(2))
          : null

      return {
        enrolledCourses: enrollmentsResult.count || 0,
        averageGrade,
      }
    } catch (error) {
      logger.error('dashboardQueries.getStudentCounts', error, { studentId })
      return { enrolledCourses: 0, averageGrade: 0 }
    }
  },

  /**
   * Weekly completion for the dashboard tracker: among the student's actionable
   * assignment/quiz to-dos DUE in the given window (the current Mon–Sun week),
   * how many are done. Completion is the shared feed layer's `is_done`, flipped
   * by submission/attempt events. `end` is exclusive. Recipient-scoped.
   */
  async getWeeklyCompletion(
    supabase: SupabaseClient,
    studentId: string,
    weekStartISO: string,
    weekEndISO: string,
  ) {
    try {
      const { data, error } = await (supabase as any)
        .from('feed_items')
        .select('is_done')
        .eq('recipient_id', studentId)
        .eq('is_actionable', true)
        .in('entity_type', ['assignment', 'quiz'])
        .gte('due_at', weekStartISO)
        .lt('due_at', weekEndISO)

      if (error) {
        logger.error('dashboardQueries.getWeeklyCompletion', error, { studentId })
        return { done: 0, total: 0 }
      }
      const rows = (data || []) as { is_done: boolean }[]
      return { done: rows.filter((r) => r.is_done).length, total: rows.length }
    } catch (error) {
      logger.error('dashboardQueries.getWeeklyCompletion', error, { studentId })
      return { done: 0, total: 0 }
    }
  },

  /**
   * Project deliverables (project_phases with a due date) for a student's to-do list,
   * weekly-completion tracker, and per-course due counts. Deliverables don't flow
   * through the shared feed, so this reads them directly — scoped to the student's
   * enrolled sections, to active + course/public-visible projects, and gated by team
   * membership (team-specific phases are only returned for teams the student is on).
   *
   * Returns ALL such phases (including completed ones) with their phase `status`; each
   * caller applies its own filter (the list/counts drop completed + past-due; the
   * weekly tracker counts completed toward its total). Date-only `due_date`s are
   * normalized to end-of-day UTC so a deliverable due today isn't treated as past-due.
   * Recipient-scoped; caller must have authenticated the student and pass an admin client.
   */
  async getStudentProjectDeliverables(
    supabase: SupabaseClient,
    studentId: string,
  ): Promise<ProjectDeliverableInput[]> {
    try {
      const db = supabase as any
      // Enrolled sections + the student's project-team memberships (independent reads).
      const [enrRes, memRes] = await Promise.all([
        db.from('enrollments').select('section_id').eq('student_id', studentId).in('status', ['enrolled', 'completed']),
        db.from('project_members').select('team_id').eq('user_id', studentId),
      ])
      if (enrRes.error) {
        logger.error('dashboardQueries.getStudentProjectDeliverables', enrRes.error, { studentId, query: 'enrollments' })
        return []
      }
      const sectionIds = [...new Set((enrRes.data || []).map((e: any) => e.section_id).filter(Boolean))]
      if (sectionIds.length === 0) return []
      const studentTeamIds = new Set((memRes.data || []).map((m: any) => m.team_id).filter(Boolean))

      // Active, course-visible projects in those sections.
      const { data: projects, error: projErr } = await db
        .from('projects')
        .select('id, title, section_id')
        .in('section_id', sectionIds)
        .eq('status', 'active')
        .in('visibility', ['course', 'public'])
      if (projErr) {
        logger.error('dashboardQueries.getStudentProjectDeliverables', projErr, { studentId, query: 'projects' })
        return []
      }
      const projById = new Map<string, { title: string; section_id: string | null }>()
      for (const p of (projects || []) as any[]) projById.set(p.id, { title: p.title, section_id: p.section_id })
      if (projById.size === 0) return []

      // Deliverables = phases with a due date for those projects.
      const { data: phases, error: phaseErr } = await db
        .from('project_phases')
        .select('id, title, due_date, status, project_id, team_id, assignment_id')
        .in('project_id', [...projById.keys()])
        .not('due_date', 'is', null)
      if (phaseErr) {
        logger.error('dashboardQueries.getStudentProjectDeliverables', phaseErr, { studentId, query: 'phases' })
        return []
      }

      const out: ProjectDeliverableInput[] = []
      for (const ph of (phases || []) as any[]) {
        // Team-specific phases are visible only to members of that team.
        if (ph.team_id != null && !studentTeamIds.has(ph.team_id)) continue
        const proj = projById.get(ph.project_id)
        if (!proj) continue
        out.push({
          phaseId: ph.id,
          projectId: ph.project_id,
          projectTitle: proj.title,
          phaseTitle: ph.title,
          sectionId: proj.section_id,
          dueAt: ph.due_date ? new Date(`${ph.due_date}T23:59:59.999Z`).toISOString() : null,
          status: ph.status,
          assignmentId: ph.assignment_id ?? null,
        })
      }
      return out
    } catch (error) {
      logger.error('dashboardQueries.getStudentProjectDeliverables', error, { studentId })
      return []
    }
  },
}

/**
 * Professor Dashboard Queries — the raw signals behind the professor to-do list.
 *
 * SECURITY: the dashboard reads with the service-role client, so RLS is bypassed
 * and tenancy is enforced HERE. Every read below is scoped either to the caller's
 * own `sectionIds` or to ids derived from an already-scoped read. An unscoped
 * `.from()` in this function is a cross-institution leak, not a style nit.
 *
 * PERFORMANCE: filtering happens at the DB, never in JS. We fetch only ungraded
 * submissions (not every submission), only assessments closing inside the
 * horizon, and only recently-ended rooms — otherwise a professor with a full
 * semester of history pulls thousands of rows on every dashboard render.
 */
export const professorDashboardQueries = {
  async getProfessorTodoSources(
    supabase: SupabaseClient,
    professorId: string,
    now: number = Date.now(),
  ): Promise<Omit<ProfessorTodoSources, 'courseCodeBySection'> & { failed: boolean }> {
    // `failed` is load-bearing: without it a broken fetch is indistinguishable
    // from an empty queue, and the dashboard would cheerfully report "you're all
    // caught up" while hiding real work. Empty means empty; failed means failed.
    const empty = {
      assessments: [],
      ungraded: [],
      turnedInByAssessment: {},
      enrolledBySection: {},
      failedSlideRooms: [],
      recentReportsBySection: {},
    }

    try {
      const db = supabase as any

      // Deriving sectionIds from professorId HERE (rather than accepting them as
      // a param) is the tenancy guarantee: it makes every downstream read
      // unforgeable by construction, the same shape as getProfessorCalendarEvents.
      // A caller can't hand this function someone else's section ids.
      const { data: sectionRows, error: sectionError } = await db
        .from('course_sections')
        .select('id')
        .eq('professor_id', professorId)
        .eq('status', 'active')

      if (sectionError) {
        logger.error('professorDashboardQueries.getProfessorTodoSources', sectionError, { professorId, query: 'sections' })
        return { ...empty, failed: true }
      }

      const sectionIds = ((sectionRows ?? []) as any[]).map((s) => s.id as string)
      if (sectionIds.length === 0) return { ...empty, failed: false }

      const DAY_MS = 86_400_000
      const reportWindowStart = new Date(now - 7 * DAY_MS).toISOString()
      const deadlineHorizon = new Date(now + 7 * DAY_MS).toISOString()

      // ── Wave 1 — everything scoped directly by section ────────────────────
      const [
        assignmentRes,
        quizRes,
        enrollmentRes,
        scheduledRoomRes,
        endedRoomRes,
        failedJobRes,
      ] = await Promise.all([
        db.from('assignments')
          .select('id, section_id, title, due_at')
          .in('section_id', sectionIds)
          .eq('status', 'published'),
        db.from('quizzes')
          .select('id, section_id, title, due_date')
          .in('section_id', sectionIds)
          .eq('status', 'published'),
        db.from('enrollments')
          .select('section_id')
          .in('section_id', sectionIds)
          .in('status', ['enrolled', 'active', 'completed']),
        db.from('lc_rooms')
          .select('id, section_id, name, scheduled_at')
          .in('section_id', sectionIds)
          .eq('status', 'scheduled'),
        // Bounded to the report window — an all-time read grows unbounded across
        // a semester and would put a permanent backlog on the dashboard.
        db.from('lc_rooms')
          .select('id, section_id')
          .in('section_id', sectionIds)
          .eq('status', 'ended')
          .gte('ended_at', reportWindowStart),
        db.from('background_jobs')
          .select('params')
          .in('section_id', sectionIds)
          .eq('type', 'render_scheduled_deck')
          .eq('status', 'failed'),
      ])

      let failed = false
      for (const [label, res] of Object.entries({
        assignments: assignmentRes, quizzes: quizRes, enrollments: enrollmentRes,
        scheduledRooms: scheduledRoomRes,
        endedRooms: endedRoomRes, failedJobs: failedJobRes,
      })) {
        if (res.error) {
          failed = true
          logger.error('professorDashboardQueries.getProfessorTodoSources', res.error, { query: label })
        }
      }

      const assessments: ProfessorAssessment[] = [
        ...((assignmentRes.data ?? []) as any[]).map((a) => ({
          id: a.id as string,
          sectionId: a.section_id as string,
          title: (a.title as string) ?? 'Untitled assignment',
          dueAt: (a.due_at as string) ?? null,
          type: 'assignment' as const,
        })),
        ...((quizRes.data ?? []) as any[]).map((q) => ({
          id: q.id as string,
          sectionId: q.section_id as string,
          title: (q.title as string) ?? 'Untitled quiz',
          // Quizzes carry `due_date`; assignments carry `due_at`.
          dueAt: (q.due_date as string) ?? null,
          type: 'quiz' as const,
        })),
      ]

      const assignmentIds = assessments.filter((a) => a.type === 'assignment').map((a) => a.id)
      const closing = assessments.filter(
        (a) => a.dueAt != null && a.dueAt >= new Date(now).toISOString() && a.dueAt <= deadlineHorizon,
      )
      const closingAssignmentIds = closing.filter((a) => a.type === 'assignment').map((a) => a.id)
      const closingQuizIds = closing.filter((a) => a.type === 'quiz').map((a) => a.id)
      const scheduledRooms = (scheduledRoomRes.data ?? []) as any[]
      const scheduledRoomIds = scheduledRooms.map((r) => r.id as string)
      const endedRooms = (endedRoomRes.data ?? []) as any[]
      const endedRoomIds = endedRooms.map((r) => r.id as string)

      // ── Wave 2 — reads keyed by ids derived from the scoped reads above ───
      const [ungradedRes, turnedInRes, attemptRes, deckRes, reportRes] = await Promise.all([
        assignmentIds.length
          ? db.from('assignment_submissions')
              .select('assignment_id, submitted_at')
              .in('assignment_id', assignmentIds)
              .eq('status', 'submitted')
          : Promise.resolve({ data: [], error: null }),
        closingAssignmentIds.length
          ? db.from('assignment_submissions')
              .select('assignment_id')
              .in('assignment_id', closingAssignmentIds)
              .neq('status', 'draft')
          : Promise.resolve({ data: [], error: null }),
        closingQuizIds.length
          ? db.from('quiz_attempts')
              .select('quiz_id, student_id')
              .in('quiz_id', closingQuizIds)
              .eq('status', 'submitted')
          : Promise.resolve({ data: [], error: null }),
        scheduledRoomIds.length
          ? db.from('lc_decks').select('room_id, deck_url').in('room_id', scheduledRoomIds)
          : Promise.resolve({ data: [], error: null }),
        endedRoomIds.length
          ? db.from('lc_session_reports').select('room_id, status:report->>status').in('room_id', endedRoomIds)
          : Promise.resolve({ data: [], error: null }),
      ])

      for (const [label, res] of Object.entries({
        ungraded: ungradedRes, turnedIn: turnedInRes, attempts: attemptRes,
        decks: deckRes, reports: reportRes,
      })) {
        if (res.error) {
          failed = true
          logger.error('professorDashboardQueries.getProfessorTodoSources', res.error, { query: label })
        }
      }

      // Turn-in counts: assignment submissions, plus DISTINCT students per quiz
      // (a quiz allows several attempts; one student is one turn-in).
      const turnedInByAssessment: Record<string, number> = {}
      for (const row of (turnedInRes.data ?? []) as any[]) {
        turnedInByAssessment[row.assignment_id] = (turnedInByAssessment[row.assignment_id] ?? 0) + 1
      }
      const quizStudents = new Map<string, Set<string>>()
      for (const row of (attemptRes.data ?? []) as any[]) {
        const set = quizStudents.get(row.quiz_id) ?? new Set<string>()
        set.add(row.student_id)
        quizStudents.set(row.quiz_id, set)
      }
      for (const [quizId, students] of quizStudents) turnedInByAssessment[quizId] = students.size

      const enrolledBySection: Record<string, number> = {}
      for (const row of (enrollmentRes.data ?? []) as any[]) {
        enrolledBySection[row.section_id] = (enrolledBySection[row.section_id] ?? 0) + 1
      }

      // A failed render deletes its deck row, so a re-upload (deck present again)
      // must NOT keep showing the stale failure — mirrors getUpcomingScheduledRooms.
      const roomsWithDeck = new Set<string>()
      for (const d of (deckRes.data ?? []) as any[]) roomsWithDeck.add(d.room_id as string)
      const failedRoomIds = new Set<string>()
      for (const j of (failedJobRes.data ?? []) as any[]) {
        const roomId = j.params?.roomId
        if (roomId) failedRoomIds.add(roomId as string)
      }
      const failedSlideRooms: FailedSlideRoom[] = scheduledRooms
        .filter((r) => failedRoomIds.has(r.id as string) && !roomsWithDeck.has(r.id as string))
        .map((r) => ({
          id: r.id as string,
          sectionId: r.section_id as string,
          name: (r.name as string) ?? null,
          scheduledAt: (r.scheduled_at as string) ?? null,
        }))

      // 'generating' placeholders aren't ready to read yet.
      const readyRoomIds = new Set<string>(
        ((reportRes.data ?? []) as any[])
          .filter((r) => r.status !== 'generating')
          .map((r) => r.room_id as string),
      )
      const recentReportsBySection: Record<string, number> = {}
      for (const room of endedRooms) {
        if (!readyRoomIds.has(room.id as string)) continue
        const sid = room.section_id as string
        recentReportsBySection[sid] = (recentReportsBySection[sid] ?? 0) + 1
      }

      return {
        assessments,
        ungraded: ((ungradedRes.data ?? []) as any[]).map((u) => ({
          assignmentId: u.assignment_id as string,
          submittedAt: (u.submitted_at as string) ?? null,
        })),
        turnedInByAssessment,
        enrolledBySection,
        failedSlideRooms,
        recentReportsBySection,
        failed,
      }
    } catch (error) {
      logger.error('professorDashboardQueries.getProfessorTodoSources', error, { professorId })
      return { ...empty, failed: true }
    }
  },
}
// ── end getProfessorTodoSources ──

/**
 * Profile Queries — CRUD operations for the profiles table.
 *
 * The profiles table stores each user's role, name, email, and avatar URL.
 * It's the central source of truth for authorization (role-based access).
 *
 * Profile creation flow (Scholera is invite-only — public signup is disabled):
 * - Institution admins call createUser() in the admin server action, then
 *   immediately upsert the profile row with the right institution_id + role.
 * - The handle_new_user() DB trigger no longer creates profiles itself —
 *   it would have to guess institution_id, and admin actions own that.
 * - getProfileById() returns null if a profile is missing; that signals a
 *   bug in the invite flow rather than a legitimate state to recover from.
 */
export const profileQueries = {
  /**
   * Fetch a user's profile by their auth ID. Returns null if no row exists.
   *
   * A missing profile means the admin invite flow that created the auth user
   * failed to upsert the matching profiles row. That is a real bug — log it
   * loudly and return null instead of silently auto-creating a tenant-less
   * row that would violate institution_id_required_for_non_super_admin.
   */
  async getProfileById(supabase: SupabaseClient, userId: string) {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .single()

      if (data) return data

      if (error && error.code === 'PGRST116') {
        logger.error('profileQueries.getProfileById: profile missing for auth user — admin invite flow likely failed mid-way', null, { userId })
        return null
      }

      logger.error('profileQueries.getProfileById', error, { userId })
      return null
    } catch (error) {
      logger.error('profileQueries.getProfileById', error, { userId })
      return null
    }
  },
}

/**
 * Course Queries — read operations for courses and their sections.
 *
 * Courses vs Sections: A "course" is the abstract catalog entry (e.g. CS 101),
 * while a "section" is a specific offering (e.g. CS 101-A, Fall 2025, taught by Prof. X).
 * Students enroll in sections, not courses directly.
 */
export const courseQueries = {
  /**
   * Fetch all active course sections for a professor, with course info and enrollment counts.
   * Uses Supabase's nested select syntax to join course_sections → courses and enrollments.
   * Returns sections with status='active' only (no archived/completed sections).
   */
  async getProfessorSections(supabase: SupabaseClient, professorId: string) {
    try {
      const { data, error } = await supabase
        .from('course_sections')
        .select(`id, section_code, semester, year, course:courses(id, code, title), enrollments(id)`)
        .eq('professor_id', professorId)
        .eq('status', 'active')

      if (error) {
        logger.error('courseQueries.getProfessorSections', error, { professorId })
        return []
      }
      return data
    } catch (error) {
      logger.error('courseQueries.getProfessorSections', error, { professorId })
      return []
    }
  },

  /**
   * Fetch all course sections for a professor with extended fields for the professor dashboard.
   * Returns all sections (not just active) with settings, schedule, modality, location, max_students.
   */
  async getProfessorSectionsExtended(supabase: SupabaseClient, professorId: string) {
    try {
      const { data, error } = await supabase
        .from('course_sections')
        .select(`
          id, section_code, semester, year, status, modality, location,
          max_students, settings, schedule,
          course:courses(id, code, title, description, credits,
            department:departments(id, code, name)),
          enrollments(id, final_grade)
        `)
        .eq('professor_id', professorId)
        .order('year', { ascending: false })
        .order('semester', { ascending: false })

      if (error) {
        logger.error('courseQueries.getProfessorSectionsExtended', error, { professorId })
        return []
      }
      return data
    } catch (error) {
      logger.error('courseQueries.getProfessorSectionsExtended', error, { professorId })
      return []
    }
  },

  /**
   * Fetch a single course section with full details for the professor course container.
   * Returns null if not found or professor doesn't own this section.
   */
  async getProfessorSectionDetail(supabase: SupabaseClient, sectionId: string, professorId: string) {
    try {
      const { data, error } = await supabase
        .from('course_sections')
        .select(`
          id, section_code, semester, year, status, modality, location,
          max_students, settings, schedule, start_date, end_date,
          enrollment_start_date, enrollment_end_date,
          course:courses(id, code, title, description, credits,
            department:departments(id, code, name)),
          enrollments(id, status, final_grade, final_score,
            student:profiles(id, name, email))
        `)
        .eq('id', sectionId)
        .eq('professor_id', professorId)
        .single()

      if (error) {
        logger.error('courseQueries.getProfessorSectionDetail', error, { sectionId, professorId })
        return null
      }
      return data
    } catch (error) {
      logger.error('courseQueries.getProfessorSectionDetail', error, { sectionId, professorId })
      return null
    }
  },

  /**
   * Fetch a single course section with full details, without filtering by
   * professor_id. Callers MUST have already run verifySectionAccess() (or
   * equivalent) to confirm the caller is allowed to see this section —
   * this query doesn't enforce it. Used by the section container layout
   * so both professors and TAs see the same data.
   */
  async getSectionDetail(supabase: SupabaseClient, sectionId: string) {
    try {
      const { data, error } = await supabase
        .from('course_sections')
        .select(`
          id, section_code, semester, year, status, modality, location,
          max_students, settings, schedule, start_date, end_date,
          enrollment_start_date, enrollment_end_date, professor_id,
          course:courses(id, code, title, description, credits,
            department:departments(id, code, name)),
          enrollments(id, status, final_grade, final_score,
            student:profiles(id, name, email))
        `)
        .eq('id', sectionId)
        .single()

      if (error) {
        logger.error('courseQueries.getSectionDetail', error, { sectionId })
        return null
      }
      return data
    } catch (error) {
      logger.error('courseQueries.getSectionDetail', error, { sectionId })
      return null
    }
  },

  /**
   * Fetch all enrollments for a student, with full section, course, and professor details.
   * The deeply nested select joins: enrollments → course_sections → courses + profiles (professor).
   * Includes grades (final_grade, final_score) and section metadata (location, modality).
   */
  async getStudentEnrollments(supabase: SupabaseClient, studentId: string) {
    try {
      const { data, error } = await supabase
        .from('enrollments')
        .select(`
          id, status, final_grade, final_score,
          section:course_sections(id, section_code, semester, year, location, modality,
            course:courses(id, code, title), profiles(name))
        `)
        .eq('student_id', studentId)
        .in('status', ['enrolled', 'completed'])

      if (error) {
        logger.error('courseQueries.getStudentEnrollments', error, { studentId })
        return []
      }
      return data
    } catch (error) {
      logger.error('courseQueries.getStudentEnrollments', error, { studentId })
      return []
    }
  },
}

/**
 * Enrollment Queries — read operations for enrollment records.
 *
 * Enrollments link students to course sections and store their grades.
 * Each enrollment row represents one student in one section.
 */
export const enrollmentQueries = {
  /**
   * Fetch all enrolled students for a specific course section.
   * Returns student profile info (name, email) plus their grades.
   * Used by professors to view their class roster and grade status.
   */
  async getSectionEnrollments(supabase: SupabaseClient, sectionId: string) {
    try {
      const { data, error } = await supabase
        .from('enrollments')
        .select(`id, status, student:profiles(id, name, email), final_grade, final_score`)
        .eq('section_id', sectionId)

      if (error) {
        logger.error('enrollmentQueries.getSectionEnrollments', error, { sectionId })
        return []
      }
      return data
    } catch (error) {
      logger.error('enrollmentQueries.getSectionEnrollments', error, { sectionId })
      return []
    }
  },
}

/**
 * Department Queries — CRUD operations and aggregate queries for departments.
 *
 * Departments are the top-level organizational unit in the university hierarchy:
 * Department → Program → Course → Course Section
 *
 * Used by admin department list page, detail page, and server actions.
 */
export const departmentQueries = {
  /** Fetch all departments ordered by name. */
  async getAll(supabase: SupabaseClient, institutionId?: string) {
    try {
      const query = supabase
        .from('departments')
        .select('*')
        .order('name')
      if (institutionId) query.eq('institution_id', institutionId)
      const { data, error } = await query

      if (error) {
        logger.error('departmentQueries.getAll', error)
        return []
      }
      return data
    } catch (error) {
      logger.error('departmentQueries.getAll', error)
      return []
    }
  },

  /**
   * Fetch all departments with program, course, and faculty counts.
   * Uses nested selects to count related records without separate queries.
   * Primary query for the department list table.
   *
   * institutionId — when provided, scopes to a single tenant.
   */
  async getAllWithCounts(supabase: SupabaseClient, institutionId?: string) {
    try {
      const query = supabase
        .from('departments')
        .select(`
          *,
          programs(id),
          courses(id),
          department_faculty(id)
        `)
        .order('name')
      if (institutionId) query.eq('institution_id', institutionId)
      const { data, error } = await query

      if (error) {
        logger.error('departmentQueries.getAllWithCounts', error)
        return []
      }

      return (data || []).map((dept) => ({
        id: dept.id,
        name: dept.name,
        code: dept.code,
        description: dept.description,
        office_location: dept.office_location,
        contact_email: dept.contact_email,
        contact_phone: dept.contact_phone,
        status: dept.status,
        created_at: dept.created_at,
        updated_at: dept.updated_at,
        programCount: Array.isArray(dept.programs) ? dept.programs.length : 0,
        courseCount: Array.isArray(dept.courses) ? dept.courses.length : 0,
        facultyCount: Array.isArray(dept.department_faculty) ? dept.department_faculty.length : 0,
      }))
    } catch (error) {
      logger.error('departmentQueries.getAllWithCounts', error)
      return []
    }
  },

  /** Fetch a single department by ID. */
  async getById(supabase: SupabaseClient, departmentId: string) {
    try {
      const { data, error } = await supabase
        .from('departments')
        .select('*')
        .eq('id', departmentId)
        .single()

      if (error) {
        logger.error('departmentQueries.getById', error, { departmentId })
        return null
      }
      return data
    } catch (error) {
      logger.error('departmentQueries.getById', error, { departmentId })
      return null
    }
  },

  /** Fetch a department by its unique code. Used to check for duplicates.
   * Code uniqueness is now per-tenant (UNIQUE(institution_id, code)), so
   * institutionId is required to disambiguate. */
  async getByCode(supabase: SupabaseClient, code: string, institutionId: string) {
    try {
      const { data, error } = await supabase
        .from('departments')
        .select('id, code, institution_id')
        .eq('code', code)
        .eq('institution_id', institutionId)
        .maybeSingle()

      if (error) {
        logger.error('departmentQueries.getByCode', error, { code, institutionId })
        return null
      }
      return data
    } catch (error) {
      logger.error('departmentQueries.getByCode', error, { code, institutionId })
      return null
    }
  },

  /**
   * Fetch a department with its associated programs, courses, and faculty.
   * Runs 4 queries in parallel for the department detail page tabs.
   */
  async getByIdWithRelated(supabase: SupabaseClient, departmentId: string) {
    try {
      const [department, programs, courses, faculty] = await Promise.all([
        supabase.from('departments').select('*').eq('id', departmentId).single(),
        supabase.from('programs').select('id, name, code, degree_type, total_credits, status').eq('department_id', departmentId).order('name'),
        supabase.from('courses').select('*').eq('department_id', departmentId).order('code'),
        supabase.from('department_faculty')
          .select('id, professor_id, title, position, status, professor:profiles(id, name, email)')
          .eq('department_id', departmentId)
          .order('position'),
      ])

      if (department.error) {
        logger.error('departmentQueries.getByIdWithRelated', department.error, { departmentId })
        return null
      }
      if (programs.error) logger.error('departmentQueries.getByIdWithRelated', programs.error, { departmentId, query: 'programs' })
      if (courses.error) logger.error('departmentQueries.getByIdWithRelated', courses.error, { departmentId, query: 'courses' })
      if (faculty.error) logger.error('departmentQueries.getByIdWithRelated', faculty.error, { departmentId, query: 'faculty' })

      return {
        department: department.data,
        programs: programs.data || [],
        courses: courses.data || [],
        faculty: faculty.data || [],
      }
    } catch (error) {
      logger.error('departmentQueries.getByIdWithRelated', error, { departmentId })
      return null
    }
  },

  /** Create a new department. Converts empty strings to null for optional fields.
   * institution_id is required — every department belongs to exactly one tenant. */
  async create(supabase: SupabaseClient, input: {
    name: string
    code: string
    institution_id: string
    description?: string
    office_location?: string
    contact_email?: string
    contact_phone?: string
    status?: string
  }) {
    try {
      const { data, error } = await supabase
        .from('departments')
        .insert({
          name: input.name,
          code: input.code,
          institution_id: input.institution_id,
          description: input.description || null,
          office_location: input.office_location || null,
          contact_email: input.contact_email || null,
          contact_phone: input.contact_phone || null,
          status: input.status || 'active',
        })
        .select('*')
        .single()

      if (error) {
        logger.error('departmentQueries.create', error, { code: input.code })
        return null
      }

      logger.info('departmentQueries.create: Department created', { id: data.id, code: data.code })
      return data
    } catch (error) {
      logger.error('departmentQueries.create', error, { code: input.code })
      return null
    }
  },

  /**
   * Update an existing department. Only updates provided fields (partial update).
   * Converts empty strings to null and always sets updated_at.
   *
   * OPTIMISTIC CONCURRENCY (#724): pass `expectedUpdatedAt` — the `updated_at` the
   * caller's form was rendered from — and the guard rides in the WHERE clause, so
   * a stale write matches zero rows instead of clobbering a newer one. It has to
   * be atomic: a read-then-compare in the action would be the same race it is
   * meant to close. Callers past `assertTenantOwns` know the row exists, so zero
   * rows can only mean the guard fired — hence 'conflict' rather than 'error'.
   *
   * Returns a discriminated result rather than the usual null fallback because
   * "somebody else edited this" and "the write failed" need different words in
   * front of the user (same shape as assertTenantOwns).
   */
  async update(
    supabase: SupabaseClient,
    departmentId: string,
    input: Record<string, unknown>,
    expectedUpdatedAt?: string | null,
  ): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; reason: 'conflict' | 'error' }> {
    try {
      const cleanInput: Record<string, unknown> = { updated_at: new Date().toISOString() }
      for (const [key, value] of Object.entries(input)) {
        if (value !== undefined) {
          cleanInput[key] = value === '' ? null : value
        }
      }

      let query = supabase.from('departments').update(cleanInput).eq('id', departmentId)
      if (expectedUpdatedAt) query = query.eq('updated_at', expectedUpdatedAt)

      /* maybeSingle, not single: with the guard on, zero matching rows is the
         EXPECTED stale-write outcome, and single() would report it as an error. */
      const { data, error } = await query.select('*').maybeSingle()

      if (error) {
        logger.error('departmentQueries.update', error, { departmentId })
        return { ok: false, reason: 'error' }
      }
      if (!data) {
        logger.warn('departmentQueries.update: stale write rejected', { departmentId, expectedUpdatedAt })
        return { ok: false, reason: 'conflict' }
      }

      logger.info('departmentQueries.update: Department updated', { departmentId })
      return { ok: true, data }
    } catch (error) {
      logger.error('departmentQueries.update', error, { departmentId })
      return { ok: false, reason: 'error' }
    }
  },

  /**
   * Delete a department. Database CASCADE constraints automatically remove
   * associated programs, courses, and department_faculty records.
   */
  async remove(supabase: SupabaseClient, departmentId: string) {
    try {
      const { error } = await supabase
        .from('departments')
        .delete()
        .eq('id', departmentId)

      if (error) {
        logger.error('departmentQueries.remove', error, { departmentId })
        return false
      }

      logger.info('departmentQueries.remove: Department deleted', { departmentId })
      return true
    } catch (error) {
      logger.error('departmentQueries.remove', error, { departmentId })
      return false
    }
  },

  /**
   * Count records that would be affected by deleting a department.
   * Used by the delete confirmation dialog to warn the admin.
   *
   * Returns null — never zeros — when any read fails. A department is the top-level
   * entity, so this is the largest blast radius in the product, and the dialog renders
   * zeros as the reassuring "nothing will be affected" line. Handing that back for a
   * lookup that merely FAILED tells an admin a populated department is empty immediately
   * before an unrecoverable delete. Mirrors getSectionCascadeCounts, which was fixed this
   * way first and left its two siblings behind (#715).
   */
  async getCascadeCounts(supabase: SupabaseClient, departmentId: string) {
    try {
      /* THROWS rather than coalescing to 0: `count` is null on error, so `count || 0`
         makes a failed read indistinguishable from an empty department. */
      const countOf = async (table: string, column: string, value: string) => {
        const { count, error } = await (supabase as any)
          .from(table)
          .select('id', { count: 'exact', head: true })
          .eq(column, value)
        if (error) throw new Error(`count failed for ${table}: ${error.message}`)
        return count ?? 0
      }

      /* Courses were counted before; the sections under them and the students enrolled in
         those sections were not — yet the delete removed them anyway. That was the bug:
         the dialog said "1 program, 1 course" and took a live section and a real
         enrollment with it. */
      const [programs, faculty, courseRows] = await Promise.all([
        countOf('programs', 'department_id', departmentId),
        countOf('department_faculty', 'department_id', departmentId),
        (supabase as any).from('courses').select('id').eq('department_id', departmentId),
      ])

      if (courseRows.error) throw new Error(`courses lookup failed: ${courseRows.error.message}`)
      const courseIds = (courseRows.data ?? []).map((r: { id: string }) => r.id)

      /* Two hops down, each gated on the previous returning ids — an errored hop would
         otherwise silently zero everything beneath it. */
      let sectionIds: string[] = []
      if (courseIds.length > 0) {
        const sectionRows = await (supabase as any).from('course_sections').select('id').in('course_id', courseIds)
        if (sectionRows.error) throw new Error(`sections lookup failed: ${sectionRows.error.message}`)
        sectionIds = (sectionRows.data ?? []).map((r: { id: string }) => r.id)
      }

      let enrollments = 0
      if (sectionIds.length > 0) {
        const { count, error } = await (supabase as any)
          .from('enrollments')
          .select('id', { count: 'exact', head: true })
          .in('section_id', sectionIds)
        if (error) throw new Error(`enrollment count failed: ${error.message}`)
        enrollments = count ?? 0
      }

      return {
        programs,
        courses: courseIds.length,
        faculty,
        sections: sectionIds.length,
        enrollments,
      }
    } catch (error) {
      logger.error('departmentQueries.getCascadeCounts', error, { departmentId })
      return null
    }
  },
}

/**
 * Course Admin Queries — CRUD operations for course management.
 *
 * Courses belong directly to a department (not to a program).
 * Department → Course → Course Section is the hierarchy.
 *
 * Deleting a course cascades to course_sections → enrollments.
 */
export const courseAdminQueries = {
  /** Fetch all courses with their department info, ordered by code.
   *  institutionId is REQUIRED to scope to a single tenant. */
  async getAll(supabase: SupabaseClient, institutionId: string) {
    try {
      const { data, error } = await (supabase as any)
        .from('courses')
        .select('*, department:departments(id, name, code)')
        .eq('institution_id', institutionId)
        .order('code')

      if (error) {
        logger.error('courseAdminQueries.getAll', error)
        return []
      }
      return data || []
    } catch (error) {
      logger.error('courseAdminQueries.getAll', error)
      return []
    }
  },

  /** Fetch all courses for a department, ordered by code. */
  async getByDepartment(supabase: SupabaseClient, departmentId: string) {
    try {
      const { data, error } = await supabase
        .from('courses')
        .select('*')
        .eq('department_id', departmentId)
        .order('code')

      if (error) {
        logger.error('courseAdminQueries.getByDepartment', error, { departmentId })
        return []
      }
      return data || []
    } catch (error) {
      logger.error('courseAdminQueries.getByDepartment', error, { departmentId })
      return []
    }
  },

  /** Fetch a single course by ID. */
  async getById(supabase: SupabaseClient, courseId: string) {
    try {
      const { data, error } = await supabase
        .from('courses')
        .select('*')
        .eq('id', courseId)
        .single()

      if (error) {
        logger.error('courseAdminQueries.getById', error, { courseId })
        return null
      }
      return data
    } catch (error) {
      logger.error('courseAdminQueries.getById', error, { courseId })
      return null
    }
  },

  /**
   * Fetch a course by code within a department.
   * Used to check for duplicate codes (unique constraint: department_id + code).
   */
  async getByCode(supabase: SupabaseClient, departmentId: string, code: string) {
    try {
      const { data, error } = await supabase
        .from('courses')
        .select('id, code')
        .eq('department_id', departmentId)
        .eq('code', code)
        .maybeSingle()

      if (error) {
        logger.error('courseAdminQueries.getByCode', error, { departmentId, code })
        return null
      }
      return data
    } catch (error) {
      logger.error('courseAdminQueries.getByCode', error, { departmentId, code })
      return null
    }
  },

  /** Create a new course. Converts empty strings to null for optional fields.
   * institution_id is required — every course belongs to exactly one tenant. */
  async create(supabase: SupabaseClient, input: {
    department_id: string
    code: string
    title: string
    institution_id: string
    description?: string
    credits?: number
    prerequisites?: string
    status?: string
  }) {
    try {
      const { data, error } = await supabase
        .from('courses')
        .insert({
          department_id: input.department_id,
          code: input.code,
          title: input.title,
          institution_id: input.institution_id,
          description: input.description || null,
          credits: input.credits ?? null,
          prerequisites: input.prerequisites || null,
          status: input.status || 'active',
        })
        .select('*')
        .single()

      if (error) {
        logger.error('courseAdminQueries.create', error, { departmentId: input.department_id, code: input.code })
        return null
      }

      logger.info('courseAdminQueries.create: Course created', { id: data.id, code: data.code })
      return data
    } catch (error) {
      logger.error('courseAdminQueries.create', error, { code: input.code })
      return null
    }
  },

  /**
   * Update an existing course. Only updates provided fields (partial update).
   * Converts empty strings to null and always sets updated_at.
   *
   * OPTIMISTIC CONCURRENCY (#724): pass `expectedUpdatedAt` — the `updated_at` the
   * caller's form was rendered from — and the guard rides in the WHERE clause, so
   * a stale write matches zero rows instead of clobbering a newer one. It has to
   * be atomic: a read-then-compare in the action would be the same race it is
   * meant to close. Callers past `assertTenantOwns` know the row exists, so zero
   * rows can only mean the guard fired — hence 'conflict' rather than 'error'.
   *
   * Returns a discriminated result rather than the usual null fallback because
   * "somebody else edited this" and "the write failed" need different words in
   * front of the user (same shape as assertTenantOwns).
   */
  async update(
    supabase: SupabaseClient,
    courseId: string,
    input: Record<string, unknown>,
    expectedUpdatedAt?: string | null,
  ): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; reason: 'conflict' | 'error' }> {
    try {
      const cleanInput: Record<string, unknown> = { updated_at: new Date().toISOString() }
      for (const [key, value] of Object.entries(input)) {
        if (value !== undefined) {
          cleanInput[key] = value === '' ? null : value
        }
      }

      let query = supabase.from('courses').update(cleanInput).eq('id', courseId)
      if (expectedUpdatedAt) query = query.eq('updated_at', expectedUpdatedAt)

      /* maybeSingle, not single: with the guard on, zero matching rows is the
         EXPECTED stale-write outcome, and single() would report it as an error. */
      const { data, error } = await query.select('*').maybeSingle()

      if (error) {
        logger.error('courseAdminQueries.update', error, { courseId })
        return { ok: false, reason: 'error' }
      }
      if (!data) {
        logger.warn('courseAdminQueries.update: stale write rejected', { courseId, expectedUpdatedAt })
        return { ok: false, reason: 'conflict' }
      }

      logger.info('courseAdminQueries.update: Course updated', { courseId })
      return { ok: true, data }
    } catch (error) {
      logger.error('courseAdminQueries.update', error, { courseId })
      return { ok: false, reason: 'error' }
    }
  },

  /**
   * Delete a course. Database CASCADE constraints automatically remove
   * associated course_sections and enrollments.
   */
  async remove(supabase: SupabaseClient, courseId: string) {
    try {
      const { error } = await supabase
        .from('courses')
        .delete()
        .eq('id', courseId)

      if (error) {
        logger.error('courseAdminQueries.remove', error, { courseId })
        return false
      }

      logger.info('courseAdminQueries.remove: Course deleted', { courseId })
      return true
    } catch (error) {
      logger.error('courseAdminQueries.remove', error, { courseId })
      return false
    }
  },

  /**
   * Count records that would be affected by deleting a course.
   * Courses cascade to course_sections, which cascade to enrollments.
   *
   * Returns null — never zeros — when any read fails, for the same reason as
   * departmentQueries.getCascadeCounts above (#715). The docstring already said this
   * cascades to enrollments; it just never counted them.
   */
  async getCascadeCounts(supabase: SupabaseClient, courseId: string) {
    try {
      const sectionRows = await (supabase as any).from('course_sections').select('id').eq('course_id', courseId)
      if (sectionRows.error) throw new Error(`sections lookup failed: ${sectionRows.error.message}`)
      const sectionIds = (sectionRows.data ?? []).map((r: { id: string }) => r.id)

      let enrollments = 0
      if (sectionIds.length > 0) {
        const { count, error } = await (supabase as any)
          .from('enrollments')
          .select('id', { count: 'exact', head: true })
          .in('section_id', sectionIds)
        if (error) throw new Error(`enrollment count failed: ${error.message}`)
        enrollments = count ?? 0
      }

      return { sections: sectionIds.length, enrollments }
    } catch (error) {
      logger.error('courseAdminQueries.getCascadeCounts', error, { courseId })
      return null
    }
  },
}

/**
 * Professor Queries — CRUD + aggregate queries for professor management.
 *
 * Professors exist in two tables:
 * - profiles: global identity (email, name, phone, role)
 * - department_faculty: per-department details (title, position, office, bio)
 *
 * A professor can belong to multiple departments with different roles.
 */
export const professorQueries = {
  /**
   * Fetch all professors with their primary department name.
   * Joins profiles (role='professor') → department_faculty (is_primary_department=true) → departments.
   *
   * institutionId — when provided, scopes professors to a single tenant.
   */
  async getAllWithDepartments(supabase: SupabaseClient, institutionId?: string) {
    try {
      /* Fetch all professor profiles */
      const profQuery = (supabase as any)
        .from('profiles')
        .select('*')
        .eq('role', 'professor')
        .order('last_name')
      if (institutionId) profQuery.eq('institution_id', institutionId)
      const { data: professors, error: profError } = await profQuery

      if (profError) {
        logger.error('professorQueries.getAllWithDepartments', profError, { query: 'profiles' })
        return []
      }

      if (!professors || professors.length === 0) return []

      /* Fetch all department_faculty records for these professors with department names */
      const professorIds = professors.map((p: { id: string }) => p.id)
      const { data: facultyRecords, error: facError } = await (supabase as any)
        .from('department_faculty')
        .select('professor_id, position, status, is_primary_department, department:departments(id, name, code)')
        .in('professor_id', professorIds)

      if (facError) {
        logger.error('professorQueries.getAllWithDepartments', facError, { query: 'department_faculty' })
      }

      /* Merge: attach primary department info to each professor */
      return professors.map((prof: any) => {
        const records = (facultyRecords || []).filter((r: any) => r.professor_id === prof.id)
        const primary = records.find((r: any) => r.is_primary_department) || records[0]
        const dept = primary?.department
        return {
          ...prof,
          primary_department: dept ? (Array.isArray(dept) ? dept[0] : dept) : null,
          position: primary?.position || null,
          faculty_status: primary?.status || null,
          invite_status: prof.invite_status || 'active',
          department_count: records.length,
        }
      })
    } catch (error) {
      logger.error('professorQueries.getAllWithDepartments', error)
      return []
    }
  },

  /** Fetch a single professor profile by ID. */
  async getById(supabase: SupabaseClient, professorId: string) {
    try {
      const { data, error } = await (supabase as any)
        .from('profiles')
        .select('*')
        .eq('id', professorId)
        .eq('role', 'professor')
        .single()

      if (error) {
        logger.error('professorQueries.getById', error, { professorId })
        return null
      }
      return data
    } catch (error) {
      logger.error('professorQueries.getById', error, { professorId })
      return null
    }
  },

  /**
   * Fetch a professor with all related data: department_faculty records + course_sections.
   * Used on the professor detail page.
   */
  async getByIdWithDetails(supabase: SupabaseClient, professorId: string) {
    try {
      const [profileResult, facultyResult, sectionsResult] = await Promise.all([
        (supabase as any)
          .from('profiles')
          .select('*')
          .eq('id', professorId)
          .eq('role', 'professor')
          .single(),
        (supabase as any)
          .from('department_faculty')
          .select('*, department:departments(id, name, code)')
          .eq('professor_id', professorId)
          .order('is_primary_department', { ascending: false }),
        (supabase as any)
          .from('course_sections')
          .select('*, course:courses(id, code, title, department_id, department:departments(id, name, code))')
          .eq('professor_id', professorId)
          .order('year', { ascending: false }),
      ])

      if (profileResult.error) {
        logger.error('professorQueries.getByIdWithDetails', profileResult.error, { professorId, query: 'profile' })
        return null
      }

      if (facultyResult.error) logger.error('professorQueries.getByIdWithDetails', facultyResult.error, { professorId, query: 'faculty' })
      if (sectionsResult.error) logger.error('professorQueries.getByIdWithDetails', sectionsResult.error, { professorId, query: 'sections' })

      return {
        professor: profileResult.data,
        departments: facultyResult.data || [],
        sections: sectionsResult.data || [],
      }
    } catch (error) {
      logger.error('professorQueries.getByIdWithDetails', error, { professorId })
      return null
    }
  },

  /** Check if a professor with this email already exists in the caller's tenant.
   *  institutionId is REQUIRED — without it, this would leak the existence of
   *  users at other institutions (info disclosure). If the email exists in
   *  another tenant, Supabase's global auth.users email uniqueness will catch
   *  it later at createUser time. */
  async getByEmail(supabase: SupabaseClient, email: string, institutionId: string) {
    try {
      const { data, error } = await (supabase as any)
        .from('profiles')
        .select('id, email, role')
        .eq('email', email)
        .eq('institution_id', institutionId)
        .maybeSingle()

      if (error) {
        logger.error('professorQueries.getByEmail', error, { email })
        return null
      }
      return data
    } catch (error) {
      logger.error('professorQueries.getByEmail', error, { email })
      return null
    }
  },

  /**
   * Upsert a professor's profile after auth user creation.
   * Uses upsert to handle the handle_new_user() trigger race condition:
   * the trigger may or may not have created the profile row yet.
   */
  async upsertProfile(supabase: SupabaseClient, input: {
    id: string
    email: string
    name: string
    first_name: string
    last_name: string
    institution_id: string
    phone?: string | null
    invite_status?: string
    invited_at?: string
    invited_by?: string
    onboarding_completed?: boolean
  }) {
    try {
      const upsertData: Record<string, unknown> = {
          id: input.id,
          email: input.email,
          name: input.name,
          first_name: input.first_name,
          last_name: input.last_name,
          institution_id: input.institution_id,
          phone: input.phone || null,
          role: 'professor',
          status: 'active',
          updated_at: new Date().toISOString(),
      }
      if (input.invite_status !== undefined) upsertData.invite_status = input.invite_status
      if (input.invited_at !== undefined) upsertData.invited_at = input.invited_at
      if (input.invited_by !== undefined) upsertData.invited_by = input.invited_by
      if (input.onboarding_completed !== undefined) upsertData.onboarding_completed = input.onboarding_completed

      const { data, error } = await (supabase as any)
        .from('profiles')
        .upsert(upsertData, { onConflict: 'id' })
        .select('*')
        .single()

      if (error) {
        logger.error('professorQueries.upsertProfile', error, { id: input.id })
        return null
      }

      logger.info('professorQueries.upsertProfile: Profile upserted', { id: data.id, role: data.role })
      return data
    } catch (error) {
      logger.error('professorQueries.upsertProfile', error, { id: input.id })
      return null
    }
  },

  /** Update a professor's profile fields (name, phone). */
  async updateProfile(supabase: SupabaseClient, professorId: string, input: Record<string, unknown>) {
    try {
      const { data, error } = await (supabase as any)
        .from('profiles')
        .update({ ...input, updated_at: new Date().toISOString() })
        .eq('id', professorId)
        .select('*')
        .single()

      if (error) {
        logger.error('professorQueries.updateProfile', error, { professorId })
        return null
      }

      logger.info('professorQueries.updateProfile: Updated', { professorId })
      return data
    } catch (error) {
      logger.error('professorQueries.updateProfile', error, { professorId })
      return null
    }
  },

  /** Insert a department_faculty row linking a professor to a department. */
  async createDepartmentFaculty(supabase: SupabaseClient, input: {
    department_id: string
    professor_id: string
    title?: string | null
    position?: string | null
    employment_type?: string | null
    office_location?: string | null
    office_hours?: string | null
    office_phone?: string | null
    bio?: string | null
    research_interests?: string | null
    website_url?: string | null
    linkedin_url?: string | null
    is_primary_department?: boolean
    status?: string
  }) {
    try {
      const { data, error } = await (supabase as any)
        .from('department_faculty')
        .insert({
          department_id: input.department_id,
          professor_id: input.professor_id,
          title: input.title || null,
          position: input.position || null,
          employment_type: input.employment_type || null,
          office_location: input.office_location || null,
          office_hours: input.office_hours || null,
          office_phone: input.office_phone || null,
          bio: input.bio || null,
          research_interests: input.research_interests || null,
          website_url: input.website_url || null,
          linkedin_url: input.linkedin_url || null,
          is_primary_department: input.is_primary_department ?? true,
          status: input.status || 'active',
        })
        .select('*')
        .single()

      if (error) {
        logger.error('professorQueries.createDepartmentFaculty', error, {
          departmentId: input.department_id,
          professorId: input.professor_id,
        })
        return null
      }

      logger.info('professorQueries.createDepartmentFaculty: Created', { id: data.id })
      return data
    } catch (error) {
      logger.error('professorQueries.createDepartmentFaculty', error)
      return null
    }
  },

  /** Update department-specific faculty fields. */
  async updateDepartmentFaculty(supabase: SupabaseClient, facultyId: string, input: Record<string, unknown>) {
    try {
      const { data, error } = await (supabase as any)
        .from('department_faculty')
        .update({ ...input, updated_at: new Date().toISOString() })
        .eq('id', facultyId)
        .select('*')
        .single()

      if (error) {
        logger.error('professorQueries.updateDepartmentFaculty', error, { facultyId })
        return null
      }

      logger.info('professorQueries.updateDepartmentFaculty: Updated', { facultyId })
      return data
    } catch (error) {
      logger.error('professorQueries.updateDepartmentFaculty', error, { facultyId })
      return null
    }
  },

  /** Remove a professor from a department (deletes the department_faculty row). */
  async removeDepartmentFaculty(supabase: SupabaseClient, facultyId: string) {
    try {
      const { error } = await (supabase as any)
        .from('department_faculty')
        .delete()
        .eq('id', facultyId)

      if (error) {
        logger.error('professorQueries.removeDepartmentFaculty', error, { facultyId })
        return false
      }

      logger.info('professorQueries.removeDepartmentFaculty: Removed', { facultyId })
      return true
    } catch (error) {
      logger.error('professorQueries.removeDepartmentFaculty', error, { facultyId })
      return false
    }
  },

  /** Delete a professor entirely (profile + all department_faculty via cascade). */
  async remove(supabase: SupabaseClient, professorId: string) {
    try {
      const { error } = await (supabase as any)
        .from('profiles')
        .delete()
        .eq('id', professorId)

      if (error) {
        logger.error('professorQueries.remove', error, { professorId })
        return false
      }

      logger.info('professorQueries.remove: Professor deleted', { professorId })
      return true
    } catch (error) {
      logger.error('professorQueries.remove', error, { professorId })
      return false
    }
  },

  /**
   * Count records affected by deleting a professor.
   * course_sections.professor_id has ON DELETE RESTRICT, so we must warn.
   */
  async getCascadeCounts(supabase: SupabaseClient, professorId: string) {
    try {
      const [departments, sections] = await Promise.all([
        (supabase as any)
          .from('department_faculty')
          .select('id', { count: 'exact', head: true })
          .eq('professor_id', professorId),
        (supabase as any)
          .from('course_sections')
          .select('id', { count: 'exact', head: true })
          .eq('professor_id', professorId),
      ])

      if (departments.error) logger.error('professorQueries.getCascadeCounts', departments.error, { professorId, query: 'departments' })
      if (sections.error) logger.error('professorQueries.getCascadeCounts', sections.error, { professorId, query: 'sections' })

      return {
        departments: departments.count || 0,
        sections: sections.count || 0,
      }
    } catch (error) {
      logger.error('professorQueries.getCascadeCounts', error, { professorId })
      return { departments: 0, sections: 0 }
    }
  },
}

/**
 * Course Assignment Queries — CRUD for assigning professors to courses.
 *
 * "Assigning a professor to a course" creates a course_section row.
 * The UI simplifies this by auto-generating section codes and defaulting optional fields.
 */
export const courseAssignmentQueries = {
  /**
   * Fetch all course sections with joined course, professor, and department info.
   * Used on the /admin/courses assignment page.
   * institutionId is REQUIRED to scope to a single tenant.
   */
  async getAll(supabase: SupabaseClient, institutionId: string) {
    try {
      const { data, error } = await (supabase as any)
        .from('course_sections')
        .select('*, course:courses(id, code, title, department_id, department:departments(id, name, code)), professor:profiles(id, name, email)')
        .eq('institution_id', institutionId)
        .order('year', { ascending: false })
        .order('semester')

      if (error) {
        logger.error('courseAssignmentQueries.getAll', error)
        return []
      }
      return data || []
    } catch (error) {
      logger.error('courseAssignmentQueries.getAll', error)
      return []
    }
  },

  /** Fetch assignments for a specific professor. */
  async getByProfessor(supabase: SupabaseClient, professorId: string) {
    try {
      const { data, error } = await (supabase as any)
        .from('course_sections')
        .select('*, course:courses(id, code, title, department_id)')
        .eq('professor_id', professorId)
        .order('year', { ascending: false })

      if (error) {
        logger.error('courseAssignmentQueries.getByProfessor', error, { professorId })
        return []
      }
      return data || []
    } catch (error) {
      logger.error('courseAssignmentQueries.getByProfessor', error, { professorId })
      return []
    }
  },

  /** Fetch assignments for a specific course. */
  async getByCourse(supabase: SupabaseClient, courseId: string) {
    try {
      const { data, error } = await (supabase as any)
        .from('course_sections')
        .select('*, professor:profiles(id, name, email)')
        .eq('course_id', courseId)
        .order('year', { ascending: false })

      if (error) {
        logger.error('courseAssignmentQueries.getByCourse', error, { courseId })
        return []
      }
      return data || []
    } catch (error) {
      logger.error('courseAssignmentQueries.getByCourse', error, { courseId })
      return []
    }
  },

  /** Create a new course section (assign professor to course). Returns { data, error }.
   * institution_id is required — must match the parent course's institution. */
  async create(supabase: SupabaseClient, input: {
    course_id: string
    professor_id: string
    semester: string
    year: number
    section_code: string
    institution_id: string
    max_students?: number | null
    location?: string | null
    modality?: string | null
    status?: string
  }): Promise<{ data: any; error: string | null }> {
    try {
      /* Build insert payload — omit status to use DB default ('active')
         unless a non-default value was explicitly provided */
      const insertPayload: Record<string, unknown> = {
        course_id: input.course_id,
        professor_id: input.professor_id,
        semester: input.semester,
        year: input.year,
        section_code: input.section_code,
        institution_id: input.institution_id,
        // Seed the features that ship on by default (e.g. AI Tutor). Professors
        // can still turn them off later via Manage Features.
        settings: { enabledFeatures: [...DEFAULT_ENABLED_FEATURES] },
      }
      if (input.max_students != null) insertPayload.max_students = input.max_students
      if (input.location) insertPayload.location = input.location
      if (input.modality) insertPayload.modality = input.modality
      if (input.status && input.status !== 'active') insertPayload.status = input.status

      const { data, error } = await (supabase as any)
        .from('course_sections')
        .insert(insertPayload)
        .select('*')
        .single()

      if (error) {
        logger.error('courseAssignmentQueries.create', error, {
          courseId: input.course_id,
          professorId: input.professor_id,
        })
        return { data: null, error: error.message || 'Database insert failed' }
      }

      logger.info('courseAssignmentQueries.create: Assignment created', { id: data.id })
      return { data, error: null }
    } catch (error) {
      logger.error('courseAssignmentQueries.create', error)
      return { data: null, error: error instanceof Error ? error.message : 'Unexpected error' }
    }
  },

  /** Update an existing course section. */
  async update(supabase: SupabaseClient, sectionId: string, input: Record<string, unknown>) {
    try {
      const { data, error } = await (supabase as any)
        .from('course_sections')
        .update({ ...input, updated_at: new Date().toISOString() })
        .eq('id', sectionId)
        .select('*')
        .single()

      if (error) {
        logger.error('courseAssignmentQueries.update', error, { sectionId })
        return null
      }

      logger.info('courseAssignmentQueries.update: Updated', { sectionId })
      return data
    } catch (error) {
      logger.error('courseAssignmentQueries.update', error, { sectionId })
      return null
    }
  },

  /** Delete a course section (remove professor assignment). */
  async remove(supabase: SupabaseClient, sectionId: string) {
    try {
      const { error } = await (supabase as any)
        .from('course_sections')
        .delete()
        .eq('id', sectionId)

      if (error) {
        logger.error('courseAssignmentQueries.remove', error, { sectionId })
        return false
      }

      logger.info('courseAssignmentQueries.remove: Deleted', { sectionId })
      return true
    } catch (error) {
      logger.error('courseAssignmentQueries.remove', error, { sectionId })
      return false
    }
  },

  /**
   * Count the next section code for a course in a given semester/year.
   * Auto-generates "A", "B", "C", etc.
   */
  async getNextSectionCode(supabase: SupabaseClient, courseId: string, semester: string, year: number) {
    try {
      const { data, error } = await (supabase as any)
        .from('course_sections')
        .select('section_code')
        .eq('course_id', courseId)
        .eq('semester', semester)
        .eq('year', year)
        .order('section_code')

      if (error) {
        logger.error('courseAssignmentQueries.getNextSectionCode', error, { courseId })
        return 'A'
      }

      if (!data || data.length === 0) return 'A'

      /* Find the next letter after the last existing section code */
      const lastCode = data[data.length - 1].section_code
      const nextChar = String.fromCharCode(lastCode.charCodeAt(0) + 1)
      return nextChar
    } catch (error) {
      logger.error('courseAssignmentQueries.getNextSectionCode', error, { courseId })
      return 'A'
    }
  },
}

/**
 * Student Queries — CRUD + aggregate queries for student management.
 *
 * Students exist in the profiles table with role='student'. Each student has a
 * unique 8-digit CWID (Campus-Wide ID) stored in profiles.cwid.
 *
 * Enrollments link students to course_sections and store their grades.
 */
export const studentQueries = {
  /**
   * Fetch all students ordered by name.
   * Returns profile data for the student list table.
   *
   * institutionId — when provided, scopes students to a single tenant.
   */
  async getAll(supabase: SupabaseClient, institutionId?: string) {
    try {
      const query = (supabase as any)
        .from('profiles')
        .select('*')
        .eq('role', 'student')
        .order('name')
      if (institutionId) query.eq('institution_id', institutionId)
      const { data, error } = await query

      if (error) {
        logger.error('studentQueries.getAll', error)
        return []
      }
      return data || []
    } catch (error) {
      logger.error('studentQueries.getAll', error)
      return []
    }
  },

  /** Fetch a single student profile by ID. */
  async getById(supabase: SupabaseClient, studentId: string) {
    try {
      const { data, error } = await (supabase as any)
        .from('profiles')
        .select('*')
        .eq('id', studentId)
        .eq('role', 'student')
        .single()

      if (error) {
        logger.error('studentQueries.getById', error, { studentId })
        return null
      }
      return data
    } catch (error) {
      logger.error('studentQueries.getById', error, { studentId })
      return null
    }
  },

  /**
   * Every section this student is currently enrolled in, with enough of the
   * section to answer two questions at once: which of them does a given
   * professor teach (the access check for the professor-side student profile),
   * and what is the student carrying this term (the list that page shows).
   *
   * Deliberately NOT `courseQueries.getStudentEnrollments`, which two
   * student-facing pages already share and which selects neither
   * `professor_id` nor the section's own `status`. An access check should not
   * depend on a select list that another surface is free to change.
   *
   * `status = 'enrolled'` only. A `completed` or `dropped` enrollment means the
   * student is no longer in the course, and neither should keep granting a
   * professor a live view of that student.
   *
   * Returns every enrolled section regardless of who teaches it — the caller
   * decides what it is allowed to do with them, and must drop the grade and
   * instructor fields for sections it does not own before anything reaches a
   * client component.
   */
  async getEnrolledSectionsForStudent(supabase: SupabaseClient, studentId: string) {
    try {
      const { data, error } = await (supabase as any)
        .from('enrollments')
        .select(`
          id, status, final_grade, final_score,
          section:course_sections(id, section_code, semester, year, status, professor_id,
            course:courses(id, code, title))
        `)
        .eq('student_id', studentId)
        .eq('status', 'enrolled')

      if (error) {
        logger.error('studentQueries.getEnrolledSectionsForStudent', error, { studentId })
        return []
      }
      return data || []
    } catch (error) {
      logger.error('studentQueries.getEnrolledSectionsForStudent', error, { studentId })
      return []
    }
  },

  /**
   * Fetch a student with all related data: enrollments with course section + course info.
   * Used on the student detail page.
   */
  async getByIdWithDetails(supabase: SupabaseClient, studentId: string) {
    try {
      const [profileResult, enrollmentsResult] = await Promise.all([
        (supabase as any)
          .from('profiles')
          .select('*')
          .eq('id', studentId)
          .eq('role', 'student')
          .single(),
        (supabase as any)
          .from('enrollments')
          .select(`
            id, status, final_grade, final_score, enrolled_at, section_id,
            section:course_sections(
              id, section_code, semester, year, location, modality,
              course:courses(id, code, title, department_id,
                department:departments(id, name, code)
              ),
              professor:profiles(id, name, email)
            )
          `)
          .eq('student_id', studentId)
          .order('enrolled_at', { ascending: false }),
      ])

      if (profileResult.error) {
        logger.error('studentQueries.getByIdWithDetails', profileResult.error, { studentId, query: 'profile' })
        return null
      }

      if (enrollmentsResult.error) {
        logger.error('studentQueries.getByIdWithDetails', enrollmentsResult.error, { studentId, query: 'enrollments' })
      }

      return {
        student: profileResult.data,
        enrollments: enrollmentsResult.data || [],
      }
    } catch (error) {
      logger.error('studentQueries.getByIdWithDetails', error, { studentId })
      return null
    }
  },

  /** Check if a student with this email already exists in the caller's tenant.
   *  institutionId is REQUIRED — without it, this would leak cross-tenant
   *  user existence. Cross-tenant email collisions are caught later by
   *  Supabase's global auth.users uniqueness when createUser runs. */
  async getByEmail(supabase: SupabaseClient, email: string, institutionId: string) {
    try {
      const { data, error } = await (supabase as any)
        .from('profiles')
        .select('id, email, role')
        .eq('email', email)
        .eq('institution_id', institutionId)
        .maybeSingle()

      if (error) {
        logger.error('studentQueries.getByEmail', error, { email })
        return null
      }
      return data
    } catch (error) {
      logger.error('studentQueries.getByEmail', error, { email })
      return null
    }
  },

  /** Check if a CWID is already in use. Used for uniqueness validation + login resolution. */
  async getByCwid(supabase: SupabaseClient, cwid: string) {
    try {
      const { data, error } = await (supabase as any)
        .from('profiles')
        .select('id, email, name, cwid, role')
        .eq('cwid', cwid)
        .maybeSingle()

      if (error) {
        logger.error('studentQueries.getByCwid', error, { cwid })
        return null
      }
      return data
    } catch (error) {
      logger.error('studentQueries.getByCwid', error, { cwid })
      return null
    }
  },

  /**
   * Upsert a student's profile after auth user creation.
   * Uses upsert to handle the handle_new_user() trigger race condition:
   * the trigger may or may not have created the profile row yet.
   */
  async upsertProfile(supabase: SupabaseClient, input: {
    id: string
    email: string
    name: string
    first_name: string
    last_name: string
    /** null = account without a campus ID (bulk roster import) — logs in by email */
    cwid: string | null
    institution_id: string
    phone?: string | null
    invite_status?: string
    invited_at?: string
    invited_by?: string
    onboarding_completed?: boolean
  }) {
    try {
      const { data, error } = await (supabase as any)
        .from('profiles')
        .upsert({
          id: input.id,
          email: input.email,
          name: input.name,
          first_name: input.first_name,
          last_name: input.last_name,
          cwid: input.cwid,
          institution_id: input.institution_id,
          phone: input.phone || null,
          role: 'student',
          status: 'active',
          /* Invite-status lifecycle tracking — only set on first creation;
             subsequent upserts shouldn't reset a student who's already
             progressed past pending. The caller is responsible for not
             passing these on update flows. */
          ...(input.invite_status ? { invite_status: input.invite_status } : {}),
          ...(input.invited_at ? { invited_at: input.invited_at } : {}),
          ...(input.invited_by ? { invited_by: input.invited_by } : {}),
          ...(input.onboarding_completed !== undefined ? { onboarding_completed: input.onboarding_completed } : {}),
          updated_at: new Date().toISOString(),
        }, { onConflict: 'id' })
        .select('*')
        .single()

      if (error) {
        logger.error('studentQueries.upsertProfile', error, { id: input.id })
        return null
      }

      logger.info('studentQueries.upsertProfile: Profile upserted', { id: data.id, cwid: input.cwid })
      return data
    } catch (error) {
      logger.error('studentQueries.upsertProfile', error, { id: input.id })
      return null
    }
  },

  /** Update a student's profile fields (name, phone, status). */
  async updateProfile(supabase: SupabaseClient, studentId: string, input: Record<string, unknown>) {
    try {
      const { data, error } = await (supabase as any)
        .from('profiles')
        .update({ ...input, updated_at: new Date().toISOString() })
        .eq('id', studentId)
        .select('*')
        .single()

      if (error) {
        logger.error('studentQueries.updateProfile', error, { studentId })
        return null
      }

      logger.info('studentQueries.updateProfile: Updated', { studentId })
      return data
    } catch (error) {
      logger.error('studentQueries.updateProfile', error, { studentId })
      return null
    }
  },

  /** Delete a student profile (cascades to enrollments via FK). */
  async remove(supabase: SupabaseClient, studentId: string) {
    try {
      const { error } = await (supabase as any)
        .from('profiles')
        .delete()
        .eq('id', studentId)

      if (error) {
        logger.error('studentQueries.remove', error, { studentId })
        return false
      }

      logger.info('studentQueries.remove: Student deleted', { studentId })
      return true
    } catch (error) {
      logger.error('studentQueries.remove', error, { studentId })
      return false
    }
  },

  /**
   * Count records affected by deleting a student.
   * enrollments.student_id has ON DELETE CASCADE, so enrollments are auto-deleted.
   * This count is for the warning dialog.
   */
  async getCascadeCounts(supabase: SupabaseClient, studentId: string) {
    try {
      const enrollments = await (supabase as any)
        .from('enrollments')
        .select('id', { count: 'exact', head: true })
        .eq('student_id', studentId)

      if (enrollments.error) {
        logger.error('studentQueries.getCascadeCounts', enrollments.error, { studentId, query: 'enrollments' })
      }

      return {
        enrollments: enrollments.count || 0,
      }
    } catch (error) {
      logger.error('studentQueries.getCascadeCounts', error, { studentId })
      return { enrollments: 0 }
    }
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin Dashboard Queries — analytics data for the /admin dashboard
// ─────────────────────────────────────────────────────────────────────────────

export const adminDashboardQueries = {
  /**
   * Extended metrics for the admin analytics dashboard.
   * Returns 6 counts plus monthly trend deltas for the hero stats row.
   */
  async getHeroStats(supabase: SupabaseClient) {
    try {
      const now = new Date()
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()

      const [
        departments, professors, students, programs,
        activeSections, enrollments,
        newStudentsThisMonth, newProfessorsThisMonth,
        newEnrollmentsThisMonth,
      ] = await Promise.all([
        supabase.from('departments').select('id', { count: 'exact', head: true }),
        supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'professor'),
        supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'student'),
        supabase.from('programs').select('id', { count: 'exact', head: true }),
        supabase.from('course_sections').select('id', { count: 'exact', head: true }).eq('status', 'active'),
        supabase.from('enrollments').select('id', { count: 'exact', head: true }),
        supabase.from('profiles').select('id', { count: 'exact', head: true })
          .eq('role', 'student').gte('created_at', startOfMonth),
        supabase.from('profiles').select('id', { count: 'exact', head: true })
          .eq('role', 'professor').gte('created_at', startOfMonth),
        supabase.from('enrollments').select('id', { count: 'exact', head: true })
          .gte('enrolled_at', startOfMonth),
      ])

      return {
        students: students.count || 0,
        professors: professors.count || 0,
        activeSections: activeSections.count || 0,
        departments: departments.count || 0,
        programs: programs.count || 0,
        enrollments: enrollments.count || 0,
        trends: {
          newStudents: newStudentsThisMonth.count || 0,
          newProfessors: newProfessorsThisMonth.count || 0,
          newEnrollments: newEnrollmentsThisMonth.count || 0,
        },
      }
    } catch (error) {
      logger.error('adminDashboardQueries.getHeroStats', error)
      return {
        students: 0, professors: 0, activeSections: 0,
        departments: 0, programs: 0, enrollments: 0,
        trends: { newStudents: 0, newProfessors: 0, newEnrollments: 0 },
      }
    }
  },

  /**
   * Enrollment counts grouped by semester+year for the bar chart.
   * Returns last 6 semesters sorted chronologically.
   */
  async getEnrollmentsBySemester(supabase: SupabaseClient) {
    try {

      const { data, error } = await (supabase as any)
        .from('enrollments')
        .select('id, section:course_sections(semester, year)')

      if (error) {
        logger.error('adminDashboardQueries.getEnrollmentsBySemester', error)
        return []
      }

      const grouped: Record<string, number> = {}

      for (const enrollment of (data || []) as any[]) {
        const section = Array.isArray(enrollment.section) ? enrollment.section[0] : enrollment.section
        if (section?.semester && section?.year) {
          const key = `${section.semester} ${section.year}`
          grouped[key] = (grouped[key] || 0) + 1
        }
      }

      const semesterOrder = ['spring', 'summer', 'fall', 'winter']
      return Object.entries(grouped)
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => {
          const [aSem, aYear] = a.label.split(' ')
          const [bSem, bYear] = b.label.split(' ')
          if (aYear !== bYear) return parseInt(aYear, 10) - parseInt(bYear, 10)
          return semesterOrder.indexOf(aSem.toLowerCase()) - semesterOrder.indexOf(bSem.toLowerCase())
        })
        .slice(-6)
    } catch (error) {
      logger.error('adminDashboardQueries.getEnrollmentsBySemester', error)
      return []
    }
  },

  /**
   * Count students per department via enrollments → sections → courses → departments.
   * For the donut chart on the admin dashboard.
   */
  async getStudentsByDepartment(supabase: SupabaseClient) {
    try {

      const { data, error } = await (supabase as any)
        .from('enrollments')
        .select(`
          student_id,
          section:course_sections(
            course:courses(
              department:departments(id, name)
            )
          )
        `)

      if (error) {
        logger.error('adminDashboardQueries.getStudentsByDepartment', error)
        return []
      }

      const deptStudents: Record<string, Set<string>> = {}

      for (const enrollment of (data || []) as any[]) {
        const section = Array.isArray(enrollment.section) ? enrollment.section[0] : enrollment.section
        const course = Array.isArray(section?.course) ? section.course[0] : section?.course
        const dept = Array.isArray(course?.department) ? course.department[0] : course?.department
        if (dept?.name && enrollment.student_id) {
          if (!deptStudents[dept.name]) deptStudents[dept.name] = new Set()
          deptStudents[dept.name].add(enrollment.student_id)
        }
      }

      return Object.entries(deptStudents)
        .map(([name, students]) => ({ name, count: students.size }))
        .sort((a, b) => b.count - a.count)
    } catch (error) {
      logger.error('adminDashboardQueries.getStudentsByDepartment', error)
      return []
    }
  },

  /**
   * Distribution of active course sections by modality (in_person, online, hybrid).
   * For the pie chart on the admin dashboard.
   */
  async getModalityDistribution(supabase: SupabaseClient) {
    try {
      const { data, error } = await supabase
        .from('course_sections')
        .select('modality')
        .eq('status', 'active')

      if (error) {
        logger.error('adminDashboardQueries.getModalityDistribution', error)
        return []
      }

      const counts: Record<string, number> = {}
      for (const section of (data || [])) {
        const modality = (section as { modality: string | null }).modality || 'unspecified'
        counts[modality] = (counts[modality] || 0) + 1
      }

      const labels: Record<string, string> = {
        in_person: 'In Person',
        online: 'Online',
        hybrid: 'Hybrid',
        unspecified: 'Unspecified',
      }

      return Object.entries(counts).map(([key, count]) => ({
        name: labels[key] || key,
        count,
      }))
    } catch (error) {
      logger.error('adminDashboardQueries.getModalityDistribution', error)
      return []
    }
  },

  /**
   * Enrollment status distribution (enrolled, completed, dropped, withdrawn).
   * For the horizontal bar chart on the admin dashboard.
   */
  async getEnrollmentStatusBreakdown(supabase: SupabaseClient) {
    try {
      const statuses = ['enrolled', 'completed', 'dropped', 'withdrawn']
      const results = await Promise.all(
        statuses.map(status =>
          supabase.from('enrollments')
            .select('id', { count: 'exact', head: true })
            .eq('status', status)
        )
      )

      return statuses.map((status, i) => ({
        status: status.charAt(0).toUpperCase() + status.slice(1),
        count: results[i].count || 0,
      }))
    } catch (error) {
      logger.error('adminDashboardQueries.getEnrollmentStatusBreakdown', error)
      return []
    }
  },

  /**
   * Per-department summary: faculty count, course count, program count.
   * For the department overview grid on the admin dashboard.
   */
  async getDepartmentOverview(supabase: SupabaseClient) {
    try {

      const { data, error } = await (supabase as any)
        .from('departments')
        .select(`
          id, name, code, status,
          department_faculty(id),
          courses(id),
          programs(id)
        `)
        .eq('status', 'active')
        .order('name')

      if (error) {
        logger.error('adminDashboardQueries.getDepartmentOverview', error)
        return []
      }


      return (data || []).map((dept: any) => ({
        id: dept.id,
        name: dept.name,
        code: dept.code,
        facultyCount: Array.isArray(dept.department_faculty) ? dept.department_faculty.length : 0,
        courseCount: Array.isArray(dept.courses) ? dept.courses.length : 0,
        programCount: Array.isArray(dept.programs) ? dept.programs.length : 0,
      }))
    } catch (error) {
      logger.error('adminDashboardQueries.getDepartmentOverview', error)
      return []
    }
  },

  /**
   * Fetch the latest events from the events table for the activity feed.
   * Joins user profile for display name.
   */
  async getRecentActivity(supabase: SupabaseClient, limit: number = 20) {
    try {

      const { data, error } = await (supabase as any)
        .from('events')
        .select('id, event_type, event_category, metadata, timestamp, user:profiles(id, name, email, role)')
        .order('timestamp', { ascending: false })
        .limit(limit)

      if (error) {
        logger.error('adminDashboardQueries.getRecentActivity', error)
        return []
      }

      return data || []
    } catch (error) {
      logger.error('adminDashboardQueries.getRecentActivity', error)
      return []
    }
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// Program Queries — CRUD for the programs table (admin)
// ─────────────────────────────────────────────────────────────────────────────

export const programQueries = {
  /** Fetch all programs ordered by name */
  async getAll(supabase: SupabaseClient) {
    try {
      const { data, error } = await supabase
        .from('programs')
        .select('*')
        .order('name')
      if (error) { logger.error('programQueries.getAll', error); return [] }
      return data || []
    } catch (error) {
      logger.error('programQueries.getAll', error)
      return []
    }
  },

  /** Fetch all programs with department and director names for the list table.
   * institutionId — when provided, scopes programs to a single tenant. */
  async getAllWithRelated(supabase: SupabaseClient, institutionId?: string) {
    try {
      const query = (supabase as any)
        .from('programs')
        .select('*, department:departments(id, name, code), director:profiles(id, name, email)')
        .order('name')
      if (institutionId) query.eq('institution_id', institutionId)
      const { data, error } = await query
      if (error) { logger.error('programQueries.getAllWithRelated', error); return [] }
      return data || []
    } catch (error) {
      logger.error('programQueries.getAllWithRelated', error)
      return []
    }
  },

  /** Fetch a single program by ID */
  async getById(supabase: SupabaseClient, programId: string) {
    try {
      const { data, error } = await supabase
        .from('programs')
        .select('*')
        .eq('id', programId)
        .single()
      if (error) {
        if (error.code !== 'PGRST116') logger.error('programQueries.getById', error, { programId })
        return null
      }
      return data
    } catch (error) {
      logger.error('programQueries.getById', error, { programId })
      return null
    }
  },

  /** Fetch a program with department and director details */
  async getByIdWithDetails(supabase: SupabaseClient, programId: string) {
    try {

      const { data, error } = await (supabase as any)
        .from('programs')
        .select('*, department:departments(id, name, code), director:profiles(id, name, email)')
        .eq('id', programId)
        .single()
      if (error) {
        if (error.code !== 'PGRST116') logger.error('programQueries.getByIdWithDetails', error, { programId })
        return null
      }
      return data
    } catch (error) {
      logger.error('programQueries.getByIdWithDetails', error, { programId })
      return null
    }
  },

  /** Check if a program code already exists in the given institution. */
  async getByCode(supabase: SupabaseClient, code: string, institutionId: string) {
    try {
      const { data, error } = await supabase
        .from('programs')
        .select('id, code, institution_id')
        .eq('code', code)
        .eq('institution_id', institutionId)
        .maybeSingle()
      if (error) { logger.error('programQueries.getByCode', error, { code, institutionId }); return null }
      return data
    } catch (error) {
      logger.error('programQueries.getByCode', error, { code, institutionId })
      return null
    }
  },

  /** Delete a program by ID */
  async remove(supabase: SupabaseClient, programId: string) {
    try {
      const { error } = await supabase
        .from('programs')
        .delete()
        .eq('id', programId)
      if (error) { logger.error('programQueries.remove', error, { programId }); return false }
      return true
    } catch (error) {
      logger.error('programQueries.remove', error, { programId })
      return false
    }
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// Enrollment Admin Queries — admin enrollment management
// ─────────────────────────────────────────────────────────────────────────────

export const enrollmentAdminQueries = {
  /** Enroll a student in a section */
  async create(supabase: SupabaseClient, input: { section_id: string; student_id: string }) {
    try {
      const { data, error } = await supabase
        .from('enrollments')
        .insert({ section_id: input.section_id, student_id: input.student_id, status: 'enrolled' })
        .select('*')
        .single()
      if (error) { logger.error('enrollmentAdminQueries.create', error, input); return null }
      return data
    } catch (error) {
      logger.error('enrollmentAdminQueries.create', error, input)
      return null
    }
  },

  /** Update enrollment status */
  async updateStatus(supabase: SupabaseClient, enrollmentId: string, status: string) {
    try {
      /* enrollments has no updated_at column (verified against prod + local) —
         setting one made PostgREST reject the whole update (PGRST204). */
      const { data, error } = await supabase
        .from('enrollments')
        .update({ status })
        .eq('id', enrollmentId)
        .select('*')
        .single()
      if (error) { logger.error('enrollmentAdminQueries.updateStatus', error, { enrollmentId, status }); return null }
      return data
    } catch (error) {
      logger.error('enrollmentAdminQueries.updateStatus', error, { enrollmentId })
      return null
    }
  },

  /** Update enrollment grade */
  async updateGrade(supabase: SupabaseClient, enrollmentId: string, grade: { final_grade?: string; final_score?: number | null }) {
    try {
      /* Same PGRST204 trap as updateStatus above: no updated_at on enrollments. */
      const { data, error } = await supabase
        .from('enrollments')
        .update({ ...grade })
        .eq('id', enrollmentId)
        .select('*')
        .single()
      if (error) { logger.error('enrollmentAdminQueries.updateGrade', error, { enrollmentId }); return null }
      return data
    } catch (error) {
      logger.error('enrollmentAdminQueries.updateGrade', error, { enrollmentId })
      return null
    }
  },

  /** Remove an enrollment (unenroll student) */
  async remove(supabase: SupabaseClient, enrollmentId: string) {
    try {
      const { error } = await supabase
        .from('enrollments')
        .delete()
        .eq('id', enrollmentId)
      if (error) { logger.error('enrollmentAdminQueries.remove', error, { enrollmentId }); return false }
      return true
    } catch (error) {
      logger.error('enrollmentAdminQueries.remove', error, { enrollmentId })
      return false
    }
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// Student Course Queries — enrollment checks, section detail, grades, announcements
// (named "catalog" for history; the browse-catalog feature was removed when
// enrollment became admin-driven — see docs/designs/platform/admin-roster-import.md)
// ─────────────────────────────────────────────────────────────────────────────

export const studentCatalogQueries = {
  /**
   * Check if a student is enrolled in a specific section.
   * Returns the enrollment row or null.
   */
  async getStudentEnrollment(supabase: SupabaseClient, sectionId: string, studentId: string) {
    try {
      const { data, error } = await (supabase as any)
        .from('enrollments')
        .select('id, status, final_grade, final_score, enrolled_at')
        .eq('section_id', sectionId)
        .eq('student_id', studentId)
        .maybeSingle()

      if (error) {
        logger.error('studentCatalogQueries.getStudentEnrollment', error, { sectionId, studentId })
        return null
      }
      return data
    } catch (error) {
      logger.error('studentCatalogQueries.getStudentEnrollment', error, { sectionId, studentId })
      return null
    }
  },

  /**
   * Fetch a section for an enrolled student's course container.
   * Verifies the student has an active enrollment.
   */
  async getStudentSectionDetail(supabase: SupabaseClient, sectionId: string, studentId: string) {
    try {
      // Fetch section
      const { data: section, error: sectionError } = await (supabase as any)
        .from('course_sections')
        .select(`
          id, section_code, semester, year, status, modality, location,
          max_students, settings, schedule, start_date, end_date, institution_id,
          course:courses(id, code, title, description, credits,
            department:departments(id, code, name)),
          professor:profiles(id, name, email, avatar_url)
        `)
        .eq('id', sectionId)
        .maybeSingle()

      if (sectionError) {
        logger.error('studentCatalogQueries.getStudentSectionDetail', sectionError, { sectionId })
        return null
      }
      /* 0 rows is a plain not-found (stale link, deleted section) — the caller
         404s; logging it as an ERROR made every dead URL look like a breakage. */
      if (!section) {
        logger.warn('studentCatalogQueries.getStudentSectionDetail: section not found', { sectionId })
        return null
      }

      // Verify enrollment
      const { data: enrollment } = await (supabase as any)
        .from('enrollments')
        .select('id, status')
        .eq('section_id', sectionId)
        .eq('student_id', studentId)
        .in('status', ['enrolled', 'completed'])
        .maybeSingle()

      if (!enrollment) {
        logger.warn('studentCatalogQueries.getStudentSectionDetail: Not enrolled', { sectionId, studentId })
        return null
      }

      return section
    } catch (error) {
      logger.error('studentCatalogQueries.getStudentSectionDetail', error, { sectionId, studentId })
      return null
    }
  },

  /**
   * Fetch all enrollments with grades for the grades overview page.
   */
  async getStudentGrades(supabase: SupabaseClient, studentId: string) {
    try {
      const { data, error } = await (supabase as any)
        .from('enrollments')
        .select(`
          id, status, final_grade, final_score, enrolled_at,
          section:course_sections(id, section_code, semester, year,
            course:courses(id, code, title, credits),
            professor:profiles(id, name))
        `)
        .eq('student_id', studentId)
        .order('enrolled_at', { ascending: false })

      if (error) {
        logger.error('studentCatalogQueries.getStudentGrades', error, { studentId })
        return []
      }
      return data || []
    } catch (error) {
      logger.error('studentCatalogQueries.getStudentGrades', error, { studentId })
      return []
    }
  },

  /**
   * Unread, important, published announcements across a student's enrolled
   * sections — the dashboard "Recent Announcements" panel. Public-visibility
   * only ('mentioned_only' posts stay on their course page). Bounded and read-
   * filtered in JS: fetch the newest important posts, drop ones already read,
   * return up to `limit`.
   */
  async getRecentImportantAnnouncements(supabase: SupabaseClient, studentId: string, limit = 5) {
    try {
      const db = supabase as any
      const { data: enrollments, error: enrollError } = await db
        .from('enrollments')
        .select('section_id')
        .eq('student_id', studentId)
        .in('status', ['enrolled', 'completed'])

      // null signals a failed load (so the UI can distinguish it from a genuinely
      // empty inbox and show an error instead of a reassuring "all clear"); [] means
      // no announcements. No enrollments is a real empty, not a failure.
      if (enrollError) {
        logger.error('studentCatalogQueries.getRecentImportantAnnouncements', enrollError, { studentId })
        return null
      }
      if (!enrollments || enrollments.length === 0) return []
      const sectionIds = enrollments.map((e: { section_id: string }) => e.section_id)

      const { data: rows, error } = await db
        .from('announcements')
        .select(`
          id, title, published_at, section_id,
          section:course_sections(id, section_code,
            course:courses(id, code, title))
        `)
        .in('section_id', sectionIds)
        .eq('status', 'published')
        .eq('is_important', true)
        .eq('visibility', 'all')
        .order('published_at', { ascending: false })
        .limit(25)

      if (error) {
        logger.error('studentCatalogQueries.getRecentImportantAnnouncements', error, { studentId })
        return null
      }
      const announcements = rows || []
      if (announcements.length === 0) return []

      // Drop the ones this student has already read.
      const ids = announcements.map((a: { id: string }) => a.id)
      const { data: reads } = await db
        .from('announcement_reads')
        .select('announcement_id')
        .eq('student_id', studentId)
        .in('announcement_id', ids)
      const readSet = new Set(((reads || []) as { announcement_id: string }[]).map((r) => r.announcement_id))

      return announcements.filter((a: { id: string }) => !readSet.has(a.id)).slice(0, limit)
    } catch (error) {
      logger.error('studentCatalogQueries.getRecentImportantAnnouncements', error, { studentId })
      return null
    }
  },

  /**
   * Count of unread, published, public-visibility announcements across a
   * student's enrolled sections — including non-important ones. Drives the
   * dashboard panel's "N unread announcements" hint so a student notices unread
   * posts a professor didn't flag important. Read count is scoped to the visible
   * ids, so it can't be inflated by reads of now-hidden announcements.
   */
  async getUnreadAnnouncementCount(supabase: SupabaseClient, studentId: string) {
    try {
      const db = supabase as any
      const { data: enrollments, error: enrollError } = await db
        .from('enrollments')
        .select('section_id')
        .eq('student_id', studentId)
        .in('status', ['enrolled', 'completed'])

      if (enrollError || !enrollments || enrollments.length === 0) {
        if (enrollError) logger.error('studentCatalogQueries.getUnreadAnnouncementCount', enrollError, { studentId })
        return 0
      }
      const sectionIds = enrollments.map((e: { section_id: string }) => e.section_id)

      const { data: anns, error } = await db
        .from('announcements')
        .select('id')
        .in('section_id', sectionIds)
        .eq('status', 'published')
        .eq('visibility', 'all')

      if (error) {
        logger.error('studentCatalogQueries.getUnreadAnnouncementCount', error, { studentId })
        return 0
      }
      const ids = ((anns || []) as { id: string }[]).map((a) => a.id)
      if (ids.length === 0) return 0

      const { data: reads } = await db
        .from('announcement_reads')
        .select('announcement_id')
        .eq('student_id', studentId)
        .in('announcement_id', ids)
      const readCount = ((reads || []) as unknown[]).length

      return Math.max(0, ids.length - readCount)
    } catch (error) {
      logger.error('studentCatalogQueries.getUnreadAnnouncementCount', error, { studentId })
      return 0
    }
  },

  /**
   * All published, public-visibility announcements across a student's enrolled
   * sections, newest first, each tagged with whether the student has read it.
   * Powers the cross-course /student/announcements page. Bounded to the most
   * recent `limit` so the query stays cheap as history grows.
   */
  async getAllStudentAnnouncements(supabase: SupabaseClient, studentId: string, limit = 200) {
    try {
      const db = supabase as any
      const { data: enrollments, error: enrollError } = await db
        .from('enrollments')
        .select('section_id')
        .eq('student_id', studentId)
        .in('status', ['enrolled', 'completed'])

      if (enrollError || !enrollments || enrollments.length === 0) {
        if (enrollError) logger.error('studentCatalogQueries.getAllStudentAnnouncements', enrollError, { studentId })
        return []
      }
      const sectionIds = enrollments.map((e: { section_id: string }) => e.section_id)

      /* Targeted announcements this student is a recipient of. `.eq('visibility','all')`
         used to exclude the whole category, so a student's central list showed
         everything EXCEPT the message singled out for them (#666) — and a targeted
         announcement is usually the more important one. Filtering by whether THIS
         student is a recipient is the correct read of the same rule the detail view
         already applies. */
      const { data: myMentions } = await db
        .from('announcement_mentions')
        .select('announcement_id')
        .eq('student_id', studentId)
      const mentionedIds = ((myMentions || []) as { announcement_id: string }[]).map(
        (m) => m.announcement_id,
      )

      /* PostgREST `or` with an empty `in.()` is a syntax error, so the targeted clause is
         only added when this student actually has mentions. Tenancy is unaffected either
         way: `.in('section_id', sectionIds)` still bounds every row to a section they are
         enrolled in, so a stray mention row could never surface another course's post. */
      let query = db
        .from('announcements')
        .select(`
          id, title, is_important, is_pinned, published_at, section_id,
          section:course_sections(id, section_code,
            course:courses(id, code, title))
        `)
        .in('section_id', sectionIds)
        .eq('status', 'published')
      query =
        mentionedIds.length > 0
          ? query.or(`visibility.eq.all,id.in.(${mentionedIds.join(',')})`)
          : query.eq('visibility', 'all')
      const { data: rows, error } = await query
        .order('published_at', { ascending: false })
        .limit(limit)

      if (error) {
        logger.error('studentCatalogQueries.getAllStudentAnnouncements', error, { studentId })
        return []
      }
      const announcements = rows || []
      if (announcements.length === 0) return []

      const ids = announcements.map((a: { id: string }) => a.id)
      const { data: reads } = await db
        .from('announcement_reads')
        .select('announcement_id')
        .eq('student_id', studentId)
        .in('announcement_id', ids)
      const readSet = new Set(((reads || []) as { announcement_id: string }[]).map((r) => r.announcement_id))

      return announcements.map((a: { id: string }) => ({ ...a, is_read: readSet.has(a.id) }))
    } catch (error) {
      logger.error('studentCatalogQueries.getAllStudentAnnouncements', error, { studentId })
      return []
    }
  },
}

// ── Roadmap Queries ──────────────────────────────────────────────

export const roadmapQueries = {
  /** Get roadmap settings from course_sections.settings.roadmap */
  async getSettings(supabase: SupabaseClient, sectionId: string) {
    try {
      const { data, error } = await (supabase as any)
        .from('course_sections')
        .select('settings')
        .eq('id', sectionId)
        .single()

      if (error) {
        logger.error('roadmapQueries.getSettings', error, { sectionId })
        return null
      }
      return data?.settings ?? null
    } catch (error) {
      logger.error('roadmapQueries.getSettings', error, { sectionId })
      return null
    }
  },

  /** Get a student's roadmap progress for a section */
  async getStudentProgress(supabase: SupabaseClient, sectionId: string, studentId: string) {
    try {
      const { data, error } = await (supabase as any)
        .from('roadmap_progress')
        .select('progress')
        .eq('section_id', sectionId)
        .eq('student_id', studentId)
        .single()

      if (error && error.code !== 'PGRST116') {
        // PGRST116 = no rows found, which is expected for new students
        logger.error('roadmapQueries.getStudentProgress', error, { sectionId, studentId })
      }
      return data?.progress ?? null
    } catch (error) {
      logger.error('roadmapQueries.getStudentProgress', error, { sectionId, studentId })
      return null
    }
  },

  /** Get progress for all students in a section (for instructor insights) */
  async getSectionProgress(supabase: SupabaseClient, sectionId: string) {
    try {
      const { data, error } = await (supabase as any)
        .from('roadmap_progress')
        .select('student_id, progress, updated_at')
        .eq('section_id', sectionId)

      if (error) {
        logger.error('roadmapQueries.getSectionProgress', error, { sectionId })
        return []
      }
      return data || []
    } catch (error) {
      logger.error('roadmapQueries.getSectionProgress', error, { sectionId })
      return []
    }
  },

  /**
   * Fetch the section's course resources (quizzes, assignments, live sessions +
   * their polls/pop-quizzes) as raw rows for the roadmap. Caller shapes them via
   * buildResourceNodes(). `publishedOnly` restricts to what a student may see
   * (published quizzes/assignments). All reads are scoped by section_id; callers
   * must have already verified ownership/enrolment for that section.
   */
  async getSectionResources(
    supabase: SupabaseClient,
    sectionId: string,
    opts: { publishedOnly: boolean; includeAttendance?: boolean },
  ) {
    const db = supabase as any
    const empty = {
      quizzes: [] as RoadmapResourceRaw['quizzes'],
      quizSkillNames: new Map<string, string[]>(),
      assignments: [] as RoadmapResourceRaw['assignments'],
      sessions: [] as RoadmapResourceRaw['sessions'],
      polls: [] as RoadmapResourceRaw['polls'],
      liveQuizzes: [] as RoadmapResourceRaw['liveQuizzes'],
    }
    try {
      let quizzesQ = db.from('quizzes').select('id, title, status, description, due_date, created_at').eq('section_id', sectionId)
      if (opts.publishedOnly) quizzesQ = quizzesQ.eq('status', 'published')

      let assignmentsQ = db
        .from('assignments')
        .select('id, title, status, description, created_at')
        .eq('section_id', sectionId)
      if (opts.publishedOnly) assignmentsQ = assignmentsQ.eq('status', 'published')

      const [quizzesRes, assignmentsRes, sessionsRes] = await Promise.all([
        quizzesQ.order('created_at', { ascending: true }),
        assignmentsQ.order('created_at', { ascending: true }),
        // Live sessions come from the v2 live-classroom model (lc_rooms). A room
        // may be scheduled (planned ahead), live, or ended — all appear on the
        // roadmap. `name` is the room's title.
        db
          .from('lc_rooms')
          .select('id, name, status, scheduled_at')
          .eq('section_id', sectionId)
          .order('scheduled_at', { ascending: true, nullsFirst: false })
          .order('created_at', { ascending: true }),
      ])

      const quizzes = (quizzesRes.data || []) as RoadmapResourceRaw['quizzes']
      const assignments = (assignmentsRes.data || []) as RoadmapResourceRaw['assignments']
      const sessions = ((sessionsRes.data || []) as {
        id: string; name: string | null; status: string | null; scheduled_at: string | null
      }[]).map((r): RawSession => ({ id: r.id, title: r.name, status: r.status, scheduledAt: r.scheduled_at }))

      const quizIds = quizzes.map((q) => q.id)
      const sessionIds = sessions.map((s) => s.id)

      // Quiz skills = the canonical skills mapped to each quiz via activity_skills
      // (the source of truth — replaces string-matching quiz_questions.tags).
      const quizSkillNames = new Map<string, string[]>()
      const [actRes, interactionsRes, attendanceRes] = await Promise.all([
        quizIds.length > 0
          ? db
              .from('activity_skills')
              .select('activity_id, skill:skills(name)')
              .eq('section_id', sectionId)
              .eq('activity_type', 'quiz')
              .in('activity_id', quizIds)
          : Promise.resolve({ data: [] }),
        /* Poll + pop-quiz children live in lc_interactions (discriminated by
           `kind`), keyed by room. One query, split in JS below.

           `publishedOnly` (the student path) applies the SAME release gate as
           getSessionContent — polls always, pop-quizzes only once closed. These
           rows are reduced to counts downstream, so no title or answer ever
           reached a student; but the count itself told them how many pop-quizzes
           exist, including drafts for a class that hasn't happened yet. The
           session card then claimed "3 live quizzes" while its own drawer
           correctly listed the one released quiz. */
        sessionIds.length > 0
          ? (() => {
              let q = db
                .from('lc_interactions')
                .select('id, room_id, kind, payload, status, closed_at')
                .in('room_id', sessionIds)
                .in('kind', ['poll', 'quiz'])
              if (opts.publishedOnly) q = q.or('kind.neq.quiz,status.eq.closed')
              return q
            })()
          : Promise.resolve({ data: [] }),
        // Attendance roster → the session facepile, for professors AND students
        // (classmates seeing who joined a live class is intended). The invariant
        // that keeps this safe is the narrow select: **names only**. Never widen it
        // to id / email / joined_at — that would ship classmate PII to every
        // enrolled student. lc_rooms-scoped, so it never crosses a section.
        opts.includeAttendance && sessionIds.length > 0
          ? db
              .from('lc_attendance')
              .select('room_id, student:profiles(name)')
              .in('room_id', sessionIds)
              .order('joined_at', { ascending: true })
          : Promise.resolve({ data: [] }),
      ])

      // Supabase returns the joined skill as object or array depending on context.
      const resolveJoin = (v: unknown) => (Array.isArray(v) ? v[0] : v)
      for (const r of (actRes.data || []) as { activity_id: string; skill: unknown }[]) {
        const name = (resolveJoin(r.skill) as { name?: string } | null)?.name
        if (!name) continue
        const list = quizSkillNames.get(r.activity_id) || []
        list.push(name)
        quizSkillNames.set(r.activity_id, list)
      }

      // Group attendee names by room (joined_at order) for the facepile.
      const attendeesByRoom = new Map<string, string[]>()
      for (const r of (attendanceRes.data || []) as { room_id: string; student: unknown }[]) {
        const name = (resolveJoin(r.student) as { name?: string } | null)?.name?.trim()
        if (!name) continue
        const list = attendeesByRoom.get(r.room_id) || []
        list.push(name)
        attendeesByRoom.set(r.room_id, list)
      }
      for (const s of sessions) s.attendees = attendeesByRoom.get(s.id)

      // Split the room's interactions into polls vs pop-quizzes. An interaction
      // is "active" while open and "complete" once closed — mirrors the old
      // is_active / closed_at flags the node builder expects.
      const interactions = (interactionsRes.data || []) as {
        id: string
        room_id: string
        kind: string
        payload: { question?: string; title?: string } | null
        status: string | null
        closed_at: string | null
      }[]
      const polls = interactions
        .filter((i) => i.kind === 'poll')
        .map((i) => ({
          id: i.id,
          session_id: i.room_id,
          label: i.payload?.question ?? null,
          is_active: i.status === 'open',
          closed_at: i.closed_at,
        }))
      const liveQuizzes = interactions
        .filter((i) => i.kind === 'quiz')
        .map((i) => ({
          id: i.id,
          session_id: i.room_id,
          label: i.payload?.title ?? null,
          is_active: i.status === 'open',
          closed_at: i.closed_at,
        }))

      return { quizzes, quizSkillNames, assignments, sessions, polls, liveQuizzes }
    } catch (error) {
      logger.error('roadmapQueries.getSectionResources', error, { sectionId })
      return empty
    }
  },

  /**
   * A quiz's assigned questions for the roadmap node drawer (read-only preview).
   * Section-scoped; callers must have verified ownership/enrolment first. Returns
   * display fields only (no answer key). `tags` are the per-question labels.
   */
  async getQuizQuestions(supabase: SupabaseClient, sectionId: string, quizId: string) {
    const db = supabase as any
    try {
      const { data: assignments } = await db
        .from('quiz_question_assignments')
        .select('question_id, position')
        .eq('quiz_id', quizId)
        .order('position', { ascending: true })
      const ids = ((assignments || []) as { question_id: string; position: number }[]).map((a) => a.question_id)
      if (ids.length === 0) return []

      const { data: rows } = await db
        .from('quiz_questions')
        .select('id, question_text, question_type, difficulty, points, tags')
        .eq('section_id', sectionId)
        .in('id', ids)

      // Preserve the quiz's question order.
      const order = new Map(ids.map((id: string, i: number) => [id, i]))
      const list = ((rows || []) as {
        id: string; question_text: string | null; question_type: string | null; difficulty: string | null; points: number | null; tags: string[] | null
      }[])
        .map((q) => ({
          id: q.id,
          text: q.question_text || '',
          type: q.question_type || '',
          difficulty: q.difficulty || '',
          points: q.points ?? 0,
          tags: Array.isArray(q.tags) ? q.tags.filter((t): t is string => typeof t === 'string' && !!t.trim()) : [],
        }))
        .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
      return list
    } catch (error) {
      logger.error('roadmapQueries.getQuizQuestions', error, { sectionId, quizId })
      return []
    }
  },

  /** Assignment content for the node drawer's LEFT column + its mapped skills.
   *  Scoped by section_id so a caller can't read another section's assignment. */
  async getAssignmentContent(
    supabase: SupabaseClient,
    sectionId: string,
    assignmentId: string,
  ): Promise<RoadmapDrawerAssignment | null> {
    const db = supabase as any
    try {
      const { data: a } = await db
        .from('assignments')
        .select('description, guidelines, settings')
        .eq('id', assignmentId)
        .eq('section_id', sectionId)
        .maybeSingle()
      if (!a) return null

      /* Rubric JSON → flat criteria descriptions (pure, tested helper).
         Read through `settings.rubric`, NOT the `assignments.rubric` column:
         nothing in the app writes that column (it stays `[]`), while the
         professor-reviewed rubric is saved into `settings.rubric` — so this
         drawer's RUBRIC block could never render. Every other consumer (student
         and professor assignment pages, the studio, the AI assistant) already
         reads it via parseRubric. */
      const criteria = flattenRubricCriteria(parseRubric(a.settings))

      const { data: sk } = await db
        .from('activity_skills')
        .select('skill:skills(name)')
        .eq('section_id', sectionId)
        .eq('activity_type', 'assignment')
        .eq('activity_id', assignmentId)
      const resolveJoin = (v: unknown) => (Array.isArray(v) ? v[0] : v)
      const skills = ((sk || []) as { skill: unknown }[])
        .map((r) => (resolveJoin(r.skill) as { name?: string } | null)?.name)
        .filter((n): n is string => !!n)

      return {
        description: (a.description as string) ?? '',
        guidelines: (a.guidelines as string) ?? '',
        criteria,
        skills,
      }
    } catch (error) {
      logger.error('roadmapQueries.getAssignmentContent', error, { sectionId, assignmentId })
      return null
    }
  },

  /** Live-session content for the node drawer: its polls / pop-quizzes (LEFT) with
   *  each child's mapped skills (for the "Section N" skill anchor). Scoped by
   *  section_id via the room, so cross-section reads are impossible. */
  async getSessionContent(
    supabase: SupabaseClient,
    sectionId: string,
    roomId: string,
    opts: { isStaff: boolean },
  ): Promise<RoadmapDrawerSession | null> {
    const db = supabase as any
    try {
      const { data: room } = await db
        .from('lc_rooms')
        .select('id')
        .eq('id', roomId)
        .eq('section_id', sectionId)
        .maybeSingle()
      if (!room) return null

      let q = db
        .from('lc_interactions')
        .select('id, kind, payload, created_at')
        .eq('room_id', roomId)
        .in('kind', ['poll', 'quiz'])
      // Mirror the table's own student SELECT policy (migration
      // 20260727144045_lc_interactions_hide_unclosed_quiz_answers.sql): a quiz
      // carries its answer key, so a student may read one only once the professor
      // has closed it; a poll has nothing to leak. This runs on the ADMIN client,
      // so that policy is not here to enforce it — without this filter the drawer
      // hands a student the prompt of every pop quiz staged for their section,
      // including drafts for a class that has not happened yet.
      if (!opts.isStaff) q = q.or('kind.neq.quiz,status.eq.closed')
      const { data: rows } = await q
        .order('created_at', { ascending: true })
        .limit(200)
      const interactions = (rows || []) as { id: string; kind: string; payload: unknown; created_at: string }[]

      // Child skills via activity_skills (live_quiz coverage) — one batched query.
      const ids = interactions.map((i) => i.id)
      const skillsById = new Map<string, string[]>()
      if (ids.length > 0) {
        const { data: sk } = await db
          .from('activity_skills')
          .select('activity_id, skill:skills(name)')
          .eq('section_id', sectionId)
          .eq('activity_type', 'live_quiz')
          .in('activity_id', ids)
        const resolveJoin = (v: unknown) => (Array.isArray(v) ? v[0] : v)
        for (const r of (sk || []) as { activity_id: string; skill: unknown }[]) {
          const name = (resolveJoin(r.skill) as { name?: string } | null)?.name
          if (!name) continue
          const list = skillsById.get(r.activity_id) || []
          list.push(name)
          skillsById.set(r.activity_id, list)
        }
      }

      const children = interactions.map((i) => {
        const p = (i.payload && typeof i.payload === 'object' ? i.payload : {}) as { title?: string; question?: string }
        const isPoll = i.kind === 'poll'
        return {
          id: i.id,
          kind: (isPoll ? 'live_poll' : 'live_quiz') as 'live_poll' | 'live_quiz',
          title: (isPoll ? p.question : p.title) || (isPoll ? 'Poll' : 'Pop quiz'),
          prompt: (p.question || p.title || '') as string,
          skills: skillsById.get(i.id) ?? [],
        }
      })
      return { children }
    } catch (error) {
      logger.error('roadmapQueries.getSessionContent', error, { sectionId, roomId })
      return null
    }
  },
}

/** Assignment content for the roadmap node drawer's LEFT column. */
export interface RoadmapDrawerAssignment {
  description: string
  guidelines: string
  criteria: string[]
  skills: string[]
}

/** Live-session content for the roadmap node drawer: its polls / pop-quizzes. */
export interface RoadmapDrawerSession {
  children: { id: string; kind: 'live_poll' | 'live_quiz'; title: string; prompt: string; skills: string[] }[]
}

/** A quiz question row for the roadmap node drawer (display-only). */
export interface RoadmapDrawerQuestion {
  id: string
  text: string
  type: string
  difficulty: string
  points: number
  tags: string[]
}

// ═══════════════════════════════════════════════════════════════
// Project Queries
// ═══════════════════════════════════════════════════════════════

export const projectQueries = {
  /** Fetch all project assignments for a course section (professor view) — includes team counts */
  async getSectionProjects(supabase: SupabaseClient, sectionId: string) {
    try {
      const { data, error } = await (supabase as any)
        .from('projects')
        .select(`
          *,
          project_teams(id, name, status),
          created_by_profile:profiles!projects_created_by_fkey(id, name, avatar_url)
        `)
        .eq('section_id', sectionId)
        .order('created_at', { ascending: false })
        .limit(200)

      if (error) {
        logger.error('projectQueries.getSectionProjects', error, { sectionId })
        return []
      }
      return data || []
    } catch (error) {
      logger.error('projectQueries.getSectionProjects', error, { sectionId })
      return []
    }
  },

  /** Fetch project assignments a student can see in a section — includes team counts */
  async getStudentSectionProjects(supabase: SupabaseClient, sectionId: string, userId: string) {
    try {
      const { data, error } = await (supabase as any)
        .from('projects')
        .select(`
          *,
          project_teams(id, name, status),
          created_by_profile:profiles!projects_created_by_fkey(id, name, avatar_url)
        `)
        .eq('section_id', sectionId)
        .in('visibility', ['course', 'public'])
        .in('status', ['active', 'completed'])
        .order('created_at', { ascending: false })
        .limit(200)

      if (error) {
        logger.error('projectQueries.getStudentSectionProjects', error, { sectionId, userId })
        return []
      }
      return data || []
    } catch (error) {
      logger.error('projectQueries.getStudentSectionProjects', error, { sectionId, userId })
      return []
    }
  },

  /** Fetch a single project assignment with full details */
  async getProjectDetail(supabase: SupabaseClient, projectId: string) {
    try {
      const { data, error } = await (supabase as any)
        .from('projects')
        .select(`
          *,
          created_by_profile:profiles!projects_created_by_fkey(id, name, email, avatar_url)
        `)
        .eq('id', projectId)
        .maybeSingle()

      if (error) {
        logger.error('projectQueries.getProjectDetail', error, { projectId })
        return null
      }
      return data ?? null
    } catch (error) {
      logger.error('projectQueries.getProjectDetail', error, { projectId })
      return null
    }
  },

  /** Fetch all teams for a project assignment — with member counts, phases, grades */
  /* NOTE: selects `*`, and `project_teams` has COLUMN-SCOPED select grants
   * (20260915193931) — `submission` and `planning_doc` are readable only by the
   * service role. Every caller today passes the admin client. If one is ever
   * handed a user-scoped client this does NOT 500: the catch below swallows the
   * permission error and returns [], i.e. an empty team list rather than a loud
   * failure. Pass adminDb. */
  async getProjectTeams(supabase: SupabaseClient, projectId: string) {
    try {
      const { data, error } = await (supabase as any)
        .from('project_teams')
        .select(`
          *,
          created_by_profile:profiles!project_teams_created_by_fkey(id, name, avatar_url),
          project_members(id, user_id, role, profile:profiles!project_members_user_id_fkey(name, avatar_url)),
          project_phases(id, status)
        `)
        .eq('project_id', projectId)
        .order('created_at', { ascending: false })
        .limit(500)

      if (error) {
        logger.error('projectQueries.getProjectTeams', error, { projectId })
        return []
      }
      return data || []
    } catch (error) {
      logger.error('projectQueries.getProjectTeams', error, { projectId })
      return []
    }
  },

  /** Fetch a single team with parent project info */
  /* Same column-grant caveat as getProjectTeams above: selects `*`, so it must be
   * given the admin client. A user-scoped client returns null, not an error. */
  async getTeamDetail(supabase: SupabaseClient, teamId: string) {
    try {
      const { data, error } = await (supabase as any)
        .from('project_teams')
        .select(`
          *,
          created_by_profile:profiles!project_teams_created_by_fkey(id, name, email, avatar_url),
          project:projects!project_teams_project_id_fkey(id, title, description, guidelines, status, max_team_size, due_date, section_id, allow_team_workspace)
        `)
        .eq('id', teamId)
        .single()

      if (error) {
        logger.error('projectQueries.getTeamDetail', error, { teamId })
        return null
      }
      return data
    } catch (error) {
      logger.error('projectQueries.getTeamDetail', error, { teamId })
      return null
    }
  },

  /** Get team members with profile info (filters by team_id when provided) */
  async getProjectMembers(supabase: SupabaseClient, projectId: string, teamId?: string) {
    try {
      let query = (supabase as any)
        .from('project_members')
        .select(`
          *,
          profile:profiles!project_members_user_id_fkey(id, name, email, avatar_url)
        `)

      if (teamId) {
        query = query.eq('team_id', teamId)
      } else {
        query = query.eq('project_id', projectId)
      }

      const { data, error } = await query
        .order('role', { ascending: true })
        .order('joined_at', { ascending: true })

      if (error) {
        logger.error('projectQueries.getProjectMembers', error, { projectId, teamId })
        return []
      }
      return data || []
    } catch (error) {
      logger.error('projectQueries.getProjectMembers', error, { projectId, teamId })
      return []
    }
  },

  /** Get project phases ordered by position, with nested phase_items (filters by team_id when provided) */
  async getProjectPhases(supabase: SupabaseClient, projectId: string, teamId?: string) {
    try {
      let query = (supabase as any)
        .from('project_phases')
        .select('*, phase_items(id, title, is_completed, position, completed_by, completed_at, created_by, created_at)')

      if (teamId) {
        query = query.eq('team_id', teamId)
      } else {
        query = query.eq('project_id', projectId)
      }

      const { data, error } = await query.order('position', { ascending: true })

      if (error) {
        logger.error('projectQueries.getProjectPhases', error, { projectId, teamId })
        return []
      }

      // Sort phase_items by position within each phase
      if (data) {
        for (const phase of data) {
          if (phase.phase_items) {
            phase.phase_items.sort((a: any, b: any) => a.position - b.position)
          }
        }
      }

      return data || []
    } catch (error) {
      logger.error('projectQueries.getProjectPhases', error, { projectId, teamId })
      return []
    }
  },

  /** Get project videos with uploader profile (filters by team_id when provided) */
  async getProjectVideos(supabase: SupabaseClient, projectId: string, teamId?: string) {
    try {
      let query = (supabase as any)
        .from('project_videos')
        .select(`
          *,
          uploader:profiles!project_videos_uploaded_by_fkey(id, name, avatar_url)
        `)

      if (teamId) {
        query = query.eq('team_id', teamId)
      } else {
        query = query.eq('project_id', projectId)
      }

      const { data, error } = await query.order('created_at', { ascending: false })

      if (error) {
        logger.error('projectQueries.getProjectVideos', error, { projectId, teamId })
        return []
      }
      return data || []
    } catch (error) {
      logger.error('projectQueries.getProjectVideos', error, { projectId, teamId })
      return []
    }
  },

  /** Get enrolled students not in any team for this project */
  async getAvailableTeamMembers(supabase: SupabaseClient, sectionId: string, projectId: string) {
    try {
      // Get all user_ids who are members of any team in this project
      const { data: members } = await (supabase as any)
        .from('project_members')
        .select('user_id')
        .eq('project_id', projectId)
        .not('team_id', 'is', null)

      const takenUserIds = (members || []).map((m: { user_id: string }) => m.user_id)

      // Get enrolled students
      const { data: enrollments, error } = await (supabase as any)
        .from('enrollments')
        .select(`
          student_id,
          profile:profiles!enrollments_student_id_fkey(id, name, email, avatar_url)
        `)
        .eq('section_id', sectionId)
        .eq('status', 'active')

      if (error) {
        logger.error('projectQueries.getAvailableTeamMembers', error, { sectionId, projectId })
        return []
      }

      return (enrollments || []).filter(
        (e: { student_id: string }) => !takenUserIds.includes(e.student_id),
      )
    } catch (error) {
      logger.error('projectQueries.getAvailableTeamMembers', error, { sectionId, projectId })
      return []
    }
  },

  /** Check user's access level: team role, 'professor', or null */
  async getProjectAccess(
    supabase: SupabaseClient,
    projectId: string,
    userId: string,
    teamId?: string,
  ): Promise<'owner' | 'member' | 'viewer' | 'professor' | null> {
    try {
      // Check if user is a team member
      if (teamId) {
        const { data: member } = await (supabase as any)
          .from('project_members')
          .select('role')
          .eq('team_id', teamId)
          .eq('user_id', userId)
          .single()

        if (member) return member.role as 'owner' | 'member' | 'viewer'
      }

      // Check if user is the section professor
      const { data: project } = await (supabase as any)
        .from('projects')
        .select('section_id')
        .eq('id', projectId)
        .single()

      if (!project) return null

      const { data: section } = await (supabase as any)
        .from('course_sections')
        .select('professor_id')
        .eq('id', project.section_id)
        .single()

      if (section?.professor_id === userId) return 'professor'

      return null
    } catch (error) {
      logger.error('projectQueries.getProjectAccess', error, { projectId, userId, teamId })
      return null
    }
  },

  /** Get the team's showcase record */
  async getShowcase(supabase: SupabaseClient, teamId: string) {
    try {
      const { data, error } = await (supabase as any)
        .from('project_showcase')
        .select('*')
        .eq('team_id', teamId)
        .single()

      if (error && error.code !== 'PGRST116') {
        logger.error('projectQueries.getShowcase', error, { teamId })
      }
      return data || null
    } catch (error) {
      logger.error('projectQueries.getShowcase', error, { teamId })
      return null
    }
  },

  /** Check if student already has a team in this project — returns team_id or null */
  async getStudentTeamInProject(supabase: SupabaseClient, projectId: string, userId: string): Promise<string | null> {
    try {
      const { data } = await (supabase as any)
        .from('project_members')
        .select('team_id')
        .eq('user_id', userId)
        .not('team_id', 'is', null)

      if (!data || data.length === 0) return null

      // Check which of these teams belong to this project
      const teamIds = data.map((m: { team_id: string }) => m.team_id)
      const { data: teams } = await (supabase as any)
        .from('project_teams')
        .select('id')
        .eq('project_id', projectId)
        .in('id', teamIds)
        .limit(1)

      return teams?.[0]?.id || null
    } catch (error) {
      logger.error('projectQueries.getStudentTeamInProject', error, { projectId, userId })
      return null
    }
  },

  /** Master phases (professor's official structure) with their placed items, ordered */
  async getMasterPhases(supabase: SupabaseClient, projectId: string) {
    try {
      const { data, error } = await (supabase as any)
        .from('project_master_phases')
        .select(`
          id, name, position, start_date, end_date,
          project_phase_items(id, item_type, assignment_id, quiz_id, position)
        `)
        .eq('project_id', projectId)
        .order('position', { ascending: true })
        .limit(100)

      if (error) {
        logger.error('projectQueries.getMasterPhases', error, { projectId })
        return []
      }
      for (const phase of data || []) {
        phase.project_phase_items?.sort((a: any, b: any) => a.position - b.position)
      }
      return data || []
    } catch (error) {
      logger.error('projectQueries.getMasterPhases', error, { projectId })
      return []
    }
  },

  /** The section's assignments and quizzes available to place on the phases board */
  async getSectionPhaseLibrary(supabase: SupabaseClient, sectionId: string) {
    try {
      const [assignments, quizzes] = await Promise.all([
        (supabase as any)
          .from('assignments')
          .select('id, title, points, status, due_at')
          .eq('section_id', sectionId)
          .order('created_at', { ascending: false })
          .limit(300),
        (supabase as any)
          .from('quizzes')
          .select('id, title, status, due_date')
          .eq('section_id', sectionId)
          .order('created_at', { ascending: false })
          .limit(300),
      ])

      if (assignments.error) {
        logger.error('projectQueries.getSectionPhaseLibrary (assignments)', assignments.error, { sectionId })
      }
      if (quizzes.error) {
        logger.error('projectQueries.getSectionPhaseLibrary (quizzes)', quizzes.error, { sectionId })
      }
      return {
        assignments: assignments.data || [],
        quizzes: quizzes.data || [],
      }
    } catch (error) {
      logger.error('projectQueries.getSectionPhaseLibrary', error, { sectionId })
      return { assignments: [], quizzes: [] }
    }
  },

  /** id -> title map source for a team's docs (mention chips in read-only chat) */
  async getTeamDocTitles(supabase: SupabaseClient, teamId: string) {
    try {
      const { data, error } = await (supabase as any)
        .from('project_docs')
        .select('id, title')
        .eq('team_id', teamId)
        .limit(200)

      if (error) {
        logger.error('projectQueries.getTeamDocTitles', error, { teamId })
        return []
      }
      return data || []
    } catch (error) {
      logger.error('projectQueries.getTeamDocTitles', error, { teamId })
      return []
    }
  },

  /** Channels of a team's workspace, ordered */
  async getTeamChannels(supabase: SupabaseClient, teamId: string) {
    try {
      const { data, error } = await (supabase as any)
        .from('project_chat_channels')
        .select('id, name, is_default, position')
        .eq('team_id', teamId)
        .order('position', { ascending: true })
        .order('created_at', { ascending: true })
        .limit(50)

      if (error) {
        logger.error('projectQueries.getTeamChannels', error, { teamId })
        return []
      }
      return data || []
    } catch (error) {
      logger.error('projectQueries.getTeamChannels', error, { teamId })
      return []
    }
  },

  /** Most recent messages of one channel (ascending order for display) */
  async getChannelMessages(supabase: SupabaseClient, channelId: string, limit = 100) {
    try {
      const { data, error } = await (supabase as any)
        .from('project_chat_messages')
        .select(`
          id, channel_id, author_id, content, kind, system_event, system_payload,
          attachment_name, attachment_url, deleted_at, created_at,
          mentioned_phase_ids, mentioned_doc_ids,
          author:profiles!project_chat_messages_author_id_fkey(id, name, avatar_url)
        `)
        .eq('channel_id', channelId)
        .order('created_at', { ascending: false })
        .limit(limit)

      if (error) {
        logger.error('projectQueries.getChannelMessages', error, { channelId })
        return []
      }
      return (data || []).reverse()
    } catch (error) {
      logger.error('projectQueries.getChannelMessages', error, { channelId })
      return []
    }
  },

  /**
   * Raw activity rows (channel, author, timestamp) for a team's channels since
   * a cutoff — one query serves per-member participation counts and
   * per-channel last-activity times.
   */
  async getTeamChatActivity(supabase: SupabaseClient, channelIds: string[], sinceIso: string) {
    if (channelIds.length === 0) return []
    try {
      const { data, error } = await (supabase as any)
        .from('project_chat_messages')
        .select('channel_id, author_id, created_at')
        .in('channel_id', channelIds)
        .eq('kind', 'user')
        .is('deleted_at', null)
        .gte('created_at', sinceIso)
        .order('created_at', { ascending: false })
        .limit(5000)

      if (error) {
        logger.error('projectQueries.getTeamChatActivity', error, { channelIds })
        return []
      }
      return data || []
    } catch (error) {
      logger.error('projectQueries.getTeamChatActivity', error, { channelIds })
      return []
    }
  },

  /** Posts-this-week count across all of a project's team channels */
  async getProjectPostsThisWeek(supabase: SupabaseClient, projectId: string) {
    try {
      const { data: channels, error: chError } = await (supabase as any)
        .from('project_chat_channels')
        .select('id, project_teams!inner(project_id)')
        .eq('project_teams.project_id', projectId)
        .limit(500)

      if (chError || !channels?.length) return 0

      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
      const { count, error } = await (supabase as any)
        .from('project_chat_messages')
        .select('id', { count: 'exact', head: true })
        .in('channel_id', channels.map((c: { id: string }) => c.id))
        .eq('kind', 'user')
        .is('deleted_at', null)
        .gte('created_at', since)

      if (error) {
        logger.error('projectQueries.getProjectPostsThisWeek', error, { projectId })
        return 0
      }
      return count || 0
    } catch (error) {
      logger.error('projectQueries.getProjectPostsThisWeek', error, { projectId })
      return 0
    }
  },
}

// ═══════════════════════════════════════════════════════════════════════════════
// Intel Queries — Course Alumni Intelligence Panel
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Strip the author identity off anonymous intel rows before they leave the server.
 *
 * `is_anonymous` is only a display flag — the cards hide the name, but the joined
 * profile and `author_id` still ride along in the RSC payload, where any viewer can
 * read them in DevTools. That defeats the "hidden from others" promise the compose
 * UI makes, and on the professor-facing intel page it would let a professor identify
 * the students who reviewed them. The viewer's own rows keep their identity so the
 * edit/delete affordance (`isOwn`) keeps working.
 */
type IntelRow = { is_anonymous?: boolean; author_id?: string | null; [key: string]: unknown }

function redactAnonymousAuthors(rows: IntelRow[], viewerId: string): IntelRow[] {
  return (rows || []).map((row) =>
    row?.is_anonymous && row.author_id !== viewerId
      ? { ...row, author_id: null, author: null }
      : row
  )
}

export const intelQueries = {
  /** Resolve course_id from a section_id */
  async getCourseIdFromSection(supabase: SupabaseClient, sectionId: string): Promise<string | null> {
    try {
      const { data, error } = await (supabase as any)
        .from('course_sections')
        .select('course_id')
        .eq('id', sectionId)
        .single()
      if (error) {
        logger.error('intelQueries.getCourseIdFromSection', error, { sectionId })
        return null
      }
      return data?.course_id || null
    } catch (error) {
      logger.error('intelQueries.getCourseIdFromSection', error, { sectionId })
      return null
    }
  },

  /** Check if user has enrollment in any section of the course (alumni verification) */
  async verifyAlumniStatus(supabase: SupabaseClient, courseId: string, userId: string): Promise<boolean> {
    try {
      const { data, error } = await (supabase as any)
        .from('enrollments')
        .select('id, course_sections!inner(course_id)')
        .eq('student_id', userId)
        .in('status', ['active', 'completed', 'enrolled'])
        .eq('course_sections.course_id', courseId)
        .limit(1)

      if (error) {
        logger.error('intelQueries.verifyAlumniStatus', error, { courseId, userId })
        return false
      }
      return (data?.length || 0) > 0
    } catch (error) {
      logger.error('intelQueries.verifyAlumniStatus', error, { courseId, userId })
      return false
    }
  },

  /** Get all active reviews for a course with author profiles */

  async getReviews(supabase: SupabaseClient, courseId: string, viewerId: string): Promise<any[]> {
    try {
      const { data, error } = await (supabase as any)
        .from('course_reviews')
        .select(`
          *,
          author:profiles!course_reviews_author_id_fkey(id, name, avatar_url)
        `)
        .eq('course_id', courseId)
        .eq('status', 'active')
        .order('created_at', { ascending: false })

      if (error) {
        logger.error('intelQueries.getReviews', error, { courseId })
        return []
      }
      return redactAnonymousAuthors(data || [], viewerId)
    } catch (error) {
      logger.error('intelQueries.getReviews', error, { courseId })
      return []
    }
  },

  /** Get the current user's review for a course */

  async getUserReview(supabase: SupabaseClient, courseId: string, userId: string): Promise<any | null> {
    try {
      const { data, error } = await (supabase as any)
        .from('course_reviews')
        .select('*')
        .eq('course_id', courseId)
        .eq('author_id', userId)
        /* Soft-deleted rows are NOT the user's review (#733). getReviews already
           filtered status='active', so a deleted review vanished from the list while
           this lookup kept returning it — the page went on offering "Edit your
           review" for a review nobody could see, prefilled with the deleted content.
           'flagged' deliberately still counts: a moderated review must keep blocking
           a rewrite. */
        .neq('status', 'hidden')
        .maybeSingle()

      if (error) {
        logger.error('intelQueries.getUserReview', error, { courseId, userId })
        return null
      }
      return data
    } catch (error) {
      logger.error('intelQueries.getUserReview', error, { courseId, userId })
      return null
    }
  },

  /** Get aggregate review stats for a course */

  async getReviewStats(supabase: SupabaseClient, courseId: string): Promise<any> {
    try {
      const { data, error } = await (supabase as any)
        .from('course_reviews')
        .select('rating_overall, rating_difficulty, rating_workload, rating_teaching, rating_grading_fairness, would_take_again, grade_received, hours_per_week')
        .eq('course_id', courseId)
        .eq('status', 'active')

      if (error) {
        logger.error('intelQueries.getReviewStats', error, { courseId })
        return { count: 0, avgOverall: 0, avgDifficulty: 0, avgWorkload: 0, avgTeaching: 0, avgGrading: 0, wouldTakeAgainPct: 0, avgHoursPerWeek: 0, gradeDistribution: [] }
      }


      const reviews = (data || []) as any[]
      const count = reviews.length
      if (count === 0) {
        return { count: 0, avgOverall: 0, avgDifficulty: 0, avgWorkload: 0, avgTeaching: 0, avgGrading: 0, wouldTakeAgainPct: 0, avgHoursPerWeek: 0, gradeDistribution: [] }
      }


      const avg = (field: string) => reviews.reduce((sum: number, r: any) => sum + (r[field] || 0), 0) / count

      const wouldTakeAgainCount = reviews.filter((r: any) => r.would_take_again).length

      const hoursReviews = reviews.filter((r: any) => r.hours_per_week != null)

      const avgHours = hoursReviews.length > 0 ? hoursReviews.reduce((sum: number, r: any) => sum + r.hours_per_week, 0) / hoursReviews.length : 0

      const gradeCounts: Record<string, number> = {}

      reviews.forEach((r: any) => {
        if (r.grade_received) {
          gradeCounts[r.grade_received] = (gradeCounts[r.grade_received] || 0) + 1
        }
      })
      const gradeDistribution = Object.entries(gradeCounts)
        .map(([grade, gradeCount]) => ({ grade, count: gradeCount }))
        .sort((a, b) => {
          const order = ['A+','A','A-','B+','B','B-','C+','C','C-','D+','D','D-','F','W','P','NP','I']
          return order.indexOf(a.grade) - order.indexOf(b.grade)
        })

      return {
        count,
        avgOverall: Math.round(avg('rating_overall') * 10) / 10,
        avgDifficulty: Math.round(avg('rating_difficulty') * 10) / 10,
        avgWorkload: Math.round(avg('rating_workload') * 10) / 10,
        avgTeaching: Math.round(avg('rating_teaching') * 10) / 10,
        avgGrading: Math.round(avg('rating_grading_fairness') * 10) / 10,
        wouldTakeAgainPct: Math.round((wouldTakeAgainCount / count) * 100),
        avgHoursPerWeek: Math.round(avgHours * 10) / 10,
        gradeDistribution,
      }
    } catch (error) {
      logger.error('intelQueries.getReviewStats', error, { courseId })
      return { count: 0, avgOverall: 0, avgDifficulty: 0, avgWorkload: 0, avgTeaching: 0, avgGrading: 0, wouldTakeAgainPct: 0, avgHoursPerWeek: 0, gradeDistribution: [] }
    }
  },

  /** Get all active questions for a course with author profiles and answer counts */

  async getQuestions(supabase: SupabaseClient, courseId: string, viewerId: string): Promise<any[]> {
    try {
      const { data, error } = await (supabase as any)
        .from('course_questions')
        .select(`
          *,
          author:profiles!course_questions_author_id_fkey(id, name, avatar_url),
          answers:course_answers(
            *,
            author:profiles!course_answers_author_id_fkey(id, name, avatar_url),
            votes:course_answer_votes(id, user_id)
          )
        `)
        .eq('course_id', courseId)
        .eq('status', 'active')
        .order('created_at', { ascending: false })

      if (error) {
        logger.error('intelQueries.getQuestions', error, { courseId })
        return []
      }

      /* Answers ride along with the questions (#705). This used to select only
         `answers:course_answers(id)` for a count, so `loadedAnswers` was never
         populated and every answer in Course Intel was invisible — the UI even had a
         fallback reading "answers will appear on next page load", which never came
         true. Embedding them here keeps it one round trip instead of a per-question
         fetch.

         The status filter runs in JS, matching getQuestionWithAnswers: the .eq()
         above applies to course_questions, and nothing constrained the joined rows,
         so hidden and moderated answers were inflating the "Show N Answers" count —
         a question could offer three and expand to two (#741).

         Authors are redacted per answer as well as per question, since
         course_answers.is_anonymous is a real, populated flag. */
      const withAnswers = (data || []).map((q: any) => {
        const active = (q.answers || []).filter((a: any) => a.status === 'active')
        const loadedAnswers = redactAnonymousAuthors(active, viewerId)
          .map((a: any) => ({
            ...a,
            vote_count: a.votes?.length || 0,
            hasVoted: (a.votes || []).some((v: any) => v.user_id === viewerId),
            votes: undefined,
          }))
          .sort((a: any, b: any) => b.vote_count - a.vote_count)

        return { ...q, answer_count: loadedAnswers.length, loadedAnswers, answers: undefined }
      })

      return redactAnonymousAuthors(withAnswers, viewerId)
    } catch (error) {
      logger.error('intelQueries.getQuestions', error, { courseId })
      return []
    }
  },

  /** Get a single question with all its answers, profiles, and vote counts */

  /**
   * Currently unused. `viewerId` is REQUIRED anyway so that whoever wires up a Q&A
   * detail view cannot reintroduce the deanonymization the other intel getters just
   * closed — this returns both the question's author AND every answer's author, and
   * course_answers.is_anonymous is a real, populated flag.
   */
  async getQuestionWithAnswers(supabase: SupabaseClient, questionId: string, viewerId: string): Promise<any | null> {
    try {
      const { data, error } = await (supabase as any)
        .from('course_questions')
        .select(`
          *,
          author:profiles!course_questions_author_id_fkey(id, name, avatar_url),
          answers:course_answers(
            *,
            author:profiles!course_answers_author_id_fkey(id, name, avatar_url),
            votes:course_answer_votes(id)
          )
        `)
        .eq('id', questionId)
        .single()

      if (error) {
        logger.error('intelQueries.getQuestionWithAnswers', error, { questionId })
        return null
      }

      if (data?.answers) {
        data.answers = redactAnonymousAuthors(
          data.answers.filter((a: any) => a.status === 'active'),
          viewerId,
        )
          .map((a: any) => ({ ...a, vote_count: a.votes?.length || 0, votes: undefined }))
          .sort((a: any, b: any) => b.vote_count - a.vote_count)
      }

      return redactAnonymousAuthors([data], viewerId)[0] ?? null
    } catch (error) {
      logger.error('intelQueries.getQuestionWithAnswers', error, { questionId })
      return null
    }
  },

  /** Get answer IDs the user has voted on */
  async getAnswerVotes(supabase: SupabaseClient, answerIds: string[], userId: string): Promise<string[]> {
    try {
      if (answerIds.length === 0) return []
      const { data, error } = await (supabase as any)
        .from('course_answer_votes')
        .select('answer_id')
        .eq('user_id', userId)
        .in('answer_id', answerIds)

      if (error) {
        logger.error('intelQueries.getAnswerVotes', error, { userId })
        return []
      }

      return (data || []).map((v: any) => v.answer_id)
    } catch (error) {
      logger.error('intelQueries.getAnswerVotes', error, { userId })
      return []
    }
  },

  /** Get all active tips for a course with author profiles and vote counts */

  async getTips(supabase: SupabaseClient, courseId: string, viewerId: string): Promise<any[]> {
    try {
      const { data, error } = await (supabase as any)
        .from('course_tips')
        .select(`
          *,
          author:profiles!course_tips_author_id_fkey(id, name, avatar_url),
          votes:course_tip_votes(id)
        `)
        .eq('course_id', courseId)
        .eq('status', 'active')
        .order('created_at', { ascending: false })

      if (error) {
        logger.error('intelQueries.getTips', error, { courseId })
        return []
      }

      return redactAnonymousAuthors(data || [], viewerId)

        .map((tip: any) => ({ ...tip, vote_count: tip.votes?.length || 0, votes: undefined }))

        .sort((a: any, b: any) => b.vote_count - a.vote_count)
    } catch (error) {
      logger.error('intelQueries.getTips', error, { courseId })
      return []
    }
  },

  /** Get tip IDs the user has voted on for a course */
  async getTipVotes(supabase: SupabaseClient, courseId: string, userId: string): Promise<string[]> {
    try {
      const { data: tips } = await (supabase as any)
        .from('course_tips')
        .select('id')
        .eq('course_id', courseId)


      const tipIds = (tips || []).map((t: any) => t.id)
      if (tipIds.length === 0) return []

      const { data, error } = await (supabase as any)
        .from('course_tip_votes')
        .select('tip_id')
        .eq('user_id', userId)
        .in('tip_id', tipIds)

      if (error) {
        logger.error('intelQueries.getTipVotes', error, { courseId, userId })
        return []
      }

      return (data || []).map((v: any) => v.tip_id)
    } catch (error) {
      logger.error('intelQueries.getTipVotes', error, { courseId, userId })
      return []
    }
  },

  /** Get all active resources for a course */

  async getResources(supabase: SupabaseClient, courseId: string, viewerId: string): Promise<any[]> {
    try {
      const { data, error } = await (supabase as any)
        .from('course_resources')
        .select(`
          *,
          author:profiles!course_resources_author_id_fkey(id, name, avatar_url)
        `)
        .eq('course_id', courseId)
        .eq('status', 'active')
        .order('created_at', { ascending: false })

      if (error) {
        logger.error('intelQueries.getResources', error, { courseId })
        return []
      }

      /* Re-sign on read (#704). The stored `file_url` is the signed URL minted at UPLOAD
         time with a 1-hour TTL and never refreshed — so even a successful upload produced
         a permanently dead link an hour later. The path is the durable thing; the URL is
         not, and storing it was the mistake. Same signMany pattern the assignment and quiz
         surfaces already use. A path that fails to sign keeps its original value, so one
         bad object degrades to one broken link instead of blanking the tab. */
      const rows = (data || []) as Array<Record<string, unknown>>

      /* Only sign paths inside THIS course's folder. signMany uses the admin client and
         bypasses storage RLS by design, so an out-of-course path here would mint a working
         URL for another course's object. uploadResource now confines the path at write
         time; this is the second line, because a legacy or hand-edited row must not be
         able to mint one either. A row that fails the check keeps its stored file_url (now
         always empty for new uploads) and simply has no working link. */
      const prefix = `${courseId}/`
      const inCourse = (v: unknown): string | null =>
        typeof v === 'string' && v.startsWith(prefix) && !v.includes('..') ? v : null

      const signed = await signMany(
        COURSE_RESOURCES_BUCKET,
        rows.map((r) => inCourse(r.file_path)),
      )
      const withFreshUrls = rows.map((r) => {
        const path = inCourse(r.file_path)
        const fresh = path ? signed.get(path) : undefined
        return fresh ? { ...r, file_url: fresh } : r
      })

      return redactAnonymousAuthors(withFreshUrls, viewerId)
    } catch (error) {
      logger.error('intelQueries.getResources', error, { courseId })
      return []
    }
  },

  /** Get professor insights with author and professor profiles */

  async getProfessorInsights(supabase: SupabaseClient, courseId: string, viewerId: string): Promise<any[]> {
    try {
      const { data, error } = await (supabase as any)
        .from('course_professor_insights')
        .select(`
          *,
          author:profiles!course_professor_insights_author_id_fkey(id, name, avatar_url),
          professor:profiles!course_professor_insights_professor_id_fkey(id, name, avatar_url, email)
        `)
        .eq('course_id', courseId)
        .eq('status', 'active')
        .order('created_at', { ascending: false })

      if (error) {
        logger.error('intelQueries.getProfessorInsights', error, { courseId })
        return []
      }
      return redactAnonymousAuthors(data || [], viewerId)
    } catch (error) {
      logger.error('intelQueries.getProfessorInsights', error, { courseId })
      return []
    }
  },

  /** Get all professors who have taught any section of this course */

  async getCourseProfessors(supabase: SupabaseClient, courseId: string): Promise<any[]> {
    try {
      const { data, error } = await (supabase as any)
        .from('course_sections')
        .select('professor_id, professor:profiles!course_sections_professor_id_fkey(id, name, avatar_url, email)')
        .eq('course_id', courseId)

      if (error) {
        logger.error('intelQueries.getCourseProfessors', error, { courseId })
        return []
      }

      const seen = new Set<string>()
      return (data || [])
  
        .filter((s: any) => {
          if (seen.has(s.professor_id)) return false
          seen.add(s.professor_id)
          return true
        })
  
        .map((s: any) => s.professor)
    } catch (error) {
      logger.error('intelQueries.getCourseProfessors', error, { courseId })
      return []
    }
  },

  /** Get combined overview stats for a course */

  async getOverviewStats(supabase: SupabaseClient, courseId: string): Promise<any> {
    try {
      const [reviews, questions, tips, resources] = await Promise.all([
        (supabase as any).from('course_reviews').select('rating_overall, rating_difficulty, would_take_again').eq('course_id', courseId).eq('status', 'active'),
        (supabase as any).from('course_questions').select('id').eq('course_id', courseId).eq('status', 'active'),
        (supabase as any).from('course_tips').select('id').eq('course_id', courseId).eq('status', 'active'),
        (supabase as any).from('course_resources').select('id').eq('course_id', courseId).eq('status', 'active'),
      ])


      const reviewData = (reviews.data || []) as any[]
      const reviewCount = reviewData.length

      const avgOverall = reviewCount > 0 ? Math.round(reviewData.reduce((s: number, r: any) => s + r.rating_overall, 0) / reviewCount * 10) / 10 : 0

      const avgDifficulty = reviewCount > 0 ? Math.round(reviewData.reduce((s: number, r: any) => s + r.rating_difficulty, 0) / reviewCount * 10) / 10 : 0

      const wouldTakeAgainPct = reviewCount > 0 ? Math.round(reviewData.filter((r: any) => r.would_take_again).length / reviewCount * 100) : 0

      return {
        reviewCount,
        avgOverall,
        avgDifficulty,
        wouldTakeAgainPct,
        questionCount: questions.data?.length || 0,
        tipCount: tips.data?.length || 0,
        resourceCount: resources.data?.length || 0,
      }
    } catch (error) {
      logger.error('intelQueries.getOverviewStats', error, { courseId })
      return { reviewCount: 0, avgOverall: 0, avgDifficulty: 0, wouldTakeAgainPct: 0, questionCount: 0, tipCount: 0, resourceCount: 0 }
    }
  },
}

// ═══════════════════════════════════════════════════════════════
// Challenge Board Queries
// ═══════════════════════════════════════════════════════════════

export const challengeQueries = {
  /** All challenges for a section (professor view — all visibilities). */
  async getSectionChallenges(supabase: SupabaseClient, sectionId: string) {
    try {
      const { data, error } = await (supabase as any)
        .from('challenges')
        .select(
          '*, creator:profiles!challenges_created_by_fkey(id, name, avatar_url), badge:badges(id, name, icon),' +
            ' challenge_claims(id, status, claimed_at, reviewer_note,' +
            ' user_profile:profiles!challenge_claims_user_id_fkey(id, name, email, avatar_url),' +
            ' challenge_submissions(*))',
        )
        .eq('section_id', sectionId)
        .order('created_at', { ascending: false })

      if (error) {
        logger.error('challengeQueries.getSectionChallenges', error, { sectionId })
        return []
      }
      return data || []
    } catch (error) {
      logger.error('challengeQueries.getSectionChallenges', error, { sectionId })
      return []
    }
  },

  /** Published challenges for a section (student view). */
  async getPublishedChallenges(supabase: SupabaseClient, sectionId: string) {
    try {
      const { data, error } = await (supabase as any)
        .from('challenges')
        .select('*, badge:badges(id, name, icon), challenge_claims(id, status, user_id)')
        .eq('section_id', sectionId)
        .eq('visibility', 'published')
        .order('created_at', { ascending: false })

      if (error) {
        logger.error('challengeQueries.getPublishedChallenges', error, { sectionId })
        return []
      }
      return data || []
    } catch (error) {
      logger.error('challengeQueries.getPublishedChallenges', error, { sectionId })
      return []
    }
  },

  /** Single challenge detail. */
  async getChallengeDetail(supabase: SupabaseClient, challengeId: string) {
    try {
      const { data, error } = await (supabase as any)
        .from('challenges')
        .select('*, creator:profiles!challenges_created_by_fkey(id, name, avatar_url), badge:badges(id, name, icon, description)')
        .eq('id', challengeId)
        .single()

      if (error) {
        logger.error('challengeQueries.getChallengeDetail', error, { challengeId })
        return null
      }
      return data
    } catch (error) {
      logger.error('challengeQueries.getChallengeDetail', error, { challengeId })
      return null
    }
  },

  /** Get a student's claim for a challenge (or null). */
  async getStudentClaim(supabase: SupabaseClient, challengeId: string, userId: string) {
    try {
      const { data, error } = await (supabase as any)
        .from('challenge_claims')
        .select('*, challenge_submissions(*)')
        .eq('challenge_id', challengeId)
        .eq('user_id', userId)
        .maybeSingle()

      if (error) {
        logger.error('challengeQueries.getStudentClaim', error, { challengeId, userId })
        return null
      }
      return data
    } catch (error) {
      logger.error('challengeQueries.getStudentClaim', error, { challengeId, userId })
      return null
    }
  },

  /** All claims for a challenge with profiles and submissions (professor review). */
  async getChallengeClaims(supabase: SupabaseClient, challengeId: string) {
    try {
      const { data, error } = await (supabase as any)
        .from('challenge_claims')
        .select('*, user_profile:profiles!challenge_claims_user_id_fkey(id, name, email, avatar_url), challenge_submissions(*)')
        .eq('challenge_id', challengeId)
        .order('claimed_at', { ascending: false })

      if (error) {
        logger.error('challengeQueries.getChallengeClaims', error, { challengeId })
        return []
      }
      return data || []
    } catch (error) {
      logger.error('challengeQueries.getChallengeClaims', error, { challengeId })
      return []
    }
  },

  /** Student-proposed challenges awaiting approval. */
  async getProposedChallenges(supabase: SupabaseClient, sectionId: string) {
    try {
      const { data, error } = await (supabase as any)
        .from('challenges')
        .select('*, creator:profiles!challenges_created_by_fkey(id, name, avatar_url)')
        .eq('section_id', sectionId)
        .eq('source', 'student_proposed')
        .eq('visibility', 'draft')
        .order('created_at', { ascending: false })

      if (error) {
        logger.error('challengeQueries.getProposedChallenges', error, { sectionId })
        return []
      }
      return data || []
    } catch (error) {
      logger.error('challengeQueries.getProposedChallenges', error, { sectionId })
      return []
    }
  },

  /**
   * Leaderboard — top students by approved challenge count + total points.
   * MVP: fetches approved claims with challenge points and aggregates in JS.
   */
  async getLeaderboard(supabase: SupabaseClient, sectionId: string) {
    try {
      const { data, error } = await (supabase as any)
        .from('challenge_claims')
        .select('user_id, claimed_at, challenge:challenges!inner(id, points, bonus_points, section_id), user_profile:profiles!challenge_claims_user_id_fkey(id, name, avatar_url)')
        .eq('challenge.section_id', sectionId)
        .eq('status', 'approved')

      if (error) {
        logger.error('challengeQueries.getLeaderboard', error, { sectionId })
        return []
      }

      if (!data || data.length === 0) return []

      // Aggregate per user
      const userMap: Record<string, { userId: string; name: string; avatarUrl: string | null; count: number; totalPoints: number }> = {}
      for (const row of data) {
        const uid = row.user_id
        const profile = row.user_profile || {}
        const challenge = row.challenge || {}
        if (!userMap[uid]) {
          userMap[uid] = {
            userId: uid,
            name: profile.name || 'Unknown',
            avatarUrl: profile.avatar_url || null,
            count: 0,
            totalPoints: 0,
          }
        }
        userMap[uid].count += 1
        userMap[uid].totalPoints += (challenge.points || 0) + (challenge.bonus_points || 0)
      }

      return Object.values(userMap)
        .sort((a, b) => b.totalPoints - a.totalPoints || b.count - a.count)
        .slice(0, 20)
    } catch (error) {
      logger.error('challengeQueries.getLeaderboard', error, { sectionId })
      return []
    }
  },

  /** All badges for a section. */
  async getSectionBadges(supabase: SupabaseClient, sectionId: string) {
    try {
      const { data, error } = await (supabase as any)
        .from('badges')
        .select('*')
        .eq('section_id', sectionId)
        .order('created_at', { ascending: false })

      if (error) {
        logger.error('challengeQueries.getSectionBadges', error, { sectionId })
        return []
      }
      return data || []
    } catch (error) {
      logger.error('challengeQueries.getSectionBadges', error, { sectionId })
      return []
    }
  },

  /** User's awarded badges in a section. */
  async getUserBadges(supabase: SupabaseClient, sectionId: string, userId: string) {
    try {
      const { data, error } = await (supabase as any)
        .from('user_badges')
        .select('*, badge:badges(id, name, description, icon)')
        .eq('section_id', sectionId)
        .eq('user_id', userId)
        .order('awarded_at', { ascending: false })

      if (error) {
        logger.error('challengeQueries.getUserBadges', error, { sectionId, userId })
        return []
      }
      return data || []
    } catch (error) {
      logger.error('challengeQueries.getUserBadges', error, { sectionId, userId })
      return []
    }
  },

  /** Student's claims across all challenges in a section. */
  async getStudentClaims(supabase: SupabaseClient, sectionId: string, userId: string) {
    try {
      const { data, error } = await (supabase as any)
        .from('challenge_claims')
        .select('*, challenge:challenges!inner(id, title, points, bonus_points, section_id, difficulty, type), challenge_submissions(*)')
        .eq('challenge.section_id', sectionId)
        .eq('user_id', userId)
        .order('claimed_at', { ascending: false })

      if (error) {
        logger.error('challengeQueries.getStudentClaims', error, { sectionId, userId })
        return []
      }
      return data || []
    } catch (error) {
      logger.error('challengeQueries.getStudentClaims', error, { sectionId, userId })
      return []
    }
  },
}

// ═══════════════════════════════════════════════════════════════
// Certificate Queries (Slice B — challenge milestones)
// ═══════════════════════════════════════════════════════════════

export const certificateQueries = {
  /** All certificate templates for a section, with their challenge_ids and the
   *  count of students who've earned each (professor view). */
  async getSectionCertificates(supabase: SupabaseClient, sectionId: string) {
    try {

      const { data, error } = await (supabase as any)
        .from('certificates')
        .select('*, certificate_challenges(challenge_id), student_certificates(id)')
        .eq('section_id', sectionId)
        .order('created_at', { ascending: false })
      if (error) {
        logger.error('certificateQueries.getSectionCertificates', error, { sectionId })
        return []
      }

      return ((data ?? []) as any[]).map((c) => ({
        id: c.id as string,
        title: c.title as string,
        description: (c.description ?? '') as string,
        is_active: c.is_active as boolean,
        challenge_ids: ((c.certificate_challenges ?? []) as Array<{ challenge_id: string }>).map((r) => r.challenge_id),
        earned_count: ((c.student_certificates ?? []) as unknown[]).length,
      }))
    } catch (error) {
      logger.error('certificateQueries.getSectionCertificates', error, { sectionId })
      return []
    }
  },

  /** A student's earned certificates in a section (student view + celebration). */
  async getStudentCertificates(supabase: SupabaseClient, sectionId: string, userId: string) {
    try {

      const { data, error } = await (supabase as any)
        .from('student_certificates')
        .select('id, public_id, title, description, skills_snapshot, issued_at, seen_at, revoked_at')
        .eq('section_id', sectionId)
        .eq('student_id', userId)
        .is('revoked_at', null)
        .order('issued_at', { ascending: false })
      if (error) {
        logger.error('certificateQueries.getStudentCertificates', error, { sectionId, userId })
        return []
      }
      return data ?? []
    } catch (error) {
      logger.error('certificateQueries.getStudentCertificates', error, { sectionId, userId })
      return []
    }
  },

  /** Public certificate by its unguessable public_id — the ONLY read path for the
   *  public page. Returns a sanitized DTO (no email / internal ids / raw rows).
   *  Must be called with the admin client (no anon RLS policy by design). */
  async getPublicCertificate(supabase: SupabaseClient, publicId: string) {
    try {

      const { data, error } = await (supabase as any)
        .from('student_certificates')
        .select(
          'public_id, title, description, skills_snapshot, issued_at, revoked_at,' +
            ' student:profiles!student_certificates_student_id_fkey(name),' +
            ' institution:institutions!student_certificates_institution_id_fkey(name)',
        )
        .eq('public_id', publicId)
        .is('revoked_at', null)
        .maybeSingle()
      if (error || !data) return null

      const student = Array.isArray(data.student) ? data.student[0] : data.student
      const institution = Array.isArray(data.institution) ? data.institution[0] : data.institution
      return {
        publicId: data.public_id as string,
        title: data.title as string,
        description: (data.description ?? '') as string,
        skills: (Array.isArray(data.skills_snapshot) ? data.skills_snapshot : []) as string[],
        issuedAt: data.issued_at as string,
        studentName: (student?.name as string) || 'A student',
        institutionName: (institution?.name as string) || 'Scholera',
      }
    } catch (error) {
      logger.error('certificateQueries.getPublicCertificate', error, { publicId })
      return null
    }
  },
}

// ═══════════════════════════════════════════════════════════════
// Calendar & Office Hours Queries
// ═══════════════════════════════════════════════════════════════

export const calendarQueries = {
  /** All office hours for a professor (active + inactive). */
  async getOfficeHoursForProfessor(supabase: SupabaseClient, professorId: string) {
    try {
      const { data, error } = await supabase
        .from('office_hours')
        .select('*')
        .eq('professor_id', professorId)
        .order('day_of_week')
        .order('start_time')

      if (error) {
        logger.error('calendarQueries.getOfficeHoursForProfessor', error, { professorId })
        return []
      }
      return data || []
    } catch (error) {
      logger.error('calendarQueries.getOfficeHoursForProfessor', error, { professorId })
      return []
    }
  },

  /** All active office hours (for student browsing). */
  async getActiveOfficeHours(supabase: SupabaseClient) {
    try {
      const { data, error } = await supabase
        .from('office_hours')
        .select('*, professor:profiles!office_hours_professor_id_fkey(id, name, email, avatar_url)')
        .eq('is_active', true)
        .order('day_of_week')
        .order('start_time')

      if (error) {
        logger.error('calendarQueries.getActiveOfficeHours', error)
        return []
      }
      return data || []
    } catch (error) {
      logger.error('calendarQueries.getActiveOfficeHours', error)
      return []
    }
  },

  /** Active office hours held by one professor — the section-scoped read Athena
   *  needs for C10. The unscoped `getActiveOfficeHours` above is right for the
   *  student's browse page (they may see several courses' professors) and wrong
   *  for "book me in with the professor of THIS course". */
  async getActiveOfficeHoursForProfessor(supabase: SupabaseClient, professorId: string) {
    try {
      const { data, error } = await supabase
        .from('office_hours')
        .select('id, professor_id, title, day_of_week, start_time, end_time, meeting_type, is_active')
        .eq('professor_id', professorId)
        .eq('is_active', true)
        .order('day_of_week')
        .order('start_time')

      if (error) {
        logger.error('calendarQueries.getActiveOfficeHoursForProfessor', error, { professorId })
        return []
      }
      return data || []
    } catch (error) {
      logger.error('calendarQueries.getActiveOfficeHoursForProfessor', error, { professorId })
      return []
    }
  },

  /** Bookings for a professor, optionally filtered by date range. */
  async getBookingsForProfessor(supabase: SupabaseClient, professorId: string, dateRange?: { from: string; to: string }) {
    try {
      let query = supabase
        .from('bookings')
        .select('*, student:profiles!bookings_student_id_fkey(id, name, email, avatar_url)')
        .eq('professor_id', professorId)
        .order('date', { ascending: true })
        .order('start_time', { ascending: true })

      if (dateRange) {
        query = query.gte('date', dateRange.from).lte('date', dateRange.to)
      }

      const { data, error } = await query
      if (error) {
        logger.error('calendarQueries.getBookingsForProfessor', error, { professorId })
        return []
      }
      return data || []
    } catch (error) {
      logger.error('calendarQueries.getBookingsForProfessor', error, { professorId })
      return []
    }
  },

  /** Bookings for a student. */
  /**
   * Slot OCCUPANCY across all students, for the student-facing availability list.
   *
   * The student page loaded only the viewer's own bookings, so a slot a classmate had
   * already taken still rendered as available and inflated the "N slots" count. The student
   * only found out when the server refused the booking (#712). Office hours are scarce and
   * time-boxed, so that is wrong in the one direction that costs them.
   *
   * Deliberately projects NO student identity — just enough for the booked check in
   * generateSlotsForDateRange: which office-hours template, which date, which start time.
   * Who booked it is none of a classmate's business, and selecting it would leak the room's
   * roster through an availability list.
   */
  async getBookingOccupancy(supabase: SupabaseClient, officeHoursIds: string[]) {
    if (officeHoursIds.length === 0) return []
    try {
      const { data, error } = await supabase
        .from('bookings')
        .select('id, office_hours_id, date, start_time, status')
        .in('office_hours_id', officeHoursIds)
        .neq('status', 'cancelled')

      if (error) {
        logger.error('calendarQueries.getBookingOccupancy', error, { count: officeHoursIds.length })
        return []
      }
      return data || []
    } catch (error) {
      logger.error('calendarQueries.getBookingOccupancy', error, { count: officeHoursIds.length })
      return []
    }
  },

  async getBookingsForStudent(supabase: SupabaseClient, studentId: string) {
    try {
      const { data, error } = await supabase
        .from('bookings')
        .select('*, professor:profiles!bookings_professor_id_fkey(id, name, email, avatar_url), office_hour:office_hours(id, title, location, zoom_link)')
        .eq('student_id', studentId)
        .order('date', { ascending: true })
        .order('start_time', { ascending: true })

      if (error) {
        logger.error('calendarQueries.getBookingsForStudent', error, { studentId })
        return []
      }
      return data || []
    } catch (error) {
      logger.error('calendarQueries.getBookingsForStudent', error, { studentId })
      return []
    }
  },

  /** Blocked times for a professor, optionally filtered by date range. */
  async getBlockedTimesForProfessor(supabase: SupabaseClient, professorId: string, dateRange?: { from: string; to: string }) {
    try {
      let query = supabase
        .from('blocked_times')
        .select('*')
        .eq('professor_id', professorId)
        .order('date')
        .order('start_time')

      if (dateRange) {
        query = query.gte('date', dateRange.from).lte('date', dateRange.to)
      }

      const { data, error } = await query
      if (error) {
        logger.error('calendarQueries.getBlockedTimesForProfessor', error, { professorId })
        return []
      }
      return data || []
    } catch (error) {
      logger.error('calendarQueries.getBlockedTimesForProfessor', error, { professorId })
      return []
    }
  },

  /**
   * Note-free busy time ranges for a professor — used by the STUDENT office-hours page to
   * grey out slots that overlap the professor's commitments. Reads via the
   * `professor_busy_times` RPC (SECURITY DEFINER, gated to the professor + their enrolled
   * students) so a professor's blocked_times note/reason NEVER reach students; only the time
   * ranges are returned. Recurrence fields ride along so a recurring lecture blocks bookings
   * in every week it repeats. (The RPC isn't in the generated types yet — hence the cast.)
   */
  async getProfessorBusyTimes(supabase: SupabaseClient, professorId: string) {
    try {
      const { data, error } = await (
        supabase as unknown as {
          rpc: (
            fn: 'professor_busy_times',
            args: { p_professor_id: string },
          ) => Promise<{ data: unknown; error: unknown }>
        }
      ).rpc('professor_busy_times', { p_professor_id: professorId })
      if (error) {
        logger.error('calendarQueries.getProfessorBusyTimes', error, { professorId })
        return []
      }
      return (data ?? []) as Array<{
        date: string
        start_time: string
        end_time: string
        recurrence: string
        recurrence_until: string | null
      }>
    } catch (error) {
      logger.error('calendarQueries.getProfessorBusyTimes', error, { professorId })
      return []
    }
  },

  /** Get a user's active calendar token. */
  async getCalendarToken(supabase: SupabaseClient, userId: string) {
    try {
      const { data, error } = await supabase
        .from('calendar_tokens')
        .select('*')
        .eq('user_id', userId)
        .eq('is_active', true)
        .maybeSingle()

      if (error) {
        logger.error('calendarQueries.getCalendarToken', error, { userId })
        return null
      }
      return data
    } catch (error) {
      logger.error('calendarQueries.getCalendarToken', error, { userId })
      return null
    }
  },

  /** Look up a user by their calendar feed token (used in the feed API route). */
  async getUserByCalendarToken(supabase: SupabaseClient, token: string) {
    try {
      const { data, error } = await supabase
        .from('calendar_tokens')
        .select('*, user:profiles!calendar_tokens_user_id_fkey(id, name, email, role)')
        .eq('token', token)
        .eq('is_active', true)
        .maybeSingle()

      if (error) {
        logger.error('calendarQueries.getUserByCalendarToken', error)
        return null
      }
      return data
    } catch (error) {
      logger.error('calendarQueries.getUserByCalendarToken', error)
      return null
    }
  },
}

// ─── Feedback Queries ──────────────────────────────────────────────────────────

export const feedbackQueries = {
  /** Get all feedbacks with user profile info — admin use (pass admin client).
   *  institutionId is REQUIRED — feedbacks are tenant-scoped (Phase 2 hardening). */
  async getAllFeedbacks(
    supabase: SupabaseClient,
    institutionId: string,
    filters?: {
      status?: string
      category?: string
      role?: string
      limit?: number
      offset?: number
    },
  ) {
    try {
      let query = (supabase as any)
        .from('feedbacks')
        .select(`
          *,
          user:profiles!feedbacks_user_id_fkey(id, name, email, avatar_url)
        `)
        .eq('institution_id', institutionId)

      if (filters?.status) query = query.eq('status', filters.status)
      if (filters?.category) query = query.eq('category', filters.category)
      if (filters?.role) query = query.eq('user_role', filters.role)

      query = query.order('created_at', { ascending: false })

      if (filters?.limit) query = query.limit(filters.limit)
      if (filters?.offset) query = query.range(filters.offset, filters.offset + (filters.limit || 20) - 1)

      const { data, error } = await query

      if (error) {
        logger.error('feedbackQueries.getAllFeedbacks', error)
        return []
      }
      return data || []
    } catch (error) {
      logger.error('feedbackQueries.getAllFeedbacks', error)
      return []
    }
  },

  /** Get feedback stats for admin dashboard — counts by status and category.
   *  institutionId is REQUIRED to scope counts to a single tenant. */
  async getFeedbackStats(supabase: SupabaseClient, institutionId: string) {
    try {
      const t = (status?: string, category?: string) => {
        let q = supabase
          .from('feedbacks')
          .select('id', { count: 'exact', head: true })
          .eq('institution_id', institutionId)
        if (status) q = q.eq('status', status)
        if (category) q = q.eq('category', category)
        return q
      }
      const [total, newCount, reviewedCount, resolvedCount, dismissedCount] = await Promise.all([
        t(),
        t('new'),
        t('reviewed'),
        t('resolved'),
        t('dismissed'),
      ])

      const [bugCount, featureCount, contentCount, uxCount, generalCount] = await Promise.all([
        t(undefined, 'bug'),
        t(undefined, 'feature_request'),
        t(undefined, 'content_issue'),
        t(undefined, 'ux'),
        t(undefined, 'general'),
      ])

      return {
        total: total.count || 0,
        byStatus: {
          new: newCount.count || 0,
          reviewed: reviewedCount.count || 0,
          resolved: resolvedCount.count || 0,
          dismissed: dismissedCount.count || 0,
        },
        byCategory: {
          bug: bugCount.count || 0,
          feature_request: featureCount.count || 0,
          content_issue: contentCount.count || 0,
          ux: uxCount.count || 0,
          general: generalCount.count || 0,
        },
      }
    } catch (error) {
      logger.error('feedbackQueries.getFeedbackStats', error)
      return {
        total: 0,
        byStatus: { new: 0, reviewed: 0, resolved: 0, dismissed: 0 },
        byCategory: { bug: 0, feature_request: 0, content_issue: 0, ux: 0, general: 0 },
      }
    }
  },

  /** Get a single feedback by ID — admin use */
  async getFeedbackById(supabase: SupabaseClient, feedbackId: string) {
    try {
      const { data, error } = await (supabase as any)
        .from('feedbacks')
        .select(`
          *,
          user:profiles!feedbacks_user_id_fkey(id, name, email, avatar_url)
        `)
        .eq('id', feedbackId)
        .single()

      if (error) {
        logger.error('feedbackQueries.getFeedbackById', error, { feedbackId })
        return null
      }
      return data
    } catch (error) {
      logger.error('feedbackQueries.getFeedbackById', error, { feedbackId })
      return null
    }
  },
}

/* ══════════════════════════════════════════════════════════════════
 * SECTION STAFF (TAs + Graders)
 * ══════════════════════════════════════════════════════════════════ */
export const sectionStaffQueries = {
  /** Active staff assignments for a given section (TAs + graders). */
  async listActiveForSection(supabase: SupabaseClient, sectionId: string) {
    try {
      const { data, error } = await (supabase as any)
        .from('section_staff')
        .select(`
          *,
          staff:profiles!section_staff_staff_id_fkey(id, name, email, avatar_url, invite_status, onboarding_completed)
        `)
        .eq('section_id', sectionId)
        .eq('status', 'active')
        .gt('ends_at', new Date().toISOString())
        .order('role', { ascending: true })

      if (error) {
        logger.error('sectionStaffQueries.listActiveForSection', error, { sectionId })
        return []
      }
      return data || []
    } catch (error) {
      logger.error('sectionStaffQueries.listActiveForSection', error, { sectionId })
      return []
    }
  },

  /** Every assignment (active + ended + removed) for a section — admin audit view. */
  async listAllForSection(supabase: SupabaseClient, sectionId: string) {
    try {
      const { data, error } = await (supabase as any)
        .from('section_staff')
        .select(`
          *,
          staff:profiles!section_staff_staff_id_fkey(id, name, email, avatar_url, invite_status)
        `)
        .eq('section_id', sectionId)
        .order('created_at', { ascending: false })

      if (error) {
        logger.error('sectionStaffQueries.listAllForSection', error, { sectionId })
        return []
      }
      return data || []
    } catch (error) {
      logger.error('sectionStaffQueries.listAllForSection', error, { sectionId })
      return []
    }
  },

  /** All ACTIVE sections where the given user is staff, with course info. */
  async listActiveForStaff(supabase: SupabaseClient, staffId: string) {
    try {
      const { data, error } = await (supabase as any)
        .from('section_staff')
        .select(`
          *,
          section:course_sections(
            id, section_code, semester, year, start_date, end_date, status,
            course:courses(id, code, title),
            professor:profiles!course_sections_professor_id_fkey(id, name, email)
          )
        `)
        .eq('staff_id', staffId)
        .eq('status', 'active')
        .gt('ends_at', new Date().toISOString())
        .order('created_at', { ascending: false })

      if (error) {
        logger.error('sectionStaffQueries.listActiveForStaff', error, { staffId })
        return []
      }
      return data || []
    } catch (error) {
      logger.error('sectionStaffQueries.listActiveForStaff', error, { staffId })
      return []
    }
  },

  /** Does this user have active staff membership on the section (optionally with a specific role)? */
  async isActiveStaff(supabase: SupabaseClient, sectionId: string, staffId: string, role?: 'ta' | 'grader') {
    try {
      let query = (supabase as any)
        .from('section_staff')
        .select('id, role')
        .eq('section_id', sectionId)
        .eq('staff_id', staffId)
        .eq('status', 'active')
        .gt('ends_at', new Date().toISOString())

      if (role) query = query.eq('role', role)

      const { data, error } = await query.maybeSingle()
      if (error) {
        logger.error('sectionStaffQueries.isActiveStaff', error, { sectionId, staffId })
        return null
      }
      return data as { id: string; role: 'ta' | 'grader' } | null
    } catch (error) {
      logger.error('sectionStaffQueries.isActiveStaff', error, { sectionId, staffId })
      return null
    }
  },

  /** Every request the professor has submitted for a given section. */
  async listRequestsForSection(supabase: SupabaseClient, sectionId: string) {
    try {
      const { data, error } = await (supabase as any)
        .from('section_staff_requests')
        .select(`
          *,
          reviewer:profiles!section_staff_requests_reviewed_by_fkey(id, name)
        `)
        .eq('section_id', sectionId)
        .order('created_at', { ascending: false })

      if (error) {
        logger.error('sectionStaffQueries.listRequestsForSection', error, { sectionId })
        return []
      }
      return data || []
    } catch (error) {
      logger.error('sectionStaffQueries.listRequestsForSection', error, { sectionId })
      return []
    }
  },

  /** Admin directory: every staff assignment (active + ended + removed) with joined staff/section/course/department/professor.
   *  institutionId is REQUIRED — without it this leaks staff across tenants.
   *  Uses an inner join on course_sections so the .eq filter applies at the JOIN. */
  async listAllForAdmin(supabase: SupabaseClient, institutionId: string) {
    try {
      const { data, error } = await (supabase as any)
        .from('section_staff')
        .select(`
          id, role, status, starts_at, ends_at, created_at,
          staff:profiles!section_staff_staff_id_fkey(id, name, email, avatar_url, invite_status, onboarding_completed),
          section:course_sections!inner(
            id, section_code, semester, year, start_date, end_date, institution_id,
            course:courses(
              id, code, title,
              department:departments(id, name, code)
            ),
            professor:profiles!course_sections_professor_id_fkey(id, name, email)
          )
        `)
        .eq('section.institution_id', institutionId)
        .order('created_at', { ascending: false })

      if (error) {
        logger.error('sectionStaffQueries.listAllForAdmin', error)
        return []
      }
      return data || []
    } catch (error) {
      logger.error('sectionStaffQueries.listAllForAdmin', error)
      return []
    }
  },

  /** Count of active staff for a given tenant — dashboard stat.
   *  Uses the section_staff_with_institution view (which exposes institution_id
   *  via the section_id → course_sections chain). */
  async countActive(supabase: SupabaseClient, institutionId: string) {
    try {
      const { count, error } = await (supabase as any)
        .from('section_staff_with_institution')
        .select('id', { count: 'exact', head: true })
        .eq('institution_id', institutionId)
        .eq('status', 'active')
        .gt('ends_at', new Date().toISOString())

      if (error) {
        logger.error('sectionStaffQueries.countActive', error)
        return 0
      }
      return count || 0
    } catch (error) {
      logger.error('sectionStaffQueries.countActive', error)
      return 0
    }
  },

  /** Admin queue: pending requests for a tenant.
   *  institutionId is REQUIRED — uses inner-join filter on the section to enforce. */
  async listAllPendingRequests(supabase: SupabaseClient, institutionId: string) {
    try {
      const { data, error } = await (supabase as any)
        .from('section_staff_requests')
        .select(`
          *,
          requester:profiles!section_staff_requests_requested_by_fkey(id, name, email),
          section:course_sections!inner(
            id, section_code, semester, year, end_date, institution_id,
            course:courses(id, code, title)
          )
        `)
        .eq('section.institution_id', institutionId)
        .eq('status', 'pending')
        .order('created_at', { ascending: true })

      if (error) {
        logger.error('sectionStaffQueries.listAllPendingRequests', error)
        return []
      }
      return data || []
    } catch (error) {
      logger.error('sectionStaffQueries.listAllPendingRequests', error)
      return []
    }
  },

  /** Count of pending requests for a tenant — used on admin dashboard badge. */
  async countPending(supabase: SupabaseClient, institutionId: string) {
    try {
      const { count, error } = await (supabase as any)
        .from('section_staff_requests')
        .select('id, section:course_sections!inner(institution_id)', { count: 'exact', head: true })
        .eq('section.institution_id', institutionId)
        .eq('status', 'pending')

      if (error) {
        logger.error('sectionStaffQueries.countPending', error)
        return 0
      }
      return count || 0
    } catch (error) {
      logger.error('sectionStaffQueries.countPending', error)
      return 0
    }
  },

  /** Fetch one request by id (admin review dialog). */
  async getRequestById(supabase: SupabaseClient, requestId: string) {
    try {
      const { data, error } = await (supabase as any)
        .from('section_staff_requests')
        .select(`
          *,
          requester:profiles!section_staff_requests_requested_by_fkey(id, name, email),
          section:course_sections(
            id, section_code, semester, year, start_date, end_date,
            course:courses(id, code, title)
          )
        `)
        .eq('id', requestId)
        .single()

      if (error) {
        logger.error('sectionStaffQueries.getRequestById', error, { requestId })
        return null
      }
      return data
    } catch (error) {
      logger.error('sectionStaffQueries.getRequestById', error, { requestId })
      return null
    }
  },
}

// ────────────────────────────────────────────────────────────────────
// Live Classroom Queries — M1 PDF Sync
// ────────────────────────────────────────────────────────────────────

// Every lc_rooms column EXCEPT `lecture_summary` (the cached "Catch me up"
// recap). That column is revoked from anon/authenticated at the DB layer
// (migration 20260811143000_revoke_lc_rooms_lecture_summary_column), so an
// authenticated `select('*')` here would fail with 42501. These helpers run
// under the caller's client — often the cookie/authenticated one — and never
// need the summary (it is read only in summary/actions.ts via the service-role
// client). Keep in sync with the lc_rooms schema: a new student-readable column
// must be added here.
const LC_ROOM_COLUMNS =
  'id, section_id, prof_id, status, deck_url, deck_page_count, current_slide, ended_at, module_item_id, source_file_path, active_deck_id, name, lecture_summary_enabled, setup_completed, scheduled_at, recurrence_group_id, is_blanked, created_at'

export const liveClassroomQueries = {
  /**
   * The room's attendance join code (#82).
   *
   * Lives on its own table, not on lc_rooms, because students can read their own section's
   * lc_rooms row directly with their browser session; see the migration comment. This runs
   * under the CALLER's client, so lc_room_codes' professor-only policy is a second check
   * behind the ownership check the pages already do.
   *
   * Callers must already have verified the caller owns the room. Both do: the projector and
   * presenter pages check `room.prof_id === user.id` before rendering.
   */
  async getRoomJoinCode(supabase: SupabaseClient, roomId: string): Promise<string | null> {
    try {
      const { data, error } = await supabase
        .from('lc_room_codes')
        .select('code')
        .eq('room_id', roomId)
        .maybeSingle()
      if (error) {
        logger.error('liveClassroomQueries.getRoomJoinCode', error, { roomId })
        return null
      }
      return (data?.code as string | null) ?? null
    } catch (error) {
      logger.error('liveClassroomQueries.getRoomJoinCode', error, { roomId })
      return null
    }
  },

  /** Get a room by ID. Used by both professor (presenter) and student (viewer). */
  async getRoomById(supabase: SupabaseClient, roomId: string) {
    try {
      const { data, error } = await (supabase as any)
        .from('lc_rooms')
        .select(LC_ROOM_COLUMNS)
        .eq('id', roomId)
        .single()

      if (error) {
        logger.error('liveClassroomQueries.getRoomById', error, { roomId })
        return null
      }
      return data
    } catch (error) {
      logger.error('liveClassroomQueries.getRoomById', error, { roomId })
      return null
    }
  },

  /** Get the active (live) room for a section. Returns null if no live room. */
  async getActiveRoomForSection(supabase: SupabaseClient, sectionId: string) {
    try {
      const { data, error } = await (supabase as any)
        .from('lc_rooms')
        .select(LC_ROOM_COLUMNS)
        .eq('section_id', sectionId)
        .eq('status', 'live')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (error) {
        logger.error('liveClassroomQueries.getActiveRoomForSection', error, { sectionId })
        return null
      }
      return data
    } catch (error) {
      logger.error('liveClassroomQueries.getActiveRoomForSection', error, { sectionId })
      return null
    }
  },

  /** List all rooms for a section (for history view). */
  async listRoomsForSection(supabase: SupabaseClient, sectionId: string) {
    try {
      const { data, error } = await (supabase as any)
        .from('lc_rooms')
        .select(LC_ROOM_COLUMNS)
        .eq('section_id', sectionId)
        .order('created_at', { ascending: false })

      if (error) {
        logger.error('liveClassroomQueries.listRoomsForSection', error, { sectionId })
        return []
      }
      return data || []
    } catch (error) {
      logger.error('liveClassroomQueries.listRoomsForSection', error, { sectionId })
      return []
    }
  },

  /**
   * One page of a section's ended sessions for the Class Insights gallery,
   * newest first. Cancelled scheduled rooms (soft-ended, never started →
   * setup_completed false) are excluded — they carry no report.
   *
   * Filtering and paging happen in SQL: a section that runs a class twice a
   * week for a term must not read every session row to render ten. Counts
   * first so a stale or hand-typed `page` clamps to the last real page
   * instead of rendering an empty gallery.
   */
  async listEndedRoomsPage(
    supabase: SupabaseClient,
    sectionId: string,
    page: number,
    perPage: number,
  ): Promise<{ rooms: LcRoom[]; page: number; pageCount: number; total: number }> {
    const empty = { rooms: [] as LcRoom[], page: 1, pageCount: 1, total: 0 }
    try {
      const { count, error: countError } = await (supabase as any)
        .from('lc_rooms')
        .select('id', { count: 'exact', head: true })
        .eq('section_id', sectionId)
        .eq('status', 'ended')
        .eq('setup_completed', true)

      if (countError) {
        logger.error('liveClassroomQueries.listEndedRoomsPage', countError, { sectionId })
        return empty
      }

      const total = count ?? 0
      if (total === 0) return empty

      const pageCount = Math.max(1, Math.ceil(total / perPage))
      const safePage = Math.min(Math.max(1, Math.trunc(page) || 1), pageCount)
      const from = (safePage - 1) * perPage

      const { data, error } = await (supabase as any)
        .from('lc_rooms')
        .select('*')
        .eq('section_id', sectionId)
        .eq('status', 'ended')
        .eq('setup_completed', true)
        .order('created_at', { ascending: false })
        .range(from, from + perPage - 1)

      if (error) {
        logger.error('liveClassroomQueries.listEndedRoomsPage', error, { sectionId, safePage })
        return empty
      }
      return { rooms: (data ?? []) as LcRoom[], page: safePage, pageCount, total }
    } catch (error) {
      logger.error('liveClassroomQueries.listEndedRoomsPage', error, { sectionId })
      return empty
    }
  },

  /**
   * Upcoming scheduled sessions for a section's "Upcoming" list, ordered by
   * start time. Each carries a derived `slidesState` for the badge:
   *   'none'       — no deck (recurring, or a one-off with no upload yet)
   *   'processing' — deck uploaded, render still running
   *   'ready'      — deck rendered (deck_url set)
   *   'failed'     — deck uploaded but its background render failed
   * Three bounded queries stitched in JS (no per-room round-trips).
   */
  async getUpcomingScheduledRooms(
    supabase: SupabaseClient,
    sectionId: string,
  ): Promise<
    Array<{
      id: string
      name: string | null
      scheduledAt: string | null
      recurrenceGroupId: string | null
      isRecurring: boolean
      slidesState: 'none' | 'processing' | 'ready' | 'failed'
    }>
  > {
    try {
      const { data: rooms, error } = await (supabase as any)
        .from('lc_rooms')
        .select('id, name, scheduled_at, recurrence_group_id')
        .eq('section_id', sectionId)
        .eq('status', 'scheduled')
        .order('scheduled_at', { ascending: true })

      if (error) {
        logger.error('liveClassroomQueries.getUpcomingScheduledRooms', error, { sectionId })
        return []
      }
      const roomRows = (rooms ?? []) as Array<{
        id: string
        name: string | null
        scheduled_at: string | null
        recurrence_group_id: string | null
      }>
      if (roomRows.length === 0) return []

      const roomIds = roomRows.map((r) => r.id)

      // Decks for these rooms (readiness = deck_url present).
      const { data: decks } = await (supabase as any)
        .from('lc_decks')
        .select('room_id, deck_url')
        .in('room_id', roomIds)
      const roomsWithDeck = new Set<string>()
      const roomsReady = new Set<string>()
      for (const d of (decks ?? []) as Array<{ room_id: string; deck_url: string | null }>) {
        roomsWithDeck.add(d.room_id)
        if (d.deck_url) roomsReady.add(d.room_id)
      }

      // Failed render jobs for this section (to distinguish 'failed' from
      // 'processing'). Bounded to this section + job type.
      const { data: jobs } = await (supabase as any)
        .from('background_jobs')
        .select('params, status')
        .eq('type', 'render_scheduled_deck')
        .eq('section_id', sectionId)
        .eq('status', 'failed')
      const failedRooms = new Set<string>()
      for (const j of (jobs ?? []) as Array<{ params: { roomId?: string } | null }>) {
        if (j.params?.roomId) failedRooms.add(j.params.roomId)
      }

      return roomRows.map((r) => {
        // Precedence: ready → processing → failed → none. A failed render deletes
        // its deck row (so a re-upload gets a clean slate) but leaves the failed
        // job. Checking `processing` (deck present) BEFORE `failed` means a
        // re-upload shows "processing", not a stale "failed"; a failure with no
        // re-upload (no deck) still falls through to `failed`.
        let slidesState: 'none' | 'processing' | 'ready' | 'failed'
        if (roomsReady.has(r.id)) slidesState = 'ready'
        else if (roomsWithDeck.has(r.id)) slidesState = 'processing'
        else if (failedRooms.has(r.id)) slidesState = 'failed'
        else slidesState = 'none'
        return {
          id: r.id,
          name: r.name,
          scheduledAt: r.scheduled_at,
          recurrenceGroupId: r.recurrence_group_id,
          isRecurring: r.recurrence_group_id != null,
          slidesState,
        }
      })
    } catch (error) {
      logger.error('liveClassroomQueries.getUpcomingScheduledRooms', error, { sectionId })
      return []
    }
  },

  /**
   * IDs of the given rooms that have a completed session report (for the
   * "Report ready" badge in the Reports gallery). RLS limits rows to the
   * caller's own rooms; 'generating' placeholders don't count as ready.
   */
  async getReportedRoomIds(supabase: SupabaseClient, roomIds: string[]): Promise<Set<string>> {
    if (roomIds.length === 0) return new Set()
    try {
      const { data, error } = await (supabase as any)
        .from('lc_session_reports')
        .select('room_id, status:report->>status')
        .in('room_id', roomIds)

      if (error) {
        logger.error('liveClassroomQueries.getReportedRoomIds', error)
        return new Set()
      }
      return new Set(
        ((data || []) as Array<{ room_id: string; status: string | null }>)
          .filter((r) => r.status !== 'generating')
          .map((r) => r.room_id),
      )
    } catch (error) {
      logger.error('liveClassroomQueries.getReportedRoomIds', error)
      return new Set()
    }
  },

  /** Get stale rooms (live > 12h) for cleanup. Uses admin client. */
  async getStaleRoomsForSection(adminDb: any, sectionId: string, thresholdMs: number) {
    try {
      const cutoff = new Date(Date.now() - thresholdMs).toISOString()
      const { data, error } = await adminDb
        .from('lc_rooms')
        .select('id, deck_url')
        .eq('section_id', sectionId)
        .eq('status', 'live')
        .lt('created_at', cutoff)

      if (error) {
        logger.error('liveClassroomQueries.getStaleRoomsForSection', error, { sectionId })
        return []
      }
      return data || []
    } catch (error) {
      logger.error('liveClassroomQueries.getStaleRoomsForSection', error, { sectionId })
      return []
    }
  },

  /**
   * Replay buffer reader. Returns lc_events for a room with seq > lastSeq,
   * ordered ascending. Caller must use the admin client because lc_events
   * has no client SELECT policy by design — authorization happens in the
   * server action that wraps this query (`getEventsSince` in replay.ts).
   */
  async getEventsSince(adminDb: any, roomId: string, lastSeq: number, limit = 500) {
    try {
      const { data, error } = await adminDb
        .from('lc_events')
        .select('seq, event_type, payload, created_at')
        .eq('room_id', roomId)
        .gt('seq', lastSeq)
        .order('seq', { ascending: true })
        .limit(limit)

      if (error) {
        logger.error('liveClassroomQueries.getEventsSince', error, { roomId, lastSeq })
        return []
      }
      return data || []
    } catch (error) {
      logger.error('liveClassroomQueries.getEventsSince', error, { roomId, lastSeq })
      return []
    }
  },

  /**
   * Closed quizzes across a section's rooms, newest first (for the quiz
   * history surfaces). RLS-scoped: students see only enrolled-section rooms,
   * professors only their own. Returns the full payload (questions + report);
   * the caller decides what to expose per role.
   */
  async getClosedQuizzesForSection(supabase: SupabaseClient, sectionId: string) {
    try {
      const { data: rooms, error: roomErr } = await (supabase as any)
        .from('lc_rooms')
        .select('id')
        .eq('section_id', sectionId)
      if (roomErr) {
        logger.error('liveClassroomQueries.getClosedQuizzesForSection', roomErr, { sectionId })
        return []
      }
      const roomIds = (rooms || []).map((r: { id: string }) => r.id)
      if (roomIds.length === 0) return []

      const { data, error } = await (supabase as any)
        .from('lc_interactions')
        .select('id, room_id, payload, closed_at')
        .in('room_id', roomIds)
        .eq('kind', 'quiz')
        .eq('status', 'closed')
        .order('closed_at', { ascending: false })
      if (error) {
        logger.error('liveClassroomQueries.getClosedQuizzesForSection', error, { sectionId })
        return []
      }
      return (data || []) as Array<{
        id: string
        room_id: string
        payload: Record<string, unknown>
        closed_at: string | null
      }>
    } catch (error) {
      logger.error('liveClassroomQueries.getClosedQuizzesForSection', error, { sectionId })
      return []
    }
  },

  /** A student's own responses for a set of interactions (history review). */
  async getMyResponsesForInteractions(
    supabase: SupabaseClient,
    interactionIds: string[],
    studentId: string,
  ) {
    try {
      if (interactionIds.length === 0) return []
      const { data, error } = await (supabase as any)
        .from('lc_responses')
        .select('interaction_id, response')
        .in('interaction_id', interactionIds)
        .eq('student_id', studentId)
      if (error) {
        logger.error('liveClassroomQueries.getMyResponsesForInteractions', error, { studentId })
        return []
      }
      return (data || []) as Array<{ interaction_id: string; response: Record<string, unknown> }>
    } catch (error) {
      logger.error('liveClassroomQueries.getMyResponsesForInteractions', error, { studentId })
      return []
    }
  },
}

/**
 * Institution Queries — read operations for the super_admin tier.
 *
 * Tables: institutions, profiles
 *
 * The list view counts institution_admin profiles per row so the UI can flag
 * institutions that don't yet have an admin assigned (Stevens is currently in
 * this state — its only admin was migrated to the Dev tenant).
 */
export const institutionQueries = {
  /**
   * Fetch every institution with profile counts (total + admin count).
   * Reads from the `institutions_with_counts` view which aggregates in SQL —
   * scales fine even once tenants have thousands of users (vs the previous
   * pattern of pulling all profiles into JS and aggregating in a Map).
   */
  async getAllWithCounts(adminDb: any) {
    try {
      const { data, error } = await adminDb
        .from('institutions_with_counts')
        .select('*')
        .order('created_at', { ascending: true })

      if (error) {
        logger.error('institutionQueries.getAllWithCounts', error)
        return []
      }
      return data || []
    } catch (error) {
      logger.error('institutionQueries.getAllWithCounts', error)
      return []
    }
  },

  /** Fetch users belonging to an institution, grouped by role. */
  async getUsersByInstitution(adminDb: any, institutionId: string) {
    try {
      const { data, error } = await adminDb
        .from('profiles')
        .select('id, email, name, role, invite_status, last_login_at, created_at')
        .eq('institution_id', institutionId)
        .order('role')
        .order('email')

      if (error) {
        logger.error('institutionQueries.getUsersByInstitution', error, { institutionId })
        return []
      }
      return data || []
    } catch (error) {
      logger.error('institutionQueries.getUsersByInstitution', error, { institutionId })
      return []
    }
  },

  /** Fetch one institution by id. */
  async getById(adminDb: any, id: string) {
    try {
      const { data, error } = await adminDb
        .from('institutions')
        .select('*')
        .eq('id', id)
        .single()

      if (error) {
        if (error.code !== 'PGRST116') {
          logger.error('institutionQueries.getById', error, { id })
        }
        return null
      }
      return data
    } catch (error) {
      logger.error('institutionQueries.getById', error, { id })
      return null
    }
  },

  /** Fetch one institution by slug — used for uniqueness checks before insert. */
  async getBySlug(adminDb: any, slug: string) {
    try {
      const { data, error } = await adminDb
        .from('institutions')
        .select('*')
        .eq('slug', slug)
        .maybeSingle()

      if (error) {
        logger.error('institutionQueries.getBySlug', error, { slug })
        return null
      }
      return data
    } catch (error) {
      logger.error('institutionQueries.getBySlug', error, { slug })
      return null
    }
  },
}

/**
 * assignmentQueries: reads for the Assignment Studio (assignments +
 * assignment_submissions). Pass the RLS-bound client for self-scoped reads,
 * or the admin client (after verifySectionAccess) for staff-wide reads.
 */
export const assignmentQueries = {
  /**
   * AI-vs-professor agreement for one assignment's committed grades (calibration flywheel).
   * Reads assignment_grading_corrections (criterion-level diffs captured at grade commit).
   * Four parallel head-counts, no row transfer. Safe fallback: all zeros.
   */
  async getAiAgreementStats(supabase: SupabaseClient, assignmentId: string) {
    const zero = { total: 0, agreed: 0, aiHigher: 0, aiLower: 0 }
    try {
      const base = () =>
        supabase
          .from('assignment_grading_corrections')
          .select('id', { count: 'exact', head: true })
          .eq('assignment_id', assignmentId)
      const [total, agreed, aiHigher, aiLower] = await Promise.all([
        base(),
        base().eq('agreed', true),
        base().eq('ai_tick', true).eq('professor_tick', false),
        base().eq('ai_tick', false).eq('professor_tick', true),
      ])
      for (const [name, res] of [
        ['total', total],
        ['agreed', agreed],
        ['aiHigher', aiHigher],
        ['aiLower', aiLower],
      ] as const) {
        if (res.error) {
          logger.error('assignmentQueries.getAiAgreementStats', res.error, { assignmentId, query: name })
          return zero
        }
      }
      return {
        total: total.count || 0,
        agreed: agreed.count || 0,
        aiHigher: aiHigher.count || 0,
        aiLower: aiLower.count || 0,
      }
    } catch (error) {
      logger.error('assignmentQueries.getAiAgreementStats', error, { assignmentId })
      return zero
    }
  },

  /** All assignments in a section, newest first. */
  async listSectionAssignments(supabase: SupabaseClient, sectionId: string) {
    try {
      const { data, error } = await supabase
        .from('assignments')
        .select('id, section_id, title, description, status, points, due_at, settings, created_at, is_graded, scheduled_publish_at')
        .eq('section_id', sectionId)
        .order('created_at', { ascending: false })
      if (error) {
        logger.error('assignmentQueries.listSectionAssignments', error, { sectionId })
        return []
      }
      return data ?? []
    } catch (error) {
      logger.error('assignmentQueries.listSectionAssignments', error, { sectionId })
      return []
    }
  },

  /** Studio/verbal assignments the given user authored, newest first — their template history.
   *  RLS-scoped: pass the request client so it only returns rows in sections they can access. */
  async listAuthoredAssignments(supabase: SupabaseClient, userId: string) {
    try {
      const { data, error } = await supabase
        .from('assignments')
        .select('id, title, settings, created_at, section_id')
        .eq('created_by', userId)
        .order('created_at', { ascending: false })
        .limit(60)
      if (error) {
        logger.error('assignmentQueries.listAuthoredAssignments', error, { userId })
        return []
      }
      return data ?? []
    } catch (error) {
      logger.error('assignmentQueries.listAuthoredAssignments', error, { userId })
      return []
    }
  },

  /** Template ids the user has saved in the marketplace (RLS scopes to the caller). */
  async listSavedTemplateIds(supabase: SupabaseClient, userId: string): Promise<string[]> {
    try {
      const { data, error } = await supabase
        .from('saved_templates')
        .select('template_id')
        .eq('user_id', userId)
      if (error) {
        logger.error('assignmentQueries.listSavedTemplateIds', error, { userId })
        return []
      }
      return (data ?? []).map((r) => r.template_id)
    } catch (error) {
      logger.error('assignmentQueries.listSavedTemplateIds', error, { userId })
      return []
    }
  },

  /** A single assignment by id (caller verifies access). */
  async getAssignment(supabase: SupabaseClient, assignmentId: string) {
    try {
      const { data, error } = await supabase
        .from('assignments')
        .select('id, section_id, institution_id, title, description, status, points, due_at, settings, created_at, is_graded, scheduled_publish_at')
        .eq('id', assignmentId)
        .maybeSingle()
      if (error) {
        logger.error('assignmentQueries.getAssignment', error, { assignmentId })
        return null
      }
      return data
    } catch (error) {
      logger.error('assignmentQueries.getAssignment', error, { assignmentId })
      return null
    }
  },

  /** All submissions for an assignment (staff view). */
  async listSubmissions(supabase: SupabaseClient, assignmentId: string) {
    try {
      const { data, error } = await supabase
        .from('assignment_submissions')
        .select(
          'id, assignment_id, student_id, status, text_content, files, answers, score, feedback, submitted_at, graded_at, updated_at, rubric_scores, graded_with_rubric, rubric_comments, proctoring_summary, resubmit_until, late_request_at',
        )
        .eq('assignment_id', assignmentId)
      if (error) {
        logger.error('assignmentQueries.listSubmissions', error, { assignmentId })
        return []
      }
      return data ?? []
    } catch (error) {
      logger.error('assignmentQueries.listSubmissions', error, { assignmentId })
      return []
    }
  },

  /** A single student's submission for an assignment, or null. */
  async getStudentSubmission(
    supabase: SupabaseClient,
    assignmentId: string,
    studentId: string,
  ) {
    try {
      const { data, error } = await supabase
        .from('assignment_submissions')
        .select(
          'id, assignment_id, student_id, status, text_content, files, score, feedback, submitted_at, graded_at, rubric_scores, rubric_comments, assessment_started_at, assessment_work_ended_at, resubmit_until, late_request_at',
        )
        .eq('assignment_id', assignmentId)
        .eq('student_id', studentId)
        .maybeSingle()
      if (error) {
        logger.error('assignmentQueries.getStudentSubmission', error, { assignmentId, studentId })
        return null
      }
      return data
    } catch (error) {
      logger.error('assignmentQueries.getStudentSubmission', error, { assignmentId, studentId })
      return null
    }
  },

  /** A student's submissions across a set of assignments (for list status pills). */
  async listStudentSubmissions(
    supabase: SupabaseClient,
    assignmentIds: string[],
    studentId: string,
  ) {
    if (assignmentIds.length === 0) return []
    try {
      const { data, error } = await supabase
        .from('assignment_submissions')
        // assessment_started_at / assessment_work_ended_at drive the assessment-window state on the
        // list (a closed window is terminal regardless of the assignment's own due date).
        .select('id, assignment_id, student_id, status, files, score, submitted_at, graded_at, resubmit_until, late_request_at, assessment_started_at, assessment_work_ended_at')
        .in('assignment_id', assignmentIds)
        .eq('student_id', studentId)
      if (error) {
        logger.error('assignmentQueries.listStudentSubmissions', error, { studentId })
        return []
      }
      return data ?? []
    } catch (error) {
      logger.error('assignmentQueries.listStudentSubmissions', error, { studentId })
      return []
    }
  },

  /** A student's regrade requests for one submission (user-scoped client; RLS enforces own-rows). */
  async getStudentRegradeRequests(supabase: SupabaseClient, submissionId: string) {
    try {
      const { data, error } = await supabase
        .from('assignment_regrade_requests')
        .select(
          'id, submission_id, questions, reason, status, old_score, new_score, resolution_note, resolved_at, created_at',
        )
        .eq('submission_id', submissionId)
        .order('created_at', { ascending: false })
        .limit(20)
      if (error) {
        logger.error('assignmentQueries.getStudentRegradeRequests', error, { submissionId })
        return []
      }
      return data ?? []
    } catch (error) {
      logger.error('assignmentQueries.getStudentRegradeRequests', error, { submissionId })
      return []
    }
  },

  /** All regrade requests for an assignment (staff grading queue; admin client after access check). */
  async listRegradeRequests(supabase: SupabaseClient, assignmentId: string) {
    try {
      const { data, error } = await supabase
        .from('assignment_regrade_requests')
        .select(
          'id, submission_id, student_id, questions, reason, status, old_score, new_score, resolution_note, resolved_at, created_at',
        )
        .eq('assignment_id', assignmentId)
        .order('created_at', { ascending: false })
        .limit(500)
      if (error) {
        logger.error('assignmentQueries.listRegradeRequests', error, { assignmentId })
        return []
      }
      return data ?? []
    } catch (error) {
      logger.error('assignmentQueries.listRegradeRequests', error, { assignmentId })
      return []
    }
  },

  /** Comments on one submission, oldest first, with the author's name. Shared by both roles. */
  async listSubmissionComments(supabase: SupabaseClient, submissionId: string) {
    try {
      const { data, error } = await supabase
        .from('assignment_submission_comments')
        .select(
          'id, submission_id, question_index, question_label, author_id, author_role, body, created_at, author:profiles(name)',
        )
        .eq('submission_id', submissionId)
        .order('created_at', { ascending: true })
        .limit(500)
      if (error) {
        logger.error('assignmentQueries.listSubmissionComments', error, { submissionId })
        return []
      }
      return data ?? []
    } catch (error) {
      logger.error('assignmentQueries.listSubmissionComments', error, { submissionId })
      return []
    }
  },

  /** Comments across a set of submissions in one query (professor grader — avoids N+1). */
  async listSubmissionCommentsFor(supabase: SupabaseClient, submissionIds: string[]) {
    if (submissionIds.length === 0) return []
    try {
      const { data, error } = await supabase
        .from('assignment_submission_comments')
        .select(
          'id, submission_id, question_index, question_label, author_id, author_role, body, created_at, author:profiles(name)',
        )
        .in('submission_id', submissionIds)
        .order('created_at', { ascending: true })
        .limit(2000)
      if (error) {
        logger.error('assignmentQueries.listSubmissionCommentsFor', error)
        return []
      }
      return data ?? []
    } catch (error) {
      logger.error('assignmentQueries.listSubmissionCommentsFor', error)
      return []
    }
  },
}

/**
 * Topic Mastery — reads for the per-section topic hierarchy (Slice 1).
 * RLS scopes visibility (professors/TAs manage their section's topics).
 * Cast to `any` because the `topics` table isn't in the generated types until
 * the migration is applied; drop the cast after `types.ts` is regenerated.
 */
/** One row of the student dashboard's "Focus areas" card (#287). */
export interface StudentFocusSkill {
  skillId: string
  name: string
  /** The student's rolled-up score for this main skill. Never null here — a skill
   *  with no data is dropped rather than shown as 0%. */
  score: number
  sectionId: string
  courseCode: string
  /** False when the professor has turned the roadmap off for this section, in which
   *  case the row must render unlinked rather than into a notFound(). */
  roadmapEnabled: boolean
  /** Points changed since the trend baseline, or null when there is no old-enough
   *  snapshot to compare against. */
  delta: number | null
}

export interface StudentFocusResult {
  skills: StudentFocusSkill[]
  /** True when the student HAS scored topics — needed because an empty `skills` means
   *  two different things: nothing assessed yet, or everything already strong. The
   *  card must not congratulate a student who has simply not been marked yet. */
  hasAnyMastery: boolean
}

/** Every failure path returns this, so a caller can't accidentally read a failure as
 *  "all topics mastered". */
const EMPTY_FOCUS: StudentFocusResult = { skills: [], hasAnyMastery: false }

export const skillQueries = {
  /** All topics for a section, flat. Shape with buildSkillTree() for rendering. */
  async listSectionSkills(
    supabase: SupabaseClient,
    sectionId: string,
  ): Promise<SkillRow[]> {
    try {
      // `topics` isn't in the generated types until the migration is applied.
      const db = supabase as any
      /* NOT paged, unlike getSectionMasteryRows below — deliberately. That table
         holds one row per (student, skill) and genuinely crosses PostgREST's
         silent 1000-row cap on a ~90-student course; this one holds a section's
         topics only, and the largest tree in prod is ~526 rows. Paging it would
         add a round trip to student chat paths for a ceiling nothing is near.
         Revisit if a section ever approaches 1000 topics. */
      const { data, error } = await db
        .from('skills')
        .select(
          'id, section_id, institution_id, parent_id, name, info, source, placement_pinned, excluded, suppressed, library_skill_id, position, created_at, updated_at',
        )
        .eq('section_id', sectionId)
        .order('position', { ascending: true })

      if (error) {
        logger.error('skillQueries.listSectionSkills', error, { sectionId })
        return []
      }
      return (data ?? []) as SkillRow[]
    } catch (error) {
      logger.error('skillQueries.listSectionSkills', error, { sectionId })
      return []
    }
  },

  /** All per-(student, subtopic) mastery for a section, for class aggregation.
   *
   *  Paged rather than a bare select: these rows feed a median/mean computed
   *  across the WHOLE class, so PostgREST's silent 1000-row cap would not weaken
   *  the number — it would make it wrong, with nothing in the response saying so.
   *  Sections run ~10+ mastery rows per student, so a ~90-student course already
   *  crosses the cap. */
  async getSectionMasteryRows(supabase: SupabaseClient, sectionId: string): Promise<MasteryDatum[]> {
    try {

      const db = supabase as any
      // `id` is selected as well as ordered on: paging needs a UNIQUE, stable
      // sort key or rows repeat/skip across page boundaries, and every other
      // column here has duplicates (many rows per student, many per skill).
      const rows = await readAllPages<unknown>(
        () =>
          db
            .from('skill_mastery')
            .select('id, student_id, skill_id, score, state')
            .eq('section_id', sectionId),
        'id',
        'skillQueries.getSectionMasteryRows',
      )
      return rows.map(mapMasteryRow)
    } catch (error) {
      logger.error('skillQueries.getSectionMasteryRows', error, { sectionId })
      return []
    }
  },

  /** One student's mastery in a section. The section-wide read above computes
   *  every student's map to serve one of them, which is fine for a class
   *  aggregate and wasteful for a per-student question — use this one there. */
  async getStudentMasteryRows(
    supabase: SupabaseClient,
    sectionId: string,
    studentId: string,
  ): Promise<MasteryDatum[]> {
    try {

      const db = supabase as any
      const { data, error } = await db
        .from('skill_mastery')
        .select('student_id, skill_id, score, state')
        .eq('section_id', sectionId)
        .eq('student_id', studentId)
      if (error) {
        logger.error('skillQueries.getStudentMasteryRows', error, { sectionId, studentId })
        return []
      }

      return (data ?? []).map(mapMasteryRow)
    } catch (error) {
      logger.error('skillQueries.getStudentMasteryRows', error, { sectionId, studentId })
      return []
    }
  },

  /**
   * The student's weakest topics across EVERY section they are enrolled in — the
   * student dashboard's "Focus areas" card (#287).
   *
   * Every other mastery reader in this file is section-scoped; this is the only
   * cross-section one, which is why it does its own enrollment read rather than
   * taking section ids. It needs `settings` and the course code anyway, and
   * `courseQueries.getStudentEnrollments` selects neither.
   *
   * Composed from existing parts rather than a hand-rolled ranking:
   *  - `aggregateStudentMastery` does the main-skill roll-up, and crucially pools a
   *    parent's OWN row with its children's (#330) — a quiz tag matching a parent
   *    writes mastery to the parent, not down to its subtopics.
   *  - `excluded` / `suppressed` skills are dropped before aggregating, matching
   *    every other reader: professor-dropped and uncorroborated skills are not
   *    things to tell a student to go work on.
   *
   * MUST be called with the ADMIN client. `skill_mastery` has a "students read
   * their own" policy, but `skills` has NO student policy at all — so under the
   * anon client the name join silently returns null and every row loses its label
   * with no error to notice.
   *
   * Not paged: this is one student across their own sections, which is nowhere
   * near PostgREST's 1000-row cap. The class-wide reader above IS paged, because
   * there a truncated page makes the number wrong rather than merely short.
   */
  async getStudentFocusSkills(
    supabase: SupabaseClient,
    studentId: string,
    limit = 3,
  ): Promise<StudentFocusResult> {
    try {
       
      const db = supabase as any

      const { data: enrollments, error: enrollErr } = await db
        .from('enrollments')
        .select('section_id, course_sections!inner(id, settings, courses!inner(code))')
        .eq('student_id', studentId)
        .eq('status', 'enrolled')
      if (enrollErr) {
        logger.error('skillQueries.getStudentFocusSkills enrollments', enrollErr, { studentId })
        return EMPTY_FOCUS
      }

      interface SectionMeta { courseCode: string; roadmapEnabled: boolean }
      const meta = new Map<string, SectionMeta>()
       
      for (const e of (enrollments ?? []) as any[]) {
        const section = resolveJoin(e.course_sections)
        if (!section?.id) continue
        const course = resolveJoin(section.courses)
        const features = Array.isArray(section.settings?.enabledFeatures)
          ? (section.settings.enabledFeatures as string[])
          : []
        meta.set(section.id, {
          courseCode: course?.code ?? '',
          // Gate the link here: the student roadmap page calls verifyFeatureEnabled
          // and notFound()s when a professor has switched it off.
          roadmapEnabled: features.includes('roadmap'),
        })
      }
      const sectionIds = [...meta.keys()]
      if (sectionIds.length === 0) return EMPTY_FOCUS

      const [skillsRes, masteryRes] = await Promise.all([
        db
          .from('skills')
          .select('id, section_id, institution_id, parent_id, name, info, source, placement_pinned, excluded, suppressed, library_skill_id, position, created_at, updated_at')
          .in('section_id', sectionIds),
        db
          .from('skill_mastery')
          .select('student_id, skill_id, section_id, score, state')
          .eq('student_id', studentId)
          .in('section_id', sectionIds),
      ])
      if (skillsRes.error || masteryRes.error) {
        logger.error(
          'skillQueries.getStudentFocusSkills read',
          skillsRes.error ?? masteryRes.error,
          { studentId },
        )
        return EMPTY_FOCUS
      }

      const skillsBySection = new Map<string, SkillRow[]>()
      for (const row of (skillsRes.data ?? []) as SkillRow[]) {
        if (row.excluded || row.suppressed) continue
        const list = skillsBySection.get(row.section_id) ?? []
        list.push(row)
        skillsBySection.set(row.section_id, list)
      }

      const masteryBySection = new Map<string, MasteryDatum[]>()
       
      for (const row of (masteryRes.data ?? []) as any[]) {
        const list = masteryBySection.get(row.section_id) ?? []
        list.push(mapMasteryRow(row))
        masteryBySection.set(row.section_id, list)
      }

      const candidates: StudentFocusSkill[] = []
      let hasAnyMastery = false
      for (const [sectionId, skills] of skillsBySection) {
        const rolled = aggregateStudentMastery(skills, masteryBySection.get(sectionId) ?? [])
        for (const skill of rolled) {
          // A null score is "not assessed yet", NOT zero — surfacing it would tell a
          // student to work on something nobody has measured.
          if (skill.classScore == null) continue
          // Counted BEFORE the strong filter: a student whose topics are all mastered
          // has mastery, and deserves "nothing needs attention" rather than "no data".
          hasAnyMastery = true
          if (skill.classScore >= MASTERY_THRESHOLDS.strong) continue
          candidates.push({
            skillId: skill.skillId,
            name: skill.name,
            score: skill.classScore,
            sectionId,
            courseCode: meta.get(sectionId)?.courseCode ?? '',
            roadmapEnabled: meta.get(sectionId)?.roadmapEnabled ?? false,
            delta: null,
          })
        }
      }

      candidates.sort((a, b) => (a.score ?? 0) - (b.score ?? 0))
      const top = candidates.slice(0, limit)
      if (top.length === 0) return { skills: top, hasAnyMastery }

      /* Trend, only for the sections the chosen few actually came from — usually one
         or two. getOwnMasteryTrend runs several reads per section, so widening this
         to every enrolled section would put a lot of latency on a landing page for a
         number that decorates three rows. */
      const trendSections = [...new Set(top.map((t) => t.sectionId))]
      const trends = await Promise.all(
        trendSections.map((id) => getOwnMasteryTrend(supabase, id, studentId)),
      )
      const deltaByKey = new Map<string, number>()
      trendSections.forEach((id, i) => {
        for (const t of trends[i]) deltaByKey.set(`${id}:${t.skillName}`, t.to - t.from)
      })
      for (const row of top) {
        // Absent when there is no old-enough baseline. Left null rather than 0, so the
        // card can omit the delta instead of claiming no change.
        row.delta = deltaByKey.get(`${row.sectionId}:${row.name}`) ?? null
      }
      return { skills: top, hasAnyMastery }
    } catch (error) {
      logger.error('skillQueries.getStudentFocusSkills', error, { studentId })
      return EMPTY_FOCUS
    }
  },

  /** Whether the section has any uploaded modules (drives the "review topics" banner). */
  async sectionHasMaterials(supabase: SupabaseClient, sectionId: string): Promise<boolean> {
    try {
      const db = supabase as unknown as {
        from: (t: string) => {
          select: (c: string, o: { count: 'exact'; head: true }) => {
            eq: (k: string, v: string) => Promise<{ count: number | null }>
          }
        }
      }
      const { count } = await db.from('modules').select('id', { count: 'exact', head: true }).eq('section_id', sectionId)
      return (count ?? 0) > 0
    } catch (error) {
      logger.error('skillQueries.sectionHasMaterials', error, { sectionId })
      return false
    }
  },

  /** The section's mappable activities (quizzes + assignments) for Activity Mapping.
   *  Reads via the admin client: quizzes/assignments have RLS enabled but no
   *  user SELECT policy (they're admin-read + app-authz). Callers must already
   *  be gated to the section (the professor route layout does this). */
  /**
   * Every activity in a section, for mapping topics onto assessments.
   *
   * `publishedOnly` is for STUDENT-facing callers: without it the list carries
   * drafts, so an unreleased quiz or assignment leaks its title (and its id) to
   * whatever renders the result — e.g. the roadmap modal's "Assessed by
   * <title>" row naming a retake the student is not meant to know about yet.
   * Staff callers omit it and see everything.
   */
  async listSectionActivities(
    sectionId: string,
    opts?: { publishedOnly?: boolean },
  ): Promise<Array<{ id: string; type: ActivityType | 'live_quiz'; title: string }>> {
    try {

      const db = createAdminClient() as any
      const pub = opts?.publishedOnly === true
      let quizQuery = db.from('quizzes').select('id, title').eq('section_id', sectionId)
      if (pub) quizQuery = quizQuery.eq('status', 'published')
      let assignmentQuery = db.from('assignments').select('id, title').eq('section_id', sectionId)
      // 'closed' = past due, still readable by the student (matches the
      // assignments table's own policy); 'scheduled'/'archived' stay hidden.
      if (pub) assignmentQuery = assignmentQuery.in('status', ['published', 'closed'])
      // Live-classroom quizzes (lc_interactions kind='quiz', joined via room).
      // A live quiz has no "published" — 'closed' is the point at which it is
      // over and students may see it, matching the table's own RLS policy.
      let liveQuizQuery = db.from('lc_interactions').select('id, payload, lc_rooms!inner(section_id)').eq('kind', 'quiz').eq('lc_rooms.section_id', sectionId)
      if (pub) liveQuizQuery = liveQuizQuery.eq('status', 'closed')
      const [quizzes, assignments, liveQuizzes] = await Promise.all([
        quizQuery,
        assignmentQuery,
        liveQuizQuery,
      ])
      const q = ((quizzes.data ?? []) as Array<{ id: string; title: string | null }>).map((r) => ({
        id: r.id,
        type: 'quiz' as ActivityType | 'live_quiz',
        title: r.title || 'Untitled quiz',
      }))
      const a = ((assignments.data ?? []) as Array<{ id: string; title: string | null }>).map((r) => ({
        id: r.id,
        type: 'assignment' as ActivityType | 'live_quiz',
        title: r.title || 'Untitled assignment',
      }))
      const lq = ((liveQuizzes.data ?? []) as Array<{ id: string; payload: { title?: string } | null }>).map((r) => ({
        id: r.id,
        type: 'live_quiz' as ActivityType | 'live_quiz',
        title: r.payload?.title || 'Live quiz',
      }))
      return [...q, ...a, ...lq]
    } catch (error) {
      logger.error('skillQueries.listSectionActivities', error, { sectionId })
      return []
    }
  },

  /** All activity→topic mappings in a section (grouped client-side per activity). */
  async getSectionActivitySkills(
    supabase: SupabaseClient,
    sectionId: string,
  ): Promise<ActivitySkillRow[]> {
    try {
       
      const db = supabase as any
      const { data, error } = await db
        .from('activity_skills')
        .select('id, section_id, activity_id, activity_type, skill_id')
        .eq('section_id', sectionId)
      if (error) {
        logger.error('skillQueries.getSectionActivitySkills', error, { sectionId })
        return []
      }
      return (data ?? []) as ActivitySkillRow[]
    } catch (error) {
      logger.error('skillQueries.getSectionActivitySkills', error, { sectionId })
      return []
    }
  },

  /** Enrolled students (id + display name) for drill-down distributions. */
  async getSectionRoster(
    supabase: SupabaseClient,
    sectionId: string,
  ): Promise<Array<{ id: string; name: string }>> {
    try {
       
      const db = supabase as any
      const { data, error } = await db
        .from('enrollments')
        .select('student_id, profiles(name)')
        .eq('section_id', sectionId)
        .eq('status', 'enrolled')
      if (error) {
        logger.error('skillQueries.getSectionRoster', error, { sectionId })
        return []
      }
       
      return (data ?? []).map((r: any) => {
        const p = Array.isArray(r.profiles) ? r.profiles[0] : r.profiles
        return { id: r.student_id as string, name: (p?.name as string) || 'Student' }
      })
    } catch (error) {
      logger.error('skillQueries.getSectionRoster', error, { sectionId })
      return []
    }
  },
}

 
function mapMasteryRow(r: any): MasteryDatum {
  const score = r.score == null ? null : Number(r.score)
  const n = typeof r.state?.n === 'number' ? r.state.n : score != null ? 1 : 0
  const w = typeof r.state?.w === 'number' ? r.state.w : null
  return { student_id: r.student_id, skill_id: r.skill_id, score, n, w }
}

// ── Roadmap triage signals — the "free data" the annotation engine needs that
//    the roadmap DTO doesn't carry (due dates, submission tallies). Deadlines
//    and grading state; everything else the engine derives from data the page
//    already fetches. All safe-fallback (never throw). ──────────────────────
export type AssignmentSubmissionTally = {
  draft: number
  submitted: number
  graded: number
  returned: number
  /**
   * Students who actually handed something in — rows with a `submitted_at`.
   *
   * Deliberately NOT derived from `status`: `finalize_overdue_assignments`
   * (pg_cron, every 15 min, mig 20260617044419) inserts a `graded`-0 row for every
   * enrolled non-submitter the moment a deadline passes, so counting `submitted +
   * graded + returned` reports the whole roster as having turned in, and "missing"
   * read as enrolled − turned-in is permanently zero 15 minutes after any due date.
   * A submission timestamp is only ever written by the student's own submit action
   * (`status: 'submitted'` always sets it, and a re-opened 'returned' row keeps
   * it), so its presence is the one honest test of "this person handed work in".
   */
  handedIn: number
}

export const roadmapSignalQueries = {
  /** Section assignments with due dates + per-assignment submission tallies by
   *  status. `enrolled` lets the caller compute missing = enrolled − turned-in.
   *
   *  Assignments only, on purpose: every quiz table (`quizzes`, `quiz_attempts`,
   *  …) is RLS-deny-all, so a section-scoped client reads zero rows from them. The
   *  quiz side of these signals comes from `getProfessorAggregates`, which
   *  verifies section ownership and then uses the admin client. */
  async getProfessorActivitySignals(
    supabase: SupabaseClient,
    sectionId: string,
  ): Promise<{
    assignments: Array<{ id: string; title: string; status: string; dueAt: string | null }>
    tallies: Record<string, AssignmentSubmissionTally>
    enrolled: number
  }> {
    const empty = { assignments: [], tallies: {}, enrolled: 0 }
    try {
      const [aRes, roster] = await Promise.all([
        supabase.from('assignments').select('id, title, status, due_at').eq('section_id', sectionId),
        skillQueries.getSectionRoster(supabase, sectionId),
      ])
      const assignments = (aRes.data ?? []).map((a: any) => ({
        id: a.id as string, title: a.title as string, status: a.status as string, dueAt: (a.due_at as string) ?? null,
      }))
      const tallies: Record<string, AssignmentSubmissionTally> = {}
      const ids = assignments.map((a) => a.id)
      if (ids.length) {
        /* No section_id on assignment_submissions — scope through assignment ids,
           and through the roster too: `enrolled` counts only `status='enrolled'`
           students, so a row from anyone else (dropped, or an 'active'/'completed'
           enrollment the auto-zero cron also writes for) would be counted against a
           denominator it isn't part of, and "N didn't turn this in" would report
           fewer than the truth. Same population on both sides of the subtraction. */
        const { data: subs } = await supabase
          .from('assignment_submissions')
          .select('assignment_id, status, submitted_at')
          .in('assignment_id', ids)
          .in('student_id', roster.map((r) => r.id))
        for (const s of (subs ?? []) as any[]) {
          const t = (tallies[s.assignment_id] ??= {
            draft: 0, submitted: 0, graded: 0, returned: 0, handedIn: 0,
          })
          if (s.status in t) (t as any)[s.status]++
          if (s.submitted_at) t.handedIn++
        }
      }
      return { assignments, tallies, enrolled: roster.length }
    } catch (error) {
      logger.error('roadmapSignalQueries.getProfessorActivitySignals', error, { sectionId })
      return empty
    }
  },
}
