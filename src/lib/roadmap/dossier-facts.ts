import 'server-only'

/**
 * Student dossier facts + the single write path for `student_insight_summaries`.
 *
 * Shared by the roadmap's dossier server actions (one student, on card open)
 * and the `regenerate_student_insights` background pipeline (whole roster, on
 * the professor's refresh click). Pure aggregations live in `dossier.ts`
 * (client-safe); this module owns the DB reads, the signal hash and the
 * generate-then-upsert, so the two callers can never drift on what a
 * "fresh" summary means.
 */

import { createHash } from 'node:crypto'
import { buildStudentMastery, buildSectionJourneyRefs, checkedOffSetFrom, type StudentMasteryMaps } from '@/lib/skills/roadmap-mastery'
import { journeyFromTopicAccuracy } from '@/lib/roadmap/journey-state'
import { generateStudentInsight } from '@/lib/ai/student-insight'
import { STUDENT_INSIGHT_MODEL } from '@/lib/ai/config'
import {
  aggregateFumbles,
  collectLateAssignments,
  collectLateQuizzes,
  collectWeakestSkills,
  materialOpenRates,
  DOSSIER_FACTS_VERSION,
  DOSSIER_MAX_FUMBLES,
  DOSSIER_MAX_LATES,
  type DossierFacts,
  type DossierMaterialOpens,
} from '@/lib/roadmap/dossier'
import { getSectionMaterialItems } from '@/lib/roadmap/engagement'
import { readAllPages } from '@/lib/supabase/paged-read'
import { ON_ROSTER_STATUSES } from '@/lib/validations/enrollment'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminDb = any

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const resolveJoin = (val: any) => (Array.isArray(val) ? val[0] : val)

/** Stable content hash of the facts snapshot — the regeneration key.
 *  The CLASS-WIDE comparison figures are deliberately zeroed out of the hash:
 *  they move whenever ANY student is graded or opens a file, so hashing them
 *  would invalidate the whole section's cached summaries (N model calls on the
 *  next roster walk) for figures the card's live tiles already show. */
export function factsHash(facts: DossierFacts): string {
  return signalHash({ ...facts, classMasteryPct: null, classMaterialsOpenedPct: null })
}

/** The bare content hash, for the other insight snapshots that carry no
 *  class-wide figures to zero out (the class summary's own facts). */
export function signalHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** The section-wide inputs every student's facts share. The class-refresh
 *  pipeline loads these ONCE for the whole roster instead of per student. */
export interface SectionInsightShared {
  masteryMaps: StudentMasteryMaps
  refs: Awaited<ReturnType<typeof buildSectionJourneyRefs>>
  /** Per-student material-open rate + the roster mean it's compared against. */
  opens: { byStudent: Map<string, DossierMaterialOpens>; classPct: number | null }
}

export async function loadSectionInsightShared(adminDb: AdminDb, sectionId: string): Promise<SectionInsightShared> {
  /* readAllPages returns the rows directly (not a { data } envelope) */
  const [masteryMaps, refs, items, { data: enrollments }, viewEvents] = await Promise.all([
    buildStudentMastery(adminDb, sectionId),
    buildSectionJourneyRefs(adminDb, sectionId),
    /* The DENOMINATOR of the open rate, so it must be exactly what a student
       can open: published module, visible item, week already unlocked — the
       same gate logMaterialEvent applies before recording an open. Anything
       looser understates every student's rate in one direction. */
    getSectionMaterialItems(adminDb, sectionId, { skipLocked: true, publishedVisibleOnly: true }),
    adminDb
      .from('enrollments')
      .select('student_id')
      .eq('section_id', sectionId)
      .in('status', ON_ROSTER_STATUSES),
    /* Completeness is load-bearing here: this feeds a class MEAN and a
       per-student rate the AI narrates, and PostgREST clamps any .limit() to
       max_rows (1000) without saying so — a plain bounded read would silently
       drop the oldest opens and understate the earliest-engaging students. */
    readAllPages<{ user_id: string; metadata: { itemId?: string } | null }>(
      () => adminDb
        .from('events')
        .select('user_id, metadata')
        .eq('section_id', sectionId)
        .eq('event_type', 'material.viewed'),
      'id',
      'dossierFacts.materialOpens',
    ),
  ])

  const opens = materialOpenRates(
    viewEvents
      .map((e) => ({ studentId: e.user_id, itemId: e.metadata?.itemId ?? '' }))
      .filter((e) => e.studentId && e.itemId),
    items.map((i) => i.id),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((enrollments || []) as any[]).map((e) => e.student_id as string),
  )

  return { masteryMaps, refs, opens }
}

/** Recompute one student's facts snapshot from raw rows — read-only. */
export async function collectDossierFacts(
  adminDb: AdminDb,
  sectionId: string,
  studentId: string,
  shared?: SectionInsightShared,
): Promise<DossierFacts> {
  const [{ masteryMaps, refs, opens }, attemptsRes, subsRes, answersRes, topicsRes, topicScoresRes, progressRes] = await Promise.all([
    shared ? Promise.resolve(shared) : loadSectionInsightShared(adminDb, sectionId),
    adminDb
      .from('quiz_attempts')
      .select('quiz_id, score, is_late, late_by_seconds, quiz:quizzes(title)')
      .eq('section_id', sectionId)
      .eq('student_id', studentId)
      .eq('status', 'submitted')
      .limit(500),
    adminDb
      .from('assignment_submissions')
      .select('submitted_at, assignment:assignments!inner(title, due_at, section_id)')
      .eq('student_id', studentId)
      .eq('assignment.section_id', sectionId)
      .not('submitted_at', 'is', null)
      .limit(500),
    adminDb
      .from('quiz_answers')
      .select('question_id, is_correct, question:quiz_questions(question_text, quiz:quizzes(title)), attempt:quiz_attempts!inner(student_id, section_id, status)')
      .eq('attempt.student_id', studentId)
      .eq('attempt.section_id', sectionId)
      .eq('attempt.status', 'submitted')
      .limit(2000),
    adminDb.from('skills').select('id, name, excluded, suppressed').eq('section_id', sectionId),
    adminDb.from('skill_mastery').select('skill_id, score').eq('section_id', sectionId).eq('student_id', studentId),
    adminDb.from('roadmap_progress').select('progress').eq('section_id', sectionId).eq('student_id', studentId).limit(1),
  ])

  // Quiz average — best score per quiz, same definition as the roster.
  const bestByQuiz = new Map<string, number>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const a of (attemptsRes.data || []) as any[]) {
    if (a.score == null) continue
    bestByQuiz.set(a.quiz_id, Math.max(bestByQuiz.get(a.quiz_id) ?? 0, a.score))
  }
  const quizScores = Array.from(bestByQuiz.values())
  const quizAvg = quizScores.length > 0
    ? Math.round(quizScores.reduce((s, v) => s + v, 0) / quizScores.length)
    : null

  // Journey state counts — the same engine that colours the map's nodes.
  const checkedOff = checkedOffSetFrom(progressRes.data?.[0]?.progress)
  const { summary } = journeyFromTopicAccuracy(
    refs.nodeRefs,
    masteryMaps.scoresByStudent.get(studentId) ?? new Map(),
    checkedOff,
  )

  // Class mastery for the "vs class" comparison in the narrative.
  const overalls = Array.from(masteryMaps.overallByStudent.values())
  const classMasteryPct = overalls.length > 0
    ? Math.round(overalls.reduce((s, v) => s + v, 0) / overalls.length)
    : null

  // Full (uncapped) lists first — the facts carry TRUE totals plus a capped
  // display list, so the tile never understates a student with many lates.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lateAssignments = collectLateAssignments(((subsRes.data || []) as any[]).map((s) => {
    const a = resolveJoin(s.assignment)
    return { title: a?.title ?? null, dueAt: a?.due_at ?? null, submittedAt: s.submitted_at }
  }), Number.MAX_SAFE_INTEGER)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lateQuizzes = collectLateQuizzes(((attemptsRes.data || []) as any[]).map((a) => ({
    title: resolveJoin(a.quiz)?.title ?? null,
    isLate: !!a.is_late,
    lateBySeconds: a.late_by_seconds,
  })), Number.MAX_SAFE_INTEGER)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fumbled = aggregateFumbles(((answersRes.data || []) as any[]).map((r) => {
    const q = resolveJoin(r.question)
    return {
      questionId: r.question_id,
      isCorrect: r.is_correct,
      questionText: q?.question_text ?? null,
      quizTitle: resolveJoin(q?.quiz)?.title ?? null,
    }
  }), Number.MAX_SAFE_INTEGER)

  return {
    version: DOSSIER_FACTS_VERSION,
    masteryPct: masteryMaps.overallByStudent.get(studentId) ?? null,
    classMasteryPct,
    quizAvg,
    counts: summary.counts,
    weakestSkills: collectWeakestSkills(topicsRes.data ?? [], topicScoresRes.data ?? []),
    materialsOpened: opens.byStudent.get(studentId) ?? { opened: 0, total: 0, pct: null },
    classMaterialsOpenedPct: opens.classPct,
    lateCount: lateAssignments.length + lateQuizzes.length,
    fumbledCount: fumbled.length,
    lateAssignments: lateAssignments.slice(0, DOSSIER_MAX_LATES),
    lateQuizzes: lateQuizzes.slice(0, DOSSIER_MAX_LATES),
    fumbledQuestions: fumbled.slice(0, DOSSIER_MAX_FUMBLES),
  }
}

export interface RefreshInsightInput {
  sectionId: string
  studentId: string
  studentName: string
  courseTitle: string
  institutionId: string
  /** Attribution for the cost ledger — the professor who triggered it. */
  userId?: string | null
  /** Section-wide inputs, precomputed once when refreshing a whole roster. */
  shared?: SectionInsightShared
  /** Facts already computed by the caller (skips the recompute). */
  facts?: DossierFacts
}

/**
 * The generate-then-upsert: recompute (or accept) the facts, skip the model
 * when the stored hash already matches, otherwise write the narrative row
 * that the card, Athena and the data-intelligence layer read.
 * Throws on model failure — callers degrade to numbers-without-prose.
 */
export async function refreshStudentInsight(
  adminDb: AdminDb,
  input: RefreshInsightInput,
): Promise<{ summary: string; generatedAt: string; regenerated: boolean }> {
  const facts = input.facts ?? await collectDossierFacts(adminDb, input.sectionId, input.studentId, input.shared)
  const hash = factsHash(facts)

  const { data: cached } = await adminDb
    .from('student_insight_summaries')
    .select('summary, signal_hash, generated_at')
    .eq('section_id', input.sectionId)
    .eq('student_id', input.studentId)
    .maybeSingle()
  if (cached && cached.signal_hash === hash) {
    return { summary: cached.summary, generatedAt: cached.generated_at, regenerated: false }
  }

  const summary = await generateStudentInsight(facts, input.studentName, input.courseTitle, {
    institutionId: input.institutionId,
    sectionId: input.sectionId,
    userId: input.userId ?? undefined,
  })

  const generatedAt = new Date().toISOString()
  const { error: upsertError } = await adminDb
    .from('student_insight_summaries')
    .upsert({
      institution_id: input.institutionId,
      section_id: input.sectionId,
      student_id: input.studentId,
      summary,
      facts,
      signal_hash: hash,
      model: STUDENT_INSIGHT_MODEL,
      generated_at: generatedAt,
    }, { onConflict: 'section_id,student_id' })
  if (upsertError) throw new Error(upsertError.message ?? 'insight upsert failed')

  return { summary, generatedAt, regenerated: true }
}
