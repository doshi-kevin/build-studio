/**
 * Quiz Server Actions (Professor + TA) — CRUD for questions, quizzes,
 * insights, and AI quiz generation via Google Gemini.
 *
 * Access model:
 *   - Reads: section professor + any active section staff (incl. grader)
 *   - Writes (most): professor + active TA
 *   - Writes (nuclear — publish, unpublish, delete, duplicate): professor only
 *
 * The legacy `verifyOwnership` helper is kept as a thin wrapper around
 * `verifySectionAccess` so existing callsites don't need a rename. Its
 * `owned` field now means "can write as staff" (prof or TA); use
 * `hasAccess` for read-only paths and `canWriteProfessor` for nuclear
 * operations.
 *
 * Uses admin client for DB operations (bypasses RLS).
 */
'use server'

import { revalidatePath } from 'next/cache'
import { after } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { selectPublishableScheduledQuizIds } from '@/lib/quiz/auto-publish'
import { logger } from '@/lib/logger'
import { logEvent } from '@/lib/supabase/event-logger'
import { emitEvent } from '@/lib/events/emit'
import { signOne, signMany, extractPathFromPublicUrl, signQuestionImages, signQuestionImage } from '@/lib/supabase/signed-urls'
import { COURSE_MATERIALS_BUCKET, inferLectureFileType, isSafeStoragePath } from '@/lib/supabase/storage'
import { enqueueExtractionJob, enqueueMasteryRecompute } from '@/lib/extraction/enqueue'
import { z } from 'zod'
import {
  createQuestionServerSchema,
  updateQuestionServerSchema,
  draftQuestionServerSchema,
  isQuestionComplete,
  createQuizServerSchema,
  createQuizFullServerSchema,
  updateQuizServerSchema,
  isScheduledPublishInPast,
  rubricNodeSchema,
  type RubricNode,
  type QuestionContent,
  type CreateQuestionServerInput,
  type UpdateQuestionServerInput,
  type CreateQuizServerInput,
  type CreateQuizFullServerInput,
  type UpdateQuizServerInput,
  type Question,
  type Quiz,
  type QuestionPool,
  type DifficultyLevel,
  type GenerationNotice,
  overrideAnswerScoreSchema,
  type OverrideAnswerScoreInput,
} from '@/lib/validations/quiz'
import type { ProctoringEvent, ProctoringSummary, ProctoringSnapshot } from '@/lib/validations/proctoring'
import {
  verifySectionAccess,
  canWriteAsProfessor,
  canWriteAsStaff,
  type SectionRole,
} from '@/lib/auth/section-access'
import { removeItemFromScheme } from '@/lib/grades/fetch'
import { checkEntitlementBySection } from '@/lib/entitlements/check'
import { entitlementRefusalMessage } from '@/lib/entitlements/entitled-features'

// ── Helpers ──────────────────────────────────────────────────────

async function getAuthUser() {
  const supabase = await createClient()
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) return null
  return user
}

interface AccessCheck {
  /** Caller can perform staff-level writes (professor or active TA). */
  owned: boolean
  /** Caller can read (professor, TA, or grader). */
  hasAccess: boolean
  /** Caller is the section's professor (nuclear-ops gate). */
  canWriteProfessor: boolean
  role: SectionRole | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminDb: any
}

async function verifyOwnership(sectionId: string, userId: string): Promise<AccessCheck> {
  const access = await verifySectionAccess(sectionId, userId)
  if (!access.ok) {
    return {
      owned: false,
      hasAccess: false,
      canWriteProfessor: false,
      role: null,
      adminDb: access.adminDb,
    }
  }
  return {
    owned: canWriteAsStaff(access.role),
    hasAccess: true,
    canWriteProfessor: canWriteAsProfessor(access.role),
    role: access.role,
    adminDb: access.adminDb,
  }
}

function sectionPath(sectionId: string) {
  return `/professor/courses/${sectionId}`
}

// ── DB → App Type Mappers ────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapDbQuestion(row: any): Question {
  return {
    id: row.id,
    sectionId: row.section_id,
    questionText: row.question_text,
    content: row.content,
    difficulty: row.difficulty,
    bloomsLevel: row.blooms_level ?? null,
    tags: row.tags ?? [],
    points: row.points,
    explanation: row.explanation ?? '',
    isBonus: row.is_bonus ?? false,
    isExtraCredit: row.is_extra_credit ?? false,
    imageUrl: row.image_url ?? null,
    imagePath: row.image_path ?? null,
    codeSnippet: row.code_snippet ?? null,
    eloRating: row.elo_rating ?? 1200,
    expectedTimeSeconds: row.expected_time_seconds ?? null,
    irtA: row.irt_a ?? null,
    irtB: row.irt_b ?? null,
    irtC: row.irt_c ?? null,
    rubric: row.rubric ?? null,
    sourceCitation: row.source_citation ?? null,
    isComplete: row.is_complete ?? true,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapDbQuiz(row: any, questionIds: string[] = []): Quiz {
  return {
    id: row.id,
    sectionId: row.section_id,
    createdBy: row.created_by,
    title: row.title,
    description: row.description ?? '',
    status: row.status,
    questionIds,
    questionPools: (row.question_pools as QuestionPool[]) ?? [],
    timeLimitMinutes: row.time_limit_minutes ?? null,
    shuffleQuestions: row.shuffle_questions ?? false,
    shuffleAnswers: row.shuffle_answers ?? false,
    // Kept as null — null means "no limit", not "one attempt" (#43).
    maxAttempts: row.max_attempts,
    passThreshold: row.pass_threshold ?? 60,
    dueDate: row.due_date ?? null,
    scheduledPublishAt: row.scheduled_publish_at ?? null,
    showExplanations: row.show_explanations ?? 'after_submission',
    showLeaderboard: row.show_leaderboard ?? false,
    allowFormulaSheet: row.allow_formula_sheet ?? false,
    formulaSheetUrl: row.formula_sheet_url ?? null,
    formulaSheetPath: row.formula_sheet_path ?? null,
    negativeMarking: row.negative_marking ?? false,
    negativeMarkingPenalty: row.negative_marking_penalty ?? 0.25,
    difficultyDistribution: row.difficulty_distribution ?? null,
    proctoringEnabled: row.proctoring_enabled ?? false,
    videoProctoringEnabled: row.video_proctoring_enabled ?? false,
    adaptiveMode: row.adaptive_mode ?? false,
    adaptiveRatio: row.adaptive_ratio ?? 60,
    adaptiveQuestionCount: row.adaptive_question_count ?? 10,
    controlDistribution: row.control_distribution ?? null,
    showRatingToStudents: row.show_rating_to_students ?? false,
    selectLambda: row.select_lambda ?? 0.5,
    stopMode: row.stop_mode === 'precision' ? 'precision' : 'fixed',
    targetSe: row.target_se ?? 0.3,
    generationNotice: row.generation_notice ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Replace each quiz's formulaSheetUrl with a fresh short-lived signed URL.
 * course-materials bucket is private (mig 48); legacy public URLs no longer
 * resolve. Falls back to extracting a path from the legacy URL if the path
 * column wasn't backfilled.
 */
async function attachFormulaSheetSignedUrls(quizzes: Quiz[]): Promise<Quiz[]> {
  if (quizzes.length === 0) return quizzes
  const paths = quizzes.map(
    (q) => q.formulaSheetPath ?? extractPathFromPublicUrl(q.formulaSheetUrl, COURSE_MATERIALS_BUCKET),
  )
  const signed = await signMany(COURSE_MATERIALS_BUCKET, paths)
  return quizzes.map((q, i) => {
    const path = paths[i]
    if (!path) return q
    const url = signed.get(path)
    return url ? { ...q, formulaSheetUrl: url, formulaSheetPath: path } : q
  })
}

async function attachFormulaSheetSignedUrl(quiz: Quiz): Promise<Quiz> {
  const path =
    quiz.formulaSheetPath ?? extractPathFromPublicUrl(quiz.formulaSheetUrl, COURSE_MATERIALS_BUCKET)
  if (!path) return quiz
  const url = await signOne(COURSE_MATERIALS_BUCKET, path)
  return url ? { ...quiz, formulaSheetUrl: url, formulaSheetPath: path } : quiz
}

/**
 * Auto-publish any draft quizzes whose scheduled_publish_at has passed.
 * Called at the top of getQuizzes (professor) and getPublishedQuizzes (student).
 * Clears scheduled_publish_at after publishing to prevent re-firing.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function autoPublishScheduledQuizzes(adminDb: any, sectionId: string) {
  const now = new Date().toISOString()

  // Only drafts that pass the same gate publishQuiz enforces — this used to be a
  // bare update that published any due draft, empty ones included (#311).
  let eligibleIds: string[]
  let heldBack: number
  try {
    ({ eligibleIds, heldBack } = await selectPublishableScheduledQuizIds(adminDb, sectionId, now))
  } catch (err) {
    logger.error('autoPublishScheduledQuizzes: Failed to list due quizzes', err, { sectionId })
    return
  }
  if (heldBack > 0) {
    logger.info(`autoPublishScheduledQuizzes: Held back ${heldBack} scheduled quiz(es) with no or incomplete questions`, { sectionId })
  }
  if (eligibleIds.length === 0) return

  // The status='draft' guard makes this an atomic per-row claim: each quiz is flipped by
  // exactly one caller even under concurrent loads, so `.select()` returns only the rows
  // THIS call published — the ones to notify about.
  const { data: justPublished, error } = await adminDb
    .from('quizzes')
    // Stamp publish_notified_at: this path emits inline below, so the publish sweep must
    // not also notify. The pg_cron path leaves it NULL for the sweep to claim.
    .update({ status: 'published', scheduled_publish_at: null, publish_notified_at: now, updated_at: now })
    .in('id', eligibleIds)
    // Redundant with the section-scoped select above, but kept so the write itself
    // is tenant-scoped and can never widen if the id list is ever built elsewhere.
    .eq('section_id', sectionId)
    .eq('status', 'draft')
    // Re-assert the schedule predicates: a professor can cancel or push out the
    // schedule between the select and this update.
    .not('scheduled_publish_at', 'is', null)
    .lte('scheduled_publish_at', now)
    .select('id, title, due_date')

  if (error) {
    logger.error('autoPublishScheduledQuizzes: Failed to publish scheduled quizzes', error, { sectionId })
    return
  }
  const rows = (justPublished ?? []) as Array<{ id: string; title: string; due_date: string | null }>
  if (rows.length === 0) return
  logger.info(`autoPublishScheduledQuizzes: Published ${rows.length} scheduled quiz(es)`, { sectionId })

  // Notify enrolled students for each newly-published quiz (mirrors publishQuiz). Time-based
  // publish → no actor. Best-effort; emitEvent dedups on (recipient, type, entity).
  await Promise.all(
    rows.map((q) =>
      emitEvent({
        type: 'quiz_published',
        sectionId,
        actorId: null,
        entity: { type: 'quiz', id: q.id },
        title: `New quiz: ${q.title}`,
        linkUrl: `/student/courses/${sectionId}/quizzes/${q.id}`,
        actionable: true,
        dueAt: q.due_date ?? null,
      }),
    ),
  )
}

// ── Question Bank Actions ────────────────────────────────────────

export async function getQuestions(sectionId: string): Promise<{ data: Question[]; error?: string }> {
  const user = await getAuthUser()
  if (!user) return { error: 'Not authenticated', data: [] as Question[] }

  const { hasAccess, adminDb } = await verifyOwnership(sectionId, user.id)
  if (!hasAccess) return { error: 'You do not have access to this section', data: [] as Question[] }

  const { data: rows, error } = await adminDb
    .from('quiz_questions')
    .select('*')
    .eq('section_id', sectionId)
    .order('created_at', { ascending: false })

  if (error) {
    logger.error('getQuestions: Fetch failed', error, { sectionId })
    return { error: 'Failed to load questions', data: [] as Question[] }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const questions = (rows || []).map((r: any) => mapDbQuestion(r))
  return { data: await signQuestionImages(questions) }
}

export async function createQuestion(
  sectionId: string,
  input: CreateQuestionServerInput,
): Promise<{ data?: Question; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = createQuestionServerSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    const { owned, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!owned) return { error: 'You do not have permission to perform this action' }

    // Ring 1. A question is section-scoped and needs no quiz to exist, so this
    // is a root create despite the name: without the gate an unentitled school
    // could author an entire question bank.
    const entitlement = await checkEntitlementBySection(adminDb, sectionId, 'quizzes')
    if (!entitlement.allowed) return { error: entitlementRefusalMessage('quizzes') }

    const { data: row, error } = await adminDb
      .from('quiz_questions')
      .insert({
        section_id: sectionId,
        /* Explicit, because the column defaults to TRUE. Without this a question
           the strict schema lets through but isQuestionComplete rejects (e.g. a
           rubric-less explanation type) would be stored as complete and clear
           publishQuiz's gate. The studio's bulk paths already compute it. */
        is_complete: isQuestionComplete(
          parsed.data.questionText,
          parsed.data.content,
          parsed.data.rubric ?? null,
        ),
        question_text: parsed.data.questionText,
        question_type: parsed.data.content.questionType,
        content: parsed.data.content,
        difficulty: parsed.data.difficulty,
        blooms_level: parsed.data.bloomsLevel,
        tags: parsed.data.tags,
        points: parsed.data.points,
        explanation: parsed.data.explanation,
        is_bonus: parsed.data.isBonus,
        is_extra_credit: parsed.data.isExtraCredit,
        image_url: parsed.data.imageUrl,
        image_path: parsed.data.imagePath,
        code_snippet: parsed.data.codeSnippet,
        elo_rating: parsed.data.eloRating ?? 1200,
        expected_time_seconds: parsed.data.expectedTimeSeconds ?? null,
        irt_a: parsed.data.irtA ?? null,
        irt_b: parsed.data.irtB ?? null,
        irt_c: parsed.data.irtC ?? null,
        rubric: parsed.data.rubric ?? null,
        source_citation: parsed.data.sourceCitation ?? null,
      })
      .select()
      .single()

    if (error) {
      logger.error('createQuestion: Insert failed', error, { sectionId })
      return { error: 'Failed to create question' }
    }

    await logEvent({ userId: user.id, eventType: 'quiz_question_created', sectionId, metadata: { questionId: row.id } })
    revalidatePath(sectionPath(sectionId))
    const signedQuestion = await signQuestionImage(mapDbQuestion(row))
    return { data: signedQuestion ?? mapDbQuestion(row) }
  } catch (error) {
    logger.error('createQuestion: Exception', error, { sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

export async function updateQuestion(
  sectionId: string,
  questionId: string,
  input: UpdateQuestionServerInput,
): Promise<{ data?: Question; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = updateQuestionServerSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    const { owned, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!owned) return { error: 'You do not have permission to perform this action' }

    /* Write only what the CALLER actually sent. `parsed.data.X !== undefined` is
       NOT that test: updateQuestionServerSchema is `.partial()` over a schema
       whose fields carry `.default()`, so zod MATERIALISES defaults for keys that
       were never in the request. The Question Bank dialog omits `rubric` and the
       IRT triple, so every edit arrived with all four set to null and wrote them
       — silently deleting a professor's rubric (leaving an AI-graded question
       ungradeable) and an adaptive question's calibration. Presence comes from
       the raw input; the VALUE still comes from the validated output.

       The `!== undefined` half is load-bearing too: hasOwnProperty is true for a
       key present with an undefined value, and zod then supplies the default for
       it — so `{...form, rubric: form.rubric}` with the field unset would re-arm
       the very wipe this guards against. Clearing a rubric on purpose still works;
       that is `null`, which is distinguishable from `undefined`. */
    const provided = (key: keyof UpdateQuestionServerInput) =>
      Object.prototype.hasOwnProperty.call(input ?? {}, key) &&
      (input as Record<string, unknown>)[key] !== undefined

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const update: Record<string, any> = { updated_at: new Date().toISOString() }
    if (provided('questionText')) update.question_text = parsed.data.questionText
    /* `&& parsed.data.content` both narrows the type and keeps an explicit
       `content: undefined` from writing a null question_type. */
    if (provided('content') && parsed.data.content) {
      update.content = parsed.data.content
      update.question_type = parsed.data.content.questionType
    }
    if (provided('difficulty')) update.difficulty = parsed.data.difficulty
    if (provided('bloomsLevel')) update.blooms_level = parsed.data.bloomsLevel
    if (provided('tags')) update.tags = parsed.data.tags
    if (provided('points')) update.points = parsed.data.points
    if (provided('explanation')) update.explanation = parsed.data.explanation
    if (provided('isBonus')) update.is_bonus = parsed.data.isBonus
    if (provided('isExtraCredit')) update.is_extra_credit = parsed.data.isExtraCredit
    if (provided('imageUrl')) update.image_url = parsed.data.imageUrl
    if (provided('imagePath')) update.image_path = parsed.data.imagePath
    if (provided('codeSnippet')) update.code_snippet = parsed.data.codeSnippet
    if (provided('eloRating')) update.elo_rating = parsed.data.eloRating
    if (provided('expectedTimeSeconds')) update.expected_time_seconds = parsed.data.expectedTimeSeconds
    if (provided('irtA')) update.irt_a = parsed.data.irtA
    if (provided('irtB')) update.irt_b = parsed.data.irtB
    if (provided('irtC')) update.irt_c = parsed.data.irtC
    if (provided('rubric')) update.rubric = parsed.data.rubric
    if (provided('sourceCitation')) update.source_citation = parsed.data.sourceCitation

    /* Recompute is_complete from the state this UPDATE will actually leave
       behind: whatever `update` carries, falling back to the stored row for
       fields it doesn't touch. Deriving it from `parsed.data` instead would
       drift, because updateQuestionServerSchema is `.partial()` over a schema
       whose fields carry `.default()` — so zod MATERIALISES defaults for keys
       the caller never sent (`{points: 3}` arrives with `rubric: null`). Reading
       the payload keeps the flag true to the row no matter what gets written.

       Also self-heals rows written before createQuestion computed the flag —
       though only when the edit touches the stem, content or rubric; a
       metadata-only edit now leaves a stale flag alone. */
    const touchesCompleteness =
      provided('questionText') || provided('content') || provided('rubric')
    const { data: current } = !touchesCompleteness
      ? { data: null }
      : await adminDb
      .from('quiz_questions')
      .select('question_text, content, rubric')
      .eq('id', questionId)
      .eq('section_id', sectionId)
      .maybeSingle()
    if (current) {
      const has = (k: string) => Object.prototype.hasOwnProperty.call(update, k)
      update.is_complete = isQuestionComplete(
        has('question_text') ? update.question_text : current.question_text,
        (has('content') ? update.content : current.content) as QuestionContent,
        (has('rubric') ? update.rubric : current.rubric) ?? null,
      )
    }

    const { data: row, error } = await adminDb
      .from('quiz_questions')
      .update(update)
      .eq('id', questionId)
      .eq('section_id', sectionId)
      .select()
      .single()

    if (error) {
      logger.error('updateQuestion: Update failed', error, { sectionId, questionId })
      return { error: 'Failed to update question' }
    }

    await logEvent({ userId: user.id, eventType: 'quiz_question_updated', sectionId, metadata: { questionId } })
    revalidatePath(sectionPath(sectionId))
    const signedQuestion = await signQuestionImage(mapDbQuestion(row))
    return { data: signedQuestion ?? mapDbQuestion(row) }
  } catch (error) {
    logger.error('updateQuestion: Exception', error, { sectionId, questionId })
    return { error: 'An unexpected error occurred' }
  }
}

export async function deleteQuestion(
  sectionId: string,
  questionId: string,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { owned, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!owned) return { error: 'You do not have permission to perform this action' }

    const { error } = await adminDb
      .from('quiz_questions')
      .delete()
      .eq('id', questionId)
      .eq('section_id', sectionId)

    if (error) {
      logger.error('deleteQuestion: Delete failed', error, { sectionId, questionId })
      return { error: 'Failed to delete question' }
    }

    await logEvent({ userId: user.id, eventType: 'quiz_question_deleted', sectionId, metadata: { questionId } })
    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('deleteQuestion: Exception', error, { sectionId, questionId })
    return { error: 'An unexpected error occurred' }
  }
}

// ── Quiz Actions ─────────────────────────────────────────────────

export async function getQuizzes(sectionId: string) {
  const user = await getAuthUser()
  if (!user) return { error: 'Not authenticated', data: [] as Quiz[] }

  const { hasAccess, owned, canWriteProfessor, adminDb } = await verifyOwnership(sectionId, user.id)
  if (!hasAccess) return { error: 'You do not have access to this section', data: [] as Quiz[] }

  // Auto-publish any scheduled quizzes whose time has arrived
  await autoPublishScheduledQuizzes(adminDb, sectionId)

  const { data: rows, error } = await adminDb
    .from('quizzes')
    .select('*')
    .eq('section_id', sectionId)
    .order('created_at', { ascending: false })

  if (error) {
    logger.error('getQuizzes: Fetch failed', error, { sectionId })
    return { error: 'Failed to load quizzes', data: [] as Quiz[] }
  }

  // Get question assignments for all quizzes
  const quizIds = (rows || []).map((r: { id: string }) => r.id)
  let assignmentMap: Record<string, string[]> = {}
  if (quizIds.length > 0) {
    const { data: assignments } = await adminDb
      .from('quiz_question_assignments')
      .select('quiz_id, question_id')
      .in('quiz_id', quizIds)
      .order('position', { ascending: true })

    if (assignments) {
      assignmentMap = (assignments as { quiz_id: string; question_id: string }[]).reduce(
        (acc: Record<string, string[]>, a) => {
          if (!acc[a.quiz_id]) acc[a.quiz_id] = []
          acc[a.quiz_id].push(a.question_id)
          return acc
        },
        {} as Record<string, string[]>,
      )
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const quizzes = (rows || []).map((r: any) => mapDbQuiz(r, assignmentMap[r.id] || []))
  /* Both capabilities ride along so the list can hide what the role can't do instead
     of letting them discover it by being refused (#749).

     canWriteProfessor gates the four professor-only actions — Publish, Unpublish,
     Duplicate, Delete. `owned` (canWriteAsStaff) gates "Create quiz": browser QA found
     a grader was shown that button, and getOrCreateEmptyDraft answered 200 with an
     error body, which is the same visible-control-gets-refused pattern on a control
     that hadn't been gated.

     Affordance only — every guard stays in the action. */
  return { data: await attachFormulaSheetSignedUrls(quizzes), canWriteProfessor, canCreate: owned }
}

export async function getQuizById(sectionId: string, quizId: string) {
  const user = await getAuthUser()
  if (!user) return { error: 'Not authenticated', data: null as Quiz | null }

  const { hasAccess, adminDb } = await verifyOwnership(sectionId, user.id)
  if (!hasAccess) return { error: 'You do not have access to this section', data: null as Quiz | null }

  // Auto-publish any scheduled quizzes whose publish time has arrived
  await autoPublishScheduledQuizzes(adminDb, sectionId)

  // maybeSingle (not single): a missing quiz returns { data: null, error: null }
  // rather than a PGRST116 error. A just-deleted quiz being re-fetched (the
  // editor RSC re-renders during the redirect to the list) is an EXPECTED
  // not-found, not a server error — logging it as an error was pure noise.
  const { data: row, error } = await adminDb
    .from('quizzes')
    .select('*')
    .eq('id', quizId)
    .eq('section_id', sectionId)
    .maybeSingle()

  if (error) {
    logger.error('getQuizById: Fetch failed', error, { sectionId, quizId })
    return { error: 'Quiz not found', data: null as Quiz | null }
  }
  if (!row) {
    // Benign: quiz doesn't exist (deleted or never existed). Caller redirects.
    return { error: 'Quiz not found', data: null as Quiz | null }
  }

  // Get question assignments
  const { data: assignments } = await adminDb
    .from('quiz_question_assignments')
    .select('question_id')
    .eq('quiz_id', quizId)
    .order('position', { ascending: true })

  const questionIds = (assignments || []).map((a: { question_id: string }) => a.question_id)

  return { data: await attachFormulaSheetSignedUrl(mapDbQuiz(row, questionIds)) }
}

/**
 * Lightweight poll for the "generation in progress" view: whether a generation
 * is still running for this quiz (generation_started_at set + recent) and its
 * current question ids. Definitive "still generating" signal from the server —
 * the reattach view polls this so the generating banner stays up until the run
 * actually finishes (not a guess based on how long questions have paused). The
 * 15-min cutoff frees a quiz whose generation crashed without clearing the stamp.
 */
export async function getQuizGenerationState(
  sectionId: string,
  quizId: string,
): Promise<{
  data?: { generating: boolean; questionIds: string[]; total: number | null; startedAt: string | null; notice: GenerationNotice | null }
  error?: string
}> {
  const user = await getAuthUser()
  if (!user) return { error: 'Not authenticated' }

  const { hasAccess, adminDb } = await verifyOwnership(sectionId, user.id)
  if (!hasAccess) return { error: 'You do not have access to this section' }

  const { data: row } = await adminDb
    .from('quizzes')
    .select('generation_started_at, generation_total, generation_notice')
    .eq('id', quizId)
    .eq('section_id', sectionId)
    .maybeSingle()
  if (!row) return { data: { generating: false, questionIds: [], total: null, startedAt: null, notice: null } }

  const { data: assignments } = await adminDb
    .from('quiz_question_assignments')
    .select('question_id')
    .eq('quiz_id', quizId)
    .order('position', { ascending: true })
  const questionIds = (assignments || []).map((a: { question_id: string }) => a.question_id)

  const startedAt = row.generation_started_at ? new Date(row.generation_started_at).getTime() : 0
  const generating = startedAt > Date.now() - 15 * 60_000
  // Target count for the reattach counter — only meaningful while a run is live.
  const total = generating ? (row.generation_total ?? null) : null
  // Shortfall notice, so a studio that reattached to a run (rather than owning
  // the live stream) can surface "supported N of M" the moment the run settles,
  // without waiting for a reload.
  const notice = (row.generation_notice as GenerationNotice | null) ?? null
  // Start time travels with "generating" so a reattached studio's elapsed
  // timer measures the real run, not the moment the tab reconnected.
  return { data: { generating, questionIds, total, startedAt: generating ? row.generation_started_at : null, notice } }
}

export async function createQuiz(
  sectionId: string,
  input: CreateQuizServerInput,
): Promise<{ data?: Quiz; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = createQuizServerSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    const { owned, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!owned) return { error: 'You do not have permission to perform this action' }

    const entitlement = await checkEntitlementBySection(adminDb, sectionId, 'quizzes')
    if (!entitlement.allowed) return { error: entitlementRefusalMessage('quizzes') }

    const { data: row, error } = await adminDb
      .from('quizzes')
      .insert({
        section_id: sectionId,
        created_by: user.id,
        title: parsed.data.title,
        description: parsed.data.description,
      })
      .select()
      .single()

    if (error) {
      logger.error('createQuiz: Insert failed', error, { sectionId })
      return { error: 'Failed to create quiz' }
    }

    await logEvent({ userId: user.id, eventType: 'quiz_created', sectionId, metadata: { quizId: row.id } })
    revalidatePath(sectionPath(sectionId))
    return { data: mapDbQuiz(row) }
  } catch (error) {
    logger.error('createQuiz: Exception', error, { sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

export async function updateQuiz(
  sectionId: string,
  quizId: string,
  input: UpdateQuizServerInput,
): Promise<{ data?: Quiz; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = updateQuizServerSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    const { owned, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!owned) return { error: 'You do not have permission to perform this action' }

    // A schedule may not be set INTO the past — that hands the auto-publish sweep a
    // due draft and pushes it live immediately (#311). Checked here rather than in
    // the schema so a schedule that merely ELAPSED while the professor kept editing
    // still saves: only a CHANGED value is rejected. Enforcing it in the schema made
    // every later autosave of that quiz fail, with no way to clear the field.
    if (isScheduledPublishInPast(parsed.data.scheduledPublishAt)) {
      const { data: current } = await adminDb
        .from('quizzes')
        .select('scheduled_publish_at')
        .eq('id', quizId)
        .eq('section_id', sectionId)
        .single()
      const stored = current?.scheduled_publish_at ?? null
      const unchanged =
        stored !== null &&
        Date.parse(stored) === Date.parse(parsed.data.scheduledPublishAt as string)
      if (!unchanged) return { error: 'Scheduled publish time must be in the future' }
    }

    // Build update object with only provided fields
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const update: Record<string, any> = { updated_at: new Date().toISOString() }
    if (parsed.data.title !== undefined) update.title = parsed.data.title
    if (parsed.data.description !== undefined) update.description = parsed.data.description
    if (parsed.data.timeLimitMinutes !== undefined) update.time_limit_minutes = parsed.data.timeLimitMinutes
    if (parsed.data.shuffleQuestions !== undefined) update.shuffle_questions = parsed.data.shuffleQuestions
    if (parsed.data.shuffleAnswers !== undefined) update.shuffle_answers = parsed.data.shuffleAnswers
    if (parsed.data.maxAttempts !== undefined) update.max_attempts = parsed.data.maxAttempts
    if (parsed.data.passThreshold !== undefined) update.pass_threshold = parsed.data.passThreshold
    if (parsed.data.dueDate !== undefined) update.due_date = parsed.data.dueDate
    if (parsed.data.scheduledPublishAt !== undefined) update.scheduled_publish_at = parsed.data.scheduledPublishAt
    if (parsed.data.showExplanations !== undefined) update.show_explanations = parsed.data.showExplanations
    if (parsed.data.showLeaderboard !== undefined) update.show_leaderboard = parsed.data.showLeaderboard
    if (parsed.data.allowFormulaSheet !== undefined) update.allow_formula_sheet = parsed.data.allowFormulaSheet
    if (parsed.data.formulaSheetUrl !== undefined) update.formula_sheet_url = parsed.data.formulaSheetUrl
    if (parsed.data.formulaSheetPath !== undefined) update.formula_sheet_path = parsed.data.formulaSheetPath
    if (parsed.data.negativeMarking !== undefined) update.negative_marking = parsed.data.negativeMarking
    if (parsed.data.negativeMarkingPenalty !== undefined) update.negative_marking_penalty = parsed.data.negativeMarkingPenalty
    if (parsed.data.questionPools !== undefined) update.question_pools = parsed.data.questionPools
    if (parsed.data.difficultyDistribution !== undefined) update.difficulty_distribution = parsed.data.difficultyDistribution
    if (parsed.data.proctoringEnabled !== undefined) update.proctoring_enabled = parsed.data.proctoringEnabled
    if (parsed.data.videoProctoringEnabled !== undefined) update.video_proctoring_enabled = parsed.data.videoProctoringEnabled
    // Adaptive (CCAT v2) config.
    if (parsed.data.adaptiveMode !== undefined) update.adaptive_mode = parsed.data.adaptiveMode
    if (parsed.data.adaptiveQuestionCount !== undefined) update.adaptive_question_count = parsed.data.adaptiveQuestionCount
    if (parsed.data.showRatingToStudents !== undefined) update.show_rating_to_students = parsed.data.showRatingToStudents
    if (parsed.data.selectLambda !== undefined) update.select_lambda = parsed.data.selectLambda
    if (parsed.data.stopMode !== undefined) update.stop_mode = parsed.data.stopMode
    if (parsed.data.targetSe !== undefined) update.target_se = parsed.data.targetSe

    const { data: row, error } = await adminDb
      .from('quizzes')
      .update(update)
      .eq('id', quizId)
      .eq('section_id', sectionId)
      .select()
      .single()

    if (error) {
      logger.error('updateQuiz: Update failed', error, { sectionId, quizId })
      return { error: 'Failed to update quiz' }
    }

    // Change notifications for a live quiz are emitted on explicit Save (publishQuiz),
    // NOT here — updateQuiz runs on the studio's autosave debounce, so notifying here
    // would fire before the professor finishes (and misses question edits, which save
    // via updateQuizQuestions). See publishQuiz's wasPublished branch.

    // Re-fetch question assignments
    const { data: assignments } = await adminDb
      .from('quiz_question_assignments')
      .select('question_id')
      .eq('quiz_id', quizId)
      .order('position', { ascending: true })

    const questionIds = (assignments || []).map((a: { question_id: string }) => a.question_id)

    revalidatePath(sectionPath(sectionId))
    return { data: mapDbQuiz(row, questionIds) }
  } catch (error) {
    logger.error('updateQuiz: Exception', error, { sectionId, quizId })
    return { error: 'An unexpected error occurred' }
  }
}

export async function updateQuizQuestions(
  sectionId: string,
  quizId: string,
  questionIds: string[],
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { owned, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!owned) return { error: 'You do not have permission to perform this action' }

    // Verify quiz belongs to this section
    const { data: quiz } = await adminDb
      .from('quizzes')
      .select('id, title')
      .eq('id', quizId)
      .eq('section_id', sectionId)
      .single()
    if (!quiz) return { error: 'Quiz not found in this section' }

    // Rewrite the assignments ATOMICALLY via a single RPC (delete + reinsert in
    // one transaction) so a failed insert can never leave the quiz with zero
    // questions. The function also owns the BOLA guard (only THIS section's
    // questions get assigned — client-supplied ids are untrusted), dedupe (keep
    // first occurrence — the table is UNIQUE(quiz_id, question_id)), and
    // contiguous positions. It returns the applied ids in order for the stamp.
    const { data: appliedIds, error } = await adminDb.rpc('set_quiz_question_assignments', {
      p_section_id: sectionId,
      p_quiz_id: quizId,
      p_question_ids: questionIds,
    })
    if (error) {
      logger.error('updateQuizQuestions: RPC failed', error, { sectionId, quizId })
      return { error: 'Failed to update quiz questions' }
    }

    if (appliedIds && appliedIds.length > 0) {
      // Provenance: stamp "used by this quiz" onto any ad-hoc quiz-upload module
      // items the quiz's AI questions cite, so the Modules page can show what
      // each upload was for. Best-effort — never fails the save.
      await stampQuizUploadUsage(adminDb, sectionId, quizId, quiz.title as string, appliedIds)
    }

    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('updateQuizQuestions: Exception', error, { sectionId, quizId })
    return { error: 'An unexpected error occurred' }
  }
}

export async function publishQuiz(
  sectionId: string,
  quizId: string,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { canWriteProfessor, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!canWriteProfessor) return { error: 'Only the professor can publish a quiz' }

    // Confirm the quiz belongs to THIS section before reading anything about it
    // (IDOR: keeps a quizId from another section from leaking its state below).
    const { data: quizRow } = await adminDb
      .from('quizzes')
      .select('id')
      .eq('id', quizId)
      .eq('section_id', sectionId)
      .maybeSingle()
    if (!quizRow) return { error: 'Quiz not found' }

    // Verify quiz has at least one question — and pull each assigned question's
    // completeness so we can hard-block on placeholders.
    const { data: assignments } = await adminDb
      .from('quiz_question_assignments')
      .select('id, question:quiz_questions(is_complete)')
      .eq('quiz_id', quizId)

    if (!assignments || assignments.length === 0) {
      return { error: 'Add at least one question before publishing' }
    }

    // Defense-in-depth: the studio already blocks publishing with invalid
    // questions client-side, but an incomplete placeholder must never reach
    // students even if this action is called directly.
    const hasIncomplete = assignments.some((a: { question: { is_complete?: boolean } | { is_complete?: boolean }[] | null }) => {
      const q = Array.isArray(a.question) ? a.question[0] : a.question
      return q?.is_complete === false
    })
    if (hasIncomplete) {
      return { error: 'Finish or remove the incomplete questions before publishing.' }
    }

    // Was this quiz already live? Re-saving a published quiz tells students it CHANGED
    // (quiz_updated), rather than re-announcing it as new.
    const { data: prior } = await adminDb
      .from('quizzes')
      .select('status')
      .eq('id', quizId)
      .eq('section_id', sectionId)
      .maybeSingle()
    const wasPublished = prior?.status === 'published'

    const nowIso = new Date().toISOString()
    const { data: published, error } = await adminDb
      .from('quizzes')
      // Stamp publish_notified_at: this action emits inline below, so the publish sweep
      // must not also notify these students.
      .update({ status: 'published', scheduled_publish_at: null, publish_notified_at: nowIso, updated_at: nowIso })
      .eq('id', quizId)
      .eq('section_id', sectionId)
      .select('title, due_date')
      .maybeSingle()

    if (error) {
      logger.error('publishQuiz: Update failed', error, { sectionId, quizId })
      return { error: 'Failed to publish quiz' }
    }

    await logEvent({ userId: user.id, eventType: 'quiz_published', sectionId, metadata: { quizId } })

    // Notify enrolled students. First publish → "New quiz" (an actionable to-do, cleared
    // when attempted). Re-saving an already-live quiz → one neutral "updated" notice
    // covering ANY change (questions, due date, settings); refresh so a later re-save
    // re-surfaces it, and non-actionable since the to-do already exists.
    if (published?.title) {
      if (wasPublished) {
        await emitEvent({
          type: 'quiz_updated',
          sectionId,
          actorId: user.id,
          entity: { type: 'quiz', id: quizId },
          title: `Quiz updated: ${published.title}`,
          body: 'This quiz was updated — check the latest.',
          linkUrl: `/student/courses/${sectionId}/quizzes/${quizId}`,
          actionable: false,
          dueAt: published.due_date ?? null,
          onDuplicate: 'refresh',
        })
      } else {
        await emitEvent({
          type: 'quiz_published',
          sectionId,
          actorId: user.id,
          entity: { type: 'quiz', id: quizId },
          title: `New quiz: ${published.title}`,
          linkUrl: `/student/courses/${sectionId}/quizzes/${quizId}`,
          actionable: true,
          dueAt: published.due_date ?? null,
        })
      }
    }

    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('publishQuiz: Exception', error, { sectionId, quizId })
    return { error: 'An unexpected error occurred' }
  }
}

export async function deleteQuiz(
  sectionId: string,
  quizId: string,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { canWriteProfessor, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!canWriteProfessor) return { error: 'Only the professor can delete a quiz' }

    const { error } = await adminDb
      .from('quizzes')
      .delete()
      .eq('id', quizId)
      .eq('section_id', sectionId)

    if (error) {
      logger.error('deleteQuiz: Delete failed', error, { sectionId, quizId })
      return { error: 'Failed to delete quiz' }
    }

    // The quiz's attempts (the mastery evidence) are gone via FK cascade, but
    // activity_skills.activity_id is polymorphic — no cascade — so its topic
    // mappings would dangle. Capture which skills this quiz mapped to BEFORE
    // pruning, then prune (both quiz + exam rows share this UUID) and reconcile
    // the section's mastery so the removed evidence drops out. Best-effort: the
    // quiz is already deleted; a cleanup miss only leaves a stale row the
    // recompute already ignores.
    const { data: mappedRows } = await adminDb
      .from('activity_skills')
      .select('skill_id')
      .eq('section_id', sectionId)
      .eq('activity_id', quizId)
    const mappedSkillIds = [...new Set((mappedRows ?? []).map((r: { skill_id: string }) => r.skill_id))]

    const { error: mapError } = await adminDb
      .from('activity_skills')
      .delete()
      .eq('section_id', sectionId)
      .eq('activity_id', quizId)
    if (mapError) {
      logger.error('deleteQuiz: activity_skills cleanup failed', mapError, { sectionId, quizId })
    }

    // Same polymorphic story for grading-scheme membership/excuses (no FK cascade).
    await removeItemFromScheme(adminDb, sectionId, 'quiz', quizId)

    // Uncheck (soft-exclude — the row is KEPT) any skill this quiz was the only
    // remaining evidence for: after the prune it has no activity_skills coverage
    // left, so it shouldn't stay tracked in the roadmap's Tracked-skills modal.
    // Skills still assessed by another quiz/assignment/exam stay tracked.
    if (mappedSkillIds.length > 0) {
      const { data: stillCovered } = await adminDb
        .from('activity_skills')
        .select('skill_id')
        .eq('section_id', sectionId)
        .in('skill_id', mappedSkillIds)
      const coveredIds = new Set((stillCovered ?? []).map((r: { skill_id: string }) => r.skill_id))
      const orphanedIds = mappedSkillIds.filter((id) => !coveredIds.has(id))
      if (orphanedIds.length > 0) {
        const { error: untrackError } = await adminDb
          .from('skills')
          .update({ excluded: true, updated_at: new Date().toISOString() })
          .eq('section_id', sectionId)
          .in('id', orphanedIds)
        if (untrackError) {
          logger.error('deleteQuiz: untrack orphaned skills failed', untrackError, { sectionId, quizId })
        }
      }
    }

    await logEvent({ userId: user.id, eventType: 'quiz_deleted', sectionId, metadata: { quizId } })
    revalidatePath(sectionPath(sectionId))
    // Deleting a quiz can untrack skills (above) — refresh the roadmap so its
    // Tracked-skills modal reflects the unchecked ones.
    revalidatePath(`/professor/courses/${sectionId}/roadmap`)
    after(() => enqueueMasteryRecompute(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('deleteQuiz: Exception', error, { sectionId, quizId })
    return { error: 'An unexpected error occurred' }
  }
}

// ── Duplicate Quiz ──────────────────────────────────────────────

/** Duplicates a quiz with all settings and question assignments. Creates as draft. */
export async function duplicateQuiz(
  sectionId: string,
  quizId: string,
): Promise<{ data?: Quiz; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { canWriteProfessor, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!canWriteProfessor) return { error: 'Only the professor can duplicate a quiz' }

    const entitlement = await checkEntitlementBySection(adminDb, sectionId, 'quizzes')
    if (!entitlement.allowed) return { error: entitlementRefusalMessage('quizzes') }

    // Fetch original quiz
    const { data: original, error: fetchErr } = await adminDb
      .from('quizzes')
      .select('*')
      .eq('id', quizId)
      .eq('section_id', sectionId)
      .single()

    if (fetchErr || !original) return { error: 'Quiz not found' }

    // Create copy with modified title
    const now = new Date().toISOString()
    const { data: copy, error: createErr } = await adminDb
      .from('quizzes')
      .insert({
        section_id: sectionId,
        created_by: user.id,
        title: `${original.title} (Copy)`,
        description: original.description,
        status: 'draft',
        time_limit_minutes: original.time_limit_minutes,
        shuffle_questions: original.shuffle_questions,
        shuffle_answers: original.shuffle_answers,
        max_attempts: original.max_attempts,
        pass_threshold: original.pass_threshold,
        due_date: null,
        scheduled_publish_at: null,
        show_explanations: original.show_explanations,
        show_leaderboard: original.show_leaderboard,
        allow_formula_sheet: original.allow_formula_sheet,
        formula_sheet_url: original.formula_sheet_url,
        formula_sheet_path: original.formula_sheet_path,
        negative_marking: original.negative_marking,
        negative_marking_penalty: original.negative_marking_penalty,
        proctoring_enabled: original.proctoring_enabled,
        video_proctoring_enabled: original.video_proctoring_enabled,
        // Preserve the original's adaptive (CCAT) config on the copy.
        adaptive_mode: original.adaptive_mode,
        adaptive_question_count: original.adaptive_question_count,
        select_lambda: original.select_lambda,
        stop_mode: original.stop_mode,
        target_se: original.target_se,
        show_rating_to_students: original.show_rating_to_students,
        created_at: now,
        updated_at: now,
      })
      .select()
      .single()

    if (createErr || !copy) {
      logger.error('duplicateQuiz: Insert failed', createErr)
      return { error: 'Failed to duplicate quiz' }
    }

    // Copy question assignments
    const { data: assignments } = await adminDb
      .from('quiz_question_assignments')
      .select('question_id, position')
      .eq('quiz_id', quizId)
      .order('position')

    if (assignments && assignments.length > 0) {
      await adminDb.from('quiz_question_assignments').insert(
        assignments.map((a: { question_id: string; position: number }) => ({
          quiz_id: copy.id,
          question_id: a.question_id,
          position: a.position,
        })),
      )
    }

    await logEvent({ userId: user.id, eventType: 'quiz_duplicated', sectionId, metadata: { originalQuizId: quizId, newQuizId: copy.id } })
    revalidatePath(sectionPath(sectionId))

    const questionIds = (assignments || []).map((a: { question_id: string }) => a.question_id)
    return { data: mapDbQuiz(copy, questionIds) }
  } catch (error) {
    logger.error('duplicateQuiz: Exception', error)
    return { error: 'An unexpected error occurred' }
  }
}

// ── Quiz Submission Counts (for dashboard cards) ────────────────

/** Returns submission counts per quiz for a section — lightweight batch query. */
export async function getQuizSubmissionCounts(sectionId: string) {
  const user = await getAuthUser()
  if (!user) return { error: 'Not authenticated', data: {} as Record<string, { submitted: number; inProgress: number }> }

  const { hasAccess, adminDb } = await verifyOwnership(sectionId, user.id)
  if (!hasAccess) return { error: 'You do not have access to this section', data: {} as Record<string, { submitted: number; inProgress: number }> }
  const { data: attempts, error } = await adminDb
    .from('quiz_attempts')
    .select('quiz_id, status')
    .eq('section_id', sectionId)

  if (error) {
    logger.error('[SCHOLERA ERROR] getQuizSubmissionCounts failed', { error })
    return { data: {} as Record<string, { submitted: number; inProgress: number }> }
  }

  const counts: Record<string, { submitted: number; inProgress: number }> = {}
  for (const row of attempts ?? []) {
    if (!counts[row.quiz_id]) counts[row.quiz_id] = { submitted: 0, inProgress: 0 }
    if (row.status === 'submitted') counts[row.quiz_id].submitted++
    else if (row.status === 'in_progress') counts[row.quiz_id].inProgress++
  }

  return { data: counts }
}

// ── Quiz Insights Action ─────────────────────────────────────────

export async function getQuizInsights(sectionId: string, quizId: string) {
  const user = await getAuthUser()
  if (!user) return { error: 'Not authenticated', data: null }

  const { hasAccess, adminDb } = await verifyOwnership(sectionId, user.id)
  if (!hasAccess) return { error: 'You do not have access to this section', data: null }

  // Get submitted attempts
  const { data: attempts, error: attError } = await adminDb
    .from('quiz_attempts')
    .select('id, score')
    .eq('quiz_id', quizId)
    .eq('section_id', sectionId)
    .eq('status', 'submitted')

  if (attError) {
    logger.error('getQuizInsights: Fetch attempts failed', attError, { sectionId, quizId })
    return { error: 'Failed to load insights', data: null }
  }

  const totalAttempts = (attempts || []).length
  const averageScore =
    totalAttempts > 0
      ? Math.round((attempts || []).reduce((sum: number, a: { score: number | null }) => sum + (a.score ?? 0), 0) / totalAttempts)
      : 0

  const completionRate = totalAttempts > 0 ? 100 : 0

  // Score distribution
  const buckets = ['0-20%', '21-40%', '41-60%', '61-80%', '81-100%']
  const scoreDistribution = buckets.map((range, i) => {
    const lo = i * 20
    const hi = (i + 1) * 20
    const count = (attempts || []).filter((a: { score: number | null }) => {
      const s = a.score ?? 0
      return i === 4 ? s >= lo && s <= hi : s >= lo && s < hi
    }).length
    return { range, count }
  })

  // Per-question analysis — only questions assigned to THIS quiz
  const { data: assignments } = await adminDb
    .from('quiz_question_assignments')
    .select('question_id')
    .eq('quiz_id', quizId)

  const assignedIds = (assignments || []).map((a: { question_id: string }) => a.question_id)

  const { data: questions } = assignedIds.length > 0
    ? await adminDb
        .from('quiz_questions')
        .select('id, question_text')
        .in('id', assignedIds)
    : { data: [] }

  const attemptIds = (attempts || []).map((a: { id: string }) => a.id)
  let answers: { question_id: string; is_correct: boolean | null; time_spent_seconds: number }[] = []
  if (attemptIds.length > 0) {
    const { data: ansRows } = await adminDb
      .from('quiz_answers')
      .select('question_id, is_correct, time_spent_seconds')
      .in('attempt_id', attemptIds)

    answers = ansRows || []
  }

  const questionAnalysis = (questions || []).map((q: { id: string; question_text: string }) => {
    const qAnswers = answers.filter((a) => a.question_id === q.id)
    const answered = qAnswers.length
    const correct = qAnswers.filter((a) => a.is_correct === true).length
    const totalTime = qAnswers.reduce((sum, a) => sum + a.time_spent_seconds, 0)

    const correctRate = answered > 0 ? Math.round((correct / answered) * 100) : 0
    const avgTime = answered > 0 ? Math.round(totalTime / answered) : 0

    let difficultyRating: DifficultyLevel = 'medium'
    if (correctRate >= 80) difficultyRating = 'easy'
    else if (correctRate <= 40) difficultyRating = 'hard'

    return {
      questionId: q.id,
      questionText: q.question_text,
      correctRate,
      averageTimeSeconds: avgTime,
      difficultyRating,
    }
  })

  return {
    data: {
      quizId,
      totalAttempts,
      averageScore,
      completionRate,
      scoreDistribution,
      questionAnalysis,
    },
  }
}

// ── Module Extraction Actions ─────────────────────────────────────

/** A single file (module_item) with completed text extraction. */
export interface ModuleFile {
  id: string
  title: string
  fileType: string
  pageCount: number
  wordCount: number
}

/** A module containing one or more extracted files. */
export interface ModuleGroup {
  id: string
  title: string
  files: ModuleFile[]
}

/**
 * Fetch modules and their extracted files for a section, grouped hierarchically.
 * Used by the AI generation dialog to let professors choose source material.
 */
export async function getModulesWithExtraction(
  sectionId: string,
): Promise<{ data: ModuleGroup[]; error?: string }> {
  const user = await getAuthUser()
  if (!user) return { data: [], error: 'Not authenticated' }

  const { hasAccess, adminDb } = await verifyOwnership(sectionId, user.id)
  if (!hasAccess) return { data: [], error: 'You do not have access to this section' }

  // Get all modules for this section (need id + title for hierarchy)
  const { data: modules, error: modError } = await adminDb
    .from('modules')
    .select('id, title, position')
    .eq('section_id', sectionId)
    .order('position', { ascending: true })

  if (modError || !modules?.length) {
    return { data: [] }
  }

  const moduleIds = modules.map((m: { id: string }) => m.id)

  // Get all module items — filter by extraction status in JS since
  // fileType lives inside the content JSONB, not a top-level column
  const { data: items, error: itemError } = await adminDb
    .from('module_items')
    .select('id, module_id, title, content')
    .in('module_id', moduleIds)

  if (itemError) {
    logger.error('getModulesWithExtraction: Fetch failed', itemError, { sectionId })
    return { data: [], error: 'Failed to load modules' }
  }

  // Group extracted files by module
  const moduleMap = new Map<string, ModuleFile[]>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const item of (items || []) as any[]) {
    const extraction = item.content?.extraction
    const fileType = item.content?.fileType
    // Any completed v2 extraction is a usable source: docx/xlsx contribute
    // native tables + exact chart data, images contribute their VLM reading.
    // Only pdf/ppt are page-renderable, so crops/peeks degrade gracefully
    // for the rest (isRenderableSource guards materialization).
    if (
      extraction?.status === 'completed' &&
      extraction?.pages?.length > 0 &&
      ['pdf', 'ppt', 'docx', 'xlsx', 'image'].includes(fileType)
    ) {
      const files = moduleMap.get(item.module_id) || []
      files.push({
        id: item.id,
        title: item.title || 'Untitled',
        fileType,
        pageCount: extraction?.metadata?.pageCount || 0,
        wordCount: extraction?.metadata?.wordCount || 0,
      })
      moduleMap.set(item.module_id, files)
    }
  }

  // Build hierarchical result — only include modules that have extracted files
  const result: ModuleGroup[] = modules
    .filter((m: { id: string }) => moduleMap.has(m.id))
    .map((m: { id: string; title: string }) => ({
      id: m.id,
      title: m.title,
      files: moduleMap.get(m.id) || [],
    }))

  return { data: result }
}

// ── Ad-hoc quiz uploads ───────────────────────────────────────────
// A file dropped into the AI-generate dialog becomes a REAL module item in a
// hidden, unpublished "Quiz Uploads" module — so it goes through the durable
// v2 extraction pipeline (tables/figures/charts → visual questions), shows up
// on the professor's Modules page with provenance, is reusable across quizzes,
// and is cleaned up by the existing delete trigger. Students never see it
// (module unpublished + item is_visible=false).

const QUIZ_UPLOADS_MODULE_TITLE = 'Quiz Uploads'
/** The container's real identity — `modules.system_kind`, not its title, which a
 *  professor can type or rename (migration 20260729044216). */
const QUIZ_UPLOADS_KIND = 'quiz_uploads'

/** Provenance stored on the item; rendered by the professor Modules page. */
export interface QuizUploadMeta {
  uploadedAt: string
  uploadedBy: string
  /** Quizzes whose AI-generated questions cite this upload (stamped at quiz save). */
  usedBy?: { quizId: string; quizTitle: string; linkedAt: string }[]
}

/**
 * Register a file uploaded in the AI-generate dialog: create the hidden
 * module item and enqueue v2 extraction. Returns the item id the dialog
 * polls for parsing status.
 */
export async function registerQuizUpload(
  sectionId: string,
  filePath: string,
  fileName: string,
): Promise<{ data?: { moduleItemId: string; moduleId: string }; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { owned, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!owned) return { error: 'You do not have permission to perform this action' }

    // The dialog uploads under this prefix; anything else is a forged path.
    // `..` traversal is rejected too — this path is stored on the item and
    // later read by the extraction worker and the peek route via the
    // RLS-bypassing admin client, so it must not be able to escape the section.
    if (!isSafeStoragePath(filePath, `${sectionId}/quiz-ai-uploads/`)) {
      return { error: 'Invalid upload path' }
    }
    const fileType = inferLectureFileType(fileName)
    if (fileType === 'notes') {
      return { error: 'Unsupported file type for extraction' }
    }

    /* Find-or-create the hidden container module (unpublished → never
       student-visible). Keyed on `system_kind`, never the title: matching on the
       title meant a module a professor happened to name "Quiz Uploads" became the
       bucket that AI-quiz source files land in. */
    const { data: existingModule } = await adminDb
      .from('modules')
      .select('id')
      .eq('section_id', sectionId)
      .eq('system_kind', QUIZ_UPLOADS_KIND)
      .limit(1)
    let moduleId: string | undefined = existingModule?.[0]?.id
    if (!moduleId) {
      const { data: createdModule, error: modError } = await adminDb
        .from('modules')
        .insert({
          section_id: sectionId,
          title: QUIZ_UPLOADS_MODULE_TITLE,
          description: 'Files uploaded for AI quiz generation. Not visible to students.',
          is_published: false,
          position: 9999,
          system_kind: QUIZ_UPLOADS_KIND,
        })
        .select('id')
        .single()
      if (createdModule) {
        moduleId = createdModule.id as string
      } else if (modError?.code === '23505') {
        // Lost the find-or-create race: a concurrent upload created the module
        // between our select and insert (modules_one_system_kind_per_section) —
        // use theirs.
        const { data: raced } = await adminDb
          .from('modules')
          .select('id')
          .eq('section_id', sectionId)
          .eq('system_kind', QUIZ_UPLOADS_KIND)
          .limit(1)
        moduleId = raced?.[0]?.id
      }
      if (!moduleId) {
        logger.error('registerQuizUpload: module create failed', modError, { sectionId })
        return { error: 'Failed to prepare the uploads module' }
      }
    }

    const quizUpload: QuizUploadMeta = {
      uploadedAt: new Date().toISOString(),
      uploadedBy: user.id,
    }
    const { data: inserted, error: insertError } = await adminDb
      .from('module_items')
      .insert({
        module_id: moduleId,
        item_type: 'lecture',
        title: fileName.replace(/\.[^.]+$/, ''),
        description: '',
        position: 9999,
        is_visible: false,
        content: { fileType, filePath, fileName, quizUpload },
      })
      .select('id')
      .single()
    if (insertError || !inserted) {
      logger.error('registerQuizUpload: item insert failed', insertError, { sectionId })
      return { error: 'Failed to save the upload' }
    }
    const moduleItemId = inserted.id as string

    // Durable queue + fire-and-forget kick — same path as normal lecture uploads.
    await enqueueExtractionJob({ moduleItemId, sectionId })

    await logEvent({
      userId: user.id,
      eventType: 'quiz_ai_upload_registered',
      sectionId,
      metadata: { moduleItemId, fileType },
    })
    revalidatePath(`/professor/courses/${sectionId}/modules`)

    return { data: { moduleItemId, moduleId } }
  } catch (err) {
    logger.error('registerQuizUpload: Exception', err, { sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

/**
 * Stamp `content.quizUpload.usedBy` on quiz-upload module items cited by the
 * given questions' source citations. Best-effort: errors are logged, never thrown.
 * The update is a read-modify-write of the whole `content` JSONB, so two quizzes
 * saved concurrently can drop one another's entry (last-write-wins). Acceptable:
 * `usedBy` is display-only provenance and must never drive deletion/GC of uploads.
 */
async function stampQuizUploadUsage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminDb: any,
  sectionId: string,
  quizId: string,
  quizTitle: string,
  questionIds: string[],
): Promise<void> {
  try {
    if (questionIds.length === 0) return
    const { data: cited } = await adminDb
      .from('quiz_questions')
      .select('source_citation')
      .in('id', questionIds)
      .eq('section_id', sectionId)
      .not('source_citation', 'is', null)
    const itemIds = [...new Set(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((cited ?? []) as any[])
        .map((q) => q.source_citation?.moduleItemId)
        .filter((id): id is string => typeof id === 'string'),
    )]
    if (itemIds.length === 0) return

    const { data: items } = await adminDb
      .from('module_items')
      .select('id, content, module:modules!inner(section_id)')
      .in('id', itemIds)
      .eq('module.section_id', sectionId)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const item of (items ?? []) as any[]) {
      const meta = item.content?.quizUpload as QuizUploadMeta | undefined
      if (!meta) continue // a normal lecture item, not an ad-hoc upload
      const usedBy = (meta.usedBy ?? []).filter((u) => u.quizId !== quizId)
      usedBy.push({ quizId, quizTitle, linkedAt: new Date().toISOString() })
      await adminDb
        .from('module_items')
        .update({
          content: { ...item.content, quizUpload: { ...meta, usedBy } },
          updated_at: new Date().toISOString(),
        })
        .eq('id', item.id)
    }
  } catch (err) {
    logger.warn('stampQuizUploadUsage: failed (non-fatal)', { sectionId, quizId, error: String(err) })
  }
}

/** Parsing status for the dialog's uploaded files (polled while the dialog is open). */
export async function getQuizUploadStatuses(
  sectionId: string,
  moduleItemIds: string[],
): Promise<{ data: { id: string; status: 'processing' | 'completed' | 'partial' | 'failed'; pageCount: number }[]; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { data: [], error: 'Not authenticated' }

    const { hasAccess, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!hasAccess) return { data: [], error: 'You do not have access to this section' }

    if (moduleItemIds.length === 0) return { data: [] }

    // Section-scoped (CWE-639 guard, same as generation's fetch).
    const { data: items, error } = await adminDb
      .from('module_items')
      .select('id, content, module:modules!inner(section_id)')
      .in('id', moduleItemIds.slice(0, 20))
      .eq('module.section_id', sectionId)
    if (error) return { data: [], error: 'Failed to load upload status' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = ((items ?? []) as any[]).map((item) => {
      const extraction = item.content?.extraction
      const status =
        extraction?.status === 'completed' || extraction?.status === 'partial' || extraction?.status === 'failed'
          ? extraction.status
          : 'processing'
      return { id: item.id as string, status, pageCount: extraction?.metadata?.pageCount ?? 0 }
    })
    return { data }
  } catch (err) {
    logger.error('getQuizUploadStatuses: Exception', err, { sectionId })
    return { data: [], error: 'An unexpected error occurred' }
  }
}

/**
 * Batch insert multiple questions into the question bank.
 * Used after AI generation or bulk import.
 */
export async function bulkCreateQuestions(
  sectionId: string,
  inputs: CreateQuestionServerInput[],
  // Draft autosave passes true: persist incomplete/blank placeholder questions
  // (tagged is_complete=false) instead of skipping them, so they survive
  // navigation. Default false keeps the strict behaviour for every other caller.
  allowIncomplete = false,
): Promise<{ data: Question[]; error?: string; skippedCount?: number }> {
  try {
    const user = await getAuthUser()
    if (!user) return { data: [], error: 'Not authenticated' }

    const { owned, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!owned) return { data: [], error: 'You do not have permission to perform this action' }

    if (inputs.length === 0) return { data: [] }

    // Validate all inputs. In draft mode a lenient schema accepts blank/partial
    // questions (shape + caps still enforced); otherwise the strict schema
    // skips anything ungradeable. Completeness → is_complete is computed below.
    const schema = allowIncomplete ? draftQuestionServerSchema : createQuestionServerSchema
    const validInputs: CreateQuestionServerInput[] = []
    let skippedCount = 0
    for (const input of inputs) {
      const parsed = schema.safeParse(input)
      if (parsed.success) {
        validInputs.push(parsed.data as CreateQuestionServerInput)
      } else {
        skippedCount++
        logger.warn('bulkCreateQuestions: Skipping invalid question', {
          error: parsed.error.issues[0]?.message,
        })
      }
    }

    if (validInputs.length === 0) {
      return { data: [], skippedCount, error: 'No valid questions to create' }
    }

    const rows = validInputs.map((q) => ({
      // Use the client-provided UUID when present so the caller can correlate
      // created rows back to client questions by id (skip-/order-proof). Falls
      // back to the column default when omitted. section_id is always the
      // verified sectionId, so this id cannot be used to write cross-tenant.
      ...(q.id ? { id: q.id } : {}),
      section_id: sectionId,
      question_text: q.questionText,
      question_type: q.content.questionType,
      content: q.content,
      difficulty: q.difficulty,
      blooms_level: q.bloomsLevel,
      tags: q.tags,
      points: q.points,
      explanation: q.explanation,
      is_bonus: q.isBonus,
      is_extra_credit: q.isExtraCredit,
      image_url: q.imageUrl,
      image_path: q.imagePath,
      code_snippet: q.codeSnippet,
      elo_rating: q.eloRating ?? 1200,
      expected_time_seconds: q.expectedTimeSeconds ?? null,
      irt_a: q.irtA ?? null,
      irt_b: q.irtB ?? null,
      irt_c: q.irtC ?? null,
      rubric: q.rubric ?? null,
      source_citation: q.sourceCitation ?? null,
      is_complete: isQuestionComplete(q.questionText, q.content, q.rubric),
    }))

    const { data: inserted, error } = await adminDb
      .from('quiz_questions')
      .insert(rows)
      .select()

    if (error) {
      logger.error('bulkCreateQuestions: Insert failed', error, { sectionId })
      return { data: [], error: 'Failed to create questions' }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const questions = (inserted || []).map((r: any) => mapDbQuestion(r))

    await logEvent({
      userId: user.id,
      eventType: 'quiz_questions_bulk_created',
      sectionId,
      metadata: { count: questions.length },
    })

    revalidatePath(sectionPath(sectionId))
    return { data: await signQuestionImages(questions), skippedCount }
  } catch (err) {
    logger.error('bulkCreateQuestions: Exception', err, { sectionId })
    return { data: [], error: 'An unexpected error occurred' }
  }
}

/**
 * Batch update difficulty, Elo rating, and expected time on existing questions.
 * Used by the wizard autosave to sync metadata edits without re-creating questions.
 * Single auth/ownership check for the batch (not per question).
 */
export async function bulkUpdateQuestionMetadata(
  sectionId: string,
  updates: { questionId: string; difficulty: string; eloRating: number; expectedTimeSeconds: number | null }[],
): Promise<{ error?: string }> {
  if (updates.length === 0) return {}
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { owned, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!owned) return { error: 'You do not have permission to perform this action' }

    const now = new Date().toISOString()
    // Update each question in parallel (Supabase doesn't support batch update with different values)
    await Promise.all(
      updates.map((u) =>
        adminDb
          .from('quiz_questions')
          .update({
            difficulty: u.difficulty,
            elo_rating: u.eloRating,
            expected_time_seconds: u.expectedTimeSeconds,
            updated_at: now,
          })
          .eq('id', u.questionId)
          .eq('section_id', sectionId),
      ),
    )

    return {}
  } catch (error) {
    logger.error('bulkUpdateQuestionMetadata: Exception', error, { sectionId })
    return { error: 'Failed to update question metadata' }
  }
}

/**
 * Batch update full content on existing questions.
 * Used by the wizard to sync edits made after auto-draft created the question
 * (e.g. image/code added after the initial auto-save).
 * Single auth/ownership check for the batch (not per question).
 */
export async function bulkUpdateQuestionContent(
  sectionId: string,
  updates: {
    questionId: string
    questionText: string
    content: CreateQuestionServerInput['content']
    difficulty: string
    bloomsLevel: string | null
    tags: string[]
    points: number
    explanation: string
    isBonus: boolean
    isExtraCredit: boolean
    imageUrl: string | null
    imagePath: string | null
    codeSnippet: { language: string; code: string } | null
    eloRating: number
    expectedTimeSeconds: number | null
    /** IRT b/a from the sidebar. Optional so a stale client that omits them
     *  can't wipe stored calibration; clamped to the engine's ranges. */
    irtA?: number | null
    irtB?: number | null
    /** Optional so stale clients that omit it can't wipe a stored rubric */
    rubric?: RubricNode[] | null
  }[],
): Promise<{ error?: string }> {
  if (updates.length === 0) return {}
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { owned, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!owned) return { error: 'You do not have permission to perform this action' }

    const rubricSchema = z.array(rubricNodeSchema).max(100).nullable()
    const now = new Date().toISOString()
    await Promise.all(
      updates.map((u) => {
        // Rubric writes only when explicitly provided AND well-formed — an
        // omitted or malformed value must never wipe the stored rubric
        // (explanation/walkthrough grading depends on it).
        const rubric = u.rubric !== undefined ? rubricSchema.safeParse(u.rubric) : null
        return adminDb
          .from('quiz_questions')
          .update({
            question_text: u.questionText,
            question_type: u.content.questionType,
            content: u.content,
            difficulty: u.difficulty,
            blooms_level: u.bloomsLevel,
            tags: u.tags,
            points: u.points,
            explanation: u.explanation,
            is_bonus: u.isBonus,
            is_extra_credit: u.isExtraCredit,
            image_url: u.imageUrl,
            image_path: u.imagePath,
            code_snippet: u.codeSnippet,
            elo_rating: u.eloRating,
            expected_time_seconds: u.expectedTimeSeconds,
            // Recompute completeness on every content edit: a placeholder that
            // just got filled in flips to complete (rejoins the bank picker);
            // one that got blanked flips back to incomplete. Pass the rubric so
            // explanation/walkthrough aren't marked complete without one.
            is_complete: isQuestionComplete(u.questionText, u.content, u.rubric),
            // Write IRT only when provided; clamp to the engine's valid ranges
            // (b ∈ [−3,3], a ∈ [0.5,2.5]). null = no explicit value → default.
            ...(u.irtA !== undefined
              ? { irt_a: u.irtA == null ? null : Math.min(2.5, Math.max(0.5, u.irtA)) }
              : {}),
            ...(u.irtB !== undefined
              ? { irt_b: u.irtB == null ? null : Math.min(3, Math.max(-3, u.irtB)) }
              : {}),
            ...(rubric?.success ? { rubric: rubric.data } : {}),
            updated_at: now,
          })
          .eq('id', u.questionId)
          .eq('section_id', sectionId)
      }),
    )

    return {}
  } catch (error) {
    logger.error('bulkUpdateQuestionContent: Exception', error, { sectionId })
    return { error: 'Failed to update questions' }
  }
}

/**
 * Create a quiz with full settings in one action (used by the wizard).
 * Unlike the simple createQuiz which only takes title/description,
 * this accepts all quiz configuration fields.
 */
export async function createQuizFull(
  sectionId: string,
  input: CreateQuizFullServerInput,
): Promise<{ data?: Quiz; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = createQuizFullServerSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    const { owned, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!owned) return { error: 'You do not have permission to perform this action' }

    const entitlement = await checkEntitlementBySection(adminDb, sectionId, 'quizzes')
    if (!entitlement.allowed) return { error: entitlementRefusalMessage('quizzes') }

    const d = parsed.data
    const { data: row, error } = await adminDb
      .from('quizzes')
      .insert({
        section_id: sectionId,
        created_by: user.id,
        title: d.title,
        description: d.description ?? '',
        time_limit_minutes: d.timeLimitMinutes ?? null,
        shuffle_questions: d.shuffleQuestions ?? false,
        shuffle_answers: d.shuffleAnswers ?? false,
        max_attempts: d.maxAttempts ?? null,
        pass_threshold: d.passThreshold ?? 60,
        due_date: d.dueDate ?? null,
        scheduled_publish_at: d.scheduledPublishAt ?? null,
        show_explanations: d.showExplanations ?? 'after_submission',
        show_leaderboard: d.showLeaderboard ?? false,
        allow_formula_sheet: d.allowFormulaSheet ?? false,
        formula_sheet_url: d.formulaSheetUrl ?? null,
        formula_sheet_path: d.formulaSheetPath ?? null,
        negative_marking: d.negativeMarking ?? false,
        negative_marking_penalty: d.negativeMarkingPenalty ?? 0.25,
        question_pools: d.questionPools ?? [],
        difficulty_distribution: d.difficultyDistribution ?? null,
        proctoring_enabled: d.proctoringEnabled ?? false,
        video_proctoring_enabled: d.videoProctoringEnabled ?? false,
        // Adaptive (CCAT v2) config.
        adaptive_mode: d.adaptiveMode ?? false,
        adaptive_question_count: d.adaptiveQuestionCount ?? 10,
        show_rating_to_students: d.showRatingToStudents ?? false,
        select_lambda: d.selectLambda ?? 0.5,
        stop_mode: d.stopMode ?? 'fixed',
        target_se: d.targetSe ?? 0.3,
      })
      .select()
      .single()

    if (error) {
      logger.error('createQuizFull: Insert failed', error, { sectionId })
      return { error: 'Failed to create quiz' }
    }

    await logEvent({ userId: user.id, eventType: 'quiz_created', sectionId, metadata: { quizId: row.id } })
    revalidatePath(sectionPath(sectionId))
    return { data: mapDbQuiz(row) }
  } catch (error) {
    logger.error('createQuizFull: Exception', error, { sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

/**
 * Resolve the draft a "Create quiz" click should land on. Reuses a lingering
 * empty "Untitled quiz" draft (no name, no description, no questions) if one
 * exists, otherwise creates a fresh one — so repeated clicks and abandoned
 * visits never multiply empty rows (Gmail-style). Called from the quiz list's
 * client "Create quiz" handler, which then navigates to the draft's real
 * /quizzes/{id} URL — so the studio has a stable, id-bearing URL from the first
 * render (no identity-less /quizzes/new hop).
 *
 * Find-or-create is intentionally NOT locked: the only race (two tabs clicking
 * "Create quiz" at the same instant) yields at most one extra empty draft, which
 * is hidden from the quiz list and reused on the next click — benign and
 * self-healing, so a lock/RPC would be over-engineering here.
 *
 * NOTE: no revalidatePath — nothing needs it. The editor fetches the draft
 * fresh on navigation, and the (client-side) quiz list hides empty drafts anyway.
 */
export async function getOrCreateEmptyDraft(
  sectionId: string,
): Promise<{ data?: { id: string }; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { owned, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!owned) return { error: 'You do not have permission to perform this action' }

    const entitlement = await checkEntitlementBySection(adminDb, sectionId, 'quizzes')
    if (!entitlement.allowed) return { error: entitlementRefusalMessage('quizzes') }

    // Reuse a lingering empty untitled draft, newest first.
    const { data: candidates } = await adminDb
      .from('quizzes')
      .select('id, description, generation_started_at')
      .eq('section_id', sectionId)
      .eq('status', 'draft')
      .eq('title', 'Untitled quiz')
      .order('created_at', { ascending: false })

    // Never reuse a draft that's mid-generation: during concept extraction it
    // has 0 questions but is about to be filled, so reusing it would land that
    // run's questions in what the professor thinks is a brand-new quiz. The
    // 15-min cutoff also frees a draft whose generation crashed without clearing
    // the stamp (a run can't legitimately outlast the 5-min route ceiling).
    const genFloor = Date.now() - 15 * 60_000
    const blank = (candidates ?? []).filter(
      (c: { description: string | null; generation_started_at: string | null }) =>
        !c.description?.trim() &&
        !(c.generation_started_at && new Date(c.generation_started_at).getTime() > genFloor),
    )
    if (blank.length > 0) {
      const ids = blank.map((c: { id: string }) => c.id)
      const { data: assigned } = await adminDb
        .from('quiz_question_assignments')
        .select('quiz_id')
        .in('quiz_id', ids)
      const hasQuestions = new Set(
        (assigned ?? []).map((a: { quiz_id: string }) => a.quiz_id),
      )
      const reusable = blank.find((c: { id: string }) => !hasQuestions.has(c.id))
      if (reusable) return { data: { id: reusable.id } }
    }

    const { data: row, error } = await adminDb
      .from('quizzes')
      .insert({
        section_id: sectionId,
        created_by: user.id,
        title: 'Untitled quiz',
        description: '',
      })
      .select('id')
      .single()

    if (error || !row) {
      logger.error('getOrCreateEmptyDraft: Insert failed', error, { sectionId })
      return { error: 'Failed to create quiz' }
    }

    await logEvent({ userId: user.id, eventType: 'quiz_created', sectionId, metadata: { quizId: row.id } })
    return { data: { id: row.id } }
  } catch (error) {
    logger.error('getOrCreateEmptyDraft: Exception', error, { sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

/**
 * Revert a published quiz back to draft status.
 */
export async function unpublishQuiz(
  sectionId: string,
  quizId: string,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { canWriteProfessor, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!canWriteProfessor) return { error: 'Only the professor can unpublish a quiz' }

    const { error } = await adminDb
      .from('quizzes')
      .update({ status: 'draft', updated_at: new Date().toISOString() })
      .eq('id', quizId)
      .eq('section_id', sectionId)

    if (error) {
      logger.error('unpublishQuiz: Update failed', error, { sectionId, quizId })
      return { error: 'Failed to revert quiz to draft' }
    }

    await logEvent({ userId: user.id, eventType: 'quiz_unpublished', sectionId, metadata: { quizId } })
    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('unpublishQuiz: Exception', error, { sectionId, quizId })
    return { error: 'An unexpected error occurred' }
  }
}

// ── Submissions Action ──────────────────────────────────────────

export interface QuizSubmissionRow {
  attemptId: string
  studentId: string
  studentName: string
  studentEmail: string
  score: number | null
  status: string
  startedAt: string
  submittedAt: string | null
  timeSpentSeconds: number
  proctoringSummary: ProctoringSummary | null
}

/**
 * Fetch all attempts for a quiz with student info and proctoring summary.
 * Used by the professor submissions view.
 */
export async function getQuizSubmissions(
  sectionId: string,
  quizId: string,
): Promise<{ data?: QuizSubmissionRow[]; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { hasAccess, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!hasAccess) return { error: 'You do not have access to this section' }

    // Fetch all attempts (submitted + in_progress)
    const { data: attempts, error: attErr } = await adminDb
      .from('quiz_attempts')
      .select('id, student_id, score, status, started_at, submitted_at, time_spent_seconds, proctoring_summary')
      .eq('quiz_id', quizId)
      .eq('section_id', sectionId)
      .order('submitted_at', { ascending: false, nullsFirst: false })

    if (attErr) {
      logger.error('getQuizSubmissions: fetch attempts failed', attErr)
      return { error: 'Failed to fetch submissions' }
    }

    if (!attempts || attempts.length === 0) return { data: [] }

    // Fetch student profiles
    const studentIds = [...new Set(attempts.map((a: { student_id: string }) => a.student_id))]
    const { data: profiles } = await adminDb
      .from('profiles')
      .select('id, first_name, last_name, email')
      .in('id', studentIds)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const profileMap = new Map((profiles || []).map((p: any) => [p.id, p]))

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: QuizSubmissionRow[] = attempts.map((a: any) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const profile: any = profileMap.get(a.student_id)
      return {
        attemptId: a.id,
        studentId: a.student_id,
        studentName: [profile?.first_name, profile?.last_name].filter(Boolean).join(' ') || 'Unknown',
        studentEmail: profile?.email ?? '',
        score: a.score,
        status: a.status,
        startedAt: a.started_at,
        submittedAt: a.submitted_at,
        timeSpentSeconds: a.time_spent_seconds ?? 0,
        proctoringSummary: a.proctoring_summary ?? null,
      }
    })

    return { data: rows }
  } catch (error) {
    logger.error('getQuizSubmissions: Exception', error, { sectionId, quizId })
    return { error: 'An unexpected error occurred' }
  }
}

// ── Student Attempt Detail (Professor View) ─────────────────────

export interface WalkthroughTurn {
  role: 'student' | 'tutor'
  text: string
}

export interface StudentAnswerDetail {
  questionId: string
  questionText: string
  questionType: string
  points: number
  selectedChoiceIds?: string[]
  booleanAnswer?: boolean
  textAnswer?: string
  blankAnswers?: Record<string, string>
  isCorrect: boolean | null
  earnedPoints: number | null
  overridePoints: number | null
  overrideReason: string | null
  timeSpentSeconds: number
  // Include content for rendering choices/correct answers
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  content: any
  explanation: string
  // Adaptive-only detail — null for standard attempts. Rubric coverage is
  // counts only (node concepts are answer-key material, never sent).
  softScore?: number | null
  rationale?: string | null
  nodesMet?: number | null
  nodesTotal?: number | null
  misconceptionNode?: string | null
  walkthroughTranscript?: WalkthroughTurn[] | null
}

export interface StudentAttemptDetail {
  attemptId: string
  studentId: string
  studentName: string
  studentEmail: string
  score: number | null
  totalPoints: number | null
  earnedPoints: number | null
  status: string
  startedAt: string
  submittedAt: string | null
  timeSpentSeconds: number
  proctoringSummary: ProctoringSummary | null
  answers: StudentAnswerDetail[]
  proctoringEvents: ProctoringEvent[]
  questionTextsMap: Record<number, string>
}

/**
 * Fetch full detail for a specific student attempt — all answers with
 * question text, correctness, and points. Used by the professor to
 * review a single student's submission.
 */
export async function getStudentAttemptDetail(
  sectionId: string,
  attemptId: string,
): Promise<{ data?: StudentAttemptDetail; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { hasAccess, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!hasAccess) return { error: 'You do not have access to this section' }

    // Fetch attempt
    const { data: attempt, error: attErr } = await adminDb
      .from('quiz_attempts')
      .select('*')
      .eq('id', attemptId)
      .single()

    if (attErr || !attempt) return { error: 'Attempt not found' }

    // Verify quiz belongs to section
    const { data: quizRow } = await adminDb
      .from('quizzes')
      .select('id, section_id')
      .eq('id', attempt.quiz_id)
      .eq('section_id', sectionId)
      .single()

    if (!quizRow) return { error: 'Quiz not found for this section' }

    // Fetch student profile
    const { data: profile } = await adminDb
      .from('profiles')
      .select('first_name, last_name, email')
      .eq('id', attempt.student_id)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .single() as { data: any }

    // Fetch answers
    const { data: answerRows } = await adminDb
      .from('quiz_answers')
      .select('*')
      .eq('attempt_id', attemptId)

    // Resolve the question order: the attempt's actually-served questions
    // (adaptive picks these per student), else the quiz's fixed assignment list.
    // Legacy adaptive attempts recorded no served list — without this fallback
    // the review renders a broken 0/0 instead of the questions.
    let resolvedIds: string[] = attempt.resolved_question_ids ?? []
    if (resolvedIds.length === 0) {
      const { data: assignments } = await adminDb
        .from('quiz_question_assignments')
        .select('question_id')
        .eq('quiz_id', attempt.quiz_id)
        .order('position', { ascending: true })
      resolvedIds = (assignments || []).map((a: { question_id: string }) => a.question_id)
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let questionRows: any[] = []
    if (resolvedIds.length > 0) {
      const { data: qRows } = await adminDb
        .from('quiz_questions')
        .select('*')
        .in('id', resolvedIds)
      questionRows = qRows || []
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const questionMap = new Map(questionRows.map((q: any) => [q.id, q]))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const answerMap = new Map((answerRows || []).map((a: any) => [a.question_id, a]))

    // Walkthrough transcripts are stored server-side on the attempt, keyed by
    // question id (migration 20260609000200). The professor owns the section,
    // so surfacing them here is authorized.
    const transcripts: Record<string, WalkthroughTurn[]> =
      (attempt.walkthrough_transcripts as Record<string, WalkthroughTurn[]>) ?? {}

    // Build ordered answer details following resolved question order
    const answers: StudentAnswerDetail[] = []
    for (const qId of resolvedIds) {
      const q = questionMap.get(qId)
      if (!q) continue
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const a: any = answerMap.get(qId)
      // Rubric node verdicts carry answer-key concept text — ship coverage as
      // counts only, never the concepts (mirrors the student results path).
      const nodes = Array.isArray(a?.nodes) ? (a.nodes as { met?: boolean }[]) : null
      const transcript = transcripts[qId]
      answers.push({
        questionId: q.id,
        questionText: q.question_text,
        questionType: q.question_type ?? q.content?.questionType ?? 'unknown',
        points: q.points,
        selectedChoiceIds: a?.selected_choice_ids ?? undefined,
        booleanAnswer: a?.boolean_answer ?? undefined,
        textAnswer: a?.text_answer ?? undefined,
        blankAnswers: a?.blank_answers ?? undefined,
        isCorrect: a?.is_correct ?? null,
        earnedPoints: a?.earned_points ?? null,
        overridePoints: a?.override_points ?? null,
        overrideReason: a?.override_reason ?? null,
        timeSpentSeconds: a?.time_spent_seconds ?? 0,
        content: q.content,
        explanation: q.explanation ?? '',
        // Adaptive-only detail — undefined/null for standard attempts so the UI omits it.
        softScore: a?.soft_score != null ? Number(a.soft_score) : null,
        rationale: a?.rationale ?? null,
        nodesMet: nodes ? nodes.filter((n) => n.met).length : null,
        nodesTotal: nodes ? nodes.length : null,
        misconceptionNode: a?.misconception_node ?? null,
        walkthroughTranscript: Array.isArray(transcript) && transcript.length > 0 ? transcript : null,
      })
    }

    // Fetch proctoring events for this attempt (if any)
    const { data: batches } = await adminDb
      .from('quiz_proctoring_logs')
      .select('events, created_at')
      .eq('attempt_id', attemptId)
      .order('created_at', { ascending: true })

    const proctoringEvents: ProctoringEvent[] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const batch of (batches || []) as any[]) {
      if (Array.isArray(batch.events)) {
        proctoringEvents.push(...batch.events)
      }
    }
    proctoringEvents.sort((a, b) => a.t - b.t)

    // Build question index → text map for timeline context
    const questionTextsMap: Record<number, string> = {}
    resolvedIds.forEach((id, index) => {
      const q = questionMap.get(id)
      if (q) questionTextsMap[index] = q.question_text
    })

    return {
      data: {
        attemptId,
        studentId: attempt.student_id,
        studentName: [profile?.first_name, profile?.last_name].filter(Boolean).join(' ') || 'Unknown',
        studentEmail: profile?.email ?? '',
        score: attempt.score,
        totalPoints: attempt.total_points,
        earnedPoints: attempt.earned_points,
        status: attempt.status,
        startedAt: attempt.started_at,
        submittedAt: attempt.submitted_at,
        timeSpentSeconds: attempt.time_spent_seconds ?? 0,
        proctoringSummary: attempt.proctoring_summary ?? null,
        answers,
        proctoringEvents,
        questionTextsMap,
      },
    }
  } catch (error) {
    logger.error('getStudentAttemptDetail: Exception', error, { sectionId, attemptId })
    return { error: 'An unexpected error occurred' }
  }
}

// ── Proctoring Actions ──────────────────────────────────────────

interface ProctoringOverviewRow {
  attemptId: string
  studentId: string
  studentName: string
  studentEmail: string
  score: number | null
  submittedAt: string | null
  timeSpentSeconds: number
  summary: ProctoringSummary | null
}

/**
 * Get a proctoring overview for all submitted attempts on a quiz.
 * Returns summary stats per student for the professor dashboard table.
 */
export async function getQuizProctoringOverview(
  sectionId: string,
  quizId: string,
): Promise<{ data?: ProctoringOverviewRow[]; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { hasAccess, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!hasAccess) return { error: 'You do not have access to this section' }

    // Verify quiz exists and has proctoring enabled
    const { data: quizRow, error: quizErr } = await adminDb
      .from('quizzes')
      .select('id, proctoring_enabled, video_proctoring_enabled')
      .eq('id', quizId)
      .eq('section_id', sectionId)
      .single()

    if (quizErr || !quizRow) return { error: 'Quiz not found' }
    if (!quizRow.proctoring_enabled && !quizRow.video_proctoring_enabled) return { error: 'Proctoring is not enabled for this quiz' }

    // Fetch all submitted attempts with proctoring summary
    const { data: attempts, error: attErr } = await adminDb
      .from('quiz_attempts')
      .select('id, student_id, score, submitted_at, time_spent_seconds, proctoring_summary')
      .eq('quiz_id', quizId)
      .eq('status', 'submitted')
      .order('submitted_at', { ascending: false })

    if (attErr) {
      logger.error('getQuizProctoringOverview: fetch attempts failed', attErr)
      return { error: 'Failed to fetch attempts' }
    }

    if (!attempts || attempts.length === 0) return { data: [] }

    // Fetch student profiles for these attempts
    const studentIds = [...new Set(attempts.map((a: { student_id: string }) => a.student_id))]
    const { data: profiles, error: profErr } = await adminDb
      .from('profiles')
      .select('id, first_name, last_name, email')
      .in('id', studentIds)

    if (profErr) {
      logger.error('getQuizProctoringOverview: fetch profiles failed', profErr)
      return { error: 'Failed to fetch student profiles' }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const profileMap = new Map((profiles || []).map((p: any) => [p.id, p]))

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: ProctoringOverviewRow[] = attempts.map((a: any) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const profile: any = profileMap.get(a.student_id)
      return {
        attemptId: a.id,
        studentId: a.student_id,
        studentName: [profile?.first_name, profile?.last_name].filter(Boolean).join(' ') || 'Unknown',
        studentEmail: profile?.email ?? '',
        score: a.score,
        submittedAt: a.submitted_at,
        timeSpentSeconds: a.time_spent_seconds ?? 0,
        summary: a.proctoring_summary ?? null,
      }
    })

    return { data: rows }
  } catch (error) {
    logger.error('getQuizProctoringOverview: Exception', error, { sectionId, quizId })
    return { error: 'An unexpected error occurred' }
  }
}

interface ProctoringDetailResult {
  studentName: string
  studentEmail: string
  startedAt: string
  submittedAt: string | null
  score: number | null
  timeSpentSeconds: number
  summary: ProctoringSummary | null
  events: ProctoringEvent[]
  questionTexts: Record<number, string>
}

/**
 * Get the full proctoring detail for a specific attempt — all events
 * flattened into a single chronological timeline with question context.
 */
export async function getAttemptProctoringDetail(
  sectionId: string,
  attemptId: string,
): Promise<{ data?: ProctoringDetailResult; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { hasAccess, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!hasAccess) return { error: 'You do not have access to this section' }

    // Fetch the attempt
    const { data: attempt, error: attErr } = await adminDb
      .from('quiz_attempts')
      .select('id, quiz_id, student_id, started_at, submitted_at, score, time_spent_seconds, proctoring_summary, resolved_question_ids')
      .eq('id', attemptId)
      .single()

    if (attErr || !attempt) return { error: 'Attempt not found' }

    // Verify the quiz belongs to this section
    const { data: quizRow, error: quizErr } = await adminDb
      .from('quizzes')
      .select('id, section_id, proctoring_enabled, video_proctoring_enabled')
      .eq('id', attempt.quiz_id)
      .eq('section_id', sectionId)
      .single()

    if (quizErr || !quizRow) return { error: 'Quiz not found for this section' }
    if (!quizRow.proctoring_enabled && !quizRow.video_proctoring_enabled) return { error: 'Proctoring is not enabled for this quiz' }

    // Fetch student profile
    const { data: profile } = await adminDb
      .from('profiles')
      .select('first_name, last_name, email')
      .eq('id', attempt.student_id)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .single() as { data: any }

    // Fetch all proctoring log batches for this attempt
    const { data: batches, error: batchErr } = await adminDb
      .from('quiz_proctoring_logs')
      .select('events, created_at')
      .eq('attempt_id', attemptId)
      .order('created_at', { ascending: true })

    if (batchErr) {
      logger.error('getAttemptProctoringDetail: fetch batches failed', batchErr)
      return { error: 'Failed to fetch proctoring logs' }
    }

    // Flatten all events and sort by timestamp offset
    const allEvents: ProctoringEvent[] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const batch of (batches || []) as any[]) {
      if (Array.isArray(batch.events)) {
        allEvents.push(...batch.events)
      }
    }
    allEvents.sort((a, b) => a.t - b.t)

    // Build question index → question text mapping
    const questionIds: string[] = attempt.resolved_question_ids ?? []
    const questionTexts: Record<number, string> = {}

    if (questionIds.length > 0) {
      const { data: questions } = await adminDb
        .from('quiz_questions')
        .select('id, question_text')
        .in('id', questionIds)

      if (questions) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const questionMap = new Map<string, string>(questions.map((q: any) => [q.id, q.question_text]))
        questionIds.forEach((id, index) => {
          questionTexts[index] = questionMap.get(id) ?? `Question ${index + 1}`
        })
      }
    }

    return {
      data: {
        studentName: [profile?.first_name, profile?.last_name].filter(Boolean).join(' ') || 'Unknown',
        studentEmail: profile?.email ?? '',
        startedAt: attempt.started_at,
        submittedAt: attempt.submitted_at,
        score: attempt.score,
        timeSpentSeconds: attempt.time_spent_seconds ?? 0,
        summary: attempt.proctoring_summary ?? null,
        events: allEvents,
        questionTexts,
      },
    }
  } catch (error) {
    logger.error('getAttemptProctoringDetail: Exception', error, { sectionId, attemptId })
    return { error: 'An unexpected error occurred' }
  }
}

// ── Video Proctoring: Get Snapshots ──────────────────────────────

/**
 * Get all proctoring snapshots for a specific attempt.
 * Returns snapshots sorted chronologically for the professor review UI.
 */
export async function getAttemptProctoringSnapshots(
  sectionId: string,
  attemptId: string,
): Promise<{ data?: ProctoringSnapshot[]; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { hasAccess, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!hasAccess) return { error: 'You do not have access to this section' }

    const { data: snapshots, error } = await adminDb
      .from('proctoring_snapshots')
      .select('*')
      .eq('attempt_id', attemptId)
      .eq('section_id', sectionId)
      .order('timestamp_offset', { ascending: true })

    if (error) {
      logger.error('getAttemptProctoringSnapshots: fetch failed', error)
      return { error: 'Failed to fetch snapshots' }
    }

    /* The proctoring-snapshots bucket is private (migration 47). The stored
     * snapshot_url may be (a) an expired 7-day signed URL, (b) a legacy public
     * URL that no longer resolves, or (c) just the storage_path. Mint a fresh
     * signed URL per snapshot at read time so the professor's review UI keeps
     * working. Batched via createSignedUrls to avoid N round-trips. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = (snapshots || []) as any[]
    const paths = rows.map((s) => s.storage_path).filter(Boolean) as string[]
    const signedByPath = new Map<string, string>()
    if (paths.length > 0) {
      const { data: signed } = await adminDb.storage
        .from('proctoring-snapshots')
        .createSignedUrls(paths, 60 * 60) // 1 hour — review session timescale
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(signed || []).forEach((row: any) => {
        if (row?.path && row?.signedUrl) signedByPath.set(row.path, row.signedUrl)
      })
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mapped: ProctoringSnapshot[] = rows.map((s: any) => ({
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

    return { data: mapped }
  } catch (error) {
    logger.error('getAttemptProctoringSnapshots: Exception', error, { sectionId, attemptId })
    return { error: 'An unexpected error occurred' }
  }
}

// ── Grade Override ────────────────────────────────────────────────

/**
 * Override the auto-graded points for a single answer. Recalculates
 * the attempt total score and earned points after the update.
 */
export async function overrideAnswerScore(
  sectionId: string,
  attemptId: string,
  questionId: string,
  input: OverrideAnswerScoreInput,
): Promise<{ success?: boolean; newScore?: number; newEarnedPoints?: number; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = overrideAnswerScoreSchema.safeParse(input)
    if (!parsed.success) return { error: 'Invalid input' }
    const { overridePoints, overrideReason } = parsed.data

    const { owned, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!owned) return { error: 'You do not have permission to perform this action' }

    // Verify attempt exists and belongs to this section
    const { data: attempt, error: attErr } = await adminDb
      .from('quiz_attempts')
      .select('id, quiz_id, total_points, status')
      .eq('id', attemptId)
      .single()

    if (attErr || !attempt) return { error: 'Attempt not found' }
    if (attempt.status !== 'submitted') return { error: 'Cannot override an in-progress attempt' }

    // Verify quiz belongs to section
    const { data: quizRow } = await adminDb
      .from('quizzes')
      .select('id')
      .eq('id', attempt.quiz_id)
      .eq('section_id', sectionId)
      .single()

    if (!quizRow) return { error: 'Quiz not found for this section' }

    // Fetch the question to validate override <= max points
    const { data: question } = await adminDb
      .from('quiz_questions')
      .select('points')
      .eq('id', questionId)
      .single()

    if (!question) return { error: 'Question not found' }
    if (overridePoints < 0) {
      return { error: 'Override points cannot be negative' }
    }
    if (overridePoints > question.points) {
      return { error: `Override cannot exceed the question's maximum points (${question.points})` }
    }

    // Update the answer's override fields
    const { error: updateErr } = await adminDb
      .from('quiz_answers')
      .update({
        override_points: overridePoints,
        override_reason: overrideReason || null,
      })
      .eq('attempt_id', attemptId)
      .eq('question_id', questionId)

    if (updateErr) {
      logger.error('overrideAnswerScore: Failed to update answer', updateErr)
      return { error: 'Failed to update score' }
    }

    // Recalculate attempt totals from all answers
    const { data: allAnswers } = await adminDb
      .from('quiz_answers')
      .select('earned_points, override_points')
      .eq('attempt_id', attemptId)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawEarnedPoints = (allAnswers || []).reduce((sum: number, a: any) => {
      const pts = a.override_points ?? a.earned_points ?? 0
      return sum + Number(pts)
    }, 0)

    const totalPoints = Number(attempt.total_points) || 0
    // Clamp earned points: floor at 0 (negative marking can't go below 0 after override),
    // cap at totalPoints to prevent >100% scores from stacked overrides
    const newEarnedPoints = totalPoints > 0
      ? Math.max(0, Math.min(rawEarnedPoints, totalPoints))
      : Math.max(0, rawEarnedPoints)
    const newScore = totalPoints > 0
      ? Math.round((newEarnedPoints / totalPoints) * 100)
      : 0

    // Update attempt totals
    await adminDb
      .from('quiz_attempts')
      .update({ earned_points: newEarnedPoints, score: newScore })
      .eq('id', attemptId)

    await logEvent({
      userId: user.id,
      eventType: 'quiz_answer_overridden',
      sectionId,
      metadata: { attemptId, questionId, overridePoints, overrideReason },
    })

    revalidatePath(sectionPath(sectionId))

    return { success: true, newScore, newEarnedPoints }
  } catch (error) {
    logger.error('overrideAnswerScore: Exception', error, { sectionId, attemptId, questionId })
    return { error: 'An unexpected error occurred' }
  }
}

// ── Time Analytics ────────────────────────────────────────────────

/** Per-question time analytics row for the professor insights chart. */
export interface TimeAnalyticsRow {
  questionId: string
  questionText: string
  position: number
  avgTime: number      // seconds
  minTime: number
  maxTime: number
  attemptCount: number
  accuracy: number     // 0–1
}

/**
 * Aggregate time_spent_seconds from quiz_answers per question in position order.
 * Only considers submitted attempts with recorded time (> 0).
 * Used by the professor Time Analysis chart in QuizInsightsDashboard.
 */
export async function getQuizTimeAnalytics(
  sectionId: string,
  quizId: string,
): Promise<{ data: TimeAnalyticsRow[]; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { data: [], error: 'Not authenticated' }

    const { hasAccess, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!hasAccess) return { data: [], error: 'You do not have access to this section' }

    // Get quiz question assignments ordered by position
    const { data: assignments } = await adminDb
      .from('quiz_question_assignments')
      .select('question_id, position')
      .eq('quiz_id', quizId)
      .order('position', { ascending: true })

    if (!assignments || assignments.length === 0) return { data: [] }

    const questionIds: string[] = assignments.map((a: { question_id: string }) => a.question_id)
    const positionMap: Record<string, number> = {}
    for (const a of assignments as { question_id: string; position: number }[]) {
      positionMap[a.question_id] = a.position
    }

    // Get question texts and points
    const { data: questions } = await adminDb
      .from('quiz_questions')
      .select('id, question_text, points')
      .in('id', questionIds)

    const questionTextMap: Record<string, string> = {}
    const questionPointsMap: Record<string, number> = {}
    for (const q of (questions || []) as { id: string; question_text: string; points: number }[]) {
      questionTextMap[q.id] = q.question_text
      questionPointsMap[q.id] = q.points
    }

    // Get submitted attempts
    const { data: attempts } = await adminDb
      .from('quiz_attempts')
      .select('id')
      .eq('quiz_id', quizId)
      .eq('section_id', sectionId)
      .eq('status', 'submitted')

    if (!attempts || attempts.length === 0) return { data: [] }

    const attemptIds: string[] = attempts.map((a: { id: string }) => a.id)

    // Get answers with time data (only rows with recorded time)
    const { data: answers } = await adminDb
      .from('quiz_answers')
      .select('question_id, time_spent_seconds, earned_points')
      .in('attempt_id', attemptIds)
      .in('question_id', questionIds)
      .gt('time_spent_seconds', 0)

    // Aggregate per question
    const statsMap: Record<string, { times: number[]; earned: number[] }> = {}
    for (const ans of (answers || []) as { question_id: string; time_spent_seconds: number; earned_points: number | null }[]) {
      if (!statsMap[ans.question_id]) {
        statsMap[ans.question_id] = { times: [], earned: [] }
      }
      statsMap[ans.question_id].times.push(ans.time_spent_seconds)
      if (ans.earned_points !== null) {
        statsMap[ans.question_id].earned.push(ans.earned_points)
      }
    }

    const result: TimeAnalyticsRow[] = questionIds
      .filter((qid) => statsMap[qid] && statsMap[qid].times.length > 0)
      .map((qid) => {
        const stats = statsMap[qid]
        const times = stats.times
        const maxPts = questionPointsMap[qid] ?? 1
        const avgTime = Math.round(times.reduce((s, t) => s + t, 0) / times.length)
        const minTime = Math.min(...times)
        const maxTime = Math.max(...times)
        const accuracy =
          stats.earned.length > 0 && maxPts > 0
            ? stats.earned.reduce((s, e) => s + e, 0) / (stats.earned.length * maxPts)
            : 0

        return {
          questionId: qid,
          questionText: questionTextMap[qid] ?? '',
          position: positionMap[qid] ?? 0,
          avgTime,
          minTime,
          maxTime,
          attemptCount: times.length,
          accuracy: Math.max(0, Math.min(1, accuracy)),
        }
      })
      .sort((a, b) => a.position - b.position)

    return { data: result }
  } catch (error) {
    logger.error('getQuizTimeAnalytics: Exception', error, { sectionId, quizId })
    return { data: [], error: 'An unexpected error occurred' }
  }
}

// ── Adaptive Quiz Analytics Actions ─────────────────────────────

/**
 * Get adaptive analytics for a quiz — cohort comparison, behavioral data,
 * integrity flags, and performance by difficulty.
 */
export async function getAdaptiveAnalytics(sectionId: string, quizId: string) {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated', data: null }

    const { hasAccess, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!hasAccess) return { error: 'You do not have access to this section', data: null }

    // Get all submitted attempts for this quiz with cohort data.
    // Bind to sectionId (not just quiz_id) — verifyOwnership only proved the
    // caller owns the SECTION; without this, a professor could pass any quizId
    // from another section/institution and read its students' results (IDOR).
    const { data: attempts } = await adminDb
      .from('quiz_attempts')
      .select('id, student_id, cohort, score, start_rating, final_rating, current_rating, status')
      .eq('quiz_id', quizId)
      .eq('section_id', sectionId)
      .eq('status', 'submitted')

    if (!attempts || attempts.length === 0) {
      return { data: { totalAttempts: 0, adaptive: null, control: null, integrityFlags: [], topPerformers: [] } }
    }

    // Get student names
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const studentIds = [...new Set((attempts as any[]).map((a: any) => a.student_id))]
    const { data: profiles } = await adminDb
      .from('profiles')
      .select('id, name')
      .in('id', studentIds)

    const nameMap: Record<string, string> = {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const p of (profiles || []) as any[]) {
      nameMap[p.id] = p.name || 'Anonymous'
    }

    // Split by cohort
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adaptiveAttempts = (attempts as any[]).filter((a: any) => a.cohort === 'adaptive')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const controlAttempts = (attempts as any[]).filter((a: any) => a.cohort === 'control')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const computeStats = (group: any[]) => {
      if (group.length === 0) return null
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const scores = group.map((a: any) => a.score ?? 0)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ratings = group.map((a: any) => a.final_rating ?? a.current_rating ?? 1200)
      return {
        count: group.length,
        avgScore: Math.round(scores.reduce((s: number, v: number) => s + v, 0) / scores.length),
        maxScore: Math.max(...scores),
        minScore: Math.min(...scores),
        avgRating: Math.round(ratings.reduce((s: number, v: number) => s + v, 0) / ratings.length),
        maxRating: Math.max(...ratings),
        minRating: Math.min(...ratings),
      }
    }

    // Get all answers for behavioral data
    const attemptIds = (attempts as { id: string }[]).map(a => a.id)
    const { data: answers } = await adminDb
      .from('quiz_answers')
      .select('attempt_id, question_id, option_changes, tab_switches, copy_attempts, time_spent_seconds, is_correct')
      .in('attempt_id', attemptIds)

    // Compute integrity flags per student
    const studentBehavior: Record<string, { tabs: number; copies: number; options: number }> = {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const ans of (answers || []) as any[]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const attempt = (attempts as any[]).find((a: any) => a.id === ans.attempt_id)
      if (!attempt) continue
      const sid = attempt.student_id
      if (!studentBehavior[sid]) studentBehavior[sid] = { tabs: 0, copies: 0, options: 0 }
      studentBehavior[sid].tabs += ans.tab_switches ?? 0
      studentBehavior[sid].copies += ans.copy_attempts ?? 0
      studentBehavior[sid].options += ans.option_changes ?? 0
    }

    const integrityFlags = Object.entries(studentBehavior)
      .filter(([, b]) => b.tabs >= 3 || b.copies >= 1)
      .map(([sid, b]) => ({
        studentId: sid,
        studentName: nameMap[sid] || 'Anonymous',
        level: (b.tabs >= 5 || b.copies >= 2 ? 'HIGH' : 'MEDIUM') as 'HIGH' | 'MEDIUM',
        totalTabSwitches: b.tabs,
        totalCopyAttempts: b.copies,
        totalOptionChanges: b.options,
        proctoringFlags: [] as string[],
      }))
      .sort((a, b) => (a.level === 'HIGH' ? 0 : 1) - (b.level === 'HIGH' ? 0 : 1))

    // Top performers by final rating
    const topPerformers = adaptiveAttempts
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((a: any) => ({
        studentId: a.student_id,
        studentName: nameMap[a.student_id] || 'Anonymous',
        finalRating: a.final_rating ?? a.current_rating ?? 1200,
        score: a.score ?? 0,
      }))
      .sort((a: { finalRating: number }, b: { finalRating: number }) => b.finalRating - a.finalRating)
      .slice(0, 10)

    return {
      data: {
        totalAttempts: attempts.length,
        adaptive: computeStats(adaptiveAttempts),
        control: computeStats(controlAttempts),
        integrityFlags,
        topPerformers,
      },
    }
  } catch (error) {
    logger.error('getAdaptiveAnalytics: Exception', error, { sectionId, quizId })
    return { error: 'An unexpected error occurred', data: null }
  }
}

/**
 * Get all cohort assignments for students in a section.
 */
export async function getCohortAssignments(sectionId: string) {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated', data: [] }

    const { hasAccess, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!hasAccess) return { error: 'You do not have access to this section', data: [] }

    const { data: rows, error } = await adminDb
      .from('cohort_assignments')
      .select('student_id, cohort, assigned_by, assigned_at')
      .eq('section_id', sectionId)

    if (error) {
      logger.error('getCohortAssignments: Fetch failed', error, { sectionId })
      return { error: 'Failed to load cohort assignments', data: [] }
    }

    // Get student names
    const studentIds = (rows || []).map((r: { student_id: string }) => r.student_id)
    let nameMap: Record<string, string> = {}
    if (studentIds.length > 0) {
      const { data: profiles } = await adminDb
        .from('profiles')
        .select('id, name')
        .in('id', studentIds)
      if (profiles) {
        nameMap = (profiles as { id: string; name: string | null }[]).reduce(
          (acc: Record<string, string>, p) => { acc[p.id] = p.name || 'Anonymous'; return acc },
          {} as Record<string, string>,
        )
      }
    }

    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: (rows || []).map((r: any) => ({
        studentId: r.student_id,
        studentName: nameMap[r.student_id] || 'Anonymous',
        cohort: r.cohort,
        assignedBy: r.assigned_by,
        assignedAt: r.assigned_at,
      })),
    }
  } catch (error) {
    logger.error('getCohortAssignments: Exception', error, { sectionId })
    return { error: 'An unexpected error occurred', data: [] }
  }
}

/**
 * Override a student's cohort assignment (professor manual override).
 */
export async function overrideCohortAssignment(
  sectionId: string,
  studentId: string,
  cohort: 'adaptive' | 'control',
) {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { owned, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!owned) return { error: 'You do not have permission to perform this action' }

    const { error } = await adminDb
      .from('cohort_assignments')
      .upsert({
        student_id: studentId,
        section_id: sectionId,
        cohort,
        assigned_by: 'professor',
        assigned_at: new Date().toISOString(),
      }, { onConflict: 'student_id,section_id' })

    if (error) {
      logger.error('overrideCohortAssignment: Upsert failed', error, { sectionId, studentId })
      return { error: 'Failed to override cohort' }
    }

    await logEvent({
      userId: user.id,
      eventType: 'cohort_override',
      sectionId,
      metadata: { studentId, cohort },
    })

    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('overrideCohortAssignment: Exception', error, { sectionId, studentId })
    return { error: 'An unexpected error occurred' }
  }
}


// ── Reset Student Attempt ──────────────────────────────────────────

/**
 * Deletes a student's quiz attempt and all associated answers so the
 * student can retake the quiz. Professor must own the section.
 */
export async function resetStudentAttempt(
  attemptId: string,
  sectionId: string,
): Promise<{ error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { owned, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!owned) return { error: 'You do not have permission to perform this action' }

    // Verify the attempt belongs to a quiz in this section
    const { data: attempt, error: fetchErr } = await adminDb
      .from('quiz_attempts')
      .select('id, quiz_id, student_id, quizzes!inner(section_id)')
      .eq('id', attemptId)
      .single()

    if (fetchErr || !attempt) return { error: 'Attempt not found' }
    if (attempt.quizzes.section_id !== sectionId) return { error: 'Attempt does not belong to this section' }

    // Delete answers first (foreign key constraint)
    const { error: answersErr } = await adminDb
      .from('quiz_answers')
      .delete()
      .eq('attempt_id', attemptId)

    if (answersErr) {
      logger.error('resetStudentAttempt: Failed to delete answers', answersErr, { attemptId })
      return { error: 'Failed to delete answers' }
    }

    // Delete the attempt
    const { error: attemptErr } = await adminDb
      .from('quiz_attempts')
      .delete()
      .eq('id', attemptId)

    if (attemptErr) {
      logger.error('resetStudentAttempt: Failed to delete attempt', attemptErr, { attemptId })
      return { error: 'Failed to delete attempt' }
    }

    await logEvent({
      userId: user.id,
      eventType: 'quiz_attempt_reset',
      sectionId,
      metadata: { attemptId, studentId: attempt.student_id, quizId: attempt.quiz_id },
    })

    logger.info('resetStudentAttempt: Success', { attemptId, studentId: attempt.student_id })
    revalidatePath(sectionPath(sectionId))
    return {}
  } catch (error) {
    logger.error('resetStudentAttempt: Exception', error, { attemptId })
    return { error: 'An unexpected error occurred' }
  }
}

// ── Lecture Library Picker (PR 6) ─────────────────────────────
// Surfaces the extracted images + formulas from every lecture in a
// section so quiz authors can pick them into a question without
// re-uploading or re-typing. Reads only; no writes.

import {
  getSectionExtractedMedia,
  type SectionLibrary,
} from '@/lib/extraction/library-queries'

export async function getLibraryForSection(
  sectionId: string,
): Promise<{ data?: SectionLibrary; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { hasAccess, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!hasAccess) return { error: 'You do not have access to this section' }

    const library = await getSectionExtractedMedia(adminDb, sectionId)
    return { data: library }
  } catch (err) {
    logger.error('getLibraryForSection: failed', err, { sectionId })
    return { error: err instanceof Error ? err.message : 'Failed to load library' }
  }
}

