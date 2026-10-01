'use server'

// Server actions for the professor roadmap: read the roadmap DTO, the class
// lens' per-student journeys, concept analytics, and the triage aggregates.
// Read-only — node status is derived, never stored (§11 decision 2).

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logEvent } from '@/lib/supabase/event-logger'
import { logger } from '@/lib/logger'
import { CLASS_INSIGHT_MODEL, STUDENT_INSIGHT_MODEL } from '@/lib/ai/config'
import type { DossierFacts } from '@/lib/roadmap/dossier'
import { collectDossierFacts, factsHash, refreshStudentInsight, signalHash } from '@/lib/roadmap/dossier-facts'
import { buildClassInsightFacts, classInsightBlocker, type ClassInsightFacts, type ClassSkillFact } from '@/lib/roadmap/class-insight'
import { generateClassInsight } from '@/lib/ai/class-insight'
import { checkAiFeature } from '@/lib/ai/kill-switch'
import { aiRefusalMessage } from '@/lib/ai/ai-features'
import { enqueueJob } from '@/lib/jobs/enqueue'
import { assembleRoadmapData, buildResourceNodes } from '@/lib/roadmap/auto-roadmap-helpers'
import { roadmapQueries } from '@/lib/supabase/queries'
import { signModuleItemContent } from '@/lib/supabase/signed-urls'
import {
  journeyFromTopicAccuracy,
  overallFromMasteryPct,
  type JourneyState,
  type NodeJourney,
} from '@/lib/roadmap/journey-state'
import { buildStudentMastery, buildSectionJourneyRefs, checkedOffSetFrom, type JourneyWeekGroup } from '@/lib/skills/roadmap-mastery'
import { skillQueries } from '@/lib/supabase/queries'
import { getPoorQuizItems } from '@/lib/roadmap/item-stats'
import { getSectionMaterialItems, getClassMasteryTrend, getSectionOpenSignals, getSectionRedownloadSignals, getSectionClickThroughSignals } from '@/lib/roadmap/engagement'
import { getNodeCheckReview, getColdExtras, type NodeCheckReview } from '@/lib/roadmap/node-check'
import { getTranscriptSignals } from '@/lib/roadmap/transcript-signals'
import type { SpokenClaim, DeliveryDepthSignal } from '@/lib/roadmap/triage'
import { aggregateSectionMastery, studentScoresForSkill, type SectionMasteryView, type MasteryDatum } from '@/lib/skills/aggregate'
import { resolveSkillMasteryConfig } from '@/lib/skills/config'
import type { SkillRow } from '@/lib/validations/skill'
import { ON_ROSTER_STATUSES } from '@/lib/validations/enrollment'
import type { ConceptSourceType } from '@/lib/roadmap/concept-links'
import type { AutoRoadmapData } from '@/lib/validations/auto-roadmap'

// ── Helpers ──────────────────────────────────────────────────────

async function getAuthUser() {
  const supabase = await createClient()
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) return null
  return user
}

async function verifyOwnership(sectionId: string, userId: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any
  // professor_id is all this guard needs. It used to hand `settings` back for the
  // saved canvas positions; that reader retired with the old canvas, so the guard
  // no longer carries a payload for anyone.
  const { data: section, error } = await adminDb
    .from('course_sections')
    .select('id, professor_id')
    .eq('id', sectionId)
    .single()

  if (error || !section) return { owned: false as const, adminDb }
  if (section.professor_id !== userId) return { owned: false as const, adminDb }
  return { owned: true as const, adminDb }
}

// ── Actions ──────────────────────────────────────────────────────

/**
 * Fetch roadmap data for a professor.
 * Professor sees ALL modules (including unpublished) and ALL items.
 * Structure only — node status is derived from coverage on read, not stored.
 */
export async function getRoadmapData(
  sectionId: string,
): Promise<{ data?: AutoRoadmapData; error?: string; denied?: true }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    /* `denied` alongside the prose, not instead of it: client callers toast the
       message, while a page has to tell an ownership denial from a broken query.
       Reachable in normal use — the course layout admits an active TA/grader via
       verifySectionAccess, but this check is owner-only, so a TA legitimately
       inside the course lands here. A denial must 404, never offer a retry that
       cannot succeed (.claude/rules/dead-ends.md). */
    const { owned, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!owned) return { error: 'You do not own this course section', denied: true }

    // Query 1: Fetch all modules for section
    const { data: modules, error: modulesError } = await adminDb
      .from('modules')
      // is_published: a professor sees unpublished modules, so the roadmap has to
      // mark them — and exclude them from the delivery headline, which otherwise
      // counts an unpublished week as work not started.
      // system_kind: identifies the app's own container modules (quiz/classroom
      // uploads), whose files belong in the off-map bench — read instead of the
      // title, which a professor can rename.
      .select('id, title, description, week_number, position, is_published, system_kind')
      .eq('section_id', sectionId)
      .order('position', { ascending: true })

    if (modulesError) {
      logger.error('getRoadmapData: modules query failed', modulesError, { sectionId })
      return { error: 'Failed to load modules' }
    }

    const moduleIds = (modules || []).map((m: { id: string }) => m.id)

    // Items + links + resources in parallel. Professors see ALL resources
    // (drafts included).
    const [itemsResult, edgesResult, resourcesRaw, dividersResult] = await Promise.all([
      moduleIds.length > 0
        ? adminDb
            .from('module_items')
            // is_visible: a professor sees hidden items, so the roadmap has to mark
            // them — an unshared live-classroom upload must not look published.
            .select('id, module_id, item_type, title, description, position, content, is_visible')
            .in('module_id', moduleIds)
            .order('position', { ascending: true })
        : Promise.resolve({ data: [], error: null }),
      adminDb
        .from('roadmap_edges')
        .select('id, from_node_type, from_node_id, to_node_type, to_node_id, edge_type, position')
        .eq('section_id', sectionId),
      roadmapQueries.getSectionResources(adminDb, sectionId, { publishedOnly: false, includeAttendance: true }),
      // Module-level dividers — labelled breaks BETWEEN modules, on modules'
      // position scale (see reorderModules).
      adminDb
        .from('module_dividers')
        .select('id, title, position')
        .eq('section_id', sectionId)
        .order('position', { ascending: true }),
    ])

    if (itemsResult.error) {
      logger.error('getRoadmapData: items query failed', itemsResult.error, { sectionId })
      return { error: 'Failed to load module items' }
    }

    // Re-sign `content.fileUrl` from `content.filePath` so PDF/file
    // previews don't 400 with InvalidJWT. The URL persisted at upload
    // time is a 1-hour signed URL; course-materials is private (mig 48),
    // so every read path that surfaces these files must re-sign at
    // render time. Alongside, fetch the semantic skill→page hits from the
    // stored pgvector embeddings for the material-viewer reference rail.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawItems: any[] = itemsResult.data || []
    const items = await signModuleItemContent(rawItems)

    const resources = buildResourceNodes('professor', sectionId, resourcesRaw)

    const data = assembleRoadmapData(
      sectionId,
      modules || [],
      items,
      edgesResult.data || [],
      resources,
      dividersResult.data || [],
    )

    return { data }
  } catch (error) {
    logger.error('getRoadmapData', error)
    return { error: 'Unexpected error' }
  }
}

// ── Per-student journeys (professor student-progress view) ───────
//
// Read-only overlay data for the professor roadmap: for each enrolled
// student, a journey state per roadmap node (mastered / review-next /
// in-progress / not-started) derived from their Topic Mastery scores, plus a
// roster roll-up (overall mastery, quiz avg, per-state counts). The shared
// roadmap (V1) is untouched — this only powers the "Overlay journey" + roster.

export interface StudentJourneyRow {
  studentId: string
  name: string
  initials: string
  overall: 'excelling' | 'on_track' | 'needs_support' | 'not_started'
  masteryPct: number | null
  quizAvg: number | null
  counts: Record<JourneyState, number>
  /** Per-node journey keyed by canvas node key. */
  nodes: Record<string, NodeJourney>
}

export interface StudentJourneysData {
  weeks: JourneyWeekGroup[]
  students: StudentJourneyRow[]
  classStats: {
    classMastery: number | null
    excelling: number
    needsSupport: number
    classQuizAvg: number | null
    totalStudents: number
  }
}

/** Two-letter initials from a display name. */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

/**
 * Fetch every enrolled student's journey over the roadmap for a professor.
 * Read-only; ownership-verified. Mastery comes from each student's Topic Mastery
 * scores on the topics behind each node (no per-student writes here).
 */
export async function getStudentJourneys(
  sectionId: string,
): Promise<{ data?: StudentJourneysData; error?: string; denied?: true }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { owned, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!owned) return { error: 'You do not own this course section', denied: true }

    return { data: await buildJourneysData(adminDb, sectionId) }
  } catch (error) {
    logger.error('getStudentJourneys', error)
    return { error: 'Unexpected error' }
  }
}

/** The roster build itself, split off the action so the class-insight facts can
 *  reuse it without re-authenticating (and without a second copy of the quiz-
 *  average / journey-count definitions, which MUST match what the drawer shows
 *  — the narrative quotes them as its audit trail). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildJourneysData(adminDb: any, sectionId: string): Promise<StudentJourneysData> {
  // 1. Roster — enrolled students. ORDERED, and not cosmetically: this roster
  //    is what the class-insight facts hash is built over, and Postgres makes
  //    no promise about the order of an unordered read. A heap rewrite silently
  //    reshuffling the rows would flip the hash with no change in the data
  //    behind it — i.e. a model call on every drawer open, which is exactly the
  //    cost the hash cache exists to prevent.
  const { data: enrollments } = await adminDb
    .from('enrollments')
    .select('student_id, student:profiles(id, name)')
    .eq('section_id', sectionId)
    .in('status', ON_ROSTER_STATUSES)
    .order('student_id')

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resolveJoin = (val: any) => (Array.isArray(val) ? val[0] : val)
  const roster: { studentId: string; name: string }[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const e of (enrollments || []) as any[]) {
    const profile = resolveJoin(e.student)
    roster.push({ studentId: e.student_id, name: profile?.name || 'Unknown' })
  }

  // 2. Roadmap node structure, grouped by week — the SHARED builder, so the
  //    roster scores the same node universe as the student's own summary.
  const { weeks, nodeRefs } = await buildSectionJourneyRefs(adminDb, sectionId)

  // 3. Per-student quiz average — a separate roster stat (not the journey
  //    signal). Best score per (student, quiz) from their submitted attempts.
  const { data: attempts } = await adminDb
    .from('quiz_attempts')
    .select('student_id, quiz_id, score')
    .eq('section_id', sectionId)
    .eq('status', 'submitted')

  const bestByStudentQuiz = new Map<string, Map<string, number>>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const a of (attempts || []) as any[]) {
    const m = bestByStudentQuiz.get(a.student_id) ?? new Map<string, number>()
    const prev = m.get(a.quiz_id) ?? -1
    if ((a.score ?? -1) > prev) m.set(a.quiz_id, a.score ?? 0)
    bestByStudentQuiz.set(a.student_id, m)
  }

  // 3b. Each student's topic mastery from the curated Topic Mastery layer:
  //     the per-topic map colours nodes via the journey engine; the overall
  //     roll-up is the roster/headline figure, read from the scores DIRECTLY
  //     so it exists even when module items carry no topic labels (#493).
  const { scoresByStudent, overallByStudent } = await buildStudentMastery(adminDb, sectionId)

  // 4. Per-student explicit check-offs (roadmap_progress — dormant, read defensively).
  const { data: progressRows } = await adminDb
    .from('roadmap_progress')
    .select('student_id, progress')
    .eq('section_id', sectionId)

  const checkedOffByStudent = new Map<string, Set<string>>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const row of (progressRows || []) as any[]) {
    const set = checkedOffSetFrom(row.progress)
    if (set.size > 0) checkedOffByStudent.set(row.student_id, set)
  }

  // 5. Build a journey row per student. The per-node journey (map overlay +
  // state counts) stays label-matched — it is inherently about the nodes on
  // the map. The masteryPct/overall figures instead read the shared direct
  // roll-up, the same value the student's own page shows (#493).
  const students: StudentJourneyRow[] = roster.map(({ studentId, name }) => {
    const { nodes, summary } = journeyFromTopicAccuracy(
      nodeRefs,
      scoresByStudent.get(studentId) ?? new Map(),
      checkedOffByStudent.get(studentId) ?? new Set(),
    )

    const quizMap = bestByStudentQuiz.get(studentId)
    const quizScores = quizMap ? Array.from(quizMap.values()) : []
    const quizAvg = quizScores.length > 0
      ? Math.round(quizScores.reduce((s, v) => s + v, 0) / quizScores.length)
      : null

    const masteryPct = overallByStudent.get(studentId) ?? null

    return {
      studentId,
      name,
      initials: initialsOf(name),
      overall: overallFromMasteryPct(masteryPct),
      masteryPct,
      quizAvg,
      counts: summary.counts,
      nodes,
    }
  })

  // 6. Class stat strip.
  const masteries = students.map((s) => s.masteryPct).filter((p): p is number => p !== null)
  const quizAvgs = students.map((s) => s.quizAvg).filter((q): q is number => q !== null)
  const classStats = {
    classMastery: masteries.length > 0
      ? Math.round(masteries.reduce((a, b) => a + b, 0) / masteries.length)
      : null,
    excelling: students.filter((s) => s.overall === 'excelling').length,
    needsSupport: students.filter((s) => s.overall === 'needs_support').length,
    classQuizAvg: quizAvgs.length > 0
      ? Math.round(quizAvgs.reduce((a, b) => a + b, 0) / quizAvgs.length)
      : null,
    totalStudents: students.length,
  }

  return { weeks, students, classStats }
}

// ── Student dossier (professor roadmap · floating student card) ───
//
// The floating card a professor opens by selecting a student in the class
// lens: structured facts (mastery/quiz roll-ups, journey counts, weakest
// topics, late submissions, fumbled quiz questions) + an AI narrative.
// Facts are recomputed on every open (cheap, read-only); the narrative is
// hash-cached in `student_insight_summaries` (see lib/roadmap/dossier-facts
// — the single write path, shared with the class-refresh pipeline), and the
// stored row (facts + prose, versioned) doubles as a feed for Athena and
// the data-intelligence layer.

const CLASS_INSIGHTS_JOB_TYPE = 'regenerate_student_insights'
/** Manual whole-class refresh cooldown — matches Canvas New Analytics'
 *  daily refresh cadence, and caps the professor-triggerable LLM spend. */
const CLASS_INSIGHTS_COOLDOWN_HOURS = 24

export interface ClassRefreshState {
  /** A refresh job is pending or running right now. */
  active: boolean
  /** When the next manual refresh becomes available; null = available now. */
  cooldownUntil: string | null
  /** The latest run's terminal state — lets the card toast a failure instead
   *  of breaking the "you'll get a notification" promise silently. */
  lastStatus: 'done' | 'partial' | 'failed' | null
  /** The latest successful run's one-line outcome ("2 rewritten, 30 already
   *  current") — surfaced where the click happened, not only in the bell. */
  lastOutcome: string | null
}

export interface StudentDossierData {
  avatarUrl: string | null
  /** profiles.last_active_at — the throttled activity stamp; null = no signal yet. */
  lastActiveAt: string | null
  facts: DossierFacts
  /** Fresh cached narrative; null → caller should ask for generation. */
  summary: string | null
  summaryGeneratedAt: string | null
  classRefresh: ClassRefreshState
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const resolveJoin = (val: any) => (Array.isArray(val) ? val[0] : val)

/**
 * Shared guard for the dossier actions: professor owns the section AND the
 * student is on its roster. Also resolves the bits the actions need
 * (profile, institution, course title for the prompt).
 */
async function verifyDossierAccess(sectionId: string, studentId: string, userId: string) {
  const { owned, adminDb } = await verifyOwnership(sectionId, userId)
  if (!owned) return { error: 'You do not own this course section' as const }

  const [{ data: enrollment }, { data: section }] = await Promise.all([
    adminDb
      .from('enrollments')
      .select('student_id, student:profiles(name, avatar_url, last_active_at)')
      .eq('section_id', sectionId)
      .eq('student_id', studentId)
      .in('status', ON_ROSTER_STATUSES)
      .maybeSingle(),
    adminDb
      .from('course_sections')
      .select('institution_id, course:courses(title)')
      .eq('id', sectionId)
      .single(),
  ])
  if (!enrollment || !section) return { error: 'Student not found in this section' as const }

  const profile = resolveJoin(enrollment.student)
  return {
    adminDb,
    institutionId: section.institution_id as string,
    courseTitle: (resolveJoin(section.course)?.title as string) || 'this course',
    studentName: (profile?.name as string) || 'Unknown',
    avatarUrl: (profile?.avatar_url as string) ?? null,
    lastActiveAt: (profile?.last_active_at as string) ?? null,
  }
}

/** Refresh-button state for the card: cooldown from the latest NON-FAILED
 *  job in the window (failed runs don't consume it), activity + terminal
 *  outcome from the latest job of any status. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function classRefreshState(adminDb: any, sectionId: string): Promise<ClassRefreshState> {
  const windowStart = new Date(Date.now() - CLASS_INSIGHTS_COOLDOWN_HOURS * 3_600_000).toISOString()
  const [{ data: latest }, { data: lastGood }] = await Promise.all([
    adminDb
      .from('background_jobs')
      .select('status, summary, created_at')
      .eq('type', CLASS_INSIGHTS_JOB_TYPE)
      .eq('section_id', sectionId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    adminDb
      .from('background_jobs')
      .select('created_at')
      .eq('type', CLASS_INSIGHTS_JOB_TYPE)
      .eq('section_id', sectionId)
      .neq('status', 'failed')
      .gte('created_at', windowStart)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])
  const active = latest?.status === 'pending' || latest?.status === 'running'
  const lastStatus = latest && (latest.status === 'done' || latest.status === 'partial' || latest.status === 'failed')
    ? (latest.status as 'done' | 'partial' | 'failed')
    : null
  return {
    active,
    cooldownUntil: lastGood
      ? new Date(new Date(lastGood.created_at).getTime() + CLASS_INSIGHTS_COOLDOWN_HOURS * 3_600_000).toISOString()
      : null,
    lastStatus,
    lastOutcome: lastStatus && lastStatus !== 'failed' ? ((latest.summary as string | null) ?? null) : null,
  }
}

/**
 * Open the dossier: facts always, plus the cached narrative when it's still
 * fresh (facts hash unchanged) and the class-refresh button state. Read-only.
 */
export async function getStudentDossier(
  sectionId: string,
  studentId: string,
): Promise<{ data?: StudentDossierData; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const access = await verifyDossierAccess(sectionId, studentId, user.id)
    if ('error' in access) return { error: access.error }

    const [facts, refresh] = await Promise.all([
      collectDossierFacts(access.adminDb, sectionId, studentId),
      classRefreshState(access.adminDb, sectionId),
    ])

    const { data: cached } = await access.adminDb
      .from('student_insight_summaries')
      .select('summary, signal_hash, generated_at')
      .eq('section_id', sectionId)
      .eq('student_id', studentId)
      .maybeSingle()

    const fresh = cached && cached.signal_hash === factsHash(facts)
    return {
      data: {
        avatarUrl: access.avatarUrl,
        lastActiveAt: access.lastActiveAt,
        facts,
        summary: fresh ? cached.summary : null,
        summaryGeneratedAt: fresh ? cached.generated_at : null,
        classRefresh: refresh,
      },
    }
  } catch (error) {
    logger.error('getStudentDossier', error)
    return { error: 'Unexpected error' }
  }
}

/**
 * (Re)generate one student's narrative — the card's stale-on-open path.
 * Recomputes the facts server-side (the client's copy is untrusted); the
 * shared write path skips the model call when the stored hash matches.
 */
export async function generateStudentDossierSummary(
  sectionId: string,
  studentId: string,
): Promise<{ data?: { summary: string; generatedAt: string }; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const access = await verifyDossierAccess(sectionId, studentId, user.id)
    if ('error' in access) return { error: access.error }

    // Institution/platform AI kill switch.
    const aiVerdict = await checkAiFeature(access.adminDb, access.institutionId, 'roadmap-skills-ai')
    if (!aiVerdict.allowed) return { error: aiRefusalMessage(aiVerdict.lockedBy) }

    const { summary, generatedAt, regenerated } = await refreshStudentInsight(access.adminDb, {
      sectionId,
      studentId,
      studentName: access.studentName,
      courseTitle: access.courseTitle,
      institutionId: access.institutionId,
      userId: user.id,
    })

    if (regenerated) {
      void logEvent({
        userId: user.id,
        eventType: 'roadmap.dossier_summary_generated',
        sectionId,
        metadata: { studentId, model: STUDENT_INSIGHT_MODEL },
      })
    }

    return { data: { summary, generatedAt } }
  } catch (error) {
    logger.error('generateStudentDossierSummary', error)
    return { error: 'Could not generate the summary' }
  }
}

/**
 * The card's refresh button: queue a whole-class insights refresh (facts +
 * narratives for every enrolled student) as a background job. Hash-guarded
 * per student, so unchanged students cost nothing; cooldown-guarded per
 * section, so the professor can't stack LLM spend by re-clicking.
 */
export async function refreshClassInsights(
  sectionId: string,
): Promise<{ data?: { queued: true }; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { owned, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!owned) return { error: 'You do not own this course section' }

    const state = await classRefreshState(adminDb, sectionId)
    if (state.active) return { error: 'A refresh is already running — you\'ll get a notification when it finishes.' }
    if (state.cooldownUntil) {
      const hoursLeft = Math.max(1, Math.ceil((new Date(state.cooldownUntil).getTime() - Date.now()) / 3_600_000))
      return { error: `Insights were refreshed recently — you can refresh again in about ${hoursLeft}h.` }
    }

    const { data: section } = await adminDb
      .from('course_sections')
      .select('institution_id')
      .eq('id', sectionId)
      .single()
    if (!section) return { error: 'Section not found' }

    // Institution/platform AI kill switch — refuse before queueing LLM work.
    const aiVerdict = await checkAiFeature(adminDb, section.institution_id, 'roadmap-skills-ai')
    if (!aiVerdict.allowed) return { error: aiRefusalMessage(aiVerdict.lockedBy) }

    await enqueueJob({
      type: CLASS_INSIGHTS_JOB_TYPE,
      institutionId: section.institution_id,
      sectionId,
      createdBy: user.id,
    })

    void logEvent({
      userId: user.id,
      eventType: 'roadmap.class_insights_refresh_queued',
      sectionId,
    })

    return { data: { queued: true } }
  } catch (error) {
    logger.error('refreshClassInsights', error)
    return { error: 'Could not start the refresh' }
  }
}

/** Poll target for the card's loader while a class refresh runs. */
export async function getClassInsightsRefreshStatus(
  sectionId: string,
): Promise<{ data?: ClassRefreshState; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }
    const { owned, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!owned) return { error: 'You do not own this course section' }
    return { data: await classRefreshState(adminDb, sectionId) }
  } catch (error) {
    logger.error('getClassInsightsRefreshStatus', error)
    return { error: 'Unexpected error' }
  }
}

// ── Concept analytics (professor "Class analytics" → By concept) ─────
// The by-concept view of the same skill_mastery data the roadmap colours by:
// curated topics ranked weakest-first with class median / % proficient / at-risk
// and per-student distribution. Reads the curated hierarchy directly (not the
// node name-join), so it includes concepts that aren't pinned to a lecture node.

const METRIC_LABEL: Record<string, string> = {
  median: 'median',
  mean: 'average',
  percent_proficient: '% proficient',
}

export interface ConceptSource {
  type: ConceptSourceType
  id: string
  title: string
}

export interface ConceptAnalyticsData {
  view: SectionMasteryView
  topics: SkillRow[]
  masteryRows: MasteryDatum[]
  roster: Array<{ id: string; name: string }>
  metricLabel: string
  proficientThreshold: number
  atRiskThreshold: number
  /** skill_id → the quizzes/exams/assignments that assess it. */
  sources: Record<string, ConceptSource[]>
}

export async function getConceptAnalytics(
  sectionId: string,
): Promise<{ data?: ConceptAnalyticsData; error?: string; denied?: true }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { owned, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!owned) return { error: 'You do not own this course section', denied: true }

    return { data: await buildConceptAnalytics(adminDb, sectionId) }
  } catch (error) {
    logger.error('getConceptAnalytics', error, { sectionId })
    return { error: 'Unexpected error' }
  }
}

/** Split off the action for the same reason as buildJourneysData: the class
 *  narrative ranks skills from exactly the rows the "By skill" tab shows. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildConceptAnalytics(adminDb: any, sectionId: string): Promise<ConceptAnalyticsData> {
  const [allTopics, masteryRows, roster, sectionRes, activities, mappings] = await Promise.all([
    skillQueries.listSectionSkills(adminDb, sectionId),
    skillQueries.getSectionMasteryRows(adminDb, sectionId),
    skillQueries.getSectionRoster(adminDb, sectionId),
    adminDb.from('course_sections').select('settings').eq('id', sectionId).maybeSingle(),
    skillQueries.listSectionActivities(sectionId),
    skillQueries.getSectionActivitySkills(adminDb, sectionId),
  ])

  // skill_id → the activities that assess it (for the concept popover's "Assessed by").
  const titleByKey = new Map(activities.map((a) => [`${a.type}:${a.id}`, a.title]))
  const sources: Record<string, ConceptSource[]> = {}
  for (const m of mappings) {
    const title = titleByKey.get(`${m.activity_type}:${m.activity_id}`)
    if (!title) continue
    ;(sources[m.skill_id] ??= []).push({ type: m.activity_type, id: m.activity_id, title })
  }

  // Excluded (professor-dropped) and suppressed (AI-suggested, not yet
  // corroborated) skills stay in the pool for the curation modal but drop out
  // of the roadmap's mastery view + chips.
  const rows = allTopics.filter((t) => !t.excluded && !t.suppressed)
  const config = resolveSkillMasteryConfig(sectionRes.data?.settings)
  const view = aggregateSectionMastery(rows, masteryRows, config)
  return {
    view,
    topics: rows,
    masteryRows,
    roster,
    metricLabel: METRIC_LABEL[config.classMetric] ?? config.classMetric,
    proficientThreshold: config.proficientThreshold,
    atRiskThreshold: config.atRiskThreshold,
    sources,
  }
}

// ── Class insight (professor "Class analytics" → the AI summary) ─────
//
// The whole-class sibling of the dossier narrative, at the top of the drawer:
// one stored row per section (`class_insight_summaries`), hash-cached against a
// facts snapshot built from EXACTLY the two readers the drawer renders
// underneath it — so the tiles, the "By skill" tab and the roster are the
// prose's audit trail, and the model is asked again only when those move.

/** The snapshot, from the drawer's own two readers. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function collectClassFacts(adminDb: any, sectionId: string): Promise<ClassInsightFacts> {
  const [journeys, concepts] = await Promise.all([
    buildJourneysData(adminDb, sectionId),
    buildConceptAnalytics(adminDb, sectionId),
  ])

  /* the "By skill" tab's own ranking — scored skills weakest-first, with the
     at-risk head-count derived exactly as the tab derives it */
  const scored = concepts.view.ranked.filter((r) => r.classScore != null)
  const skills: ClassSkillFact[] = scored.map((r) => ({
    name: r.name,
    score: Math.round(r.classScore as number),
    atRisk: studentScoresForSkill(concepts.topics, concepts.masteryRows, concepts.roster, r.skillId)
      .filter((e) => e.score != null && e.score < concepts.atRiskThreshold).length,
  }))

  return buildClassInsightFacts(
    journeys.students,
    journeys.classStats,
    skills,
    concepts.view.ranked.length - scored.length,
  )
}

/**
 * The drawer's ONE call: return the stored narrative when the facts hash still
 * matches, otherwise write a fresh one. Facts are recomputed server-side (the
 * client's copy is untrusted) and the model is skipped on a hash match, so a
 * re-open costs nothing but the aggregation.
 *
 * Deliberately not split into a read action + a write action the way the
 * dossier is. The card renders the student's facts, so it needs them back; the
 * drawer renders `journeys`/`concepts` it already holds and discards the facts
 * entirely — a separate reader would just run the whole section aggregation a
 * second time on every cache miss for a value nobody looks at.
 */
export async function generateClassInsightSummary(
  sectionId: string,
): Promise<{ data?: { summary: string; generatedAt: string }; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }
    const { owned, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!owned) return { error: 'You do not own this course section' }

    const { data: section } = await adminDb
      .from('course_sections')
      .select('institution_id, course:courses(title)')
      .eq('id', sectionId)
      .single()
    if (!section) return { error: 'Section not found' }

    // Institution/platform AI kill switch.
    const aiVerdict = await checkAiFeature(adminDb, section.institution_id, 'roadmap-skills-ai')
    if (!aiVerdict.allowed) return { error: aiRefusalMessage(aiVerdict.lockedBy) }

    const facts = await collectClassFacts(adminDb, sectionId)

    // Refuse before spending a model call on nothing. Rule + rationale live in
    // classInsightBlocker, which is pure so it can be tested on its own.
    const blocker = classInsightBlocker(facts)
    if (blocker) return { error: blocker }

    const hash = signalHash(facts)

    const { data: cached } = await adminDb
      .from('class_insight_summaries')
      .select('summary, signal_hash, generated_at')
      .eq('section_id', sectionId)
      .maybeSingle()
    if (cached && cached.signal_hash === hash) {
      return { data: { summary: cached.summary, generatedAt: cached.generated_at } }
    }

    const summary = await generateClassInsight(
      facts,
      (resolveJoin(section.course)?.title as string) || 'this course',
      { institutionId: section.institution_id, sectionId, userId: user.id },
    )

    const generatedAt = new Date().toISOString()
    const { error: upsertError } = await adminDb
      .from('class_insight_summaries')
      .upsert({
        institution_id: section.institution_id,
        section_id: sectionId,
        summary,
        facts,
        signal_hash: hash,
        model: CLASS_INSIGHT_MODEL,
        generated_at: generatedAt,
      }, { onConflict: 'section_id' })
    if (upsertError) throw new Error(upsertError.message ?? 'class insight upsert failed')

    void logEvent({
      userId: user.id,
      eventType: 'roadmap.class_summary_generated',
      sectionId,
      metadata: { model: CLASS_INSIGHT_MODEL },
    })

    return { data: { summary, generatedAt } }
  } catch (error) {
    logger.error('generateClassInsightSummary', error, { sectionId })
    return { error: 'Could not generate the summary' }
  }
}

/**
 * Read-only preview of a quiz's questions for the roadmap node drawer.
 * Ownership-verified; display fields only (no answer key).
 */
export async function getNodeQuizQuestions(
  sectionId: string,
  quizId: string,
): Promise<{ data?: import('@/lib/supabase/queries').RoadmapDrawerQuestion[]; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }
    const { owned, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!owned) return { error: 'You do not own this course section' }
    const data = await roadmapQueries.getQuizQuestions(adminDb, sectionId, quizId)
    return { data }
  } catch (error) {
    logger.error('getNodeQuizQuestions', error)
    return { error: 'Unexpected error' }
  }
}

/**
 * Slice-2 professor aggregate signals for the triage engine (admin-only reads):
 * empirically poor quiz items (point-biserial, cached) + recent office-hour
 * booking volume. Verifies section ownership first. bookingRecent is the count
 * of the professor's bookings created in the last 7 days (bookings link to a
 * course, not a section/topic — so the engine picks the node to attach it to).
 */
export async function getProfessorAggregates(
  sectionId: string,
): Promise<{
  data?: {
    itemQuality: { quizTitle: string; questionLabel: string }[]
    bookingRecent: number
    masteryTrend: { skillId: string; from: number; to: number }[]
    noOpens: { title: string }[]
    openSpike: { title: string; count: number }[]
    reDownloads: { title: string; students: number }[]
    revisits: { title: string; students: number }[]
    clickThroughs: { title: string; students: number }[]
    quizActivity: { title: string; status: string; dueDate: string | null; inProgress: number }[]
    extrasCold: { title: string }[]
    spokenClaims: SpokenClaim[]
    deliveryDepth: DeliveryDepthSignal[]
  }
  error?: string
}> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }
    const { owned, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!owned) return { error: 'Not authorized' }

    const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()
    const items = await getSectionMaterialItems(adminDb, sectionId)
    // The quiz half of the deadline/draft signals. It lives here rather than in
    // getProfessorActivitySignals because every quiz table is RLS-deny-all: the
    // section-scoped client that query uses reads zero rows, so quiz signals only
    // work through this ownership-verified admin path.
    const [itemQuality, bookingRes, masteryTrend, openSignals, redownloadSignals, clickThroughSignals, quizRes, startedRes, transcriptSignals] = await Promise.all([
      getPoorQuizItems(adminDb, sectionId, { userId: user.id }),
      adminDb.from('bookings').select('id', { count: 'exact', head: true }).eq('professor_id', user.id).gte('created_at', since),
      getClassMasteryTrend(adminDb, sectionId),
      getSectionOpenSignals(adminDb, sectionId, items),
      getSectionRedownloadSignals(adminDb, sectionId, items),
      getSectionClickThroughSignals(adminDb, sectionId, items),
      adminDb.from('quizzes').select('id, title, status, due_date').eq('section_id', sectionId),
      adminDb.from('quiz_attempts').select('quiz_id').eq('section_id', sectionId).eq('status', 'in_progress'),
      // Slice 4 — the professor reads their own spoken claims unconditionally
      // (it is a read-back of their own speech; the RLS policy says the same).
      getTranscriptSignals(adminDb, sectionId, 'professor'),
    ])

    // P20 — supplementary material nobody has completed by either route.
    // `items` above is already the section's material list.
    const extras = items
      .filter((i: { itemType?: string; item_type?: string }) =>
        ['video', 'image', 'reference', 'link'].includes((i.itemType ?? i.item_type ?? '') as string))
      .map((i: { id: string; title?: string }) => ({ id: i.id, title: i.title ?? '' }))
      .filter((e: { title: string }) => e.title)
    const extrasCold = await getColdExtras(adminDb, sectionId, extras)
    const startedByQuiz = new Map<string, number>()
    for (const a of startedRes.data ?? []) startedByQuiz.set(a.quiz_id, (startedByQuiz.get(a.quiz_id) ?? 0) + 1)
    const quizActivity = (quizRes.data ?? []).map((q: { id: string; title: string; status: string; due_date: string | null }) => ({
      title: q.title, status: q.status, dueDate: q.due_date ?? null, inProgress: startedByQuiz.get(q.id) ?? 0,
    }))
    return {
      data: {
        itemQuality, bookingRecent: bookingRes.count ?? 0, masteryTrend,
        noOpens: openSignals.noOpens, openSpike: openSignals.openSpike,
        reDownloads: redownloadSignals.reDownloads,
        revisits: openSignals.revisits, clickThroughs: clickThroughSignals.clickThroughs,
        quizActivity, extrasCold,
        spokenClaims: transcriptSignals.spokenClaims, deliveryDepth: transcriptSignals.deliveryDepth,
      },
    }
  } catch (error) {
    logger.error('getProfessorAggregates', error, { sectionId })
    return { error: 'Failed to load aggregates' }
  }
}

/**
 * A professor's read-only view of one student's node check (§14.2).
 *
 * Read-only by construction: there is no write path for a professor into
 * node_check_* at all. Ownership-verified, and the student id is checked
 * against the section's roster so a professor can't read a stranger's row.
 */
export async function getStudentNodeCheck(
  sectionId: string,
  moduleItemId: string,
  studentId: string,
): Promise<{ data?: NodeCheckReview | null; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }
    const { owned, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!owned) return { error: 'Not authorized' }

    /* Filter on STATUS too, not just the row's existence: an enrollments row
       survives a drop or withdrawal, so without this a dropped student's check
       stayed readable. ON_ROSTER_STATUSES is the same pair every other roster
       reader gates on, so "on this roster" means one thing app-wide. */
    const { data: enrolled } = await adminDb
      .from('enrollments')
      .select('id')
      .eq('section_id', sectionId)
      .eq('student_id', studentId)
      .in('status', ON_ROSTER_STATUSES)
      .maybeSingle()
    if (!enrolled) return { error: 'Student is not on this roster' }

    return { data: await getNodeCheckReview(adminDb, { sectionId, moduleItemId, studentId }) }
  } catch (error) {
    logger.error('getStudentNodeCheck', error, { sectionId, moduleItemId })
    return { error: 'Could not load the check' }
  }
}
