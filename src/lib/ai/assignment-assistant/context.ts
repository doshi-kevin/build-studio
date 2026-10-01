/**
 * Context loaders for the assignment-scoped Athena.
 *
 * Design (per the "just-in-time context" principle): the ALWAYS-ON prompt stays
 * small — course + modules + professor voice come from the shared
 * loadAssistantContext. The DEEP, situational context lives behind read-only
 * tools that the model calls only when relevant:
 *
 *  - loadClassStruggles → the differentiator. Class-level concept gaps from the
 *    course's curated topic mastery (the authoritative, semester-cumulative
 *    axis), plus the most recent live-class quiz + published-quiz performance,
 *    so Athena can ground a remediation assignment in what the class ACTUALLY
 *    struggled with. The three are kept separate rather than merged: topic
 *    mastery is slow-moving and course-wide, the live-class report is what
 *    happened in one session, and neither subsumes the other (folding live
 *    quizzes into mastery is itself a per-section config flag).
 *    FERPA guard: returns CONCEPT-LEVEL aggregates ONLY — never any student name
 *    (we deliberately drop loadCourseSnapshot.atRiskStudents and the live
 *    report's nonResponders here; individual data has no place in a brainstorm).
 *
 *  - loadGradeContext → small, always-relevant context for the grade surface:
 *    the assignment's own instructions + its rubric DIMENSION names, so drafted
 *    feedback speaks to the real task. Rubric POINTS/tiers are intentionally
 *    omitted so the model can't infer a grade from them.
 *
 * Server-only. Callers pass the admin client AFTER verifying section access; the
 * section id is the security boundary (loaders never accept a client-chosen id
 * without the route having verified it).
 */

import 'server-only'
import { logger } from '@/lib/logger'
import { parseRubric } from '@/lib/validations/assignment'
import { fence } from '@/lib/ai/prompt-fence'
import { fetchGradingScheme } from '@/lib/grades/fetch'
import { assignmentQueries, calendarQueries, sectionStaffQueries } from '@/lib/supabase/queries'
import {
  loadCourseSnapshot,
  loadLiveClassReport,
  loadTopicMastery,
  type TopicMasteryDigest,
} from '@/lib/ai/professor-assistant/context'
import type { AthenaLimitScope } from '@/lib/ai/professor-assistant/models'
import { getModulesWithExtraction } from '@/app/(dashboard)/professor/courses/[sectionId]/quizzes/actions'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminDb = any

export interface ClassStruggles {
  /** Class standing on the course's CURATED topics — the authoritative, semester-
   *  cumulative axis. Listed first because it is the signal a remediation
   *  assignment should target; the two below are narrower and more recent. */
  topicMastery: TopicMasteryDigest
  liveClass:
    | { found: false; note: string }
    | {
        found: true
        overallAccuracy?: number
        weakestConcepts: string[]
        concepts: { concept: string; correctRate: number }[]
      }
  quizGaps: {
    classAverage: number | null
    quizzes: { title: string; avgScore: number; belowPass: number; attempts: number }[]
  }
}

/**
 * Class-level struggle signals for grounding a remediation assignment. Reuses the
 * existing (section-scoped, read-only) loaders and strips every per-student name
 * before returning — the brainstorm context must be blind to individuals (FERPA).
 */
export async function loadClassStruggles(adminDb: AdminDb, sectionId: string): Promise<ClassStruggles> {
  const [report, snapshot, topicMastery] = await Promise.all([
    loadLiveClassReport(adminDb, sectionId),
    loadCourseSnapshot(adminDb, sectionId),
    loadTopicMastery(adminDb, sectionId),
  ])

  // Every free-text field in this payload is fenced, not just the topic names:
  // concept labels and quiz titles are authored by professors and by the AI
  // extraction pipeline exactly as topic names are, and they land in the same
  // prompt. Fencing one and not its neighbours makes the rule a coin-flip.
  const liveClass: ClassStruggles['liveClass'] = report.found
    ? {
        found: true,
        overallAccuracy: report.overallAccuracy,
        weakestConcepts: (report.weakestConcepts ?? []).map((c) => fence(c, 120)),
        // Concept-level only; nonResponders (names) deliberately excluded.
        concepts: (report.concepts ?? []).map((c) => ({
          concept: fence(c.concept, 120),
          correctRate: c.correctRate,
        })),
      }
    : { found: false, note: report.note ?? 'No live-class quiz report yet.' }

  return {
    topicMastery,
    liveClass,
    quizGaps: {
      classAverage: snapshot.classAverage,
      // quizPerformance is already aggregate (no names); atRiskStudents dropped.
      quizzes: snapshot.quizPerformance.map((q) => ({
        title: fence(q.title, 120),
        avgScore: q.avgScore,
        belowPass: q.belowPass,
        attempts: q.attempts,
      })),
    },
  }
}

export interface QuizSourceModules {
  modules: {
    id: string
    title: string
    files: { id: string; title: string; fileType: string; pages: number; ready: boolean }[]
  }[]
  totals: { modules: number; readyFiles: number; pages: number }
  /** Files uploaded but still being extracted — they cannot be generated from yet. */
  pendingFiles: number
  note?: string
}

/**
 * The course's lecture material as GENERATION SOURCES: module + file titles and ids only,
 * never the lecture text itself (that stays server-side inside the generation pipeline,
 * which has its own 400k-char budget). This is what lets Athena turn "module 1" into a
 * real id without ever carrying the content in its context window.
 *
 * `getModulesWithExtraction` returns only files whose extraction COMPLETED — so every
 * file it yields is `ready`. We add a separate count of still-extracting items so Athena
 * can say "two files are still processing" instead of silently pretending they don't exist.
 */
export async function loadQuizSourceModules(
  adminDb: AdminDb,
  sectionId: string,
): Promise<QuizSourceModules> {
  const empty: QuizSourceModules = {
    modules: [],
    totals: { modules: 0, readyFiles: 0, pages: 0 },
    pendingFiles: 0,
  }

  const [{ data: groups, error }, pendingFiles] = await Promise.all([
    getModulesWithExtraction(sectionId),
    countPendingExtractions(adminDb, sectionId),
  ])
  if (error) return { ...empty, pendingFiles, note: 'Could not load the course modules.' }

  const modules = groups.map((g) => ({
    id: g.id,
    title: g.title,
    files: g.files.map((f) => ({
      id: f.id,
      title: f.title,
      fileType: f.fileType,
      pages: f.pageCount,
      ready: true,
    })),
  }))
  const readyFiles = modules.reduce((n, m) => n + m.files.length, 0)
  const pages = modules.reduce((n, m) => n + m.files.reduce((p, f) => p + f.pages, 0), 0)

  return {
    modules,
    totals: { modules: modules.length, readyFiles, pages },
    pendingFiles,
    note: readyFiles
      ? undefined
      : pendingFiles
        ? 'Nothing is ready to generate from yet — the uploaded files are still being processed.'
        : 'This course has no lecture files with extracted text yet, so there is nothing to generate from.',
  }
}

/** How many module items are uploaded but not yet extractable. Best-effort: a failure
 *  here just reports 0 rather than breaking the tool.
 *
 *  Projects the ONE value it reads out of the JSONB rather than selecting `content` —
 *  that column holds the whole extraction payload (pages, tables, figures), megabytes per
 *  row on a real course, and the model can call list_modules every turn. The explicit
 *  limit keeps it off PostgREST's implicit 1000-row cap, which would silently undercount. */
async function countPendingExtractions(adminDb: AdminDb, sectionId: string): Promise<number> {
  try {
    const { data } = await adminDb
      .from('module_items')
      .select('status:content->extraction->>status, modules!inner(section_id)')
      .eq('modules.section_id', sectionId)
      .limit(2000)
    if (!data) return 0
    return (data as { status?: string | null }[]).filter(
      (row) => !!row.status && row.status !== 'completed' && row.status !== 'failed',
    ).length
  } catch (err) {
    logger.error('countPendingExtractions: failed', err, { sectionId })
    return 0
  }
}

export interface AboutCourseData {
  assignments: { title: string; points: number; status: string; dueAt: string | null }[]
  quizzes: { title: string; status: string; dueDate: string | null }[]
  modules: { title: string; published: boolean }[]
  grading:
    | { configured: true; categories: { name: string; weightPercent: number; itemCount: number }[]; weightsSumTo: number }
    | { configured: false; note: string }
  officeHours: { day: string; start: string; end: string; location: string }[]
  staff: { name: string; role: string }[]
  section: { semester: string; courseCode: string; courseTitle: string; credits: number | null }
}


/**
 * The REAL course, for the About surface: what actually exists (assignments,
 * quizzes and their due dates, modules, the grading scheme's category weights,
 * the professor's office hours, current staff, the section's own facts) — so
 * Athena can derive the weekly schedule from reality and diff the page against
 * it. Aggregate/metadata only, never any student data. Every professor-authored
 * free-text string is fenced before it lands in the prompt.
 */
export async function loadAboutCourseData(adminDb: AdminDb, sectionId: string): Promise<AboutCourseData> {
  // The section row first — it carries the professor id the office-hours read needs.
  const { data: section } = await adminDb
    .from('course_sections')
    .select('professor_id, semester, year, course:courses(code, title, credits)')
    .eq('id', sectionId)
    .maybeSingle()
  const course = Array.isArray(section?.course) ? section?.course[0] : section?.course

  // allSettled, not all: a drift check reads six independent sources, and one of
  // them throwing (fetchGradingScheme has no internal catch) must not blank out the
  // other five — losing all course context breaks schedule derivation AND drift on
  // an unrelated failure. Each source degrades to its own empty fallback.
  const settled = await Promise.allSettled([
    assignmentQueries.listSectionAssignments(adminDb, sectionId),
    adminDb
      .from('quizzes')
      .select('title, status, due_date')
      .eq('section_id', sectionId)
      .order('due_date', { ascending: true })
      .limit(100),
    adminDb
      .from('modules')
      .select('title, is_published')
      .eq('section_id', sectionId)
      .order('position', { ascending: true })
      .limit(100),
    fetchGradingScheme(adminDb, sectionId),
    section?.professor_id
      ? calendarQueries.getOfficeHoursForProfessor(adminDb, section.professor_id)
      : Promise.resolve([]),
    sectionStaffQueries.listActiveForSection(adminDb, sectionId),
  ])
  const val = <T,>(i: number, fallback: T): T => {
    const r = settled[i]
    if (r.status === 'fulfilled') return r.value as T
    logger.error('loadAboutCourseData: a source failed', r.reason, { sectionId, source: i })
    return fallback
  }
  const assignments = val<{ title: string; points: number; status: string; due_at: string | null }[]>(0, [])
  const quizzesRes = val<{ data: unknown }>(1, { data: [] })
  const modulesRes = val<{ data: unknown }>(2, { data: [] })
  const scheme = val<Awaited<ReturnType<typeof fetchGradingScheme>>>(3, null)
  const officeHours = val<{ day_of_week: string; start_time: string; end_time: string; location?: string | null }[]>(4, [])
  const staffRows = val<{ role: string; staff?: { name?: string | null } | { name?: string | null }[] }[]>(5, [])

  const weights = (scheme?.categories ?? []).map((c) => c.weight)
  return {
    assignments: (assignments ?? []).slice(0, 100).map(
      (a: { title: string; points: number; status: string; due_at: string | null }) => ({
        title: fence(a.title, 200),
        points: a.points,
        status: a.status,
        dueAt: a.due_at,
      }),
    ),
    quizzes: ((quizzesRes.data ?? []) as { title: string; status: string; due_date: string | null }[]).map((q) => ({
      title: fence(q.title, 200),
      status: q.status,
      dueDate: q.due_date,
    })),
    modules: ((modulesRes.data ?? []) as { title: string; is_published: boolean }[]).map((m) => ({
      title: fence(m.title, 200),
      published: !!m.is_published,
    })),
    grading: scheme
      ? {
          configured: true,
          categories: scheme.categories.map((c) => ({
            name: fence(c.name, 120),
            weightPercent: c.weight,
            itemCount: c.items.length,
          })),
          weightsSumTo: Math.round(weights.reduce((s, w) => s + w, 0) * 100) / 100,
        }
      : { configured: false, note: 'No grading scheme is configured yet — the gradebook has no category weights to compare against.' },
    officeHours: (officeHours ?? []).map(
      // day_of_week is stored as text (e.g. 'tuesday') — pass it through.
      (o: { day_of_week: string; start_time: string; end_time: string; location?: string | null }) => ({
        day: String(o.day_of_week),
        start: o.start_time,
        end: o.end_time,
        location: fence(o.location ?? '', 200),
      }),
    ),
    staff: (staffRows ?? []).map((s: { role: string; staff?: { name?: string | null } | { name?: string | null }[] }) => {
      const profile = Array.isArray(s.staff) ? s.staff[0] : s.staff
      return { name: fence(profile?.name ?? '(unnamed)', 200), role: s.role }
    }),
    section: {
      semester:
        section?.semester && section?.year
          ? `${String(section.semester).charAt(0).toUpperCase()}${String(section.semester).slice(1)} ${section.year}`
          : '(not set)',
      courseCode: course?.code ?? '',
      courseTitle: fence(course?.title ?? '', 200),
      credits: course?.credits ?? null,
    },
  }
}

/**
 * Which rate-limit pool this turn draws from.
 *
 * Assignment authoring and quiz authoring are the SAME component posting to the
 * SAME route, told apart only by `kind` — which is client-supplied context. If we
 * trusted it, a professor who exhausted the assignment pool could flip one field
 * in devtools to `quiz` and keep authoring the same assignment on a fresh pool.
 * They could never exceed the four-pool total (nor reach another tenant — the
 * route verifies section access independently), so this is quota integrity rather
 * than access control. We verify anyway: it costs one indexed primary-key lookup
 * against a turn that already takes seconds and costs cents, it keeps the
 * per-surface figures in docs/reference/athena-cost-analysis.md honest, and a limit you bypass by
 * editing a request field is not a limit.
 *
 * Grading is decided by `surface`, which stays client-supplied (an allow-listed
 * 400-on-invalid value). Shuffling between the grade and authoring pools is
 * therefore still possible — bounded, no worse than the total, accepted.
 *
 * Falls back to the claimed `kind` only when there is no id to check yet, i.e. an
 * unsaved draft in the create wizard, where nothing exists to verify against.
 */
export async function resolveAthenaLimitScope(
  adminDb: AdminDb,
  params: {
    /** The section the caller has ALREADY been verified against. */
    sectionId: string
    surface: string
    kind: string | undefined
    assignmentId: string | undefined
  },
): Promise<AthenaLimitScope> {
  if (params.surface === 'grade') return 'grade'
  // The About page builder registers with kind 'about' and never an assignmentId —
  // there is no subject row to verify against, so the claimed kind decides (the
  // same accepted bound as the create wizard below: pool shuffling is possible but
  // capped at the all-pools total, and claiming 'about' also swaps the tool set to
  // the About one, which is self-defeating for someone farming assignment turns).
  if (params.kind === 'about') return 'about'
  if (!params.assignmentId) return params.kind === 'quiz' ? 'quiz' : 'assignment'

  // Existence in `quizzes` IS the answer: the quiz studio registers the quiz id as
  // its assignmentId. Scoped to the verified section — an id from anywhere else is
  // simply "not a quiz here", so passing a foreign id can never change which pool
  // is charged and the lookup can't be used to probe whether that id exists.
  const { data, error } = await adminDb
    .from('quizzes')
    .select('id')
    .eq('id', params.assignmentId)
    .eq('section_id', params.sectionId)
    .maybeSingle()

  if (error) {
    // Fall back to the claimed kind rather than failing the turn. Consistent with
    // the limiter itself, which fails open: a lookup glitch must never block Athena.
    logger.error('resolveAthenaLimitScope: quiz lookup failed', error, {
      assignmentId: params.assignmentId,
    })
    return params.kind === 'quiz' ? 'quiz' : 'assignment'
  }

  return data ? 'quiz' : 'assignment'
}

export interface GradeContext {
  title: string
  instructions: string
  /** Rubric rows as dimension names → criteria descriptions. NO points/tiers. */
  rubricDimensions: { label: string; criteria: string[] }[]
}

/**
 * The assignment being graded — instructions + rubric DIMENSION names only, for
 * feedback grounding. Verifies the assignment belongs to the route-verified
 * section (IDOR guard); returns null on any mismatch/miss so the prompt just
 * omits the block rather than leaking another section's assignment.
 */
export async function loadGradeContext(
  adminDb: AdminDb,
  sectionId: string,
  assignmentId: string,
): Promise<GradeContext | null> {
  try {
    const { data, error } = await adminDb
      .from('assignments')
      .select('title, description, settings, section_id')
      .eq('id', assignmentId)
      .maybeSingle()
    if (error || !data || data.section_id !== sectionId) return null

    const rubric = parseRubric(data.settings)
    const rubricDimensions = rubric
      ? rubric.questions.map((q) => ({
          label: q.label,
          criteria: q.criteria.map((c) => c.description),
        }))
      : []

    return {
      title: data.title ?? '',
      instructions: (data.description ?? '').slice(0, 4000),
      rubricDimensions,
    }
  } catch (err) {
    logger.error('loadGradeContext: failed', err, { sectionId, assignmentId })
    return null
  }
}

// ── Project authoring context ───────────────────────────────────────
// What Athena needs to propose a phase timeline and a weighted rubric: the brief
// the professor already wrote, the structure that exists now, the section's own
// assignments and quizzes it can place, and whether any of it is already scored.
// Aggregate course metadata only — no student work and no scores are returned,
// only the COUNT of saved scores, which is what the refusal rule turns on.

export interface ProjectAuthoringContext {
  project: {
    title: string
    description: string
    guidelines: string
    dueDate: string | null
    maxTeamSize: number | null
    teamCount: number
  }
  /** Existing master phases, in board order, with the rubric rows on each. */
  phases: {
    id: string
    name: string
    startDate: string | null
    endDate: string | null
    items: {
      id: string
      itemType: string
      title: string
      weight: number
      grain: string
      scoringMode: string
    }[]
  }[]
  /** Assignments and quizzes in this section that could be placed on a phase. */
  library: { id: string; type: 'assignment' | 'quiz'; title: string; points: number | null }[]
  weightTotal: number
  /** True once ANY score is saved against this project — the restructure refusal. */
  anyScored: boolean
  gradesReleased: boolean
}

export async function loadProjectAuthoringContext(
  adminDb: AdminDb,
  sectionId: string,
  projectId: string,
): Promise<ProjectAuthoringContext | { error: string }> {
  // Bind the project to the ALREADY-VERIFIED section before reading anything else.
  // A project id from another section resolves to nothing here, so a wrong or
  // probing id returns the same "not found" as a deleted one.
  const { data: project, error: projectError } = await adminDb
    .from('projects')
    .select('id, title, description, guidelines, due_date, max_team_size')
    .eq('id', projectId)
    .eq('section_id', sectionId)
    .maybeSingle()

  if (projectError) {
    logger.error('loadProjectAuthoringContext: project read failed', projectError, { projectId })
    return { error: 'Could not load this project right now.' }
  }
  if (!project) return { error: 'That project could not be found in this course.' }

  const [phasesRes, itemsRes, teamsRes, assignmentsRes, quizzesRes, scoresRes, releaseRes] =
    await Promise.all([
      adminDb
        .from('project_master_phases')
        .select('id, name, start_date, end_date, position')
        .eq('project_id', projectId)
        .order('position', { ascending: true }),
      adminDb
        .from('project_phase_items')
        .select('id, phase_id, item_type, assignment_id, quiz_id, manual_title, weight, grain, scoring_mode')
        .eq('project_id', projectId),
      adminDb.from('project_teams').select('id', { count: 'exact', head: true }).eq('project_id', projectId),
      adminDb.from('assignments').select('id, title, points').eq('section_id', sectionId).limit(200),
      adminDb.from('quizzes').select('id, title').eq('section_id', sectionId).limit(200),
      adminDb.from('project_item_scores').select('id', { count: 'exact', head: true }).eq('project_id', projectId),
      adminDb.from('project_grade_releases').select('project_id').eq('project_id', projectId).maybeSingle(),
    ])

  const assignmentTitles = new Map<string, string>(
    (assignmentsRes.data ?? []).map((a: { id: string; title: string }) => [a.id, a.title]),
  )
  const quizTitles = new Map<string, string>(
    (quizzesRes.data ?? []).map((q: { id: string; title: string }) => [q.id, q.title]),
  )

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const itemRows: any[] = itemsRes.data ?? []
  const itemsByPhase = new Map<string, ProjectAuthoringContext['phases'][number]['items']>()
  let weightTotal = 0
  for (const it of itemRows) {
    const weight = Number(it.weight) || 0
    weightTotal += weight
    const title =
      it.item_type === 'assignment'
        ? (assignmentTitles.get(it.assignment_id) ?? 'Assignment')
        : it.item_type === 'quiz'
          ? (quizTitles.get(it.quiz_id) ?? 'Quiz')
          : (it.manual_title ?? it.item_type)
    const list = itemsByPhase.get(it.phase_id) ?? []
    list.push({
      id: it.id,
      itemType: it.item_type,
      title,
      weight,
      grain: it.grain,
      scoringMode: it.scoring_mode,
    })
    itemsByPhase.set(it.phase_id, list)
  }

  return {
    project: {
      title: project.title ?? '',
      description: project.description ?? '',
      guidelines: project.guidelines ?? '',
      dueDate: project.due_date ?? null,
      maxTeamSize: project.max_team_size ?? null,
      teamCount: teamsRes.count ?? 0,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    phases: (phasesRes.data ?? []).map((p: any) => ({
      id: p.id,
      name: p.name,
      startDate: p.start_date ?? null,
      endDate: p.end_date ?? null,
      items: itemsByPhase.get(p.id) ?? [],
    })),
    library: [
      ...(assignmentsRes.data ?? []).map((a: { id: string; title: string; points: number | null }) => ({
        id: a.id,
        type: 'assignment' as const,
        title: a.title,
        points: a.points ?? null,
      })),
      ...(quizzesRes.data ?? []).map((q: { id: string; title: string }) => ({
        id: q.id,
        type: 'quiz' as const,
        title: q.title,
        points: null,
      })),
    ],
    weightTotal,
    anyScored: (scoresRes.count ?? 0) > 0,
    gradesReleased: !!releaseRes.data,
  }
}
