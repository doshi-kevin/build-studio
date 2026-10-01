/**
 * Quiz Server Actions (Student) — attempt lifecycle, answer saving, and results.
 *
 * Verifies the student is enrolled in the section before any operation.
 * Uses admin client for DB operations (bypasses RLS).
 */
'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { markFeedItemDone } from '@/lib/events/emit'
import { logger } from '@/lib/logger'
import { checkEntitlementBySection } from '@/lib/entitlements/check'
import { entitlementRefusalMessage } from '@/lib/entitlements/entitled-features'
import { signOne, signMany, extractPathFromPublicUrl, signQuestionImages } from '@/lib/supabase/signed-urls'
import { COURSE_MATERIALS_BUCKET } from '@/lib/supabase/storage'
import { gradeAnswer, resolveQuestionPool } from '@/lib/quiz/scoring'
import type { ProctoringEvent, ProctoringSummary } from '@/lib/validations/proctoring'
import { shuffleArray, dueDeadlineMs } from '@/lib/quiz/utils'
import { selectPublishableScheduledQuizIds } from '@/lib/quiz/auto-publish'
import { stripBlankAnswers } from '@/lib/quiz/fill-in-blank'
import { rateLimit } from '@/lib/quiz/rate-limit'
import {
  saveAnswerServerSchema,
  type SaveAnswerServerInput,
  type Quiz,
  type Question,
  type QuizAttempt,
  type Answer,
  type QuestionPool,
  type RubricNode,
  type ExplanationTiming,
  canRevealQuizAnswers,
  adaptiveAnswerServerSchema,
  type AdaptiveAnswerServerInput,
  attemptsExhausted,
} from '@/lib/validations/quiz'
import { toUnifiedResult, resolveQuestionOrder } from '@/lib/quiz/unified-result'
import { logEvent } from '@/lib/supabase/event-logger'
import { after as afterResponse } from 'next/server'
import { applyGradeToSkillMastery } from '@/lib/skills/grade-hook'
import { enqueueMasteryRecompute } from '@/lib/extraction/enqueue'
import {
  computePosterior,
  selectNext,
  shouldStop,
  guessingFor,
  DEFAULT_IRT_A,
  type IrtItem,
  type IrtResponse,
  type StopRule,
} from '@/lib/quiz/irt/estimator'
import {
  gradeExplanation,
  gradeWalkthrough,
  walkthroughTurn,
  type TranscriptTurn,
} from '@/lib/quiz/irt/grader'
import type { AiAttribution } from '@/lib/ai/usage'

// ── Helpers ──────────────────────────────────────────────────────

/** Grace period (in seconds) for network latency / clock skew on due date checks. */
const DUE_DATE_GRACE_SECONDS = 120

/**
 * Check if a quiz's due date has passed (with grace period).
 * Returns { isPast, lateBySeconds } — lateBySeconds is 0 when on-time.
 */
function checkDueDate(dueDate: string | null): { isPast: boolean; lateBySeconds: number } {
  if (!dueDate) return { isPast: false, lateBySeconds: 0 }
  const now = Date.now()
  // A date-only due date expires at the END of that day. Measuring from UTC
  // midnight marked work submitted on the due date itself as late (#311).
  const due = dueDeadlineMs(dueDate)
  if (Number.isNaN(due)) return { isPast: false, lateBySeconds: 0 }
  const deadline = due + DUE_DATE_GRACE_SECONDS * 1000
  if (now <= deadline) return { isPast: false, lateBySeconds: 0 }
  const lateBySeconds = Math.round((now - due) / 1000)
  return { isPast: true, lateBySeconds }
}

/**
 * Check if a timed quiz attempt has exceeded its time limit (with grace period).
 * Returns { expired, overtimeSeconds } — overtimeSeconds is 0 when on-time.
 */
function checkTimerExpired(
  startedAt: string,
  timeLimitMinutes: number | null,
): { expired: boolean; overtimeSeconds: number } {
  if (timeLimitMinutes == null) return { expired: false, overtimeSeconds: 0 }
  const now = Date.now()
  const maxMs = timeLimitMinutes * 60 * 1000
  const graceMs = DUE_DATE_GRACE_SECONDS * 1000
  const deadline = new Date(startedAt).getTime() + maxMs + graceMs
  if (now <= deadline) return { expired: false, overtimeSeconds: 0 }
  const overtimeSeconds = Math.round((now - new Date(startedAt).getTime() - maxMs) / 1000)
  return { expired: true, overtimeSeconds }
}

async function getAuthUser() {
  const supabase = await createClient()
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) return null
  return user
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function verifyEnrollment(sectionId: string, userId: string): Promise<{ enrolled: boolean; adminDb: any }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any

  const { data: enrollment } = await adminDb
    .from('enrollments')
    .select('id')
    .eq('section_id', sectionId)
    .eq('student_id', userId)
    .in('status', ['enrolled', 'completed', 'active'])
    .single()

  if (!enrollment) return { enrolled: false, adminDb }
  return { enrolled: true, adminDb }
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
    // Professor-only authoring aid — never expose the source citation to students.
    sourceCitation: null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Student-safe question text. Inline fill-in-blank answers live in the text token
 * ({{blank:id:answers}}), so they must be stripped before a student sees the text —
 * but ONLY for fill_in_blank questions. Gating on type means a non-FITB question
 * whose prose legitimately contains a "{{blank:...}}" substring (e.g. a CS lesson
 * on templating syntax) isn't silently mangled.
 */
function studentQuestionText(q: { questionText?: string | null; content: { questionType: string } }): string {
  return q.content.questionType === 'fill_in_blank'
    ? stripBlankAnswers(q.questionText ?? '')
    : (q.questionText ?? '')
}

/**
 * Strip correct-answer data from a Question object so it can't be leaked to the client.
 * Reuses the lower-level stripCorrectAnswers (which operates on raw content) and also
 * clears the explanation text. Used when showExplanations timing gates the reveal.
 */
function redactQuestionAnswers(question: Question): Question {
  return {
    ...question,
    questionText: studentQuestionText(question),
    content: stripCorrectAnswers(question.content),
    explanation: '',
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
    // Professor-only authoring notice — never surfaced to students, but the
    // shared Quiz type requires the field.
    generationNotice: null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Replace each quiz's formulaSheetUrl with a fresh short-lived signed URL
 * minted from formulaSheetPath. The course-materials bucket is private as
 * of migration 48; legacy public URLs no longer resolve. Falls back to
 * extracting a path from the legacy URL if formulaSheetPath isn't populated.
 */
async function attachFormulaSheetSignedUrls(quizzes: Quiz[]): Promise<Quiz[]> {
  if (quizzes.length === 0) return quizzes

  const paths = quizzes.map((q) => {
    if (q.formulaSheetPath) return q.formulaSheetPath
    return extractPathFromPublicUrl(q.formulaSheetUrl, COURSE_MATERIALS_BUCKET)
  })
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
 * Auto-publish scheduled quizzes whose publish time has arrived.
 * Called before any student quiz list fetch.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function autoPublishScheduledQuizzes(adminDb: any, sectionId: string) {
  const now = new Date().toISOString()

  // Same eligibility gate as the professor path. This copy runs on every student
  // quiz-list load and was a bare update, so a question-less scheduled quiz still
  // reached students through here even once the professor path refused it (#311).
  let eligibleIds: string[]
  try {
    ({ eligibleIds } = await selectPublishableScheduledQuizIds(adminDb, sectionId, now))
  } catch (err) {
    logger.error('autoPublishScheduledQuizzes: Failed to list due quizzes', err, { sectionId })
    return
  }
  if (eligibleIds.length === 0) return

  const { error } = await adminDb
    .from('quizzes')
    .update({ status: 'published', scheduled_publish_at: null, updated_at: now })
    .in('id', eligibleIds)
    .eq('section_id', sectionId)
    .eq('status', 'draft')
    .not('scheduled_publish_at', 'is', null)
    .lte('scheduled_publish_at', now)

  if (error) {
    logger.error('autoPublishScheduledQuizzes: Failed to publish scheduled quizzes', error, { sectionId })
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapDbAttempt(row: any, answers: Record<string, Answer> = {}): QuizAttempt {
  return {
    id: row.id,
    quizId: row.quiz_id,
    studentId: row.student_id,
    sectionId: row.section_id,
    mode: row.mode ?? 'graded',
    status: row.status ?? 'in_progress',
    answers,
    resolvedQuestionIds: row.resolved_question_ids ?? [],
    score: row.score ?? null,
    totalPoints: row.total_points ?? null,
    earnedPoints: row.earned_points ?? null,
    startedAt: row.started_at,
    submittedAt: row.submitted_at ?? null,
    timeSpentSeconds: row.time_spent_seconds ?? 0,
    proctoringSummary: row.proctoring_summary ?? null,
    isLate: row.is_late ?? false,
    lateBySeconds: row.late_by_seconds ?? 0,
    timeLimitExceeded: row.time_limit_exceeded ?? false,
    overtimeSeconds: row.overtime_seconds ?? 0,
    cohort: row.cohort ?? null,
    startRating: row.start_rating ?? 1200,
    currentRating: row.current_rating ?? 1200,
    finalRating: row.final_rating ?? null,
    adaptiveQuestionIndex: row.adaptive_question_index ?? 0,
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapDbAnswer(row: any): Answer {
  return {
    questionId: row.question_id,
    selectedChoiceIds: row.selected_choice_ids ?? undefined,
    booleanAnswer: row.boolean_answer ?? undefined,
    textAnswer: row.text_answer ?? undefined,
    blankAnswers: row.blank_answers ?? undefined,
    isFlagged: row.is_flagged ?? false,
    timeSpentSeconds: row.time_spent_seconds ?? 0,
    isCorrect: row.is_correct ?? null,
    earnedPoints: row.earned_points ?? null,
    optionChanges: row.option_changes ?? 0,
    tabSwitches: row.tab_switches ?? 0,
    copyAttempts: row.copy_attempts ?? 0,
  }
}

// ── Quiz List Actions ────────────────────────────────────────────

export async function getPublishedQuizzes(sectionId: string) {
  const user = await getAuthUser()
  if (!user) return { error: 'Not authenticated', data: [] as Quiz[] }

  const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
  if (!enrolled) return { error: 'Not enrolled in this section', data: [] as Quiz[] }

  // Auto-publish any scheduled quizzes whose time has arrived before fetching
  await autoPublishScheduledQuizzes(adminDb, sectionId)

  const { data: rows, error } = await adminDb
    .from('quizzes')
    .select('*')
    .eq('section_id', sectionId)
    .eq('status', 'published')
    .order('created_at', { ascending: false })

  if (error) {
    logger.error('getPublishedQuizzes: Fetch failed', error, { sectionId })
    return { error: 'Failed to load quizzes', data: [] as Quiz[] }
  }

  // Get question counts
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
  const withSignedUrls = await attachFormulaSheetSignedUrls(quizzes)
  return { data: withSignedUrls }
}

export async function getQuizForAttempt(sectionId: string, quizId: string) {
  const user = await getAuthUser()
  if (!user) return { error: 'Not authenticated', data: null, questions: [] as Question[] }

  const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
  if (!enrolled) return { error: 'Not enrolled in this section', data: null, questions: [] as Question[] }

  // Get quiz
  const { data: quizRow, error: qErr } = await adminDb
    .from('quizzes')
    .select('*')
    .eq('id', quizId)
    .eq('section_id', sectionId)
    .eq('status', 'published')
    .single()

  if (qErr || !quizRow) {
    return { error: 'Quiz not found', data: null, questions: [] as Question[] }
  }

  // Get question assignments
  const { data: assignments } = await adminDb
    .from('quiz_question_assignments')
    .select('question_id')
    .eq('quiz_id', quizId)
    .order('position', { ascending: true })

  const questionIds = (assignments || []).map((a: { question_id: string }) => a.question_id)

  // Get all questions for this section (needed for pool resolution)
  const { data: questionRows } = await adminDb
    .from('quiz_questions')
    .select('*')
    .eq('section_id', sectionId)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapped: Question[] = (questionRows || []).map((r: any) => mapDbQuestion(r))
  const allQuestions = await signQuestionImages(mapped)
  const quiz = await attachFormulaSheetSignedUrl(mapDbQuiz(quizRow, questionIds))

  // Strip correct answers before returning to client — grading happens server-side
  const safeQuestions = allQuestions.map((q) => ({
    ...q,
    questionText: studentQuestionText(q),
    content: stripCorrectAnswers(q.content),
    explanation: '',
  }))

  return { data: quiz, questions: safeQuestions }
}

// ── Attempt Actions ──────────────────────────────────────────────

export async function getMyAttempts(sectionId: string, quizId: string) {
  const user = await getAuthUser()
  if (!user) return { error: 'Not authenticated', data: [] as QuizAttempt[] }

  const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
  if (!enrolled) return { error: 'Not enrolled in this section', data: [] as QuizAttempt[] }

  const { data: rows, error } = await adminDb
    .from('quiz_attempts')
    .select('*')
    .eq('quiz_id', quizId)
    .eq('student_id', user.id)
    .order('started_at', { ascending: false })

  if (error) {
    logger.error('getMyAttempts: Fetch failed', error, { sectionId, quizId })
    return { error: 'Failed to load attempts', data: [] as QuizAttempt[] }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { data: (rows || []).map((r: any) => mapDbAttempt(r)) }
}

export async function startAttempt(
  sectionId: string,
  quizId: string,
): Promise<{ data?: QuizAttempt; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this section' }

    // Ring 2 (see the entitlements design doc): stop a revoked feature accruing
    // NEW evidence. Deliberately on the start and not the submit, so a student
    // already mid-attempt when a revocation date passes can still finish and
    // keep their work.
    const entitlement = await checkEntitlementBySection(adminDb, sectionId, 'quizzes')
    if (!entitlement.allowed) return { error: entitlementRefusalMessage('quizzes') }

    // Get quiz
    const { data: quizRow, error: qErr } = await adminDb
      .from('quizzes')
      .select('*')
      .eq('id', quizId)
      .eq('section_id', sectionId)
      .eq('status', 'published')
      .single()

    if (qErr || !quizRow) return { error: 'Quiz not found or not published' }

    // Adaptive (CCAT) quizzes are driven by the dedicated adaptive player, which
    // creates/serves items itself — never resolve them through the linear flow.
    if (quizRow.adaptive_mode) return { error: 'This is an adaptive quiz — open it from the quiz list to start.' }

    // Block new starts after due date (with grace period)
    const { isPast: isDuePast } = checkDueDate(quizRow.due_date)
    if (isDuePast) return { error: 'This quiz is past its due date' }

    // Check max attempts
    const { data: existingAttempts } = await adminDb
      .from('quiz_attempts')
      .select('id')
      .eq('quiz_id', quizId)
      .eq('student_id', user.id)
      .eq('status', 'submitted')

    const submittedCount = (existingAttempts || []).length
    if (attemptsExhausted(quizRow.max_attempts, submittedCount)) {
      return { error: 'Maximum attempts reached' }
    }

    // Check for in-progress attempt (resume instead of creating new)
    const { data: inProgressAttempts } = await adminDb
      .from('quiz_attempts')
      .select('*')
      .eq('quiz_id', quizId)
      .eq('student_id', user.id)
      .eq('status', 'in_progress')
      .limit(1)

    if (inProgressAttempts && inProgressAttempts.length > 0) {
      const attempt = inProgressAttempts[0]

      // If quiz is timed, check if the wall-clock deadline has passed.
      // If expired, auto-submit server-side so students can't keep an
      // in-progress attempt alive past the time limit.
      if (quizRow.time_limit_minutes != null) {
        const deadlineMs =
          new Date(attempt.started_at).getTime() +
          quizRow.time_limit_minutes * 60 * 1000
        if (Date.now() >= deadlineMs) {
          // Deadline passed — submit the attempt instead of resuming
          const submitted = await submitAttempt(sectionId, attempt.id)
          return submitted
        }
      }

      // Load existing answers
      const { data: answerRows } = await adminDb
        .from('quiz_answers')
        .select('*')
        .eq('attempt_id', attempt.id)

      const answers: Record<string, Answer> = {}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const row of (answerRows || []) as any[]) {
        answers[row.question_id] = mapDbAnswer(row)
      }

      return { data: mapDbAttempt(attempt, answers) }
    }

    // Get question assignments
    const { data: assignments } = await adminDb
      .from('quiz_question_assignments')
      .select('question_id')
      .eq('quiz_id', quizId)
      .order('position', { ascending: true })

    let questionIds = (assignments || []).map((a: { question_id: string }) => a.question_id)

    // Resolve question pools if any
    const pools = (quizRow.question_pools as QuestionPool[]) ?? []
    if (pools.length > 0) {
      const { data: allQuestionRows } = await adminDb
        .from('quiz_questions')
        .select('*')
        .eq('section_id', sectionId)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const allQuestions = (allQuestionRows || []).map((r: any) => mapDbQuestion(r))
      const poolIds = pools.flatMap((pool) => resolveQuestionPool(pool, allQuestions))
      // Merge: fixed questions + pool-drawn questions (deduplicated)
      const allIds = [...new Set([...questionIds, ...poolIds])]
      questionIds = allIds
    }

    // AI-graded types (explanation/walkthrough) are adaptive-only — the linear flow
    // has no chat UI or rubric grader for them, so a stray one (added to a standard
    // quiz before the wizard gated these types, or drawn in via a tag pool) would
    // render unanswerable and always grade 0. Exclude them from the attempt.
    if (questionIds.length > 0) {
      const { data: typeRows } = await adminDb
        .from('quiz_questions')
        .select('id, content')
        .in('id', questionIds)
      const aiGraded = new Set(
        ((typeRows || []) as { id: string; content: { questionType?: string } | null }[])
          .filter((r) => r.content?.questionType === 'explanation' || r.content?.questionType === 'walkthrough')
          .map((r) => r.id),
      )
      if (aiGraded.size > 0) {
        logger.warn('startAttempt: excluding AI-graded questions from a non-adaptive quiz', { quizId, excluded: aiGraded.size })
        questionIds = questionIds.filter((id: string) => !aiGraded.has(id))
      }
    }

    // Shuffle if enabled
    if (quizRow.shuffle_questions) {
      questionIds = shuffleArray(questionIds)
    }

    // Create attempt
    const { data: attemptRow, error: aErr } = await adminDb
      .from('quiz_attempts')
      .insert({
        quiz_id: quizId,
        student_id: user.id,
        section_id: sectionId,
        resolved_question_ids: questionIds,
      })
      .select()
      .single()

    if (aErr) {
      /* 23505 = uq_quiz_attempt_one_in_progress. A concurrent start won the race; the
         max_attempts check above ran against pre-write state, so creating a second
         attempt here is exactly what the index exists to prevent. Resume the winner's
         attempt instead of returning an error — from the student's point of view the
         double-click simply opened the attempt they already have. */
      if (aErr.code === '23505') {
        const { data: raced } = await adminDb
          .from('quiz_attempts')
          .select('*')
          .eq('quiz_id', quizId)
          .eq('student_id', user.id)
          .eq('status', 'in_progress')
          .maybeSingle()
        if (raced) {
          /* Load the answers already saved against that attempt. Returning the row bare
             hands the player an attempt with nothing in it, which reads to the student as
             their work having vanished — and the next save would write over it. */
          const { data: answerRows, error: answersErr } = await adminDb
            .from('quiz_answers')
            .select('*')
            .eq('attempt_id', raced.id)
          /* Fail loudly rather than resuming with an empty answer set: a blank attempt
             reads as "my work is gone", and the next autosave would make that true. */
          if (answersErr) {
            logger.error('startAttempt: could not load answers for the raced attempt', answersErr, {
              sectionId, quizId, attemptId: raced.id,
            })
            return { error: 'Could not reopen your attempt. Please try again.' }
          }
          const answers: Record<string, Answer> = {}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          for (const row of (answerRows || []) as any[]) {
            answers[row.question_id] = mapDbAnswer(row)
          }
          logger.info('startAttempt: resumed attempt after concurrent start', { sectionId, quizId, attemptId: raced.id })
          return { data: mapDbAttempt(raced, answers) }
        }
      }
      logger.error('startAttempt: Insert failed', aErr, { sectionId, quizId })
      return { error: 'Failed to start attempt' }
    }

    return { data: mapDbAttempt(attemptRow) }
  } catch (error) {
    logger.error('startAttempt: Exception', error, { sectionId, quizId })
    return { error: 'An unexpected error occurred' }
  }
}

export async function saveAnswer(
  attemptId: string,
  questionId: string,
  input: SaveAnswerServerInput,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = saveAnswerServerSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    // Verify this attempt belongs to the current user and is in progress
    const { data: attempt } = await adminDb
      .from('quiz_attempts')
      .select('id, student_id, status, started_at, quiz_id')
      .eq('id', attemptId)
      .single()

    if (!attempt || attempt.student_id !== user.id) return { error: 'Attempt not found' }
    if (attempt.status !== 'in_progress') return { error: 'Attempt already submitted' }

    if (attempt.quiz_id) {
      const { data: quiz } = await adminDb
        .from('quizzes')
        .select('adaptive_mode, time_limit_minutes')
        .eq('id', attempt.quiz_id)
        .single()
      // Adaptive (CCAT) attempts are mutated ONLY through the adaptive path —
      // never let this linear endpoint overwrite a graded adaptive answer row
      // (which would null its soft_score and silently drop it from θ̂ + grade).
      if (quiz?.adaptive_mode) return { error: 'Adaptive quizzes must be answered through the adaptive player.' }
      // Server-side timer enforcement — reject saves after time limit expires
      if (quiz) {
        const { expired } = checkTimerExpired(attempt.started_at, quiz.time_limit_minutes)
        if (expired) return { error: 'Time limit exceeded' }
      }
    }

    // Upsert answer
    const { error } = await adminDb
      .from('quiz_answers')
      .upsert(
        {
          attempt_id: attemptId,
          question_id: questionId,
          selected_choice_ids: parsed.data.selectedChoiceIds ?? null,
          boolean_answer: parsed.data.booleanAnswer ?? null,
          text_answer: parsed.data.textAnswer ?? null,
          blank_answers: parsed.data.blankAnswers ?? null,
          is_flagged: parsed.data.isFlagged,
          time_spent_seconds: parsed.data.timeSpentSeconds,
          option_changes: parsed.data.optionChanges ?? 0,
          tab_switches: parsed.data.tabSwitches ?? 0,
          copy_attempts: parsed.data.copyAttempts ?? 0,
        },
        { onConflict: 'attempt_id,question_id' },
      )

    if (error) {
      logger.error('saveAnswer: Upsert failed', error, { attemptId, questionId })
      return { error: 'Failed to save answer' }
    }

    return { success: true }
  } catch (error) {
    logger.error('saveAnswer: Exception', error, { attemptId, questionId })
    return { error: 'An unexpected error occurred' }
  }
}

export async function updateAttemptTime(
  attemptId: string,
  timeSpentSeconds: number,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    // Reject obviously invalid values
    if (timeSpentSeconds < 0 || !Number.isFinite(timeSpentSeconds)) {
      return { error: 'Invalid time value' }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    // Fetch the attempt + quiz time limit so we can clamp the value.
    // This prevents a malicious client from setting arbitrarily high time.
    const { data: attemptRow } = await adminDb
      .from('quiz_attempts')
      .select('quiz_id')
      .eq('id', attemptId)
      .eq('student_id', user.id)
      .eq('status', 'in_progress')
      .single()

    if (!attemptRow) return { error: 'Attempt not found or already submitted' }

    const { data: quizRow } = await adminDb
      .from('quizzes')
      .select('adaptive_mode, time_limit_minutes')
      .eq('id', attemptRow.quiz_id)
      .single()

    // Adaptive attempts don't use the linear timer/answer flow.
    if (quizRow?.adaptive_mode) return { error: 'Adaptive quizzes must be answered through the adaptive player.' }

    let clampedTime = Math.round(timeSpentSeconds)
    if (quizRow?.time_limit_minutes != null) {
      const maxSeconds = quizRow.time_limit_minutes * 60
      clampedTime = Math.min(clampedTime, maxSeconds)
    }

    const { error } = await adminDb
      .from('quiz_attempts')
      .update({ time_spent_seconds: clampedTime })
      .eq('id', attemptId)
      .eq('student_id', user.id)
      .eq('status', 'in_progress')

    if (error) {
      logger.error('updateAttemptTime: Update failed', error, { attemptId })
      return { error: 'Failed to update time' }
    }

    return { success: true }
  } catch (error) {
    logger.error('updateAttemptTime: Exception', error, { attemptId })
    return { error: 'An unexpected error occurred' }
  }
}

/**
 * `alreadySubmitted` marks the one error the caller can safely treat as success:
 * the attempt is finished, this call just wasn't the one that finished it. The
 * timer-expiry path races `startAttempt`, which auto-submits an expired attempt
 * server-side — without this flag the player surfaced a hard error and unmounted
 * to a blank screen even though the score was recorded (#311).
 */
export async function submitAttempt(
  sectionId: string,
  attemptId: string,
): Promise<{ data?: QuizAttempt; error?: string; alreadySubmitted?: true }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    // Get attempt
    const { data: attemptRow, error: aErr } = await adminDb
      .from('quiz_attempts')
      .select('*')
      .eq('id', attemptId)
      .eq('student_id', user.id)
      // The attempt must belong to the section the caller named. Without this, an
      // authenticated student could pass any sectionId and drive
      // enqueueMasteryRecompute against it — which also marks that section's
      // pending recompute 'superseded', so it is queue interference, not just
      // wasted compute. Pre-existing; this change makes each such rebuild
      // markedly heavier, so the amplification is worth closing here.
      .eq('section_id', sectionId)
      .eq('status', 'in_progress')
      .single()

    // A genuine DB/network fault must NOT be reported as alreadySubmitted: the client
    // treats that flag as "it's finished, go to results", so a transient blip would
    // eject the student from a live attempt with no error and no way back.
    // PGRST116 = no rows, which given the filters above genuinely means submitted.
    if (aErr && aErr.code !== 'PGRST116') {
      logger.error('submitAttempt: Attempt lookup failed', aErr, { attemptId })
      return { error: 'Could not reach the server. Your answers are saved — try submitting again.' }
    }
    if (!attemptRow) return { error: 'Attempt not found or already submitted', alreadySubmitted: true }

    // Get quiz
    const { data: quizRow } = await adminDb
      .from('quizzes')
      .select('*')
      .eq('id', attemptRow.quiz_id)
      .single()

    if (!quizRow) return { error: 'Quiz not found' }

    // Adaptive (CCAT) attempts are finalized by submitAdaptiveAnswer, not here.
    if (quizRow.adaptive_mode) return { error: 'Adaptive quizzes are submitted through the adaptive player.' }

    // Check due date — accept late submissions but flag them
    const { isPast: isLate, lateBySeconds } = checkDueDate(quizRow.due_date)

    // Server-side timer enforcement — grade only already-saved answers if expired
    const { expired: timerExpired, overtimeSeconds } = checkTimerExpired(
      attemptRow.started_at,
      quizRow.time_limit_minutes,
    )

    // Get answers for this attempt
    const { data: answerRows } = await adminDb
      .from('quiz_answers')
      .select('*')
      .eq('attempt_id', attemptId)

    // Get questions
    const resolvedIds: string[] = attemptRow.resolved_question_ids ?? []
    let questions: Question[] = []
    if (resolvedIds.length > 0) {
      const { data: questionRows } = await adminDb
        .from('quiz_questions')
        .select('*')
        .in('id', resolvedIds)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      questions = await signQuestionImages((questionRows || []).map((r: any) => mapDbQuestion(r)))
    }

    // Build answers map
    const answersMap: Record<string, Answer> = {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const row of (answerRows || []) as any[]) {
      answersMap[row.question_id] = mapDbAnswer(row)
    }

    // Grade each question
    const gradeOptions = {
      negativeMarking: quizRow.negative_marking ?? false,
      negativeMarkingPenalty: quizRow.negative_marking_penalty ?? 0.25,
    }

    let totalPoints = 0
    let earnedPoints = 0

    for (const question of questions) {
      const answer = answersMap[question.id]
      const isNonTotal = question.isBonus || question.isExtraCredit

      if (!isNonTotal) {
        totalPoints += question.points
      }

      if (answer) {
        const result = gradeAnswer(question, answer, gradeOptions)

        earnedPoints += result.earnedPoints

        // Update the answer row with grading results
        await adminDb
          .from('quiz_answers')
          .update({
            is_correct: result.isCorrect,
            earned_points: result.earnedPoints,
          })
          .eq('attempt_id', attemptId)
          .eq('question_id', question.id)
      }
    }

    const score = totalPoints > 0 ? Math.round((earnedPoints / totalPoints) * 100) : 0

    // Compute proctoring summary if enabled (keystroke or video proctoring)
    let proctoringSummary: ProctoringSummary | null = null
    if (quizRow.proctoring_enabled || quizRow.video_proctoring_enabled) {
      const { data: logs } = await adminDb
        .from('quiz_proctoring_logs')
        .select('events, keystroke_count')
        .eq('attempt_id', attemptId)

      // Fetch video proctoring snapshots if video proctoring is enabled
      let snapshotCount = 0
      let webcamDenied = false
      if (quizRow.video_proctoring_enabled) {
        const { count } = await adminDb
          .from('proctoring_snapshots')
          .select('id', { count: 'exact', head: true })
          .eq('attempt_id', attemptId)
        snapshotCount = count ?? 0
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const typedLogs = (logs as any[]) ?? []
      const allEvents: ProctoringEvent[] = typedLogs.flatMap(
        (l) => l.events,
      )

      // Plain typing count comes from the keystroke_count column (not kd events)
      // kd events in the log are only modifier combos / special keys
      let totalKeystrokes = typedLogs.reduce((sum, l) => sum + (l.keystroke_count ?? 0), 0)
      let copyCount = 0
      let pasteCount = 0
      let cutCount = 0
      let tabSwitchCount = 0
      let multipleFaceCount = 0
      let phoneDetectedCount = 0

      for (const e of allEvents) {
        switch (e.type) {
          case 'kd': totalKeystrokes++; break // modifier combos / special keys
          case 'cp': copyCount++; break
          case 'ps': pasteCount++; break
          case 'ct': cutCount++; break
          case 'bl': tabSwitchCount++; break
          case 'mf': multipleFaceCount++; break
          case 'ph': phoneDetectedCount++; break
        }
      }

      // Supplement with Layer 2 per-question behavioral data from quiz_answers.
      // This catches events that may have been in the client buffer when the quiz
      // completed (race condition between client flush and server-side summary).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const answersForBehavior = (answerRows || []) as any[]
      const l2TabSwitches = answersForBehavior.reduce((s: number, a: { tab_switches?: number }) => s + (a.tab_switches ?? 0), 0)
      const l2CopyAttempts = answersForBehavior.reduce((s: number, a: { copy_attempts?: number }) => s + (a.copy_attempts ?? 0), 0)

      // Use the higher of Layer 1 vs Layer 2 counts (Layer 2 is always accurate per-question)
      tabSwitchCount = Math.max(tabSwitchCount, l2TabSwitches)
      copyCount = Math.max(copyCount, l2CopyAttempts)

      // Webcam denied = video proctoring enabled but zero snapshots stored,
      // meaning the camera stream was never active. Zero face/phone detections
      // alone does NOT mean denied — a well-behaved student has those at 0.
      if (quizRow.video_proctoring_enabled && snapshotCount === 0) {
        webcamDenied = true
      }

      const suspiciousFlags: string[] = []
      if (pasteCount >= 3) suspiciousFlags.push('multiple_paste_events')
      if (tabSwitchCount >= 10) suspiciousFlags.push('frequent_tab_switches')
      if (copyCount >= 5) suspiciousFlags.push('excessive_copying')
      if (multipleFaceCount >= 1) suspiciousFlags.push('multiple_faces_detected')
      if (phoneDetectedCount >= 1) suspiciousFlags.push('phone_detected')
      if (webcamDenied) suspiciousFlags.push('camera_denied')

      const sortedByTime = allEvents.sort((a, b) => a.t - b.t)
      const attemptStart = new Date(attemptRow.started_at)

      proctoringSummary = {
        totalKeystrokes,
        copyCount,
        pasteCount,
        cutCount,
        tabSwitchCount,
        suspiciousFlags,
        eventCount: allEvents.length,
        firstEventAt: sortedByTime.length > 0
          ? new Date(attemptStart.getTime() + sortedByTime[0].t).toISOString()
          : null,
        lastEventAt: sortedByTime.length > 0
          ? new Date(attemptStart.getTime() + sortedByTime[sortedByTime.length - 1].t).toISOString()
          : null,
        multipleFaceCount,
        phoneDetectedCount,
        snapshotCount,
        webcamDenied,
        fullscreenExitCount: 0,
      }
    }

    // Attempt-total time = wall-clock elapsed (submitted - started). This is the
    // single source of truth the professor views read; the student results page
    // computes the same fallback when this is 0, so writing it here keeps both in sync.
    const submittedAt = new Date()
    const totalTimeSpentSeconds = attemptRow.started_at
      ? Math.max(0, Math.round((submittedAt.getTime() - new Date(attemptRow.started_at).getTime()) / 1000))
      : 0

    // Build update payload
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updatePayload: Record<string, any> = {
      status: 'submitted',
      score: Math.max(0, score),
      total_points: totalPoints,
      earned_points: earnedPoints,
      submitted_at: submittedAt.toISOString(),
      time_spent_seconds: totalTimeSpentSeconds,
      is_late: isLate,
      late_by_seconds: lateBySeconds,
      time_limit_exceeded: timerExpired,
      overtime_seconds: overtimeSeconds,
      ...(proctoringSummary ? { proctoring_summary: proctoringSummary } : {}),
    }

    // Atomic update — only succeeds if attempt is still in_progress (prevents double-submit)
    const { data: updatedRow, error: uErr } = await adminDb
      .from('quiz_attempts')
      .update(updatePayload)
      .eq('id', attemptId)
      .eq('status', 'in_progress')
      .select()
      .single()

    if (uErr || !updatedRow) {
      // If no row matched, the attempt was already submitted (race condition)
      if (!updatedRow) return { error: 'Attempt already submitted', alreadySubmitted: true }
      logger.error('submitAttempt: Update failed', uErr, { attemptId })
      return { error: 'Failed to submit attempt' }
    }

    // Fold this grade into the student's topic mastery (best-effort, never throws).
    await applyGradeToSkillMastery({
      sectionId,
      studentId: updatedRow.student_id,
      activityType: 'quiz',
      activityId: updatedRow.quiz_id,
      pct: totalPoints > 0 ? (earnedPoints / totalPoints) * 100 : Math.max(0, score),
      points: totalPoints,
      // Lets mastery score each skill on its OWN questions rather than recording
      // the whole-quiz percentage against every topic the quiz touched.
      attemptId: updatedRow.id,
      // The rebuild dates a quiz by submitted_at; match it so the incremental
      // write and the nightly rebuild age evidence from the same instant.
      occurredAt: updatedRow.submitted_at,
    })

    // Authoritative section reconcile in the background (coalesced, post-response).
    afterResponse(() => enqueueMasteryRecompute(sectionId))

    // Completion event: clear this quiz's to-do in the shared feed (best-effort).
    void markFeedItemDone({ recipientId: user.id, entityType: 'quiz', entityId: updatedRow.quiz_id })

    revalidatePath(`/student/courses/${sectionId}/quizzes`)
    return { data: mapDbAttempt(updatedRow, answersMap) }
  } catch (error) {
    logger.error('submitAttempt: Exception', error, { attemptId })
    return { error: 'An unexpected error occurred' }
  }
}

// ── Class Average Action ────────────────────────────────────────

/** Returns class average for a quiz, respecting due date logic. */
export async function getQuizClassAverage(sectionId: string, quizId: string) {
  const user = await getAuthUser()
  if (!user) return { error: 'Not authenticated' }

  const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
  if (!enrolled) return { error: 'Not enrolled in this section' }

  // Fetch quiz for due date
  const { data: quiz } = await adminDb
    .from('quizzes')
    .select('due_date')
    .eq('id', quizId)
    .eq('section_id', sectionId)
    .single()

  // Fetch all submitted attempts (best score per student)
  const { data: attempts } = await adminDb
    .from('quiz_attempts')
    .select('student_id, score')
    .eq('quiz_id', quizId)
    .eq('section_id', sectionId)
    .eq('status', 'submitted')

  if (!attempts || attempts.length === 0) {
    return { data: { average: 0, submissionCount: 0, totalStudents: 0, isDueDatePassed: false } }
  }

  // Best score per student
  const bestScores: Record<string, number> = {}
  for (const a of attempts) {
    const current = bestScores[a.student_id] ?? -1
    if ((a.score ?? 0) > current) bestScores[a.student_id] = a.score ?? 0
  }

  const isDueDatePassed = quiz?.due_date ? new Date(quiz.due_date) < new Date() : false

  if (isDueDatePassed) {
    // After due date: include 0 for students who didn't attempt
    const { count } = await adminDb
      .from('enrollments')
      .select('*', { count: 'exact', head: true })
      .eq('section_id', sectionId)
      .eq('status', 'enrolled')

    const totalStudents = count ?? Object.keys(bestScores).length
    const submitters = Object.values(bestScores)
    const totalScore = submitters.reduce((s, v) => s + v, 0)
    // Non-submitters get 0
    const average = totalStudents > 0 ? Math.round(totalScore / totalStudents) : 0

    return {
      data: {
        average,
        submissionCount: submitters.length,
        totalStudents,
        isDueDatePassed: true,
      },
    }
  }

  // Before due date: average from submitted only
  const scores = Object.values(bestScores)
  const average = scores.length > 0 ? Math.round(scores.reduce((s, v) => s + v, 0) / scores.length) : 0

  return {
    data: {
      average,
      submissionCount: scores.length,
      totalStudents: scores.length,
      isDueDatePassed: false,
    },
  }
}

// ── Results Actions ──────────────────────────────────────────────

/**
 * Unified results read — produces ONE `UnifiedResult` for any attempt, standard
 * or adaptive. The grade, pass/fail, per-question review, and topic breakdown
 * are computed identically for both; the adaptive ability estimate (θ̂±SE) and
 * misconceptions ride along as optional add-ons. Both the standard and adaptive
 * student results views consume this single shape (see
 * docs/designs/quizzes/quiz-analytics-unification.md).
 *
 * Returns the normalized `result` plus the extras each view needs: the resolved
 * (and reveal-gated) questions + answers for the rich per-question review card,
 * quiz display fields, and adaptive-only misconceptions.
 */
export async function getUnifiedResult(sectionId: string, attemptId: string) {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' as const }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this section' as const }

    // Own the attempt; only submitted attempts may be reviewed (prevents
    // inspecting correct answers for in-progress quizzes via dev tools).
    const { data: attemptRow } = await adminDb
      .from('quiz_attempts').select('*').eq('id', attemptId).eq('student_id', user.id).eq('section_id', sectionId).single()
    if (!attemptRow) return { error: 'Attempt not found' as const }
    if (attemptRow.status !== 'submitted') return { error: 'Attempt not yet submitted' as const }

    const { data: quizRow } = await adminDb.from('quizzes').select('*').eq('id', attemptRow.quiz_id).single()
    if (!quizRow) return { error: 'Quiz not found' as const }

    const { data: answerRows } = await adminDb.from('quiz_answers').select('*').eq('attempt_id', attemptId)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const answerRowsArr = (answerRows || []) as any[]

    // Fixed assignment order — used both as the resolver's fallback (legacy
    // attempts with no served list) and for the standard review order.
    const { data: assignments } = await adminDb
      .from('quiz_question_assignments').select('question_id').eq('quiz_id', attemptRow.quiz_id).order('position', { ascending: true })
    const fixedQuestionIds = (assignments || []).map((a: { question_id: string }) => a.question_id)

    // Served list (adaptive) else fixed list (standard / legacy fallback).
    const order = resolveQuestionOrder(attemptRow.resolved_question_ids ?? [], fixedQuestionIds)

    let questionsRaw: Question[] = []
    if (order.length > 0) {
      const { data: qRows } = await adminDb.from('quiz_questions').select('*').in('id', order)
      const byId = new Map<string, Question>()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const r of (qRows || []) as any[]) byId.set(r.id, mapDbQuestion(r))
      questionsRaw = order.map((id) => byId.get(id)).filter((q): q is Question => !!q)
    }
    const questions = await signQuestionImages(questionsRaw)

    // AI feedback (rationale, rubric coverage) and correct answers respect the
    // professor's explanation-timing setting — same rule for both quiz types.
    const showExplanations: ExplanationTiming = quizRow.show_explanations ?? 'after_submission'
    const canReveal = canRevealQuizAnswers(showExplanations, quizRow.due_date)

    const answersMap: Record<string, Answer> = {}
    for (const row of answerRowsArr) answersMap[row.question_id] = mapDbAnswer(row)

    // Map answer rows into normalizer inputs, gating the feedback fields.
    const answerInputs = answerRowsArr.map((a) => {
      const nodes = Array.isArray(a.nodes) ? (a.nodes as { met?: boolean }[]) : null
      return {
        questionId: a.question_id,
        isCorrect: a.is_correct ?? null,
        earnedPoints: a.earned_points != null ? Number(a.earned_points) : null,
        softScore: a.soft_score != null ? Number(a.soft_score) : null,
        textAnswer: a.text_answer ?? null,
        rationale: canReveal ? (a.rationale ?? null) : null,
        nodesMet: canReveal && nodes ? nodes.filter((n) => n.met).length : null,
        nodesTotal: canReveal && nodes ? nodes.length : null,
        isFormative: a.is_formative ?? false,
      }
    })

    const questionInputs = questionsRaw.map((q) => ({
      id: q.id,
      // Anti-leak: questionReview reaches the student regardless of canReveal,
      // so inline fill-in-blank answer tokens must be stripped here too.
      questionText: studentQuestionText(q),
      type: q.content.questionType,
      points: q.points,
      tags: q.tags,
    }))

    const result = toUnifiedResult({
      isAdaptive: quizRow.adaptive_mode ?? false,
      passThreshold: quizRow.pass_threshold ?? 60,
      attempt: {
        score: attemptRow.score ?? null,
        totalPoints: attemptRow.total_points ?? null,
        earnedPoints: attemptRow.earned_points ?? null,
        resolvedQuestionIds: order,
        cohort: attemptRow.cohort ?? null,
        theta: attemptRow.theta ?? null,
        se: attemptRow.se ?? null,
        stopReason: attemptRow.stop_reason ?? null,
        finalRating: attemptRow.final_rating ?? null,
      },
      answers: answerInputs,
      questions: questionInputs,
      fixedQuestionIds,
    })

    // Misconceptions — adaptive diagnostic, gated like the rest of the feedback.
    const questionById = new Map(questionsRaw.map((q) => [q.id, q]))
    const misconceptions = canReveal
      ? answerRowsArr
          .filter((a) => a.misconception_node)
          .map((a) => ({ node: a.misconception_node as string, topic: questionById.get(a.question_id)?.tags?.[0] ?? '' }))
      : []

    // Redact correct-answer content for the standard review card when gated off.
    const reviewQuestions = canReveal ? questions : questions.map(redactQuestionAnswers)

    // Fall back to elapsed time when per-attempt time wasn't recorded.
    const timeSpentSeconds =
      (attemptRow.time_spent_seconds ?? 0) > 0
        ? attemptRow.time_spent_seconds
        : attemptRow.submitted_at && attemptRow.started_at
          ? Math.max(0, Math.round((new Date(attemptRow.submitted_at).getTime() - new Date(attemptRow.started_at).getTime()) / 1000))
          : 0

    return {
      result,
      quizTitle: quizRow.title as string,
      showExplanations,
      dueDate: (quizRow.due_date ?? null) as string | null,
      showLeaderboard: (quizRow.show_leaderboard ?? false) as boolean,
      timeSpentSeconds: timeSpentSeconds as number,
      questions: reviewQuestions,
      answers: answersMap,
      misconceptions,
      /* Guided Walkthrough answers are NOT in `quiz_answers.text_answer` (#379 part 1). The player
         deliberately does not send the transcript, and the grader reads it from here, so the review
         card was rendering "No answer recorded" next to real AI feedback, including on
         full-credit answers. This is the only place the student's actual work exists.

         Gated on canReveal like every other feedback field: a transcript is the student's own work,
         but it sits beside the rationale and node counts, so it follows the same disclosure rule
         rather than inventing a second one. */
      walkthroughTranscripts: (canReveal
        ? ((attemptRow.walkthrough_transcripts as Record<string, TranscriptTurn[]>) ?? {})
        : {}) as Record<string, TranscriptTurn[]>,
    }
  } catch (error) {
    logger.error('getUnifiedResult: Exception', error, { sectionId, attemptId })
    return { error: 'An unexpected error occurred' as const }
  }
}

// ── Leaderboard Action ───────────────────────────────────────────

export async function getQuizLeaderboard(sectionId: string, quizId: string) {
  const user = await getAuthUser()
  if (!user) return { error: 'Not authenticated', data: [] }

  const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
  if (!enrolled) return { error: 'Not enrolled in this section', data: [] }

  // Bind the quiz to this section and respect the professor's leaderboard
  // toggle — the action is directly callable, so without this an enrolled
  // student could read classmates' names + scores for a quiz where the
  // professor disabled the leaderboard (or a quiz in another section).
  const { data: quiz } = await adminDb
    .from('quizzes')
    .select('id, show_leaderboard')
    .eq('id', quizId)
    .eq('section_id', sectionId)
    .maybeSingle()
  if (!quiz) return { error: 'Quiz not found', data: [] }
  if (!quiz.show_leaderboard) return { error: 'Leaderboard is not enabled for this quiz', data: [] }

  // Get best score per student
  const { data: attempts, error } = await adminDb
    .from('quiz_attempts')
    .select('student_id, score, submitted_at')
    .eq('quiz_id', quizId)
    .eq('status', 'submitted')
    .order('score', { ascending: false })

  if (error) {
    logger.error('getQuizLeaderboard: Fetch failed', error, { sectionId, quizId })
    return { error: 'Failed to load leaderboard', data: [] }
  }

  // Group by student, keep best score
  const bestByStudent: Record<string, { studentId: string; score: number; submittedAt: string }> = {}
  for (const a of (attempts || []) as { student_id: string; score: number | null; submitted_at: string }[]) {
    const existing = bestByStudent[a.student_id]
    if (!existing || (a.score ?? 0) > existing.score) {
      bestByStudent[a.student_id] = {
        studentId: a.student_id,
        score: a.score ?? 0,
        submittedAt: a.submitted_at,
      }
    }
  }

  // Get student names
  const studentIds = Object.keys(bestByStudent)
  let nameMap: Record<string, string> = {}
  if (studentIds.length > 0) {
    const { data: profiles } = await adminDb
      .from('profiles')
      .select('id, name')
      .in('id', studentIds)

    if (profiles) {
      nameMap = (profiles as { id: string; name: string | null }[]).reduce(
        (acc: Record<string, string>, p) => {
          acc[p.id] = p.name || 'Anonymous'
          return acc
        },
        {} as Record<string, string>,
      )
    }
  }

  const leaderboard = Object.values(bestByStudent)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)
    .map((entry, index) => ({
      rank: index + 1,
      studentName: nameMap[entry.studentId] || 'Anonymous',
      score: entry.score,
      submittedAt: entry.submittedAt,
      isCurrentUser: entry.studentId === user.id,
    }))

  return { data: leaderboard }
}

/**
 * Strip correct answer information from question content before sending to
 * the quiz client. Prevents answer leakage.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stripCorrectAnswers(content: any): any {
  if (!content || !content.questionType) return content

  switch (content.questionType) {
    case 'multiple_choice':
      return {
        ...content,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        choices: (content.choices || []).map((c: any) => ({
          id: c.id,
          text: c.text,
          // Omit isCorrect
        })),
      }
    case 'true_false':
      return {
        questionType: content.questionType,
        // Omit correctAnswer
      }
    case 'short_answer':
      return {
        questionType: content.questionType,
        caseSensitive: content.caseSensitive,
        // Omit acceptedAnswers
      }
    case 'fill_in_blank':
      return {
        questionType: content.questionType,
        blanks: (content.blanks || []).map(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (b: any) => ({
            id: b.id,
            caseSensitive: b.caseSensitive,
            // Omit acceptedAnswers
          }),
        ),
      }
    default:
      return content
  }
}

// ── Proctoring Actions ──────────────────────────────────────────

export async function saveProctoringBatch(
  attemptId: string,
  events: ProctoringEvent[],
  batchIndex: number,
  keystrokeCount: number = 0,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    // Verify attempt belongs to user and is in progress
    const { data: attempt } = await adminDb
      .from('quiz_attempts')
      .select('id, student_id, status, quiz_id, section_id')
      .eq('id', attemptId)
      .single()

    if (!attempt || attempt.student_id !== user.id) return { error: 'Attempt not found' }
    if (attempt.status !== 'in_progress') return { error: 'Attempt already submitted' }

    // Verify quiz has proctoring enabled
    const { data: quiz } = await adminDb
      .from('quizzes')
      .select('proctoring_enabled')
      .eq('id', attempt.quiz_id)
      .single()

    if (!quiz?.proctoring_enabled) return { error: 'Proctoring not enabled' }

    // Insert batch
    const { error } = await adminDb
      .from('quiz_proctoring_logs')
      .insert({
        attempt_id: attemptId,
        student_id: user.id,
        quiz_id: attempt.quiz_id,
        section_id: attempt.section_id,
        batch_index: batchIndex,
        events,
        keystroke_count: keystrokeCount,
      })

    if (error) {
      logger.error('saveProctoringBatch: Insert failed', error, { attemptId, batchIndex })
      return { error: 'Failed to save proctoring data' }
    }

    return { success: true }
  } catch (error) {
    logger.error('saveProctoringBatch: Exception', error, { attemptId })
    return { error: 'An unexpected error occurred' }
  }
}

// ── Video Proctoring: Save Snapshot Metadata ─────────────────────

/**
 * Save video proctoring snapshot metadata after the image has been uploaded to Storage.
 * Fire-and-forget from client — should not block quiz interaction.
 */
export async function saveProctoringSnapshot(
  attemptId: string,
  violationType: string,
  snapshotBase64: string,
  timestampOffset: number,
  questionIndex: number,
  faceCount: number,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const adminDb = createAdminClient()

    // Verify attempt belongs to user and is in progress
    const { data: attempt } = await adminDb
      .from('quiz_attempts')
      .select('id, student_id, status, quiz_id, section_id')
      .eq('id', attemptId)
      .single()

    if (!attempt || attempt.student_id !== user.id) return { error: 'Attempt not found' }
    if (attempt.status !== 'in_progress') return { error: 'Attempt already submitted' }

    // Verify quiz has video proctoring enabled
    const { data: quiz } = await adminDb
      .from('quizzes')
      .select('video_proctoring_enabled')
      .eq('id', attempt.quiz_id)
      .single()

    if (!quiz?.video_proctoring_enabled) return { error: 'Video proctoring not enabled' }

    // Decode base64 to Buffer for upload
    const buffer = Buffer.from(snapshotBase64, 'base64')

    // Upload to Supabase Storage via admin client (bypasses RLS)
    const storagePath = `${attempt.section_id}/${attempt.quiz_id}/${attemptId}/${timestampOffset}.jpg`

    const { error: uploadError } = await adminDb.storage
      .from('proctoring-snapshots')
      .upload(storagePath, buffer, {
        contentType: 'image/jpeg',
        cacheControl: '3600',
        upsert: false,
      })

    if (uploadError) {
      logger.error('saveProctoringSnapshot: Upload failed', uploadError, { attemptId })
      return { error: 'Failed to upload snapshot' }
    }

    // Get signed URL for professor review (private bucket, 7 day expiry)
    const { data: urlData } = await adminDb.storage
      .from('proctoring-snapshots')
      .createSignedUrl(storagePath, 60 * 60 * 24 * 7)

    const snapshotUrl = urlData?.signedUrl ?? storagePath

    // Insert snapshot metadata
    const { error } = await adminDb
      .from('proctoring_snapshots')
      .insert({
        attempt_id: attemptId,
        student_id: user.id,
        quiz_id: attempt.quiz_id,
        section_id: attempt.section_id,
        violation_type: violationType,
        storage_path: storagePath,
        snapshot_url: snapshotUrl,
        timestamp_offset: timestampOffset,
        question_index: questionIndex,
        face_count: faceCount,
      })

    if (error) {
      logger.error('saveProctoringSnapshot: Insert failed', error, { attemptId })
      return { error: 'Failed to save snapshot' }
    }

    return { success: true }
  } catch (error) {
    logger.error('saveProctoringSnapshot: Exception', error, { attemptId })
    return { error: 'An unexpected error occurred' }
  }
}

// ════════════════════════════════════════════════════════════════════
// CCAT Adaptive Quiz (Quizzes v2) — stateless IRT step loop.
// Ports CCAT demo/api/index.py to Supabase persistence. Each call recomputes
// θ̂ from the full stored response pattern (so resume falls out for free), grades
// the answer, selects the next item by difficulty-tempered Fisher info, and stops
// on SE<τ or length. See docs/designs/quizzes/ccat-system-design.md.
// ════════════════════════════════════════════════════════════════════

const HARD_ITEM_B_THRESHOLD = 1.0 // difficulty cutoff for flagging a "hard item" miss (analytics only)

/** Build an IRT item from a stored question, filling any missing param from a
 *  difficulty→b map / type-derived guessing (uncalibrated questions still work). */
function irtItemFromQuestion(q: Question): IrtItem {
  const itemType = q.content.questionType
  const fallbackB = q.difficulty === 'easy' ? -1 : q.difficulty === 'hard' ? 1 : 0
  const numChoices = q.content.questionType === 'multiple_choice' ? q.content.choices.length : 4
  return {
    id: q.id,
    itemType,
    a: q.irtA ?? DEFAULT_IRT_A,
    b: q.irtB ?? fallbackB,
    c: q.irtC ?? guessingFor(itemType, numChoices),
  }
}

/** Strip every grading signal before sending an item to the student: answer keys
 *  (via stripCorrectAnswers), the rubric, and the explanation. */
function serveAdaptiveQuestion(q: Question): Question {
  return {
    ...q,
    questionText: studentQuestionText(q),
    content: stripCorrectAnswers(q.content),
    rubric: null,
    explanation: '',
  }
}

/** The stop rule for a quiz, read from its adaptive config. `bankSize` is the
 *  number of questions actually available. Fixed-length mode serves EVERY
 *  question (adaptively ordered) — the professor no longer sets a count — so the
 *  target is the bank size. Precision mode keeps its SE target + safety cap. */
function stopRuleFor(
  quizRow: { stop_mode?: string | null; adaptive_question_count?: number | null; target_se?: number | null },
  bankSize: number,
): StopRule {
  const precision = quizRow.stop_mode === 'precision'
  return {
    mode: precision ? 'precision' : 'fixed',
    length: bankSize,
    targetSe: quizRow.target_se ?? 0.3,
    maxItems: precision ? Math.max(quizRow.adaptive_question_count ?? 10, 12) : bankSize,
  }
}

/** Load the quiz's question bank (assignments + resolved pools) with full IRT
 *  params, keyed by id. */
async function loadAdaptiveBank(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminDb: any,
  sectionId: string,
  quizId: string,
  quizRow: { question_pools?: unknown },
): Promise<Map<string, Question>> {
  const { data: assignments } = await adminDb
    .from('quiz_question_assignments')
    .select('question_id')
    .eq('quiz_id', quizId)
  const assignedIds = new Set((assignments || []).map((a: { question_id: string }) => a.question_id))

  const { data: rows } = await adminDb.from('quiz_questions').select('*').eq('section_id', sectionId)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const all: Question[] = (rows || []).map((r: any) => mapDbQuestion(r))

  const pools = (quizRow.question_pools as QuestionPool[]) ?? []
  const poolIds = new Set(pools.flatMap((pool) => resolveQuestionPool(pool, all)))

  const bank = new Map<string, Question>()
  for (const q of all) {
    if (assignedIds.has(q.id) || poolIds.has(q.id)) bank.set(q.id, q)
  }
  return bank
}

/** Grade one response into a soft score g ∈ [0,1] plus grading metadata.
 *  Objective types reuse the deterministic scoring engine; explanation/walkthrough
 *  use the Gemini rubric grader. */
async function gradeAdaptiveResponse(
  q: Question,
  input: AdaptiveAnswerServerInput,
  serverTranscript: TranscriptTurn[],
  attribution?: AiAttribution,
): Promise<{
  g: number
  isCorrect: boolean | null
  earnedPoints: number | null
  graderMode: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  nodes: any
  rationale: string
}> {
  const type = q.content.questionType
  if (type === 'explanation') {
    const grade = await gradeExplanation(q.questionText, (q.rubric as RubricNode[]) ?? [], input.textAnswer ?? '', attribution)
    return { g: grade.g, isCorrect: grade.g >= 0.5, earnedPoints: Math.round(grade.g * q.points), graderMode: grade.mode, nodes: grade.nodes, rationale: grade.rationale }
  }
  if (type === 'walkthrough') {
    // Grade the SERVER-persisted transcript (tamper-proof), never the client payload.
    const grade = await gradeWalkthrough(q.questionText, (q.rubric as RubricNode[]) ?? [], serverTranscript, attribution)
    return { g: grade.g, isCorrect: grade.g >= 0.5, earnedPoints: Math.round(grade.g * q.points), graderMode: grade.mode, nodes: grade.nodes, rationale: grade.rationale }
  }
  // Objective: build an Answer and reuse the deterministic grader.
  const answer: Answer = {
    questionId: q.id,
    selectedChoiceIds: input.selectedChoiceIds,
    booleanAnswer: input.booleanAnswer,
    textAnswer: input.textAnswer,
    blankAnswers: input.blankAnswers,
    isFlagged: false,
    timeSpentSeconds: input.timeSpentSeconds ?? 0,
    isCorrect: null,
    earnedPoints: null,
    optionChanges: 0,
    tabSwitches: input.tabSwitches ?? 0,
    copyAttempts: input.copyAttempts ?? 0,
  }
  const result = gradeAnswer(q, answer)
  const g = q.points > 0 ? Math.min(1, Math.max(0, result.earnedPoints / q.points)) : result.isCorrect ? 1 : 0
  return { g, isCorrect: result.isCorrect, earnedPoints: result.earnedPoints, graderMode: 'exact', nodes: null, rationale: result.isCorrect ? 'Correct.' : 'Incorrect.' }
}

/**
 * Start (or resume) an adaptive attempt. Verifies enrollment + that the quiz is
 * adaptive, creates the attempt at θ̂=0/SE=1, and serves the first item by Fisher
 * information. Resumes an in-progress attempt by recomputing θ̂ from stored answers.
 */
export async function startAdaptiveAttempt(sectionId: string, quizId: string) {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this section' }

    const entitlement = await checkEntitlementBySection(adminDb, sectionId, 'quizzes')
    if (!entitlement.allowed) return { error: entitlementRefusalMessage('quizzes') }

    const { data: quizRow } = await adminDb
      .from('quizzes').select('*').eq('id', quizId).eq('section_id', sectionId).eq('status', 'published').single()
    if (!quizRow) return { error: 'Quiz not found or not published' }
    if (!quizRow.adaptive_mode) return { error: 'This quiz is not adaptive' }
    if (checkDueDate(quizRow.due_date).isPast) return { error: 'This quiz is past its due date' }

    const bank = await loadAdaptiveBank(adminDb, sectionId, quizId, quizRow)
    if (bank.size === 0) return { error: 'This quiz has no questions' }

    // Resume an in-progress attempt, or create a new one.
    const { data: existing } = await adminDb
      .from('quiz_attempts').select('*')
      .eq('quiz_id', quizId).eq('student_id', user.id).eq('status', 'in_progress').limit(1)

    let attemptRow = existing && existing.length > 0 ? existing[0] : null
    if (!attemptRow) {
      const submittedCount = ((await adminDb.from('quiz_attempts').select('id')
        .eq('quiz_id', quizId).eq('student_id', user.id).eq('status', 'submitted')).data || []).length
      if (attemptsExhausted(quizRow.max_attempts, submittedCount)) return { error: 'Maximum attempts reached' }

      const { data: created, error: aErr } = await adminDb.from('quiz_attempts').insert({
        quiz_id: quizId, student_id: user.id, section_id: sectionId,
        resolved_question_ids: [], theta: 0, se: 1,
      }).select().single()
      if (aErr) {
        /* 23505 = uq_quiz_attempt_one_in_progress — a concurrent start won the race.
           The max_attempts check above read pre-write state, so the index is what
           actually enforces the cap; resume the winner's attempt rather than
           creating the extra one it just prevented. */
        if (aErr.code === '23505') {
          const { data: raced } = await adminDb.from('quiz_attempts').select('*')
            .eq('quiz_id', quizId).eq('student_id', user.id).eq('status', 'in_progress').maybeSingle()
          if (raced) {
            logger.info('startAdaptiveAttempt: resumed attempt after concurrent start', { quizId, attemptId: raced.id })
            attemptRow = raced
          }
        }
        if (!attemptRow) {
          logger.error('startAdaptiveAttempt: insert failed', aErr, { quizId })
          return { error: 'Failed to start attempt' }
        }
      } else {
        attemptRow = created
      }
    }

    // Recompute θ̂ from any stored (non-formative) answers, then serve next item.
    const { responses, answeredIds } = await loadAttemptResponses(adminDb, attemptRow.id, bank)
    const post = computePosterior(responses)
    const lam = quizRow.select_lambda ?? 0.5
    const next = selectNext([...bank.values()].map(irtItemFromQuestion), answeredIds, post.theta, { lam, rand: Math.random })

    return {
      data: {
        attemptId: attemptRow.id,
        theta: post.theta,
        se: post.se,
        answered: answeredIds.size,
        // Fixed-length serves the whole bank; precision keeps its cap estimate.
        targetItems: quizRow.stop_mode === 'precision' ? (quizRow.adaptive_question_count ?? 10) : bank.size,
        served: next ? serveAdaptiveQuestion(bank.get(next.chosen.item.id)!) : null,
        stopped: !next,
      },
    }
  } catch (error) {
    logger.error('startAdaptiveAttempt: Exception', error, { sectionId, quizId })
    return { error: 'An unexpected error occurred' }
  }
}

/** Load an attempt's stored non-formative answers as IRT responses + the set of
 *  answered ids (used to recompute θ̂ and exclude already-served items). */
async function loadAttemptResponses(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminDb: any,
  attemptId: string,
  bank: Map<string, Question>,
): Promise<{ responses: IrtResponse[]; answeredIds: Set<string> }> {
  const { data: rows } = await adminDb
    .from('quiz_answers').select('question_id, soft_score, is_formative').eq('attempt_id', attemptId)
  const responses: IrtResponse[] = []
  const answeredIds = new Set<string>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const row of (rows || []) as any[]) {
    answeredIds.add(row.question_id)
    if (row.is_formative) continue
    const q = bank.get(row.question_id)
    if (q && row.soft_score != null) responses.push({ item: irtItemFromQuestion(q), g: Number(row.soft_score) })
  }
  return { responses, answeredIds }
}

/**
 * Submit one answer in an adaptive attempt: grade → recompute θ̂±SE → persist the
 * response with its IRT trace → flag any hard-item miss as a misconception → select
 * the next item (or stop). On stop, finalize the attempt and persist the student's ability.
 */
export async function submitAdaptiveAnswer(
  sectionId: string,
  attemptId: string,
  input: AdaptiveAnswerServerInput,
) {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    // Coarse per-instance rate limit on this LLM-calling action (free-text grades).
    if (!rateLimit(`adaptiveSubmit:${user.id}`, 40, 60_000)) return { error: 'Too many requests — please slow down.' }

    const parsed = adaptiveAnswerServerSchema.safeParse(input)
    if (!parsed.success) return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this section' }

    // Verify the attempt belongs to this student + section (IDOR guard).
    const { data: attemptRow } = await adminDb
      .from('quiz_attempts').select('*').eq('id', attemptId).eq('student_id', user.id).eq('section_id', sectionId).single()
    if (!attemptRow) return { error: 'Attempt not found' }
    if (attemptRow.status !== 'in_progress') return { error: 'Attempt already submitted' }

    const { data: quizRow } = await adminDb.from('quizzes').select('*').eq('id', attemptRow.quiz_id).single()
    if (!quizRow) return { error: 'Quiz not found' }

    const bank = await loadAdaptiveBank(adminDb, sectionId, attemptRow.quiz_id, quizRow)
    const question = bank.get(parsed.data.questionId)
    if (!question) return { error: 'Question not in this quiz' }

    // θ̂ before this answer (from the stored pattern).
    const { responses: prior, answeredIds } = await loadAttemptResponses(adminDb, attemptId, bank)
    if (answeredIds.has(question.id)) return { error: 'Question already answered' }
    const before = computePosterior(prior)

    // Walkthrough grades the SERVER-persisted transcript, not the client payload.
    const transcripts = (attemptRow.walkthrough_transcripts as Record<string, TranscriptTurn[]>) ?? {}
    const serverTranscript = Array.isArray(transcripts[question.id]) ? transcripts[question.id] : []

    // Grade → g, then recompute θ̂ over the full pattern including this response.
    const grade = await gradeAdaptiveResponse(question, parsed.data, serverTranscript, { sectionId, userId: user.id })
    const after = computePosterior([...prior, { item: irtItemFromQuestion(question), g: grade.g }])

    // Diagnostic only: flag a hard item answered poorly so the results page can
    // surface where the student struggled. (No remediation/coaching branch.)
    const item = irtItemFromQuestion(question)
    const hardMiss = item.b >= HARD_ITEM_B_THRESHOLD && grade.g < 0.5
    const misconceptionNode = hardMiss ? `Struggled on a hard ${question.content.questionType} item (${question.tags?.[0] ?? 'concept'})` : null

    // Persist the graded response with its full IRT trace.
    const { error: insErr } = await adminDb.from('quiz_answers').insert({
      attempt_id: attemptId,
      question_id: question.id,
      selected_choice_ids: parsed.data.selectedChoiceIds ?? null,
      boolean_answer: parsed.data.booleanAnswer ?? null,
      text_answer: parsed.data.textAnswer ?? null,
      blank_answers: parsed.data.blankAnswers ?? null,
      time_spent_seconds: parsed.data.timeSpentSeconds ?? 0,
      tab_switches: parsed.data.tabSwitches ?? 0,
      copy_attempts: parsed.data.copyAttempts ?? 0,
      is_correct: grade.isCorrect,
      earned_points: grade.earnedPoints,
      soft_score: grade.g,
      theta_before: before.theta,
      theta_after: after.theta,
      se_after: after.se,
      grader_mode: grade.graderMode,
      nodes: grade.nodes,
      // Student-facing AI feedback (issue #174) — only the rubric grader's
      // rationale is meaningful; objective types just say Correct./Incorrect.
      rationale: grade.nodes ? grade.rationale : null,
      misconception_node: misconceptionNode,
      is_formative: false,
    })
    if (insErr) { logger.error('submitAdaptiveAnswer: insert failed', insErr, { attemptId }); return { error: 'Failed to save answer' } }

    const nAnswered = answeredIds.size + 1
    const [stopped, reason] = shouldStop(after.se, nAnswered, stopRuleFor(quizRow, bank.size))

    // Select the next item (unless stopped or bank exhausted).
    const lam = quizRow.select_lambda ?? 0.5
    const nextAnswered = new Set(answeredIds); nextAnswered.add(question.id)
    const next = stopped ? null : selectNext([...bank.values()].map(irtItemFromQuestion), nextAnswered, after.theta, { lam, rand: Math.random })
    const finalStopped = stopped || !next
    const finalReason = stopped ? reason : !next ? 'max' : ''

    // Update attempt θ̂/SE; finalize on stop.
    if (finalStopped) {
      // Headline grade = mean soft-score across answered items (deterministic), 0–100.
      const all = [...prior.map((r) => r.g), grade.g]
      const score = all.length ? Math.round((all.reduce((s, g) => s + g, 0) / all.length) * 100) : 0
      // Guard the finalize against a concurrent submit: only the update that flips
      // status from in_progress wins, so ability/log don't get double-applied.
      const { data: finalized } = await adminDb.from('quiz_attempts').update({
        status: 'submitted', submitted_at: new Date().toISOString(),
        theta: after.theta, se: after.se, stop_reason: finalReason,
        score, current_rating: attemptRow.current_rating,
      }).eq('id', attemptId).eq('status', 'in_progress').select('id')
      if (finalized && finalized.length > 0) {
        // Persist per-(student, section) ability via the SECURITY DEFINER RPC.
        await adminDb.rpc('upsert_student_ability', {
          p_student_id: user.id, p_section_id: sectionId, p_theta: after.theta, p_se: after.se,
        })
        await logEvent({ userId: user.id, eventType: 'adaptive_quiz_submitted', sectionId, metadata: { attemptId, theta: after.theta, se: after.se, items: nAnswered } })
        // Fold this grade into the student's topic mastery (best-effort, never throws).
        await applyGradeToSkillMastery({
          sectionId,
          studentId: user.id,
          activityType: 'quiz',
          activityId: attemptRow.quiz_id,
          pct: score,
          attemptId: attemptRow.id,
          occurredAt: attemptRow.submitted_at,
        })
        afterResponse(() => enqueueMasteryRecompute(sectionId))
      }
    } else {
      await adminDb.from('quiz_attempts').update({ theta: after.theta, se: after.se }).eq('id', attemptId)
    }

    revalidatePath(`/student/courses/${sectionId}/quizzes`)

    return {
      data: {
        graded: { g: grade.g, isCorrect: grade.isCorrect, rationale: grade.rationale, nodes: grade.nodes, mode: grade.graderMode },
        theta: after.theta,
        se: after.se,
        answered: nAnswered,
        served: next ? serveAdaptiveQuestion(bank.get(next.chosen.item.id)!) : null,
        stopped: finalStopped,
        stopReason: finalReason,
      },
    }
  } catch (error) {
    logger.error('submitAdaptiveAnswer: Exception', error, { sectionId, attemptId })
    return { error: 'An unexpected error occurred' }
  }
}

/**
 * One walkthrough tutor turn. The SERVER owns the transcript: it appends the
 * student's new message + the tutor reply to quiz_attempts.walkthrough_transcripts,
 * so neither the graded transcript nor the per-question turn cap can be forged by
 * the client. Verifies the attempt is still in_progress, keeps context scoped to the
 * item + rubric (never full course context), and enforces the turn cap server-side.
 * NOT scored — grading happens from the stored transcript at submit time.
 *
 * `studentMessage` is the student's NEW message (empty string to request the
 * opening when the item has no scripted one).
 */
export async function adaptiveTutorTurn(
  sectionId: string,
  attemptId: string,
  questionId: string,
  studentMessage: string,
) {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    // Coarse per-instance rate limit — this endpoint calls Gemini per turn.
    if (!rateLimit(`tutor:${user.id}`, 20, 60_000)) return { error: 'Too many requests — please slow down.' }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this section' }

    // Attempt must belong to this student + section AND still be open.
    const { data: attemptRow } = await adminDb
      .from('quiz_attempts')
      .select('id, status, walkthrough_transcripts')
      .eq('id', attemptId).eq('student_id', user.id).eq('section_id', sectionId).single()
    if (!attemptRow) return { error: 'Attempt not found' }
    if (attemptRow.status !== 'in_progress') return { error: 'Attempt already submitted' }

    const { data: qRow } = await adminDb
      .from('quiz_questions').select('*').eq('id', questionId).eq('section_id', sectionId).single()
    if (!qRow) return { error: 'Question not found' }
    const q = mapDbQuestion(qRow)
    if (q.content.questionType !== 'walkthrough') return { error: 'Not a walkthrough item' }

    const rubric = (q.rubric as RubricNode[]) ?? []
    const maxTurns = qRow.content?.maxTurns ?? 4

    // Server-side transcript for this question is the source of truth.
    const transcripts: Record<string, TranscriptTurn[]> =
      (attemptRow.walkthrough_transcripts as Record<string, TranscriptTurn[]>) ?? {}
    const stored: TranscriptTurn[] = Array.isArray(transcripts[questionId])
      ? transcripts[questionId].filter((t) => t && (t.role === 'student' || t.role === 'tutor') && typeof t.text === 'string')
      : []

    // Seed the scripted opening once so the stored transcript matches the UI.
    if (stored.length === 0 && q.content.opening) {
      stored.push({ role: 'tutor', text: q.content.opening })
    }

    const studentTurns = stored.filter((t) => t.role === 'student').length
    const cleanMsg = (studentMessage ?? '').toString().slice(0, 4000).trim()

    // Server-side turn cap: once the student has spent their turns, end the
    // interview WITHOUT another Gemini call. The count comes from the stored
    // transcript, so a client can't reset it by trimming what it sends.
    if (cleanMsg && studentTurns >= maxTurns) {
      return { data: { reply: "That's a good place to stop — let's score the reasoning you've shown.", done: true } }
    }

    if (cleanMsg) stored.push({ role: 'student', text: cleanMsg })

    const turn = await walkthroughTurn(q.questionText, rubric, stored.slice(-40), maxTurns, { sectionId, userId: user.id })
    stored.push({ role: 'tutor', text: turn.reply })

    transcripts[questionId] = stored.slice(-80) // keep the persisted row bounded
    await adminDb.from('quiz_attempts')
      .update({ walkthrough_transcripts: transcripts })
      .eq('id', attemptId).eq('status', 'in_progress')

    return { data: turn }
  } catch (error) {
    logger.error('adaptiveTutorTurn: Exception', error, { sectionId, attemptId })
    return { error: 'An unexpected error occurred' }
  }
}

