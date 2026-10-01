/**
 * Quiz System Validation Schemas — Zod schemas for questions, quizzes, and attempts.
 *
 * Question content uses a discriminated union on `questionType` for type-specific
 * content validation. Follows the same pattern as module.ts content schemas.
 *
 * Used in:
 * 1. Client-side: react-hook-form resolver for instant form validation
 * 2. Storage layer: validate data before persisting
 */

import { z } from 'zod'
// `@/lib/quiz/utils` imports nothing, so this cannot cycle back.
import { isPastDue } from '@/lib/quiz/utils'

// ── Enums ─────────────────────────────────────────────────────

export const QUESTION_TYPES = ['multiple_choice', 'true_false', 'short_answer', 'fill_in_blank'] as const
export type QuestionType = (typeof QUESTION_TYPES)[number]

// CCAT (Quizzes v2) item types: the four selected/exact-match types plus two
// AI-graded constructed-response types. Drives the IRT model (guessing `c`) and
// the grader path. See docs/designs/quizzes/ccat-system-design.md §4.
export const QUIZ_ITEM_TYPES = [
  ...QUESTION_TYPES,
  'explanation', // free-text, graded by Gemini against a rubric of nodes
  'walkthrough', // multi-turn Socratic interview, transcript graded
] as const
export type QuizItemType = (typeof QUIZ_ITEM_TYPES)[number]

// The AI-graded constructed-response types — only adaptive quizzes can grade
// them, so authoring surfaces show them locked until Adaptive Mode is on.
export const ADAPTIVE_ONLY_TYPES = ['explanation', 'walkthrough'] as const

// Labels cover all six item types (legacy four + the two v2 constructed types)
// so display surfaces keyed by content.questionType never miss a key.
export const QUESTION_TYPE_LABELS: Record<QuizItemType, string> = {
  multiple_choice: 'Multiple Choice',
  true_false: 'True / False',
  short_answer: 'Short Answer',
  fill_in_blank: 'Fill in the Blank',
  explanation: 'Explanation',
  walkthrough: 'Guided Walkthrough',
}

export const DIFFICULTY_LEVELS = ['easy', 'medium', 'hard'] as const
export type DifficultyLevel = (typeof DIFFICULTY_LEVELS)[number]

export const DIFFICULTY_LABELS: Record<DifficultyLevel, string> = {
  easy: 'Easy',
  medium: 'Medium',
  hard: 'Hard',
}

export const BLOOMS_LEVELS = ['remember', 'understand', 'apply', 'analyze', 'evaluate', 'create'] as const
export type BloomsLevel = (typeof BLOOMS_LEVELS)[number]

export const BLOOMS_LABELS: Record<BloomsLevel, string> = {
  remember: 'Remember',
  understand: 'Understand',
  apply: 'Apply',
  analyze: 'Analyze',
  evaluate: 'Evaluate',
  create: 'Create',
}

export const QUIZ_STATUSES = ['draft', 'published'] as const
export type QuizStatus = (typeof QUIZ_STATUSES)[number]

/** Sanity ceiling on Max Attempts — NOT the old cap of 10, which is what #43 removed.
 *  `quizzes.max_attempts` is an int4, so an unbounded schema let a fat-fingered 3e9 pass
 *  validation and fail in Postgres as an opaque save error. Anyone wanting more than this
 *  wants "no limit", which is null.
 *
 *  Enforced at all three layers deliberately: the studio form + input clamp to it (so an
 *  over-large entry never becomes a raw validator toast — the very symptom of #43), the
 *  server schemas reject it, and `quizzes_max_attempts_check` bounds direct DB writes.
 *  Changing this value means changing that CHECK constraint too. */
export const MAX_ATTEMPTS_CEILING = 1000

export const EXPLANATION_TIMINGS = ['after_submission', 'after_due_date', 'never'] as const
export type ExplanationTiming = (typeof EXPLANATION_TIMINGS)[number]

export const EXPLANATION_TIMING_LABELS: Record<ExplanationTiming, string> = {
  after_submission: 'After Submission',
  after_due_date: 'After Due Date',
  never: 'Never',
}

/**
 * The professor's reveal gate — may the student see per-question correct answers
 * and AI rationale for this quiz yet? `after_submission` reveals immediately,
 * `after_due_date` waits for the deadline to pass, `never` never reveals. The one
 * predicate BOTH student-facing review surfaces must apply: the human review
 * (`getUnifiedResult`) and Athena's `get_my_quiz_review` tool. Keeping it here
 * stops the guard from drifting between the two.
 */
export function canRevealQuizAnswers(
  showExplanations: ExplanationTiming | null | undefined,
  dueDate: string | null | undefined,
  now: Date = new Date(),
): boolean {
  const timing: ExplanationTiming = showExplanations ?? 'after_submission'
  if (timing === 'after_submission') return true
  // MUST use the same deadline as checkDueDate. These two were `new Date(dueDate)`
  // in both places, so they moved together by accident. Extending the submission
  // window to end-of-day without moving this one opened a ~24h window on a
  // date-only due date where the answer key was revealed (here and via Athena's
  // quiz-review tool) while new attempts were still being accepted (#311).
  if (timing === 'after_due_date') return isPastDue(dueDate, now.getTime())
  return false
}

export const ATTEMPT_STATUSES = ['in_progress', 'submitted'] as const
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number]

export const QUIZ_MODES = ['graded', 'practice'] as const
export type QuizMode = (typeof QUIZ_MODES)[number]

export const COHORT_TYPES = ['adaptive', 'control'] as const
export type CohortType = (typeof COHORT_TYPES)[number]

export const COHORT_LABELS: Record<CohortType, string> = {
  adaptive: 'Adaptive',
  control: 'Control',
}

export const COHORT_ASSIGNED_BY = ['auto', 'professor'] as const
export type CohortAssignedBy = (typeof COHORT_ASSIGNED_BY)[number]

// ── Choice Schema (for multiple_choice) ─────────────────────

export const choiceSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1, 'Choice text is required').max(500),
  isCorrect: z.boolean(),
})

export type Choice = z.infer<typeof choiceSchema>

// ── Question Content — discriminated union by questionType ───

/**
 * A single-answer MCQ with two choices marked correct is not merely untidy — it is
 * ungradeable. `gradeAnswer` requires `correctIds.length === 1` in that mode, so EVERY
 * student is scored wrong whatever they pick, and with negative marking they are docked
 * for it. The editors now enforce exclusivity in the UI, but five different paths write
 * this shape (studio, question bank, JSON import, the LLM extractor, Athena's adapter),
 * so the UI cannot be the invariant. This schema is the one chokepoint they all funnel
 * through — hence the check lives here.
 */
export const multipleChoiceContentSchema = z
  .object({
    questionType: z.literal('multiple_choice'),
    choices: z.array(choiceSchema).min(2, 'At least 2 choices required').max(8),
    allowMultiple: z.boolean().default(false),
  })
  .superRefine((content, ctx) => {
    /* Zero correct answers is as ungradeable as two: gradeAnswer requires
       exactly one correct id for a single-answer question, so every student
       scores 0 (and loses marks under negative marking). This rejected only the
       >1 case, so the Question Bank dialog saved zero-correct questions with a
       "Question created" toast and no validation — and because is_complete
       defaults to TRUE, publishQuiz's incomplete-question gate waved them
       through. Guarding here covers every strict writer at one chokepoint.

       Deliberately NOT applied to draftQuestionContentSchema: draft autosave
       must keep persisting blank placeholders (see the is_complete migration),
       and that schema declares its own multiple_choice shape. */
    const correct = content.choices.filter((c) => c.isCorrect).length
    if (correct === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['choices'],
        message: 'Mark at least one choice as correct.',
      })
      return
    }
    if (content.allowMultiple) return
    if (correct > 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['choices'],
        message: 'Only one choice can be correct unless you allow multiple correct answers.',
      })
    }
  })

export const trueFalseContentSchema = z.object({
  questionType: z.literal('true_false'),
  correctAnswer: z.boolean(),
})

export const shortAnswerContentSchema = z.object({
  questionType: z.literal('short_answer'),
  acceptedAnswers: z.array(z.string().min(1)).min(1, 'At least 1 accepted answer'),
  caseSensitive: z.boolean().default(false),
})

export const fillInBlankContentSchema = z.object({
  questionType: z.literal('fill_in_blank'),
  blanks: z
    .array(
      z.object({
        id: z.string().min(1),
        acceptedAnswers: z.array(z.string().min(1)).min(1),
        caseSensitive: z.boolean().default(false),
      }),
    )
    .min(1, 'At least 1 blank required'),
})

// ── CCAT (v2) constructed-response content ──────────────────
// These two types have no answer key in `content` — they are AI-graded against
// the question's `rubric` (a sibling field/column), so their content only holds
// presentation/config. The rubric's `match` keyword lists are stripped before a
// question is sent to a student (see the public-item helper in the adaptive path).

/** One rubric node: a conceptual point a good answer should convey. `match`
 *  keywords power the zero-cost keyword grader fallback (kept server-side). */
export const rubricNodeSchema = z.object({
  concept: z.string().min(1).max(500),
  match: z.array(z.string().max(80)).max(20).optional(),
})
export type RubricNode = z.infer<typeof rubricNodeSchema>

// ── Source citation (AI-generated questions only) ───────────
// Remembers which file + page an AI question was drawn from, so the professor
// can peek the exact source page in the quiz creator (see docs/designs/
// quizzes/hybrid-extraction-and-citation.md §15). Resolved + range-checked server-side after
// generation — never trusted from the model directly. Null when hand-written
// or unverifiable. Professor-only authoring aid.
// `renderable`: whether the peek endpoint can render this file (PDF/PPT only);
// stamped at citation resolution so the chip can disable the peek for
// docx/xlsx/image sources. Absent (older citations) = treat as renderable.
export const sourceCitationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('module_item'),
    moduleItemId: z.string().min(1),
    page: z.number().int().min(1),
    title: z.string().min(1).max(300),
    renderable: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('upload'),
    filePath: z.string().min(1),
    page: z.number().int().min(1),
    title: z.string().min(1).max(300),
    renderable: z.boolean().optional(),
  }),
  // AI-extended: the question was generated on-topic from the model's own
  // knowledge (opt-in "beyond the document" mode), NOT drawn verbatim from a
  // source page. It carries no file/page — the chip reads "AI-extended · topic"
  // and isn't peekable. This flags questions the professor should review harder.
  z.object({
    kind: z.literal('ai_extended'),
    topic: z.string().min(1).max(300),
  }),
])
export type SourceCitation = z.infer<typeof sourceCitationSchema>
/** A citation that points at a real source page (module_item | upload) — what
 *  the server-side resolvers produce. Excludes ai_extended, which is stamped at
 *  generation, never resolved from source. */
export type SourcePageCitation = Exclude<SourceCitation, { kind: 'ai_extended' }>

// ── Generation notice (AI shortfall) ────────────────────────────
// Stored on the quiz row after an AI run delivered fewer than requested. The
// `request` snapshot is what the "fill the rest" action replays with
// beyondDocument=true, so the professor fills the gap in one click even after
// leaving and returning. Kept deliberately small — ids + counts, no content.
export const generationNoticeSchema = z.object({
  requested: z.number().int().min(1),
  delivered: z.number().int().min(0),
  /** Wall-clock of the generation run, for "(in 2m 10s)" — absent on notices
   *  written before this field existed. */
  durationMs: z.number().int().min(0).optional(),
  request: z.object({
    moduleItemIds: z.array(z.string()).default([]),
    additionalFilePaths: z.array(z.string()).default([]),
    questionCount: z.number().int().min(1),
    customPrompt: z.string().optional(),
    includeMetadata: z.boolean().optional(),
    questionTypes: z.array(z.string()).optional(),
  }),
  createdAt: z.string(),
})
export type GenerationNotice = z.infer<typeof generationNoticeSchema>

export const explanationContentSchema = z.object({
  questionType: z.literal('explanation'),
})

export const walkthroughContentSchema = z.object({
  questionType: z.literal('walkthrough'),
  opening: z.string().max(1000).default(''), // the tutor's first prompt
  maxTurns: z.number().int().min(2).max(8).default(4),
})

export const questionContentSchema = z.discriminatedUnion('questionType', [
  multipleChoiceContentSchema,
  trueFalseContentSchema,
  shortAnswerContentSchema,
  fillInBlankContentSchema,
  explanationContentSchema,
  walkthroughContentSchema,
])

export type QuestionContent = z.infer<typeof questionContentSchema>

// ── Lenient content for DRAFT persistence ───────────────────
// A brand-new question is blank; we still persist it (as a placeholder on the
// quiz) so it survives navigation — tagged is_complete=false, hidden from the
// bank picker and blocking publish until valid. These relax ONLY the
// completeness minimums (empty stem, no choices yet) while keeping shape + caps.
const draftChoiceSchema = z.object({
  id: z.string().min(1),
  text: z.string().max(500),
  isCorrect: z.boolean(),
})
const draftQuestionContentSchema = z.discriminatedUnion('questionType', [
  z.object({
    questionType: z.literal('multiple_choice'),
    choices: z.array(draftChoiceSchema).max(8),
    allowMultiple: z.boolean().default(false),
  }),
  trueFalseContentSchema,
  z.object({
    questionType: z.literal('short_answer'),
    acceptedAnswers: z.array(z.string().max(500)).default([]),
    caseSensitive: z.boolean().default(false),
  }),
  z.object({
    questionType: z.literal('fill_in_blank'),
    blanks: z
      .array(
        z.object({
          id: z.string().min(1),
          acceptedAnswers: z.array(z.string().max(500)).default([]),
          caseSensitive: z.boolean().default(false),
        }),
      )
      .default([]),
  }),
  explanationContentSchema,
  walkthroughContentSchema,
])

/** True when a question is fully gradeable — a non-empty stem, valid content
 *  shape (the STRICT content rules), (for MCQ) at least one correct choice, and
 *  (for the AI-graded explanation/walkthrough types) at least one rubric
 *  concept, since the grader scores every answer 0 without one. Drives
 *  `is_complete`: incomplete questions persist as placeholders but stay out of
 *  the bank picker and block publish. Kept in step with the client's
 *  `wizardQuestionInlineError` rules — the rubric is a sibling field, not part
 *  of `content`, so callers must pass it. */
export function isQuestionComplete(
  questionText: string,
  content: unknown,
  rubric?: RubricNode[] | null,
): boolean {
  if (!questionText.trim()) return false
  const parsed = questionContentSchema.safeParse(content)
  if (!parsed.success) return false
  const c = parsed.data
  if (c.questionType === 'multiple_choice' && !c.choices.some((ch) => ch.isCorrect)) return false
  if (c.questionType === 'explanation' || c.questionType === 'walkthrough') {
    if (!(rubric ?? []).some((n) => n?.concept?.trim())) return false
  }
  return true
}

// ── Question Schema ─────────────────────────────────────────

export const questionSchema = z.object({
  id: z.string().min(1),
  sectionId: z.string().min(1),
  questionText: z.string().min(1, 'Question text is required').max(2000),
  content: questionContentSchema,
  difficulty: z.enum(DIFFICULTY_LEVELS),
  bloomsLevel: z.enum(BLOOMS_LEVELS).nullable().default(null),
  tags: z.array(z.string().max(50)).max(10).default([]),
  points: z.number().int().min(1).max(100).default(1),
  explanation: z.string().max(2000).default(''),
  isBonus: z.boolean().default(false),
  isExtraCredit: z.boolean().default(false),
  imageUrl: z.string().nullable().default(null),
  imagePath: z.string().nullable().default(null),
  codeSnippet: z
    .object({
      language: z.string().min(1),
      code: z.string().max(5000),
    })
    .nullable()
    .default(null),
  // Adaptive quiz fields (legacy Elo — retained, unused by the v2 IRT engine)
  eloRating: z.number().int().min(400).max(2400).default(1200),
  expectedTimeSeconds: z.number().int().min(5).max(600).nullable().default(null),
  // CCAT / IRT parameters (v2). Seeded from difficulty/AI; calibrated in phase 2.
  irtA: z.number().min(0.1).max(4).nullable().default(null), // discrimination
  irtB: z.number().min(-4).max(4).nullable().default(null), // difficulty (latent scale)
  irtC: z.number().min(0).max(0.9).nullable().default(null), // guessing (derived from type)
  rubric: z.array(rubricNodeSchema).nullable().default(null), // explanation/walkthrough only
  sourceCitation: sourceCitationSchema.nullable().optional(), // AI-generated: source file + page
  // false = an incomplete placeholder: persisted so it survives navigation, but
  // hidden from the "Pick from question bank" picker and blocks publish until
  // filled in. Absent (older rows) = treat as complete.
  isComplete: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export type Question = z.infer<typeof questionSchema>

export const createQuestionSchema = questionSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
})
export type CreateQuestionInput = z.infer<typeof createQuestionSchema>

// ── Quiz Pool Schema (random selection from bank) ───────────

export const questionPoolSchema = z.object({
  id: z.string().min(1),
  tag: z.string().min(1),
  count: z.number().int().min(1),
})

export type QuestionPool = z.infer<typeof questionPoolSchema>

// ── Quiz Schema ─────────────────────────────────────────────

export const quizSchema = z.object({
  id: z.string().min(1),
  sectionId: z.string().min(1),
  createdBy: z.string().min(1).default(''),
  title: z.string().min(1, 'Title is required').max(200).trim(),
  description: z.string().max(2000).default(''),
  status: z.enum(QUIZ_STATUSES).default('draft'),
  questionIds: z.array(z.string()).default([]),
  questionPools: z.array(questionPoolSchema).default([]),
  timeLimitMinutes: z.number().int().min(1).max(480).nullable().default(null),
  shuffleQuestions: z.boolean().default(false),
  shuffleAnswers: z.boolean().default(false),
  // null = no limit. The old .max(10) rejected the 99 professors actually asked for and
  // surfaced as "Too big: expected number to be <=10" (#43). MAX_ATTEMPTS_CEILING is not
  // that cap back — it only keeps a fat-fingered value inside int4 (unlimited is null).
  //
  // The DEFAULT is 1, not null: unlimited has to be chosen, never inherited. Omitting the
  // field is what a caller does when it has no opinion, and pairing "no opinion" with the
  // 'after_submission' explanations default would let a student resubmit toward 100%.
  // Kept in step with QuizStudio's form default and the column DEFAULT, so all three
  // creation paths (Studio, createQuizFull, quick-create) agree on what a new quiz means.
  maxAttempts: z.number().int().min(1).max(MAX_ATTEMPTS_CEILING).nullable().default(1),
  passThreshold: z.number().min(0).max(100).default(60),
  dueDate: z.string().nullable().default(null),
  scheduledPublishAt: z.string().nullable().default(null),
  showExplanations: z.enum(EXPLANATION_TIMINGS).default('after_submission'),
  showLeaderboard: z.boolean().default(false),
  allowFormulaSheet: z.boolean().default(false),
  formulaSheetUrl: z.string().nullable().default(null),
  formulaSheetPath: z.string().nullable().default(null),
  negativeMarking: z.boolean().default(false),
  negativeMarkingPenalty: z.number().min(0).max(1).default(0.25),
  difficultyDistribution: z
    .object({
      easy: z.number().min(0).max(100),
      medium: z.number().min(0).max(100),
      hard: z.number().min(0).max(100),
    })
    .nullable()
    .default(null),
  proctoringEnabled: z.boolean().default(false),
  videoProctoringEnabled: z.boolean().default(false),
  // Adaptive quiz fields
  adaptiveMode: z.boolean().default(false),
  adaptiveRatio: z.number().int().min(0).max(100).default(60),
  adaptiveQuestionCount: z.number().int().min(1).max(100).default(10),
  controlDistribution: z
    .object({
      easy: z.number().int().min(0),
      medium: z.number().int().min(0),
      hard: z.number().int().min(0),
    })
    .nullable()
    .default(null),
  showRatingToStudents: z.boolean().default(false),
  // CCAT (v2) config: selection difficulty-tempering + stopping rule.
  selectLambda: z.number().min(0).max(2).default(0.5),
  stopMode: z.enum(['fixed', 'precision']).default('fixed'),
  targetSe: z.number().min(0.1).max(2).default(0.3),
  // A persistent, dismissible notice shown in the studio after an AI generation
  // fell short of the requested count (the source material only supported N of M
  // distinct grounded questions). It survives reload/navigation until the
  // professor acts on it (fills the gap with topic-based questions) or dismisses
  // it, and carries the original request so the fill is one click. Null = none.
  generationNotice: generationNoticeSchema.nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export type Quiz = z.infer<typeof quizSchema>

/**
 * Has the student used up their attempts? `maxAttempts === null` means no limit,
 * so it never exhausts. Every attempt gate — the two server-side start guards and
 * the student-facing state/CTA — goes through here, so "null = unlimited" is
 * decided in exactly one place.
 */
export function attemptsExhausted(
  maxAttempts: number | null | undefined,
  submittedCount: number,
): boolean {
  // Fail CLOSED on a missing value — only an explicit null means "no limit". Callers read
  // this off a DB row, so if one ever narrows its select and drops the column, that has to
  // surface as a lockout in testing rather than as a silently uncapped quiz in production.
  if (typeof maxAttempts === 'undefined') return true
  return maxAttempts !== null && submittedCount >= maxAttempts
}

export const createQuizSchema = quizSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
})
export type CreateQuizInput = z.infer<typeof createQuizSchema>

// ── Answer Schema (student response to a question) ──────────

export const answerSchema = z.object({
  questionId: z.string().min(1),
  selectedChoiceIds: z.array(z.string()).optional(),
  booleanAnswer: z.boolean().optional(),
  textAnswer: z.string().optional(),
  blankAnswers: z.record(z.string(), z.string()).optional(),
  isFlagged: z.boolean().default(false),
  timeSpentSeconds: z.number().int().min(0).default(0),
  isCorrect: z.boolean().nullable().default(null),
  earnedPoints: z.number().nullable().default(null),
  // Per-question behavioral signals (for adaptive Elo calculation)
  optionChanges: z.number().int().min(0).default(0),
  tabSwitches: z.number().int().min(0).default(0),
  copyAttempts: z.number().int().min(0).default(0),
})

export type Answer = z.infer<typeof answerSchema>

// ── Quiz Attempt Schema ─────────────────────────────────────

export const quizAttemptSchema = z.object({
  id: z.string().min(1),
  quizId: z.string().min(1),
  studentId: z.string().min(1),
  sectionId: z.string().min(1),
  mode: z.enum(QUIZ_MODES).default('graded'),
  status: z.enum(ATTEMPT_STATUSES).default('in_progress'),
  answers: z.record(z.string(), answerSchema).default({}),
  resolvedQuestionIds: z.array(z.string()).default([]),
  score: z.number().nullable().default(null),
  totalPoints: z.number().nullable().default(null),
  earnedPoints: z.number().nullable().default(null),
  startedAt: z.string(),
  submittedAt: z.string().nullable().default(null),
  timeSpentSeconds: z.number().int().min(0).default(0),
  proctoringSummary: z.record(z.string(), z.unknown()).nullable().default(null),
  // Late submission tracking
  isLate: z.boolean().default(false),
  lateBySeconds: z.number().int().min(0).default(0),
  // Timer enforcement tracking
  timeLimitExceeded: z.boolean().default(false),
  overtimeSeconds: z.number().int().min(0).default(0),
  // Adaptive quiz fields
  cohort: z.enum(COHORT_TYPES).nullable().default(null),
  startRating: z.number().int().default(1200),
  currentRating: z.number().int().default(1200),
  finalRating: z.number().int().nullable().default(null),
  adaptiveQuestionIndex: z.number().int().default(0),
})

export type QuizAttempt = z.infer<typeof quizAttemptSchema>

// ── Server Action Input Schemas ──────────────────────────────

/** Input for creating a question via server action */
export const createQuestionServerSchema = z.object({
  // Optional client-generated UUID. When provided, it becomes the row's primary
  // key so the caller can correlate created rows back to client questions
  // without relying on insert order — see bulkCreateQuestions.
  id: z.string().uuid().optional(),
  questionText: z.string().min(1, 'Question text is required').max(2000),
  content: questionContentSchema,
  difficulty: z.enum(DIFFICULTY_LEVELS),
  bloomsLevel: z.enum(BLOOMS_LEVELS).nullable().default(null),
  tags: z.array(z.string().max(50)).max(10).default([]),
  points: z.number().int().min(1).max(100).default(1),
  explanation: z.string().max(2000).default(''),
  isBonus: z.boolean().default(false),
  isExtraCredit: z.boolean().default(false),
  imageUrl: z.string().nullable().default(null),
  imagePath: z.string().nullable().default(null),
  codeSnippet: z
    .object({
      language: z.string().min(1),
      code: z.string().max(5000),
    })
    .nullable()
    .default(null),
  // Adaptive quiz fields (legacy Elo — retained, unused by the v2 IRT engine)
  eloRating: z.number().int().min(400).max(2400).default(1200),
  expectedTimeSeconds: z.number().int().min(5).max(600).nullable().default(null),
  // CCAT / IRT parameters (v2). Seeded from difficulty/AI; calibrated in phase 2.
  irtA: z.number().min(0.1).max(4).nullable().default(null),
  irtB: z.number().min(-4).max(4).nullable().default(null),
  irtC: z.number().min(0).max(0.9).nullable().default(null),
  rubric: z.array(rubricNodeSchema).nullable().default(null),
  sourceCitation: sourceCitationSchema.nullable().optional(),
})
export type CreateQuestionServerInput = z.infer<typeof createQuestionServerSchema>

/** Lenient variant for DRAFT autosave — allows an empty stem / not-yet-filled
 *  content so a placeholder question can persist. Completeness (→ is_complete)
 *  is computed separately via isQuestionComplete. */
export const draftQuestionServerSchema = createQuestionServerSchema.extend({
  questionText: z.string().max(2000),
  content: draftQuestionContentSchema,
})

/** Input for updating a question via server action */
export const updateQuestionServerSchema = createQuestionServerSchema.partial()
export type UpdateQuestionServerInput = z.infer<typeof updateQuestionServerSchema>

/** Input for creating a quiz via server action (simple — title/description only) */
export const createQuizServerSchema = z.object({
  title: z.string().min(1, 'Title is required').max(200).trim(),
  description: z.string().max(2000).default(''),
})
export type CreateQuizServerInput = z.infer<typeof createQuizServerSchema>

/** True when a scheduled publish time is set and already in the past. */
export function isScheduledPublishInPast(value: string | null | undefined): boolean {
  if (value == null) return false // null clears the schedule — always allowed
  const t = Date.parse(value)
  return Number.isNaN(t) || t <= Date.now()
}

/**
 * A NEW scheduled publish time must be in the FUTURE. The wizard blocks a past time
 * client-side, but the server took whatever it was given — and the auto-publish
 * sweep flips any draft whose time has passed, so a past value pushed the quiz live
 * on the next list load, bypassing the publish gate (#311).
 *
 * Only used on CREATE. On update the same rule is applied in `updateQuiz` against
 * the STORED value, because a schedule that simply elapsed while the professor kept
 * editing must stay saveable — enforcing it here blocked every later autosave of
 * that quiz, with no way to clear the field.
 */
const scheduledPublishAtField = z.string().nullable().optional().refine(
  (v) => !isScheduledPublishInPast(v),
  { message: 'Scheduled publish time must be in the future' },
)

/** Input for creating a quiz with full settings via the wizard */
export const createQuizFullServerSchema = z.object({
  title: z.string().min(1, 'Title is required').max(200).trim(),
  description: z.string().max(2000).default(''),
  timeLimitMinutes: z.number().int().min(1).max(480).nullable().optional(),
  shuffleQuestions: z.boolean().optional(),
  shuffleAnswers: z.boolean().optional(),
  // null = no limit (#43)
  maxAttempts: z.number().int().min(1).max(MAX_ATTEMPTS_CEILING).nullable().optional(),
  passThreshold: z.number().min(0).max(100).optional(),
  dueDate: z.string().nullable().optional(),
  scheduledPublishAt: scheduledPublishAtField,
  showExplanations: z.enum(EXPLANATION_TIMINGS).optional(),
  showLeaderboard: z.boolean().optional(),
  allowFormulaSheet: z.boolean().optional(),
  formulaSheetUrl: z.string().nullable().optional(),
  formulaSheetPath: z.string().nullable().optional(),
  negativeMarking: z.boolean().optional(),
  negativeMarkingPenalty: z.number().min(0).max(1).optional(),
  questionPools: z.array(questionPoolSchema).optional(),
  difficultyDistribution: z.object({
    easy: z.number().min(0).max(100),
    medium: z.number().min(0).max(100),
    hard: z.number().min(0).max(100),
  }).nullable().optional(),
  proctoringEnabled: z.boolean().optional(),
  videoProctoringEnabled: z.boolean().optional(),
  // Adaptive quiz fields
  adaptiveMode: z.boolean().optional(),
  adaptiveRatio: z.number().int().min(0).max(100).optional(),
  adaptiveQuestionCount: z.number().int().min(1).max(100).optional(),
  controlDistribution: z.object({
    easy: z.number().int().min(0),
    medium: z.number().int().min(0),
    hard: z.number().int().min(0),
  }).nullable().optional(),
  showRatingToStudents: z.boolean().optional(),
  selectLambda: z.number().min(0).max(2).optional(),
  stopMode: z.enum(['fixed', 'precision']).optional(),
  targetSe: z.number().min(0.1).max(2).optional(),
})
export type CreateQuizFullServerInput = z.infer<typeof createQuizFullServerSchema>

/** Input for updating quiz settings via server action */
export const updateQuizServerSchema = z.object({
  title: z.string().min(1).max(200).trim().optional(),
  description: z.string().max(2000).optional(),
  timeLimitMinutes: z.number().int().min(1).max(480).nullable().optional(),
  shuffleQuestions: z.boolean().optional(),
  shuffleAnswers: z.boolean().optional(),
  // null = no limit (#43)
  maxAttempts: z.number().int().min(1).max(MAX_ATTEMPTS_CEILING).nullable().optional(),
  passThreshold: z.number().min(0).max(100).optional(),
  dueDate: z.string().nullable().optional(),
  // Deliberately unrefined here — see isScheduledPublishInPast. `updateQuiz` checks
  // a CHANGED value against the stored one, so a schedule that merely elapsed while
  // the professor kept editing stays saveable.
  scheduledPublishAt: z.string().nullable().optional(),
  showExplanations: z.enum(EXPLANATION_TIMINGS).optional(),
  showLeaderboard: z.boolean().optional(),
  allowFormulaSheet: z.boolean().optional(),
  formulaSheetUrl: z.string().nullable().optional(),
  formulaSheetPath: z.string().nullable().optional(),
  negativeMarking: z.boolean().optional(),
  negativeMarkingPenalty: z.number().min(0).max(1).optional(),
  questionPools: z.array(questionPoolSchema).optional(),
  difficultyDistribution: z.object({
    easy: z.number().min(0).max(100),
    medium: z.number().min(0).max(100),
    hard: z.number().min(0).max(100),
  }).nullable().optional(),
  proctoringEnabled: z.boolean().optional(),
  videoProctoringEnabled: z.boolean().optional(),
  // Adaptive quiz fields
  adaptiveMode: z.boolean().optional(),
  adaptiveRatio: z.number().int().min(0).max(100).optional(),
  adaptiveQuestionCount: z.number().int().min(1).max(100).optional(),
  controlDistribution: z.object({
    easy: z.number().int().min(0),
    medium: z.number().int().min(0),
    hard: z.number().int().min(0),
  }).nullable().optional(),
  showRatingToStudents: z.boolean().optional(),
  selectLambda: z.number().min(0).max(2).optional(),
  stopMode: z.enum(['fixed', 'precision']).optional(),
  targetSe: z.number().min(0.1).max(2).optional(),
})
export type UpdateQuizServerInput = z.infer<typeof updateQuizServerSchema>

/** Input for saving a single answer (auto-save) */
export const saveAnswerServerSchema = z.object({
  selectedChoiceIds: z.array(z.string()).optional(),
  booleanAnswer: z.boolean().optional(),
  textAnswer: z.string().optional(),
  blankAnswers: z.record(z.string(), z.string()).optional(),
  isFlagged: z.boolean().default(false),
  timeSpentSeconds: z.number().int().min(0).default(0),
  // Per-question behavioral signals (optional, used in adaptive mode)
  optionChanges: z.number().int().min(0).optional().default(0),
  tabSwitches: z.number().int().min(0).optional().default(0),
  copyAttempts: z.number().int().min(0).optional().default(0),
})
export type SaveAnswerServerInput = z.infer<typeof saveAnswerServerSchema>

/** Input for submitting one answer in an adaptive (CCAT) attempt. Walkthrough
 *  items carry no transcript here — it is graded from the server-persisted
 *  transcript (quiz_attempts.walkthrough_transcripts), never the client payload. */
export const adaptiveAnswerServerSchema = z.object({
  questionId: z.string().min(1),
  selectedChoiceIds: z.array(z.string()).optional(),
  booleanAnswer: z.boolean().optional(),
  textAnswer: z.string().max(8000).optional(),
  blankAnswers: z.record(z.string(), z.string()).optional(),
  timeSpentSeconds: z.number().int().min(0).default(0),
  tabSwitches: z.number().int().min(0).optional().default(0),
  copyAttempts: z.number().int().min(0).optional().default(0),
})
export type AdaptiveAnswerServerInput = z.infer<typeof adaptiveAnswerServerSchema>

// ── Quiz Insights (computed, not persisted) ─────────────────

export interface QuizInsights {
  quizId: string
  totalAttempts: number
  averageScore: number
  completionRate: number
  scoreDistribution: { range: string; count: number }[]
  questionAnalysis: {
    questionId: string
    questionText: string
    correctRate: number
    averageTimeSeconds: number
    difficultyRating: DifficultyLevel
  }[]
}

// ── Grade Override ──────────────────────────────────────────────

/** Input for professor grade override on a single answer */
export const overrideAnswerScoreSchema = z.object({
  overridePoints: z.number().min(0).max(100),
  overrideReason: z.string().max(500).default(''),
})
export type OverrideAnswerScoreInput = z.infer<typeof overrideAnswerScoreSchema>
