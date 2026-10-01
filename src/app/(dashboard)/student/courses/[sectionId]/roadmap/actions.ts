'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import { logEvent } from '@/lib/supabase/event-logger'
import { assembleRoadmapData, buildResourceNodes } from '@/lib/roadmap/auto-roadmap-helpers'
import { isUnlockPending, lockedModuleIds } from '@/lib/modules/unlock'
import { roadmapQueries } from '@/lib/supabase/queries'
import { signModuleItemContent } from '@/lib/supabase/signed-urls'
import { normalizeTopicKey } from '@/lib/roadmap/journey-state'
import { buildStudentMastery } from '@/lib/skills/roadmap-mastery'
import { applyNodeCheckPassToSkillMastery } from '@/lib/skills/grade-hook'
import { noImprovementByQuiz, slowWrongQuizIds, absenceGapMatches } from '@/lib/roadmap/aggregates'
import { getSectionMaterialItems, getOwnMasteryTrend, getStudentEngagement } from '@/lib/roadmap/engagement'
import { getTranscriptSignals } from '@/lib/roadmap/transcript-signals'
import type { SpokenClaim, DeliveryDepthSignal } from '@/lib/roadmap/triage'
import { ON_ROSTER_STATUSES } from '@/lib/validations/enrollment'
import { skillQueries } from '@/lib/supabase/queries'
import {
  gradeNodeCheck,
  getNodeCheckForStudent,
  type NodeCheckState,
} from '@/lib/roadmap/node-check'
import type { AutoRoadmapData } from '@/lib/validations/auto-roadmap'
import { isArtifactKind, type ArtifactState, type AthenaArtifactView } from '@/lib/athena/artifact-kinds'

// ── Helpers ──────────────────────────────────────────────────────

/** Node keys are free-form JSONB keys, but a module-item key is a real uuid —
 *  checked before it reaches a uuid column, where a non-uuid errors the query. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function getAuthUser() {
  const supabase = await createClient()
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) return null
  return user
}

/** Confirm the caller is actively enrolled in the section. Returns the admin client. */
async function verifyEnrollment(sectionId: string, userId: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any
  const { data } = await adminDb
    .from('enrollments')
    .select('id')
    .eq('section_id', sectionId)
    .eq('student_id', userId)
    .in('status', ON_ROSTER_STATUSES)
    .maybeSingle()
  return { enrolled: !!data, adminDb }
}

// ── Actions ──────────────────────────────────────────────────────

/**
 * Fetch auto-generated roadmap data for an enrolled student.
 * Only returns published modules and visible items.
 * Students have no write actions — statuses are read-only.
 */
export async function getRoadmapData(
  sectionId: string,
): Promise<{ data?: AutoRoadmapData; error?: string; denied?: true }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    const enrollmentResult = await adminDb
      .from('enrollments')
      .select('id')
      .eq('section_id', sectionId)
      .eq('student_id', user.id)
      // The shared read boundary — same pair as the enrollments RLS policy and
      // the course layout's gate, so this can't be looser than the layout that
      // already let the student in.
      .in('status', ON_ROSTER_STATUSES)
      .single()

    /* `denied` alongside the message, not instead of it: other callers toast the
       prose, while the page needs to tell an authorization denial from a broken
       query — a denial is notFound(), never a "try again" the reader can't fix. */
    if (!enrollmentResult.data) return { error: 'Not enrolled in this course', denied: true }

    // Query 1: Fetch published modules only
    const { data: modules, error: modulesError } = await adminDb
      .from('modules')
      // system_kind so the adapter routes container-module files to the bench by
      // marker rather than by title (a student sees the published container).
      // unlock_date so a week the class hasn't reached yet assembles as a locked
      // shell — title only, contents stripped (assembleRoadmapData).
      .select('id, title, description, week_number, position, system_kind, unlock_date')
      .eq('section_id', sectionId)
      .eq('is_published', true)
      .order('position', { ascending: true })

    if (modulesError) {
      logger.error('student getRoadmapData: modules query failed', modulesError, { sectionId })
      return { error: 'Failed to load modules' }
    }

    /* A locked week's items are stripped from the DTO anyway, so don't fetch them
       — that also keeps signed file URLs from being minted for material the
       student can't open yet. */
    const locked = lockedModuleIds(modules || [])
    const openModuleIds = (modules || []).map((m: { id: string }) => m.id).filter((id: string) => !locked.has(id))

    // Visible items + links + resources in parallel.
    const [itemsResult, edgesResult, resourcesRaw, dividersResult] = await Promise.all([
      openModuleIds.length > 0
        ? adminDb
            .from('module_items')
            .select('id, module_id, item_type, title, description, position, content')
            .in('module_id', openModuleIds)
            .eq('is_visible', true)
            .order('position', { ascending: true })
        : Promise.resolve({ data: [], error: null }),
      adminDb
        .from('roadmap_edges')
        .select('id, from_node_type, from_node_id, to_node_type, to_node_id, edge_type, position')
        .eq('section_id', sectionId),
      // Students see only published quizzes/assignments; sessions are always real (no drafts).
      // includeAttendance surfaces the live-session roster (names) so the facepile
      // shows classmates who joined — a class roster, deliberately visible to peers.
      roadmapQueries.getSectionResources(adminDb, sectionId, { publishedOnly: true, includeAttendance: true }),
      // Module-level dividers — course structure, same for both roles.
      adminDb
        .from('module_dividers')
        .select('id, title, position')
        .eq('section_id', sectionId)
        .order('position', { ascending: true }),
    ])

    if (itemsResult.error) {
      logger.error('student getRoadmapData: items query failed', itemsResult.error, { sectionId })
      return { error: 'Failed to load module items' }
    }

    // Re-sign `content.fileUrl` from `content.filePath` so PDF/file
    // previews don't 400 with InvalidJWT. The URL persisted at upload
    // time is a 1-hour signed URL and goes stale immediately after.
    // course-materials has been private since migration 48; every read
    // path that surfaces these files must re-sign at render time. The
    // student modules page does this; we missed the roadmap. The reference
    // rail's topic→page anchors ride along on each item's own content, written
    // when the material was indexed — no extra query here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawItems: any[] = itemsResult.data || []
    const items = await signModuleItemContent(rawItems)

    const resources = buildResourceNodes('student', sectionId, resourcesRaw)

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
    logger.error('student getRoadmapData', error)
    return { error: 'Unexpected error' }
  }
}

/**
 * The logged-in student's own concept detail for the roadmap material viewer:
 * one entry per CURATED topic (mirrors the professor map so non-pool node topics
 * stay blank) keyed by normalised name — the student's own score (or null) and
 * which quizzes/assignments assess it — plus whether the AI Tutor is enabled
 * (gates the "Study with AI Tutor" link), and the student's overall
 * `masteryPct` — the SAME direct skill-score roll-up the professor's roster
 * reads (buildStudentMastery), so the figure a student reads is the figure
 * their professor reads for them, and it exists whenever scores exist —
 * even on a course whose module items carry no topic labels (#493).
 */
export async function getMyConceptScores(
  sectionId: string,
): Promise<{
  data?: { concepts: Record<string, { score: number | null; assessedBy: { title: string; type: string; id: string }[] }>; aiTutorEnabled: boolean; masteryPct: number | null }
  error?: string
}> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    const [mastery, sectionRes, topics, activities, mappings] = await Promise.all([
      buildStudentMastery(adminDb, sectionId),
      adminDb.from('course_sections').select('settings').eq('id', sectionId).maybeSingle(),
      skillQueries.listSectionSkills(adminDb, sectionId),
      // Student-facing: drafts must not surface their titles (see the option's doc).
      skillQueries.listSectionActivities(sectionId, { publishedOnly: true }),
      skillQueries.getSectionActivitySkills(adminDb, sectionId),
    ])

    const mine = mastery.scoresByStudent.get(user.id) ?? new Map<string, number>()

    // Which quizzes/assignments assess each topic id (titles).
    const titleByKey = new Map(activities.map((a) => [`${a.type}:${a.id}`, a.title]))
    const assessedByTopicId = new Map<string, { title: string; type: string; id: string }[]>()
    for (const m of mappings) {
      const title = titleByKey.get(`${m.activity_type}:${m.activity_id}`)
      if (!title) continue
      const arr = assessedByTopicId.get(m.skill_id) ?? []
      arr.push({ title, type: m.activity_type, id: m.activity_id })
      assessedByTopicId.set(m.skill_id, arr)
    }

    const concepts: Record<string, { score: number | null; assessedBy: { title: string; type: string; id: string }[] }> = {}
    for (const t of topics) {
      const key = normalizeTopicKey(t.name)
      concepts[key] = {
        score: mine.get(key) ?? null,
        assessedBy: assessedByTopicId.get(t.id) ?? [],
      }
    }

    const settings = sectionRes.data?.settings as { enabledFeatures?: unknown } | null
    const enabled = Array.isArray(settings?.enabledFeatures) ? (settings.enabledFeatures as string[]) : []
    const aiTutorEnabled = enabled.includes('athena')

    return { data: { concepts, aiTutorEnabled, masteryPct: mastery.overallByStudent.get(user.id) ?? null } }
  } catch (error) {
    logger.error('getMyConceptScores', error)
    return { error: 'Unexpected error' }
  }
}

/**
 * Toggle the calling student's explicit check-off for one roadmap node.
 * Writes only the student's own roadmap_progress row (RLS-scoped to them).
 */
export async function setMyNodeCheckedOff(
  sectionId: string,
  nodeId: string,
  checkedOff: boolean,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }
    // Bound the key: it's the student's own RLS-scoped row, but cap length so a
    // scripted caller can't grow the JSONB with arbitrarily large keys.
    if (!nodeId || nodeId.length > 200) return { error: 'Invalid node' }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    // Atomic merge: one `insert … on conflict … do update set progress =
    // jsonb_set(…)` statement (see migration 20260619143157). Avoids the
    // read-merge-write lost-update race where two concurrent toggles to
    // different nodes would clobber each other.
    const { error: rpcError } = await adminDb.rpc('roadmap_set_node_checkoff', {
      p_section_id: sectionId,
      p_student_id: user.id,
      p_node_id: nodeId,
      p_checked_off: checkedOff,
    })

    if (rpcError) {
      logger.error('setMyNodeCheckedOff: rpc failed', rpcError, { sectionId, nodeId })
      return { error: 'Failed to save your progress' }
    }

    /* Un-ticking has to clear a passed quick check as well. getStudentCoverage
       unions TWO sources into completedExtras — roadmap_progress.checkedOff and
       getPassedNodeChecks — so clearing only the flag left the node complete via
       the other half, and Undo silently did nothing: the week's percentage and the
       headline never moved, and a reload still offered "Undo".

       Only `passed` is reset; `answers` and `tries` stay, so the professor's
       per-student review (§14.2) still shows what they actually picked, and the
       check becomes answerable again — which is what Undo claims. Guarded on a
       UUID because nodeId is a free-form JSONB key here (bounded at 200 chars),
       and a non-UUID would make Postgres reject the comparison outright. */
    if (!checkedOff && UUID_RE.test(nodeId)) {
      const { error: clearError } = await adminDb
        .from('node_check_attempts')
        .update({ passed: false, updated_at: new Date().toISOString() })
        .eq('section_id', sectionId)
        .eq('student_id', user.id)
        .eq('module_item_id', nodeId)
      // Non-fatal: the tick itself is already saved. Report success rather than
      // telling the student their undo failed when half of it landed.
      if (clearError) {
        logger.error('setMyNodeCheckedOff: clearing the passed check failed', clearError, { sectionId, nodeId })
      }
    }

    logEvent({
      userId: user.id,
      eventType: 'roadmap.node_checked_off',
      eventCategory: 'student',
      metadata: { sectionId, nodeId, checkedOff },
    })
    revalidatePath(`/student/courses/${sectionId}/roadmap`)
    return { success: true }
  } catch (error) {
    logger.error('setMyNodeCheckedOff', error)
    return { error: 'Unexpected error' }
  }
}

/**
 * Read-only preview of a quiz's questions for the roadmap node drawer.
 * Enrolment-verified; display fields only (no answer key).
 */
export async function getNodeQuizQuestions(
  sectionId: string,
  quizId: string,
): Promise<{ data?: import('@/lib/supabase/queries').RoadmapDrawerQuestion[]; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }
    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }
    // Students may only preview PUBLISHED quizzes — never a draft's question text
    // (section-scoped, but a draft in their own section must stay hidden pre-release).
    const { data: quiz } = await adminDb
      .from('quizzes')
      .select('status')
      .eq('id', quizId)
      .eq('section_id', sectionId)
      .maybeSingle()
    if (!quiz || quiz.status !== 'published') return { data: [] }
    const data = await roadmapQueries.getQuizQuestions(adminDb, sectionId, quizId)
    return { data }
  } catch (error) {
    logger.error('getNodeQuizQuestions', error)
    return { error: 'Unexpected error' }
  }
}

/**
 * Student activity signals for the roadmap triage engine — the student's own
 * deadlines + completion state. Runs through the admin client after verifying
 * enrollment (NOT the RLS client): quiz tables are deliberately RLS-deny-all so
 * every read enforces release/timing rules in app code — a direct student
 * select would bypass that. This returns only completion + due dates (never a
 * score value or explanations), so it respects the quiz release gate.
 */
export async function getStudentActivity(
  sectionId: string,
): Promise<{
  data?: {
    assignments: Array<{ title: string; dueAt: string | null; mySubmission: string | null }>
    quizzes: Array<{ title: string; dueDate: string | null; completed: boolean }>
  }
  error?: string
}> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }
    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    const [aRes, qRes, attRes] = await Promise.all([
      // published AND closed: an overdue assignment moves to 'closed' (see
      // assignments_status_check), and excluding it here undercounts exactly the
      // assignments a struggling student is most likely to have missed.
      adminDb.from('assignments').select('id, title, due_at').eq('section_id', sectionId).in('status', ['published', 'closed']),
      adminDb.from('quizzes').select('id, title, due_date').eq('section_id', sectionId).eq('status', 'published'),
      adminDb.from('quiz_attempts').select('quiz_id, status').eq('section_id', sectionId).eq('student_id', user.id),
    ])

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const aRows = (aRes.data ?? []) as any[]
    const aIds = aRows.map((a) => a.id as string)
    // Narrow the student's submissions to THIS section's assignments (their own
    // rows either way, but no reason to pull every course's submissions).
    const subRes = aIds.length
      ? await adminDb.from('assignment_submissions').select('assignment_id, status').eq('student_id', user.id).in('assignment_id', aIds)
      : { data: [] }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const subByAssignment = new Map<string, string>((subRes.data ?? []).map((s: any) => [s.assignment_id, s.status]))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const completedQuizzes = new Set((attRes.data ?? []).filter((a: any) => a.status === 'submitted').map((a: any) => a.quiz_id))

    const assignments = aRows.map((a) => ({
      title: a.title as string, dueAt: (a.due_at as string) ?? null, mySubmission: subByAssignment.get(a.id) ?? null,
    }))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const quizzes = (qRes.data ?? []).map((q: any) => ({
      title: q.title as string, dueDate: (q.due_date as string) ?? null, completed: completedQuizzes.has(q.id),
    }))
    return { data: { assignments, quizzes } }
  } catch (error) {
    logger.error('getStudentActivity', error, { sectionId })
    return { error: 'Failed to load activity' }
  }
}

/**
 * Slice-2 student aggregate signals (admin-only reads, enrollment-verified):
 * attempts-without-improvement (C10), slow-and-wrong (C7), and absence gap (C3).
 * The arithmetic runs in pure helpers (src/lib/roadmap/aggregates.ts); this only
 * gathers the rows and shapes the results. Strictly self-scoped: every attempt/
 * answer/mastery read filters by the authenticated student; session reports are
 * read only to check THIS student's absence + the class concept labels (no other
 * student's data leaves the action).
 */
export async function getStudentAggregates(
  sectionId: string,
): Promise<{
  data?: {
    noImprovement: { title: string; attempts: number }[]
    slowWrong: { title: string; skill: string }[]
    absenceGap: { sessionTitle: string; topic: string }[]
    masteryTrend: { skillName: string; from: number; to: number }[]
    newSinceVisit: { title: string }[]
    youAreHere?: { title: string }
    spokenClaims: SpokenClaim[]
    deliveryDepth: DeliveryDepthSignal[]
  }
  error?: string
}> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }
    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    const [attemptsRes, quizzesRes] = await Promise.all([
      adminDb.from('quiz_attempts').select('id, quiz_id, score, started_at').eq('section_id', sectionId).eq('student_id', user.id).eq('status', 'submitted'),
      adminDb.from('quizzes').select('id, title').eq('section_id', sectionId),
    ])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const attempts = (attemptsRes.data ?? []) as any[]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const quizTitle = new Map<string, string>(((quizzesRes.data ?? []) as any[]).map((q) => [q.id, q.title]))

    // C10 — attempts without improvement
    const noImprovement = noImprovementByQuiz(
      attempts.map((a) => ({ quizId: a.quiz_id, score: a.score == null ? null : Number(a.score), startedAt: a.started_at })),
    ).map((x) => ({ title: quizTitle.get(x.quizId) ?? '', attempts: x.attempts })).filter((x) => x.title)

    // C7 — slow AND wrong (quiz granularity: standard quizzes map skills per-quiz)
    let slowWrong: { title: string; skill: string }[] = []
    if (attempts.length) {
      const attemptToQuiz = new Map<string, string>(attempts.map((a) => [a.id, a.quiz_id]))
      const { data: ans } = await adminDb
        .from('quiz_answers').select('attempt_id, question_id, is_correct, time_spent_seconds').in('attempt_id', attempts.map((a) => a.id))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const answers = (ans ?? []) as any[]
      const qIds = [...new Set(answers.map((a) => a.question_id))]
      const { data: qs } = qIds.length
        ? await adminDb.from('quiz_questions').select('id, expected_time_seconds').in('id', qIds)
        : { data: [] }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const expected = new Map<string, number | null>(((qs ?? []) as any[]).map((q) => [q.id, q.expected_time_seconds]))
      const slowIds = slowWrongQuizIds(
        answers.map((a) => ({ attemptId: a.attempt_id, questionId: a.question_id, isCorrect: a.is_correct, timeSpent: a.time_spent_seconds ?? 0 })),
        attemptToQuiz,
        expected,
      )
      if (slowIds.size) {
        const ids = [...slowIds]
        const { data: acts } = await adminDb.from('activity_skills').select('activity_id, skill_id').eq('activity_type', 'quiz').in('activity_id', ids)
        const skillIdByQuiz = new Map<string, string>()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const a of (acts ?? []) as any[]) if (!skillIdByQuiz.has(a.activity_id)) skillIdByQuiz.set(a.activity_id, a.skill_id)
        const skillIds = [...new Set(skillIdByQuiz.values())]
        const { data: sk } = skillIds.length ? await adminDb.from('skills').select('id, name').in('id', skillIds) : { data: [] }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const skillName = new Map<string, string>(((sk ?? []) as any[]).map((s) => [s.id, s.name]))
        slowWrong = ids
          .map((qid) => ({ title: quizTitle.get(qid) ?? '', skill: skillName.get(skillIdByQuiz.get(qid) ?? '') ?? '' }))
          .filter((x) => x.title && x.skill)
      }
    }

    // C3 — absence gap: a missed session whose struggle concepts hit a weak skill
    let absenceGap: { sessionTitle: string; topic: string }[] = []
    const { data: rooms } = await adminDb.from('lc_rooms').select('id, name').eq('section_id', sectionId).eq('status', 'ended')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const roomRows = (rooms ?? []) as any[]
    if (roomRows.length) {
      const roomName = new Map<string, string>(roomRows.map((r) => [r.id, r.name]))
      const [reportsRes, masteryRes] = await Promise.all([
        adminDb.from('lc_session_reports').select('room_id, report').in('room_id', roomRows.map((r) => r.id)),
        adminDb.from('skill_mastery').select('skill_id, score').eq('section_id', sectionId).eq('student_id', user.id),
      ])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const weakIds = ((masteryRes.data ?? []) as any[]).filter((m) => m.score != null && Number(m.score) < 60).map((m) => m.skill_id)
      const { data: sk } = weakIds.length ? await adminDb.from('skills').select('name').in('id', weakIds) : { data: [] }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const weakNames = ((sk ?? []) as any[]).map((s) => s.name as string)
      const missed: { title: string; concepts: string[] }[] = []
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const r of (reportsRes.data ?? []) as any[]) {
        const report = r.report ?? {}
        const absent = (report.attendance?.absent ?? []) as { id: string }[]
        if (!absent.some((a) => a.id === user.id)) continue // only sessions THIS student missed
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const concepts = ((report.struggleConcepts ?? []) as any[]).map((c) => c.concept).filter(Boolean)
        const title = roomName.get(r.room_id)
        if (title) missed.push({ title, concepts })
      }
      absenceGap = absenceGapMatches(missed, weakNames)
    }

    // Slice 3 — own mastery trend (from snapshots) + engagement (you-are-here / new-since)
    const items = await getSectionMaterialItems(adminDb, sectionId, { skipLocked: true })
    const [masteryTrend, engagement, transcriptSignals] = await Promise.all([
      getOwnMasteryTrend(adminDb, sectionId, user.id),
      getStudentEngagement(adminDb, sectionId, user.id, items),
      // Slice 4 — S20/S21/S22/S23. The reader applies the student gate (ended
      // rooms + the replay toggle, G14); nothing here is another student's data.
      getTranscriptSignals(adminDb, sectionId, 'student'),
    ])

    return {
      data: {
        noImprovement, slowWrong, absenceGap,
        masteryTrend, newSinceVisit: engagement.newSinceVisit, youAreHere: engagement.youAreHere,
        spokenClaims: transcriptSignals.spokenClaims, deliveryDepth: transcriptSignals.deliveryDepth,
      },
    }
  } catch (error) {
    logger.error('getStudentAggregates', error, { sectionId })
    return { error: 'Failed to load aggregates' }
  }
}

// ── Node checks (Part II slice 2b) ───────────────────────────────
//
// The short comprehension check on supplementary material
// (docs/designs/roadmap-mastery/roadmap-engine.md §14). The pool and the answer key live behind
// these enrolment-verified actions: `node_check_questions` has no student RLS
// policy, so the browser cannot read an answer even by asking PostgREST
// directly, and grading happens server-side.

/** Resolve the section's institution — node-check rows are tenant-scoped. */
async function institutionOf(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminDb: any,
  sectionId: string,
): Promise<string | null> {
  const { data } = await adminDb
    .from('course_sections')
    .select('institution_id')
    .eq('id', sectionId)
    .maybeSingle()
  return data?.institution_id ?? null
}

/** Most ids the map can be watching at once — a bound on the `in()` below, not a
 *  real limit: a student can only have opened so many nodes in one sitting. */
const BAKING_POLL_MAX_IDS = 40

/**
 * Of these items, which still have their quick check being written?
 *
 * The map shows a node as "writing you a few questions" while its pool job runs,
 * and that job notifies nobody — so the client has to look again. This is what it
 * asks. It exists so the watcher does NOT call `router.refresh()`: that re-runs
 * the roadmap's whole assembly (modules, items, signed URLs, coverage, mastery)
 * every few seconds AND re-mounts the hand-drawn annotation layer, so every
 * margin note on the map blinked out and replayed its pen strokes on each tick.
 *
 * Read-only and cheap: one indexed `in()` over ids the caller already holds.
 * `itemIds` comes straight from the client, so the section join is the boundary —
 * an enrolled student passing another course's ids gets them filtered out, not
 * answered. Returns only ids still 'pending'; anything else (ready, failed,
 * not_quizzable, or not in this section at all) is simply absent, which the
 * caller reads as "stop saying it".
 */
export async function getMyBakingNodes(
  sectionId: string,
  itemIds: string[],
): Promise<{ data?: string[]; error?: string }> {
  try {
    const ids = itemIds.filter((id) => UUID_RE.test(id)).slice(0, BAKING_POLL_MAX_IDS)
    if (ids.length === 0) return { data: [] }
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }
    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    const { data, error } = await adminDb
      .from('module_items')
      .select('id, modules!inner(section_id)')
      .in('id', ids)
      .eq('modules.section_id', sectionId)
      /* Same visibility predicate `itemInSection` applies. Without it a student
         holding a stale id could still learn that a since-hidden item has a job in
         flight — one bit, no content, but the sibling guard on this column sets the
         stricter precedent and drift between the two is how a real gap starts. */
      .eq('is_visible', true)
      .eq('node_check_state', 'pending')
    if (error) {
      logger.error('getMyBakingNodes: query failed', error, { sectionId })
      return { error: 'Could not check' }
    }
    return { data: ((data ?? []) as { id: string }[]).map((r) => r.id) }
  } catch (error) {
    logger.error('getMyBakingNodes', error, { sectionId })
    return { error: 'Could not check' }
  }
}

export async function getMyNodeCheck(
  sectionId: string,
  moduleItemId: string,
): Promise<{ data?: NodeCheckState; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }
    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    // The item must belong to THIS section — otherwise an enrolled student
    // could read any course's check by passing a foreign item id.
    const institutionId = await institutionOf(adminDb, sectionId)
    if (!institutionId) return { error: 'Course not found' }
    if (!(await itemInSection(adminDb, moduleItemId, sectionId))) {
      return { error: 'Item not found in this course' }
    }

    return {
      data: await getNodeCheckForStudent(adminDb, {
        sectionId, institutionId, moduleItemId, studentId: user.id,
      }),
    }
  } catch (error) {
    logger.error('getMyNodeCheck', error, { sectionId, moduleItemId })
    return { error: 'Could not load the check' }
  }
}

export async function submitMyNodeCheck(
  sectionId: string,
  moduleItemId: string,
  answers: (number | null)[],
): Promise<{ data?: { passed: boolean; correct: number; total: number }; error?: string }> {
  try {
    if (!Array.isArray(answers) || answers.length > 10) return { error: 'Invalid answers' }
    const clean = answers.map((a) => (typeof a === 'number' && a >= 0 && a <= 3 ? a : null))

    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }
    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }
    if (!(await itemInSection(adminDb, moduleItemId, sectionId))) {
      return { error: 'Item not found in this course' }
    }

    const result = await gradeNodeCheck(adminDb, {
      sectionId, moduleItemId, studentId: user.id, answers: clean,
    })
    if (!result) return { error: 'No check to submit' }

    /* The quiz door's "small mastery boost" — first pass ONLY (the grader's
       false→true transition), so re-submitting after a pass can't stack it.
       Best-effort by design: the hook never throws, and a boost that fails
       must not fail the submission that earned it. */
    if (result.firstPass) {
      await applyNodeCheckPassToSkillMastery({ sectionId, studentId: user.id, moduleItemId })
    }

    await logEvent({
      userId: user.id,
      eventType: 'roadmap.node_check_submitted',
      eventCategory: 'student',
      sectionId,
      metadata: { moduleItemId, passed: result.passed, correct: result.correct, firstPass: result.firstPass },
    })
    revalidatePath(`/student/courses/${sectionId}/roadmap`)
    /* The client sees the tally only — `firstPass` is bookkeeping, not UI. */
    return { data: { passed: result.passed, correct: result.correct, total: result.total } }
  } catch (error) {
    logger.error('submitMyNodeCheck', error, { sectionId, moduleItemId })
    return { error: 'Could not submit the check' }
  }
}

/**
 * Guard: this item is one the student may actually see in this section.
 *
 * Section scope alone is not enough. Without the publish/visibility predicates
 * a student could name a HIDDEN item, or one in an unpublished module, and have
 * the generator write questions from its description and extracted concepts —
 * a machine-made paraphrase of material the professor deliberately withheld.
 * Mirrors getMyItemPages, which already gates this way. The type filter keeps
 * lecture extraction out of the generator entirely: only supplementary material
 * offers a check (EXTRA_KINDS in RoadmapPrototype).
 */
const CHECKABLE_ITEM_TYPES = ['video', 'image', 'reference', 'link']

async function itemInSection(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminDb: any,
  moduleItemId: string,
  sectionId: string,
): Promise<boolean> {
  const { data } = await adminDb
    .from('module_items')
    .select('id, modules!inner(section_id, is_published, unlock_date)')
    .eq('id', moduleItemId)
    .eq('modules.section_id', sectionId)
    .eq('modules.is_published', true)
    .eq('is_visible', true)
    .in('item_type', CHECKABLE_ITEM_TYPES)
    .maybeSingle()
  if (!data) return false
  /* A week that hasn't opened is not checkable either. This guard takes an item id
     straight from the client, and passing a locked one would run a paid LLM job over
     that item's content, write `node_check_state`, and hand back questions generated
     from material the class hasn't reached. The roadmap DTO no longer ships those
     ids — but a professor pushing an already-open week's date back (the "Change the
     date…" flow) leaves students holding ids that were legitimate a moment ago. */
  const mod = Array.isArray(data.modules) ? data.modules[0] : data.modules
  return !isUnlockPending(mod?.unlock_date)
}

// ── Athena artifacts (the margin notes she leaves on the map) ────

/**
 * This student's own Athena-generated study artifacts for the section, newest
 * first. Personal by construction: the query is keyed by the VERIFIED user id,
 * so no one ever reads another student's notes. Rows whose kind the app no
 * longer knows are dropped rather than rendered broken.
 */
export async function getMyRoadmapArtifacts(
  sectionId: string,
): Promise<{ data?: AthenaArtifactView[]; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }
    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    const { data, error } = await adminDb
      .from('athena_artifacts')
      .select('id, kind, title, module_id, payload, state, created_at, archived_at')
      .eq('section_id', sectionId)
      .eq('student_id', user.id)
      .order('created_at', { ascending: false })
      .limit(50)
    if (error) {
      logger.error('getMyRoadmapArtifacts: query failed', error, { sectionId })
      return { error: 'Failed to load your study notes' }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const views = ((data ?? []) as any[])
      .filter((r) => isArtifactKind(r.kind))
      .map((r) => ({
        id: r.id as string,
        kind: r.kind as AthenaArtifactView['kind'],
        title: r.title as string,
        moduleId: r.module_id as string,
        payload: (r.payload ?? {}) as AthenaArtifactView['payload'],
        state: (r.state ?? {}) as AthenaArtifactView['state'],
        createdAt: r.created_at as string,
        archivedAt: (r.archived_at ?? null) as string | null,
      }))
    return { data: views }
  } catch (error) {
    logger.error('getMyRoadmapArtifacts', error, { sectionId })
    return { error: 'Unexpected error' }
  }
}

/**
 * Persist the student's interaction state on one of THEIR artifacts (ticked
 * steps, locked-in answers). Ownership lives in the UPDATE's own WHERE — zero
 * rows means "not yours or not there", one atomic statement either way.
 */
export async function saveMyArtifactState(
  sectionId: string,
  artifactId: string,
  state: ArtifactState,
): Promise<{ success?: true; error?: string }> {
  try {
    if (!UUID_RE.test(artifactId)) return { error: 'Invalid artifact' }
    // Bound the blob: indexes and small maps only — nothing here should
    // approach a kilobyte, so reject anything that could bloat the row.
    const clean: ArtifactState = {}
    if (Array.isArray(state?.done)) {
      clean.done = state.done.filter((n) => Number.isInteger(n) && n >= 0 && n < 100).slice(0, 100)
    }
    if (state?.answers && typeof state.answers === 'object') {
      const answers: Record<string, number> = {}
      for (const [k, v] of Object.entries(state.answers).slice(0, 50)) {
        if (/^\d{1,2}$/.test(k) && Number.isInteger(v) && v >= 0 && v < 10) answers[k] = v
      }
      clean.answers = answers
    }

    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }
    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    const { data, error } = await adminDb
      .from('athena_artifacts')
      .update({ state: clean, updated_at: new Date().toISOString() })
      .eq('id', artifactId)
      .eq('section_id', sectionId)
      .eq('student_id', user.id)
      .select('id')
    if (error) {
      logger.error('saveMyArtifactState: update failed', error, { sectionId, artifactId })
      return { error: 'Could not save your progress' }
    }
    if (!data?.length) return { error: 'Not found' }

    await logEvent({
      userId: user.id,
      eventType: 'athena_artifact_state_saved',
      eventCategory: 'student',
      sectionId,
      metadata: { artifactId },
    })
    /* Deliberately NO revalidatePath: the widget owns this state optimistically
       and the row is only read on the next page load — revalidating here made
       every checklist tick refetch the whole (heavy) roadmap page behind the
       open modal. */
    return { success: true }
  } catch (error) {
    logger.error('saveMyArtifactState', error, { sectionId, artifactId })
    return { error: 'Unexpected error' }
  }
}

/** Park one of the student's own artifacts in the Archive tray (or put it
 *  back on the map). Same atomic ownership-in-WHERE shape as the state save —
 *  nothing is destroyed here; permanent delete lives in `deleteMyArtifact`. */
export async function setMyArtifactArchived(
  sectionId: string,
  artifactId: string,
  archived: boolean,
): Promise<{ success?: true; error?: string }> {
  try {
    if (!UUID_RE.test(artifactId)) return { error: 'Invalid artifact' }
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }
    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    const { data, error } = await adminDb
      .from('athena_artifacts')
      .update({ archived_at: archived ? new Date().toISOString() : null, updated_at: new Date().toISOString() })
      .eq('id', artifactId)
      .eq('section_id', sectionId)
      .eq('student_id', user.id)
      .select('id')
    if (error) {
      logger.error('setMyArtifactArchived: update failed', error, { sectionId, artifactId, archived })
      return { error: archived ? 'Could not archive it' : 'Could not restore it' }
    }
    if (!data?.length) return { error: 'Not found' }

    await logEvent({
      userId: user.id,
      eventType: archived ? 'athena_artifact_archived' : 'athena_artifact_restored',
      eventCategory: 'student',
      sectionId,
      metadata: { artifactId },
    })
    revalidatePath(`/student/courses/${sectionId}/roadmap`)
    return { success: true }
  } catch (error) {
    logger.error('setMyArtifactArchived', error, { sectionId, artifactId, archived })
    return { error: 'Unexpected error' }
  }
}

/** Permanently delete one of the student's own artifacts — offered only from
 *  inside the Archive tray. Same atomic ownership-in-WHERE shape. */
export async function deleteMyArtifact(
  sectionId: string,
  artifactId: string,
): Promise<{ success?: true; error?: string }> {
  try {
    if (!UUID_RE.test(artifactId)) return { error: 'Invalid artifact' }
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }
    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    const { data, error } = await adminDb
      .from('athena_artifacts')
      .delete()
      .eq('id', artifactId)
      .eq('section_id', sectionId)
      .eq('student_id', user.id)
      .select('id')
    if (error) {
      logger.error('deleteMyArtifact: delete failed', error, { sectionId, artifactId })
      return { error: 'Could not remove it' }
    }
    if (!data?.length) return { error: 'Not found' }

    await logEvent({
      userId: user.id,
      eventType: 'athena_artifact_deleted',
      eventCategory: 'student',
      sectionId,
      metadata: { artifactId },
    })
    revalidatePath(`/student/courses/${sectionId}/roadmap`)
    return { success: true }
  } catch (error) {
    logger.error('deleteMyArtifact', error, { sectionId, artifactId })
    return { error: 'Unexpected error' }
  }
}
