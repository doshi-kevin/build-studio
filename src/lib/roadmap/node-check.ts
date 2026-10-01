import 'server-only'

/**
 * Node checks — dealing and grading (docs/designs/roadmap-mastery/roadmap-engine.md §14).
 *
 * The security shape of this file is the whole point:
 *
 * - **A student never receives `answer_index`.** They get five question bodies
 *   and their choices; grading happens here, server-side, against the pool.
 *   `node_check_questions` has no student RLS policy at all, so even a direct
 *   PostgREST call returns nothing.
 * - **A student never writes their own result.** `node_check_attempts` is
 *   SELECT-only for clients; `passed` is set here after scoring. A writable
 *   policy would let them PATCH `passed = true` and skip the questions.
 *
 * Callers must have verified enrolment (student) or ownership (professor)
 * before calling — every function here takes an admin client.
 */

import { logger } from '@/lib/logger'
import { logEvent } from '@/lib/supabase/event-logger'
import { enqueueJob } from '@/lib/jobs/enqueue'
import { NODE_CHECK_DEAL, NODE_CHECK_PASS } from '@/lib/ai/config'
import { NODE_CHECK_POOL_JOB_TYPE } from '@/lib/jobs/pipelines/node-check-pool'
import { checkAiFeature } from '@/lib/ai/kill-switch'

/** One dealt question as a STUDENT sees it — no answer key. */
export interface DealtQuestion {
  id: string
  prompt: string
  choices: string[]
  /** Their current selection, if they've answered before. */
  selected: number | null
}

export type NodeCheckState =
  /** Generating — the first student to open it triggered the job. */
  | { kind: 'preparing' }
  /** Nothing worth testing here; the node falls back to a self check-off (§14.1). */
  | { kind: 'not_quizzable' }
  /** Ready to answer (or re-answer). */
  | { kind: 'ready'; questions: DealtQuestion[]; passed: boolean; tries: number }

type PoolRow = { id: string; prompt: string; choices: unknown; answer_index: number }

/** Fisher–Yates over a copy; the deal is random PER STUDENT to blunt sharing. */
function pickFive<T>(rows: T[], n: number): T[] {
  const a = [...rows]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a.slice(0, n)
}

const asChoices = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : [])

/**
 * The student's view of an item's check, generating the pool on first ask.
 *
 * Their five questions are dealt once and then fixed (§14.2) — re-reading this
 * returns the same five, so a retry is the same check rather than a reroll
 * until an easy draw appears.
 */
export async function getNodeCheckForStudent(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminDb: any,
  params: { sectionId: string; institutionId: string; moduleItemId: string; studentId: string },
): Promise<NodeCheckState> {
  const { sectionId, institutionId, moduleItemId, studentId } = params

  /* Section-scoped through the module join, like every other statement here. The
     caller runs itemInSection first, but that is the same "the guard lives in the
     caller" argument this file rejects elsewhere — and this pair is the one that
     WRITES (node_check_state below) and spends money on a model call, so it is the
     last place to rely on someone else having checked. */
  const { data: item } = await adminDb
    .from('module_items')
    .select('id, node_check_state, node_check_pool_version, modules!inner(section_id)')
    .eq('id', moduleItemId)
    .eq('modules.section_id', sectionId)
    .maybeSingle()

  /* No row for this (item, section) pair — nothing to offer, and nothing to
     generate. Distinct from a genuinely unquizzable item only in cause; the
     student-visible outcome is the same self check-off either way. */
  if (!item) return { kind: 'not_quizzable' }

  const state = (item?.node_check_state ?? 'none') as string
  if (state === 'not_quizzable') return { kind: 'not_quizzable' }

  // A failed generation is TERMINAL for the student path. Retrying here meant
  // an item that fails persistently (bad key, provider outage) enqueued a fresh
  // LLM job on every 3-second poll for as long as the card stayed open. The
  // student loses nothing: 'not_quizzable' renders the self check-off, which is
  // the same fallback a genuinely unquizzable item gets.
  if (state === 'failed') return { kind: 'not_quizzable' }

  if (state === 'none') {
    // Institution/platform AI kill switch — don't flip state or enqueue a model
    // call. 'not_quizzable' renders the same self check-off fallback, and state
    // stays 'none' so the node generates normally once AI is re-enabled.
    const aiVerdict = await checkAiFeature(adminDb, institutionId, 'roadmap-skills-ai')
    if (!aiVerdict.allowed) return { kind: 'not_quizzable' }
    // First student to open this node pays for the generation — in latency, not
    // in money worth worrying about. `subjectKey` dedups, so a class opening the
    // same node at once still enqueues one job.
    /* Guarded on the state we just read as well as the id: two students opening
       the same node together would otherwise both flip it and both enqueue (the
       job's `subjectKey` dedups, but the write should not race either). */
    await adminDb
      .from('module_items')
      .update({ node_check_state: 'pending' })
      .eq('id', moduleItemId)
      .eq('node_check_state', 'none')
    try {
      await enqueueJob({
        type: NODE_CHECK_POOL_JOB_TYPE,
        params: { moduleItemId },
        institutionId,
        sectionId,
        subjectKey: moduleItemId,
        createdBy: studentId,
      })
      /* Audit the spend. This read MUTATES (`node_check_state` → pending) and
         enqueues a paid model call, so without this the only record of who
         triggered it is background_jobs.created_by. */
      await logEvent({
        userId: studentId,
        eventType: 'roadmap.node_check_pool_requested',
        eventCategory: 'student',
        sectionId,
        metadata: { moduleItemId },
      })
    } catch (error) {
      // Reset so the next opener retries rather than staring at "preparing".
      logger.error('getNodeCheckForStudent: enqueue failed', error, { moduleItemId })
      await adminDb.from('module_items').update({ node_check_state: 'none' }).eq('id', moduleItemId)
    }
    return { kind: 'preparing' }
  }
  if (state === 'pending') return { kind: 'preparing' }

  /* Default 0 to match the column's own DB default (NOT NULL DEFAULT 0, migration
     20260725024723) rather than a hopeful 1. Reaching this line means the state is
     'ready', and the generator bumps the version to (previous ?? 0) + 1 *before*
     flipping the state — so a ready item is always ≥ 1 and the fallback never
     actually decides anything. Disagreeing with the DB default only left an
     off-by-one waiting for whoever changes the state gate above. */
  const poolVersion = item?.node_check_pool_version ?? 0

  /* `section_id` on the statement itself, not only in the caller's itemInSection
     check — same defence-in-depth rule as getNodeCheckReview and gradeNodeCheck. */
  const { data: attempt } = await adminDb
    .from('node_check_attempts')
    .select('question_ids, answers, passed, tries, pool_version')
    .eq('module_item_id', moduleItemId)
    .eq('student_id', studentId)
    .eq('section_id', sectionId)
    .maybeSingle()

  let questionIds: string[] = attempt?.pool_version === poolVersion ? (attempt.question_ids ?? []) : []

  if (questionIds.length === 0) {
    const { data: pool } = await adminDb
      .from('node_check_questions')
      .select('id')
      .eq('section_id', sectionId)
      .eq('module_item_id', moduleItemId)
      .eq('pool_version', poolVersion)
    const ids = ((pool ?? []) as { id: string }[]).map((r) => r.id)
    // 'ready' with an empty pool is a broken state, not a slow one — polling
    // would spin forever. Fall back to the tick.
    if (ids.length === 0) return { kind: 'not_quizzable' }

    questionIds = pickFive(ids, NODE_CHECK_DEAL)
    // Re-deal on a regenerated pool, but KEEP a prior pass: a student shouldn't
    // lose a tick because the professor replaced the file (§14.2).
    await adminDb.from('node_check_attempts').upsert(
      {
        institution_id: institutionId,
        section_id: sectionId,
        module_item_id: moduleItemId,
        student_id: studentId,
        question_ids: questionIds,
        answers: [],
        passed: attempt?.passed ?? false,
        tries: attempt?.tries ?? 0,
        pool_version: poolVersion,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'module_item_id,student_id' },
    )
  }

  const { data: rows } = await adminDb
    .from('node_check_questions')
    .select('id, prompt, choices')
    .eq('section_id', sectionId)
    .in('id', questionIds)

  const byId = new Map(((rows ?? []) as PoolRow[]).map((r) => [r.id, r]))
  const answers = (attempt?.answers ?? []) as (number | null)[]
  /* Hand back stored picks ONLY once the attempt has passed.
     Be precise about what this does and does not buy. It closes the *UI* leak
     NodeCheckPanel was already trying to close: the panel clears picks after a
     failed submit so the tally can't be read as a per-question oracle, but that
     was client-side only, and closing and reopening the card restored all five —
     undoing the defence for anyone clicking through the app.

     It does NOT make the check un-brute-forceable, and nothing here could. The
     grader returns `correct` alongside `passed`, and retries are deliberately
     unlimited (§14.2), so a scripted caller — which already knows the answers it
     just submitted and never needed them echoed back — can still flip one index
     per request and read the ±1. That is accepted, with eyes open: since the
     optional-check redesign a FIRST pass does feed mastery, but only as one
     deliberately tiny, per-item-capped nudge (NODE_CHECK_MASTERY_WEIGHT — the
     row is UNIQUE per student+item, `passed` never regresses, and `firstPass`
     keys the boost), so the most a brute-forcer can farm is the same small
     bump an honest pass earns. It still joins to no grade. */
  const keepAnswers = !!attempt?.passed

  // All-or-nothing on purpose. Dropping just the missing ones would renumber
  // the client's array while gradeNodeCheck still scores answers[i] against
  // questionIds[i] — every answer would then be marked against the wrong
  // question. If any dealt row has gone, treat the deal as unusable.
  const questions: DealtQuestion[] = []
  for (const [i, id] of questionIds.entries()) {
    const r = byId.get(id)
    if (!r) { questions.length = 0; break }
    questions.push({
      id,
      prompt: r.prompt,
      choices: asChoices(r.choices),
      selected: keepAnswers ? (answers[i] ?? null) : null,
    })
  }

  // The deal exists but its rows are gone (a pool regenerated out from under
  // it). Nothing to answer, so offer the tick.
  if (questions.length === 0) return { kind: 'not_quizzable' }

  return {
    kind: 'ready',
    questions,
    passed: !!attempt?.passed,
    tries: attempt?.tries ?? 0,
  }
}

export interface GradeResult {
  passed: boolean
  correct: number
  total: number
  /** True ONLY on the submission that flipped `passed` false→true. The mastery
   *  boost keys off this, so re-submitting after a pass can never re-apply it. */
  firstPass: boolean
}

/**
 * Score a submission against the pool and persist the outcome.
 *
 * Scoring reads `answer_index` here and returns only the tally — the client is
 * told how many it got right, never which ones, so the check can't be
 * brute-forced one question at a time. (It can still be brute-forced by
 * resubmitting whole sets; that is accepted — see the §14.2 warning.)
 */
export async function gradeNodeCheck(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminDb: any,
  /* `sectionId` is defence in depth, matching getNodeCheckReview. The calling
     action already runs itemInSection first, so today the guard lives entirely in
     the caller — one refactor away from these statements addressing an attempt or
     an answer key in another section. Scoping the statements themselves costs a
     predicate. */
  params: { sectionId: string; moduleItemId: string; studentId: string; answers: (number | null)[] },
): Promise<GradeResult | null> {
  const { sectionId, moduleItemId, studentId, answers } = params

  const { data: attempt } = await adminDb
    .from('node_check_attempts')
    .select('question_ids, passed, tries')
    .eq('module_item_id', moduleItemId)
    .eq('student_id', studentId)
    .eq('section_id', sectionId)
    .maybeSingle()

  const questionIds = (attempt?.question_ids ?? []) as string[]
  if (questionIds.length === 0) return null

  const { data: rows } = await adminDb
    .from('node_check_questions')
    .select('id, answer_index')
    .eq('section_id', sectionId)
    .in('id', questionIds)

  const keyById = new Map(((rows ?? []) as { id: string; answer_index: number }[]).map((r) => [r.id, r.answer_index]))

  let correct = 0
  questionIds.forEach((id, i) => {
    const key = keyById.get(id)
    if (key !== undefined && answers[i] === key) correct++
  })

  // Once passed, stay passed — a later wrong answer shouldn't revoke a tick.
  const wasPassed = attempt?.passed ?? false
  const passed = wasPassed || correct >= NODE_CHECK_PASS

  await adminDb
    .from('node_check_attempts')
    .update({
      answers: answers.slice(0, questionIds.length),
      passed,
      tries: (attempt?.tries ?? 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('module_item_id', moduleItemId)
    .eq('student_id', studentId)
    .eq('section_id', sectionId)

  return { passed, correct, total: questionIds.length, firstPass: passed && !wasPassed }
}

/** One question as the PROFESSOR reviews it — with the key and what was picked. */
export interface ReviewedQuestion {
  prompt: string
  choices: string[]
  answerIndex: number
  selected: number | null
}

export interface NodeCheckReview {
  questions: ReviewedQuestion[]
  passed: boolean
  tries: number
}

/**
 * A professor's read-only view of one student's check (§14.2): the five
 * questions they were dealt, what they picked, and the result. Read-only by
 * construction — there is no write path for a professor here at all.
 *
 * Caller must have verified section ownership.
 */
export async function getNodeCheckReview(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminDb: any,
  params: { sectionId: string; moduleItemId: string; studentId: string },
): Promise<NodeCheckReview | null> {
  // `sectionId` is REQUIRED, not decoration. The caller has verified the
  // professor owns this section and that the student is on its roster, but
  // `moduleItemId` still arrives from the client — without this predicate a
  // professor could name an item from another course the same student is
  // enrolled in and read its answer key and their attempt.
  const { data: attempt } = await adminDb
    .from('node_check_attempts')
    .select('question_ids, answers, passed, tries')
    .eq('module_item_id', params.moduleItemId)
    .eq('student_id', params.studentId)
    .eq('section_id', params.sectionId)
    .maybeSingle()

  const questionIds = (attempt?.question_ids ?? []) as string[]
  if (questionIds.length === 0) return null

  const { data: rows } = await adminDb
    .from('node_check_questions')
    .select('id, prompt, choices, answer_index')
    .eq('section_id', params.sectionId)
    .in('id', questionIds)

  const byId = new Map(((rows ?? []) as PoolRow[]).map((r) => [r.id, r]))
  const answers = (attempt?.answers ?? []) as (number | null)[]

  const questions = questionIds
    .map((id, i) => {
      const r = byId.get(id)
      if (!r) return null
      return {
        prompt: r.prompt,
        choices: asChoices(r.choices),
        answerIndex: r.answer_index,
        selected: answers[i] ?? null,
      }
    })
    .filter((q): q is ReviewedQuestion => q !== null)

  return { questions, passed: !!attempt?.passed, tries: attempt?.tries ?? 0 }
}

/** module_items.id → this student passed its check. Feeds the coverage %. */
export async function getPassedNodeChecks(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminDb: any,
  sectionId: string,
  studentId: string,
): Promise<Set<string>> {
  const { data } = await adminDb
    .from('node_check_attempts')
    .select('module_item_id')
    .eq('section_id', sectionId)
    .eq('student_id', studentId)
    .eq('passed', true)

  return new Set(((data ?? []) as { module_item_id: string }[]).map((r) => r.module_item_id))
}

/**
 * P20 — supplementary material NO student has completed, by either route
 * (a passed check or a self check-off). The engagement twin of P1, for material
 * the professor never presents.
 *
 * Class-wide, so professor-only; the caller must have verified ownership.
 */
export async function getColdExtras(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminDb: any,
  sectionId: string,
  extras: { id: string; title: string }[],
): Promise<{ title: string }[]> {
  if (extras.length === 0) return []

  const ids = extras.map((e) => e.id)
  const [passedRes, progressRes] = await Promise.all([
    adminDb
      .from('node_check_attempts')
      .select('module_item_id')
      .eq('section_id', sectionId)
      .eq('passed', true)
      .in('module_item_id', ids),
    adminDb.from('roadmap_progress').select('progress').eq('section_id', sectionId),
  ])

  const touched = new Set<string>(
    ((passedRes.data ?? []) as { module_item_id: string }[]).map((r) => r.module_item_id),
  )
  // Check-offs live in a per-student jsonb blob, keyed by raw item id.
  for (const row of (progressRes.data ?? []) as { progress?: { nodeProgress?: Record<string, { checkedOff?: boolean }> } }[]) {
    for (const [nodeId, p] of Object.entries(row.progress?.nodeProgress ?? {})) {
      if (p?.checkedOff) touched.add(nodeId)
    }
  }

  return extras.filter((e) => !touched.has(e.id)).map((e) => ({ title: e.title }))
}
