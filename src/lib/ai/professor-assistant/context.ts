/**
 * Course-context loaders for the professor AI assistant.
 *
 * Server-only. Called from the /api/professor-assistant route (which already
 * authenticated the caller + verified section access) with the admin client.
 * All queries are read-only and section-scoped. Failures degrade gracefully to
 * empty/zero rather than throwing — a missing signal should never break chat.
 */

import 'server-only'
import { getProfessorState } from '@/lib/memory/state'
import { renderProfessorMemory } from './memory-block'
import { logger } from '@/lib/logger'
import { skillQueries } from '@/lib/supabase/queries'
import { gatherSectionRisk } from '@/lib/risk/gather'
import { aggregateSectionMastery, aggregateStudentMastery } from '@/lib/skills/aggregate'
import { resolveSkillMasteryConfig } from '@/lib/skills/config'
import { masteryTier, type MasteryTier } from '@/lib/skills/mastery'
import { fence } from '@/lib/ai/prompt-fence'
import { resolveStudent } from './student-resolve'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminDb = any

const ENROLLED_STATUSES = ['enrolled', 'completed', 'active']

export interface AssistantContext {
  institutionId: string
  professorName: string
  courseTitle: string
  courseCode: string
  sectionCode: string
  rosterCount: number
  modules: { title: string; published: boolean }[]
  /** Recent published announcements, used for tone matching. */
  recentAnnouncements: { title: string; content: string }[]
  /** Rendered prompt lines for what this professor has told us about how they
   *  work, or null when they have said nothing. Both professor surfaces share
   *  this loader, so filling it here gives memory to each of them at once. */
  memory: string | null
  /** Last teaching day, used to expire professor preferences with the term
   *  rather than on a flat clock. Null when the section has none recorded. */
  sectionEndDate: string | null
}

/** Lightweight context for the system prompt ("knows your course"). */
export async function loadAssistantContext(
  adminDb: AdminDb,
  sectionId: string,
  userId?: string,
): Promise<AssistantContext> {
  const fallback: AssistantContext = {
    institutionId: '',
    professorName: '',
    courseTitle: 'this course',
    courseCode: '',
    sectionCode: '',
    rosterCount: 0,
    modules: [],
    recentAnnouncements: [],
    memory: null,
    sectionEndDate: null,
  }

  try {
    const [{ data: section }, { count }, { data: modules }, { data: announcements }, { data: profile }] =
      await Promise.all([
        adminDb
          .from('course_sections')
          .select('section_code, institution_id, end_date, course:courses(code, title)')
          .eq('id', sectionId)
          .single(),
        adminDb
          .from('enrollments')
          .select('id', { count: 'exact', head: true })
          .eq('section_id', sectionId)
          .in('status', ENROLLED_STATUSES),
        adminDb
          .from('modules')
          .select('title, is_published')
          .eq('section_id', sectionId)
          .order('position', { ascending: true }),
        adminDb
          .from('announcements')
          .select('title, content')
          .eq('section_id', sectionId)
          .eq('status', 'published')
          .order('published_at', { ascending: false })
          .limit(5),
        userId
          ? adminDb.from('profiles').select('name, first_name, last_name').eq('id', userId).single()
          : Promise.resolve({ data: null }),
      ])

    /* Memory is read AFTER the section, because it needs the institution id to
       scope by tenant and the admin client bypasses row-level security. A
       failure here must not take the whole context down: a professor with no
       memory is the normal case, so the assistant still works without it. */
    let memory: string | null = null
    if (userId && section?.institution_id) {
      try {
        const state = await getProfessorState(adminDb, {
          userId,
          institutionId: section.institution_id as string,
          sectionId,
        })
        memory = renderProfessorMemory(state)
      } catch (error) {
        logger.error('loadAssistantContext: memory read failed', error, { sectionId })
      }
    }

    const course = Array.isArray(section?.course) ? section?.course[0] : section?.course
    const professorName =
      profile?.name || `${profile?.first_name ?? ''} ${profile?.last_name ?? ''}`.trim() || ''

    return {
      institutionId: section?.institution_id || '',
      professorName,
      courseTitle: course?.title || fallback.courseTitle,
      courseCode: course?.code || '',
      sectionCode: section?.section_code || '',
      rosterCount: count ?? 0,
      modules: (modules || []).map((m: { title: string; is_published: boolean }) => ({
        title: m.title,
        published: !!m.is_published,
      })),
      recentAnnouncements: (announcements || [])
        .map((a: { title: string; content: string | null }) => ({
          title: a.title || '',
          content: (a.content || '').slice(0, 600),
        }))
        .filter((a: { title: string; content: string }) => a.title || a.content),
      memory,
      sectionEndDate: (section?.end_date as string | null) ?? null,
    }
  } catch (error) {
    logger.error('loadAssistantContext: failed', error, { sectionId })
    return fallback
  }
}

/**
 * How many scored topics the digest names before it truncates. Sized from real
 * data: the largest section in prod tracks 195 main topics but only 36 carry any
 * score, so this bites only on a pathologically large course — and when it does,
 * `truncated` says so rather than quietly shortening the list.
 *
 * The cap deliberately is NOT "the 6 weakest". A short list makes the digest
 * blind to the middle: asked "how are they doing on Arrays?" with Arrays at 63%,
 * a top-6 payload omits it and the model reports it as untracked.
 */
const TOPIC_DIGEST_MAX = 40

/** The word for the single class number, per the section's configured metric.
 *  Never hardcode "median" — a section can be set to mean or % proficient. */
const METRIC_WORD: Record<string, string> = {
  median: 'median',
  mean: 'average',
  percent_proficient: '% proficient',
}

export interface TopicMasteryTopic {
  topic: string
  /** The class number for this topic under `metric`, 0–100. */
  score: number
  /** weak < 60 · shaky 60–79 · strong 80–100 */
  tier: MasteryTier
  /** Share of students below this section's at-risk threshold, 0–100. */
  atRiskPct: number | null
}

export interface TopicMasteryDigest {
  /** False when the course curates no topics, or none has been assessed yet. */
  tracked: boolean
  /** What `score` means here — "median" unless the professor changed it. */
  metric: string
  /** Curated main topics (excluding professor-dropped / unconfirmed ones). */
  totalTopics: number
  scoredTopics: number
  /** Weakest first. Topics with no evidence are omitted, never shown as 0%. */
  topics: TopicMasteryTopic[]
  truncated: boolean
  note?: string
}

/**
 * Class standing on this section's CURATED topics (`skills` + `skill_mastery`) —
 * the authoritative mastery axis, as opposed to the raw quiz-tag accuracy that
 * `loadStudentPerformance` reports.
 *
 * Read-only and class-level: it returns per-topic aggregates and never a student
 * name, so it is safe in the same brainstorm context `loadClassStruggles` keeps
 * blind to individuals. Composes the shipped readers and the shipped pure
 * aggregator rather than re-deriving any of the maths, so Athena's numbers and
 * the roadmap's Class analytics cannot disagree.
 *
 * Degrades to `tracked: false` with a note on any failure — a missing signal must
 * never break a chat turn.
 */
export async function loadTopicMastery(adminDb: AdminDb, sectionId: string): Promise<TopicMasteryDigest> {
  const blank = (note: string, totalTopics = 0, tracked = false): TopicMasteryDigest => ({
    tracked,
    metric: METRIC_WORD.median,
    totalTopics,
    scoredTopics: 0,
    topics: [],
    truncated: false,
    note,
  })

  try {
    const [skills, masteryRows, sectionRes] = await Promise.all([
      skillQueries.listSectionSkills(adminDb, sectionId),
      skillQueries.getSectionMasteryRows(adminDb, sectionId),
      adminDb.from('course_sections').select('settings').eq('id', sectionId).maybeSingle(),
    ])

    // Excluded (professor dropped it) and suppressed (AI-suggested, not yet
    // corroborated) topics are hidden from the roadmap and Class analytics —
    // Athena must not be the one surface that resurrects them.
    const active = (skills ?? []).filter((s) => !s.excluded && !s.suppressed)
    const mainCount = active.filter((s) => s.parent_id === null).length
    if (mainCount === 0) return blank('This course does not track topics yet.')

    const config = resolveSkillMasteryConfig(sectionRes?.data?.settings)
    const view = aggregateSectionMastery(active, masteryRows ?? [], config)

    // `classScore` is null until a topic has real evidence. Dropping those is
    // what keeps this small on a 195-topic course where only 36 are scored — and
    // a null must never be rendered as 0%, which would read as "they failed it".
    const scored = view.ranked.filter((t) => t.classScore != null)
    if (scored.length === 0) {
      return blank('Topics are tracked for this course, but nothing has been assessed against them yet.', mainCount, true)
    }

    const topics = scored.slice(0, TOPIC_DIGEST_MAX).map((t) => ({
      // Topic names are free text written by professors AND by the extraction
      // pipeline reading uploaded files — fenced before they enter a prompt.
      topic: fence(t.name, 120),
      score: Math.round(t.classScore as number),
      tier: masteryTier(t.classScore),
      atRiskPct: t.atRiskPct == null ? null : Math.round(t.atRiskPct),
    }))

    const truncated = scored.length > TOPIC_DIGEST_MAX
    return {
      tracked: true,
      metric: METRIC_WORD[config.classMetric] ?? config.classMetric,
      totalTopics: mainCount,
      scoredTopics: scored.length,
      topics,
      truncated,
      note: truncated
        ? `Showing the ${TOPIC_DIGEST_MAX} weakest of ${scored.length} assessed topics. Topics not listed here are stronger, not missing.`
        : undefined,
    }
  } catch (error) {
    logger.error('loadTopicMastery: failed', error, { sectionId })
    return blank('Topic mastery could not be loaded right now.')
  }
}

export interface CourseSnapshot {
  courseTitle: string
  courseCode: string
  rosterCount: number
  modules: { title: string; published: boolean; itemCount: number }[]
  quizzes: { title: string; status: string }[]
  publishedAnnouncementCount: number
  /** Class-wide average across all submitted graded quiz attempts (percent), or null if none yet. */
  classAverage: number | null
  /** Per published quiz: how many students submitted, the average %, and how many scored below pass. */
  quizPerformance: { title: string; attempts: number; avgScore: number; belowPass: number }[]
  /** Students the shared risk engine flagged. Reads graded work of both kinds,
   *  missing submissions past a 72h grace, and skill mastery. */
  atRiskStudents: { name: string; avgScore: number | null; flaggedFor: string }[]
  /** False when the section has too little closed work to judge anyone. An
   *  empty atRiskStudents then means "cannot tell yet", not "everyone is fine",
   *  and Athena must not tell a professor their class is fine on no evidence. */
  riskHasEnoughSignal: boolean
}

/**
 * Richer read-only snapshot for the `ask_course_insights` tool. Covers both
 * course STRUCTURE / SCHEDULE / COVERAGE (modules, quizzes, announcements —
 * what exists and what's published vs draft) AND class-level performance (the
 * class average, per-quiz performance, and at-risk students computed below).
 * It returns class-level aggregates only — not a per-student gradebook (that's
 * `loadStudentPerformance`). Degrades gracefully to empty/zero on any failure.
 */
export async function loadCourseSnapshot(adminDb: AdminDb, sectionId: string): Promise<CourseSnapshot> {
  const base = await loadAssistantContext(adminDb, sectionId)
  const snapshot: CourseSnapshot = {
    courseTitle: base.courseTitle,
    courseCode: base.courseCode,
    rosterCount: base.rosterCount,
    modules: base.modules.map((m) => ({ ...m, itemCount: 0 })),
    quizzes: [],
    publishedAnnouncementCount: 0,
    classAverage: null,
    quizPerformance: [],
    atRiskStudents: [],
    riskHasEnoughSignal: false,
  }

  try {
    // Module item counts (one query, grouped client-side).
    const { data: modRows } = await adminDb
      .from('modules')
      .select('id, title, is_published')
      .eq('section_id', sectionId)
      .order('position', { ascending: true })

    const moduleIds = (modRows || []).map((m: { id: string }) => m.id)
    let itemCounts: Record<string, number> = {}
    if (moduleIds.length > 0) {
      const { data: items } = await adminDb.from('module_items').select('module_id').in('module_id', moduleIds)
      itemCounts = (items || []).reduce((acc: Record<string, number>, it: { module_id: string }) => {
        acc[it.module_id] = (acc[it.module_id] || 0) + 1
        return acc
      }, {})
    }
    snapshot.modules = (modRows || []).map((m: { id: string; title: string; is_published: boolean }) => ({
      title: m.title,
      published: !!m.is_published,
      itemCount: itemCounts[m.id] || 0,
    }))

    const { data: quizzes } = await adminDb
      .from('quizzes')
      .select('id, title, status, pass_threshold')
      .eq('section_id', sectionId)
      .order('created_at', { ascending: false })
      .limit(30)
    snapshot.quizzes = (quizzes || []).map((q: { title: string; status: string }) => ({
      title: q.title,
      status: q.status,
    }))

    const { count: annCount } = await adminDb
      .from('announcements')
      .select('id', { count: 'exact', head: true })
      .eq('section_id', sectionId)
      .eq('status', 'published')
    snapshot.publishedAnnouncementCount = annCount ?? 0

    // ── Performance analytics (graded, submitted attempts on published quizzes) ──
    const publishedQuizzes = (quizzes || []).filter((q: { status: string }) => q.status === 'published')
    if (publishedQuizzes.length > 0) {
      const passOf = new Map<string, number>(
        publishedQuizzes.map((q: { id: string; pass_threshold: number | null }) => [q.id, q.pass_threshold ?? 60]),
      )
      const { data: attempts } = await adminDb
        .from('quiz_attempts')
        .select('quiz_id, student_id, score')
        .eq('section_id', sectionId)
        .eq('status', 'submitted')

      const rows: { quiz_id: string; student_id: string; score: number | null }[] = (attempts || []).filter(
        (a: { quiz_id: string; score: number | null }) => passOf.has(a.quiz_id) && a.score != null,
      )

      if (rows.length > 0) {
        snapshot.classAverage = Math.round((rows.reduce((s, r) => s + (r.score ?? 0), 0) / rows.length) * 10) / 10


        snapshot.quizPerformance = publishedQuizzes
          .map((q: { id: string; title: string }) => {
            const qa = rows.filter((r) => r.quiz_id === q.id)
            const avg = qa.length ? qa.reduce((s, r) => s + (r.score ?? 0), 0) / qa.length : 0
            return {
              title: q.title,
              attempts: qa.length,
              avgScore: Math.round(avg * 10) / 10,
              belowPass: qa.filter((r) => (r.score ?? 0) < (passOf.get(q.id) ?? 60)).length,
            }
          })
          .filter((p: { attempts: number }) => p.attempts > 0)

        /* At-risk comes from the shared engine now. This used to be a second
           copy of the gradebook's quiz-only rule, so Athena and the gradebook
           could disagree about the same student on the same day, and neither
           saw assignments. gatherSectionRisk reads both kinds of work and knows
           when it has too little evidence to judge. */
        const sectionRisk = await gatherSectionRisk(adminDb, sectionId)
        snapshot.atRiskStudents = sectionRisk.students
          .filter((st) => st.atRisk)
          .slice(0, 15)
          .map((st) => ({
            name: st.studentName,
            avgScore: st.averagePct,
            flaggedFor: st.reasons.join(' · '),
          }))
        snapshot.riskHasEnoughSignal = sectionRisk.hasEnoughSignal
      }
    }
  } catch (error) {
    logger.error('loadCourseSnapshot: failed', error, { sectionId })
  }

  return snapshot
}

// ── Per-student performance (get_student_performance tool) ─────────────────────
// Read-only individual summary. Resolution is scoped to THIS section's enrollment
// (the security boundary: a professor can only ever pull a student enrolled in
// their own section). Summarizes existing graded scores — assigns nothing.

export interface StudentPerformance {
  resolution: 'found' | 'not_found' | 'ambiguous'
  attemptedName: string
  /** not_found → up to 5 closest enrolled names (never the whole roster). */
  suggestions?: string[]
  /** ambiguous → the enrolled names that matched, for the model to disambiguate. */
  matches?: string[]
  student?: string
  note?: string
  /** Professor's manually-set course grade (enrollments.final_grade/score). null until set. */
  finalGrade?: { letter: string | null; score: number | null }
  overall?: {
    /** Quiz average (best attempt per quiz), to match the gradebook. */
    avgPct: number | null
    classAvgPct: number | null
    standing: 'above_average' | 'about_average' | 'below_average' | null
    completion: string
    quizzesTaken: number
    expectedQuizzes: number
    belowPass: number
    atRisk: boolean
    atRiskReason: string | null
  }
  /** Team project grades (project_grades via the student's team membership). */
  projects?: { avgPct: number | null; graded: number; items: { title: string; score: number }[] }
  behavior?: { lateSubmissions: number; daysSinceLastActivity: number | null }
  trend?: {
    trajectory: 'improving' | 'declining' | 'steady' | 'insufficient_data'
    recentAvg: number | null
    previousAvg: number | null
  }
  topics?: { strengths: string[]; weaknesses: { tag: string; score: number }[] }
  recentQuizzes?: {
    title: string
    status: 'submitted_on_time' | 'submitted_late' | 'missing'
    score: number | null
    passed: boolean | null
  }[]
  olderQuizCount?: number
}

export async function loadStudentPerformance(
  adminDb: AdminDb,
  sectionId: string,
  studentName: string,
): Promise<StudentPerformance> {
  try {
    // Enrolled roster (resolution is constrained to THIS section — the security boundary).
    const { data: enrolled } = await adminDb
      .from('enrollments')
      .select('student_id')
      .eq('section_id', sectionId)
      .in('status', ENROLLED_STATUSES)
    const studentIds: string[] = (enrolled || []).map((e: { student_id: string }) => e.student_id)
    const { data: profiles } = await adminDb
      .from('profiles')
      .select('id, name')
      .in('id', studentIds.length ? studentIds : ['00000000-0000-0000-0000-000000000000'])
    const roster: { id: string; name: string }[] = (profiles || []).map((p: { id: string; name: string | null }) => ({
      id: p.id,
      name: p.name || 'Unknown',
    }))
    const rosterCount = roster.length

    const resolved = resolveStudent(studentName, roster)
    if (resolved.kind === 'not_found') {
      return { resolution: 'not_found', attemptedName: studentName, suggestions: resolved.suggestions }
    }
    if (resolved.kind === 'ambiguous') {
      return { resolution: 'ambiguous', attemptedName: studentName, matches: resolved.matches }
    }
    const studentId = resolved.id
    const studentDisplay = resolved.name

    // Official final grade (manually set by the professor; null until then) — computed
    // up front so it's reported even for a student with no quiz attempts yet.
    const { data: enrollRow } = await adminDb
      .from('enrollments')
      .select('final_grade, final_score')
      .eq('section_id', sectionId)
      .eq('student_id', studentId)
      .maybeSingle()
    const finalGrade = {
      letter: enrollRow?.final_grade ?? null,
      score: typeof enrollRow?.final_score === 'number' ? enrollRow.final_score : null,
    }

    // Team project grades: section projects → this student's team memberships →
    // project_grades. Mirrors the student grades page (per-team grade, score 0–100).
    let projects: StudentPerformance['projects'] = { avgPct: null, graded: 0, items: [] }
    const { data: projRows } = await adminDb
      .from('projects')
      .select('id, title')
      .eq('section_id', sectionId)
      .in('status', ['active', 'completed'])
    const sectionProjects: { id: string; title: string }[] = projRows || []
    if (sectionProjects.length) {
      const { data: memberships } = await adminDb
        .from('project_members')
        .select('team_id')
        .eq('user_id', studentId)
      const teamIds: string[] = (memberships || []).map((m: { team_id: string }) => m.team_id).filter(Boolean)
      if (teamIds.length) {
        const { data: teams } = await adminDb
          .from('project_teams')
          .select('id, name, project_id, project_grades(score)')
          .in('id', teamIds)
          .in('project_id', sectionProjects.map((p) => p.id))
        const projTitle = new Map(sectionProjects.map((p) => [p.id, p.title]))
        const items: { title: string; score: number }[] = []
        for (const t of (teams || []) as { project_id: string; project_grades: unknown }[]) {
          const g = Array.isArray(t.project_grades) ? t.project_grades[0] : t.project_grades
          const score = (g as { score?: number } | null)?.score
          if (score != null) items.push({ title: projTitle.get(t.project_id) || 'Project', score: Math.round(score * 10) / 10 })
        }
        const avgPct = items.length
          ? Math.round((items.reduce((s, x) => s + x.score, 0) / items.length) * 10) / 10
          : null
        projects = { avgPct, graded: items.length, items }
      }
    }

    // Published quizzes + all submitted attempts in the section (for class avg + this student).
    const { data: quizzes } = await adminDb
      .from('quizzes')
      .select('id, title, status, pass_threshold, due_date')
      .eq('section_id', sectionId)
      .eq('status', 'published')
    const pubQuizzes: { id: string; title: string; pass_threshold: number | null; due_date: string | null }[] =
      quizzes || []
    const passOf = new Map<string, number>(pubQuizzes.map((q) => [q.id, q.pass_threshold ?? 60]))
    const titleOf = new Map<string, string>(pubQuizzes.map((q) => [q.id, q.title]))
    const pubIds = new Set(pubQuizzes.map((q) => q.id))

    const { data: attemptsRaw } = await adminDb
      .from('quiz_attempts')
      .select('quiz_id, student_id, score, submitted_at, is_late')
      .eq('section_id', sectionId)
      .eq('status', 'submitted')
    const attempts: { quiz_id: string; student_id: string; score: number | null; submitted_at: string | null; is_late: boolean | null }[] =
      (attemptsRaw || []).filter((a: { quiz_id: string; score: number | null }) => pubIds.has(a.quiz_id) && a.score != null)

    // Dedup retakes: keep the BEST attempt per (student, quiz) — matches how the
    // gradebook + student grades page score each quiz, so our numbers agree.
    type Att = { quiz_id: string; student_id: string; score: number; submitted_at: string | null; is_late: boolean }
    const best = new Map<string, Att>()
    for (const a of attempts) {
      const key = `${a.student_id}|${a.quiz_id}`
      const prev = best.get(key)
      if (!prev || (a.score ?? -1) > prev.score) {
        best.set(key, { quiz_id: a.quiz_id, student_id: a.student_id, score: a.score ?? 0, submitted_at: a.submitted_at, is_late: !!a.is_late })
      }
    }
    const deduped = [...best.values()]

    // Expected quizzes: due date passed OR taken by ≥40% of the roster (min 3 takers).
    const now = Date.now()
    const takersByQuiz = new Map<string, number>()
    for (const a of deduped) takersByQuiz.set(a.quiz_id, (takersByQuiz.get(a.quiz_id) || 0) + 1)
    const expectedThreshold = Math.max(3, Math.floor((rosterCount || 20) * 0.4))
    const expectedIds = new Set(
      pubQuizzes
        .filter((q) => (q.due_date && Date.parse(q.due_date) < now) || (takersByQuiz.get(q.id) || 0) >= expectedThreshold)
        .map((q) => q.id),
    )

    // This student's deduped attempts.
    const mine = deduped.filter((a) => a.student_id === studentId)
    const mineByQuiz = new Map(mine.map((a) => [a.quiz_id, a]))

    /* Topic strengths/weaknesses from this student's curated skill mastery.
       This used to be raw quiz-tag accuracy, which put a DIFFERENT topic number
       in the same chat context as loadTopicMastery's canonical one — Athena
       could answer "how is Priya doing on recursion?" two ways in one reply.

       Computed ABOVE the no-quizzes early return on purpose. Mastery folds in
       assignments, live-classroom quizzes and node checks, so a student with no
       quiz submissions can still have real scores. Leaving this below the return
       meant Athena told the professor there was nothing to report about a
       student sitting at 88 on assignment evidence, while loadTopicMastery and
       the roadmap both showed them. Same quiz-shaped gate that was wrong in the
       gradebook and in the outcomes pipeline. */
    let topics: StudentPerformance['topics'] = { strengths: [], weaknesses: [] }
    const [perfSkillRows, perfMasteryRows] = await Promise.all([
      skillQueries.listSectionSkills(adminDb, sectionId),
      skillQueries.getStudentMasteryRows(adminDb, sectionId, studentId),
    ])
    const perfTracked = (perfSkillRows ?? []).filter((s) => !s.excluded && !s.suppressed)
    const perfScored = aggregateStudentMastery(perfTracked, perfMasteryRows ?? [])
      .filter((s) => s.classScore != null)
    if (perfScored.length) {
      topics = {
        strengths: perfScored
          .filter((s) => masteryTier(s.classScore) === 'strong')
          .map((s) => fence(s.name, 120)),
        weaknesses: perfScored
          .filter((s) => masteryTier(s.classScore) === 'weak')
          .map((s) => ({ tag: fence(s.name, 120), score: Math.round(s.classScore as number) })),
      }
    }

    if (mine.length === 0) {
      return {
        resolution: 'found',
        attemptedName: studentName,
        student: studentDisplay,
        note: 'This student has not submitted any graded quizzes yet.',
        finalGrade,
        projects,
        topics,
        overall: {
          avgPct: null,
          classAvgPct: null,
          standing: null,
          completion: `0/${expectedIds.size} expected`,
          quizzesTaken: 0,
          expectedQuizzes: expectedIds.size,
          belowPass: 0,
          atRisk: expectedIds.size >= 2,
          atRiskReason: expectedIds.size >= 2 ? `missing ${expectedIds.size} quizzes` : null,
        },
      }
    }

    // Overall.
    const myScores = mine.map((a) => a.score)
    const avgPct = Math.round((myScores.reduce((s, x) => s + x, 0) / myScores.length) * 10) / 10
    const belowPass = mine.filter((a) => a.score < (passOf.get(a.quiz_id) ?? 60)).length

    // Class average across all students' deduped scores.
    const classScores = deduped.map((a) => a.score)
    const classAvgPct = classScores.length
      ? Math.round((classScores.reduce((s, x) => s + x, 0) / classScores.length) * 10) / 10
      : null
    let standing: 'above_average' | 'about_average' | 'below_average' | null = null
    if (classAvgPct != null) {
      const diff = avgPct - classAvgPct
      standing = diff >= 5 ? 'above_average' : diff <= -5 ? 'below_average' : 'about_average'
    }

    /* The third and last copy of the quiz-only rule, now the shared engine.
       Athena, the gradebook and the course snapshot answer "is this student at
       risk" from one place, and all three see assignments.
       This scores the whole section to report on one student, which is not
       waste: signal 1 compares each score to that item's own class median, so a
       single student's standing is undefined without the class. */
    const riskForSection = await gatherSectionRisk(adminDb, sectionId)
    const myRisk = riskForSection.students.find((st) => st.studentId === studentId)
    const atRisk = myRisk?.atRisk ?? false
    const reasons: string[] = myRisk?.reasons ?? []

    // Behavior. Last activity = most recent submission across ALL attempts (engagement recency).
    const lateSubmissions = mine.filter((a) => a.is_late).length
    const allSubmitTs = attempts
      .filter((a) => a.student_id === studentId)
      .map((a) => (a.submitted_at ? Date.parse(a.submitted_at) : 0))
    const lastTs = allSubmitTs.length ? Math.max(...allSubmitTs) : 0
    const daysSinceLastActivity = lastTs > 0 ? Math.floor((now - lastTs) / 86_400_000) : null

    // Trend: recent 3 vs previous (needs ≥4 taken). ±10 pts → improving/declining.
    const chrono = [...mine].sort(
      (a, b) => (a.submitted_at ? Date.parse(a.submitted_at) : 0) - (b.submitted_at ? Date.parse(b.submitted_at) : 0),
    )
    let trend: StudentPerformance['trend']
    if (chrono.length < 4) {
      trend = { trajectory: 'insufficient_data', recentAvg: null, previousAvg: null }
    } else {
      const recent = chrono.slice(-3).map((a) => a.score)
      const previous = chrono.slice(0, -3).map((a) => a.score)
      const rAvg = Math.round((recent.reduce((s, x) => s + x, 0) / recent.length) * 10) / 10
      const pAvg = Math.round((previous.reduce((s, x) => s + x, 0) / previous.length) * 10) / 10
      const d = rAvg - pAvg
      trend = {
        trajectory: d >= 10 ? 'improving' : d <= -10 ? 'declining' : 'steady',
        recentAvg: rAvg,
        previousAvg: pAvg,
      }
    }

    // recentQuizzes: every expected quiz (chronological by due date), capped to 6.
    const orderedQuizIds = pubQuizzes
      .filter((q) => expectedIds.has(q.id) || mineByQuiz.has(q.id))
      .sort((a, b) => (a.due_date ? Date.parse(a.due_date) : 0) - (b.due_date ? Date.parse(b.due_date) : 0))
      .map((q) => q.id)
    const allEntries = orderedQuizIds.map((qid) => {
      const a = mineByQuiz.get(qid)
      if (!a) return { title: titleOf.get(qid) || 'Quiz', status: 'missing' as const, score: null, passed: null }
      return {
        title: titleOf.get(qid) || 'Quiz',
        status: a.is_late ? ('submitted_late' as const) : ('submitted_on_time' as const),
        score: a.score,
        passed: a.score >= (passOf.get(qid) ?? 60),
      }
    })
    const recentQuizzes = allEntries.slice(-6)
    const olderQuizCount = Math.max(0, allEntries.length - recentQuizzes.length)

    return {
      resolution: 'found',
      attemptedName: studentName,
      student: studentDisplay,
      overall: {
        avgPct,
        classAvgPct,
        standing,
        completion: `${mine.length}/${expectedIds.size} expected`,
        quizzesTaken: mine.length,
        expectedQuizzes: expectedIds.size,
        belowPass,
        atRisk,
        atRiskReason: reasons.length ? reasons.join(' · ') : null,
      },
      finalGrade,
      projects,
      behavior: { lateSubmissions, daysSinceLastActivity },
      trend,
      topics,
      recentQuizzes,
      olderQuizCount,
    }
  } catch (error) {
    logger.error('loadStudentPerformance: failed', error, { sectionId })
    return { resolution: 'not_found', attemptedName: studentName, suggestions: [], note: 'Could not load performance data.' }
  }
}

// ── Live-class post-quiz report (get_live_class_report tool) ───────────────────
// Read-only. Reads the report that closeQuizWithReport already PERSISTED into the
// quiz interaction's payload (concepts weakest-first, per-question accuracy,
// non-responders) — no recomputation, no extra auth surface. Resolves the
// section's most-recent live-classroom quiz that has a saved report. Section
// scoping is the security boundary (caller already verified as section staff).

export interface LiveClassReport {
  found: boolean
  /** Human-readable note when there's nothing to report (no rooms, no closed quiz). */
  note?: string
  closedAt?: string
  totalStudents?: number
  /** Overall % correct across all answered questions. */
  overallAccuracy?: number
  /** Per concept, sorted weakest first (as stored). */
  concepts?: { concept: string; correctRate: number; correctCount: number; totalCount: number }[]
  /** The concepts students did worst on (correctRate < 60), for quick remediation. */
  weakestConcepts?: string[]
  /** Per question accuracy (capped). */
  questions?: { prompt: string; concept: string; correctRate: number }[]
  /** Enrolled students who didn't answer (names only, capped). */
  nonResponders?: string[]
}

interface StoredQuizReport {
  closedAt?: string
  totalStudents?: number
  overallAccuracy?: number
  concepts?: { concept: string; correctRate: number; correctCount: number; totalCount: number }[]
  questions?: { prompt: string; concept: string; correctRate: number }[]
  nonResponders?: { id: string; name: string }[]
}

export async function loadLiveClassReport(adminDb: AdminDb, sectionId: string): Promise<LiveClassReport> {
  try {
    const { data: rooms } = await adminDb.from('lc_rooms').select('id').eq('section_id', sectionId)
    const roomIds: string[] = (rooms || []).map((r: { id: string }) => r.id)
    if (roomIds.length === 0) {
      return { found: false, note: 'No live classroom sessions have been run in this course yet.' }
    }

    // Most-recent quiz interactions; find the first one with a persisted report.
    const { data: interactions } = await adminDb
      .from('lc_interactions')
      .select('id, payload, created_at')
      .in('room_id', roomIds)
      .eq('kind', 'quiz')
      .order('created_at', { ascending: false })
      .limit(25)

    const withReport = (interactions || []).find(
      (i: { payload?: { report?: StoredQuizReport } }) => i?.payload?.report,
    ) as { payload: { report: StoredQuizReport } } | undefined

    if (!withReport) {
      return {
        found: false,
        note: 'No completed live-class quiz with a saved report yet. Run and close an AI quiz in a live session first.',
      }
    }

    const report = withReport.payload.report
    const concepts = report.concepts || []
    return {
      found: true,
      closedAt: report.closedAt,
      totalStudents: report.totalStudents,
      overallAccuracy: report.overallAccuracy,
      concepts,
      weakestConcepts: concepts.filter((c) => c.correctRate < 60).map((c) => c.concept),
      questions: (report.questions || []).slice(0, 12),
      nonResponders: (report.nonResponders || []).map((n) => n.name).slice(0, 25),
    }
  } catch (error) {
    logger.error('loadLiveClassReport: failed', error, { sectionId })
    return { found: false, note: 'Could not load the live-class report.' }
  }
}
