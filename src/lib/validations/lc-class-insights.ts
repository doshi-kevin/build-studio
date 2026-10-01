// Shapes for Class Insights — the post-class surface generated when a live
// classroom ends. Two blobs with different audiences:
//   • Professor blob = the existing SessionReport (lc/report/compute.ts).
//   • Student blob (here) = a PII-FREE study pack stored in
//     lc_class_insights_student.content. NEVER contains names, absentees, or
//     who-answered-what — per-student numbers are computed live from the
//     caller's own responses at view time.
//
// The AI-generated parts (lecture summary, flashcards, practice quiz) are
// validated against the Zod schemas here before they are ever stored, so the
// student UI can trust the shape (never trust raw LLM output).

import { z } from 'zod'

/** Class-level aggregates below this many respondents are suppressed so the
 *  3–4 students who answered can't be de-anonymised on the student view. */
export const STUDENT_MIN_RESPONDENTS = 5

// ── AI-generated content (validated before storage) ──────────────────

export const flashcardSchema = z.object({
  front: z.string().min(1).max(300),
  back: z.string().min(1).max(800),
  concept: z.string().min(1).max(60),
})
export type Flashcard = z.infer<typeof flashcardSchema>

export const flashcardsOutputSchema = z.object({
  cards: z.array(flashcardSchema).min(1).max(20),
})

/** All five reveal-based practice types share one flat shape (no grading):
 *  `options` is non-empty for multiple_choice / true_false; empty for the
 *  free-text types, where `correctAnswer` is the model answer the student
 *  self-checks against. Keeps the LLM output + the player simple. */
export const PRACTICE_QUESTION_TYPES = [
  'multiple_choice',
  'true_false',
  'fill_in_blank',
  'short_answer',
  'explanation',
] as const

export const practiceQuestionSchema = z
  .object({
    type: z.enum(PRACTICE_QUESTION_TYPES),
    prompt: z.string().min(1).max(1000),
    /** Choices for multiple_choice (3–4) and true_false (["True","False"]);
     *  empty for free-text types. */
    options: z.array(z.string().min(1).max(300)).max(4).default([]),
    /** The correct option's text, "True"/"False", or the model answer. */
    correctAnswer: z.string().min(1).max(1000),
    explanation: z.string().min(1).max(1000),
    concept: z.string().min(1).max(60),
  })
  // Choice types MUST ship renderable options with the correct answer among
  // them — otherwise the player would show a choice-less question. Rejecting
  // here makes the LLM output retry rather than store a broken quiz.
  .superRefine((q, ctx) => {
    const isChoice = q.type === 'multiple_choice' || q.type === 'true_false'
    if (!isChoice) return
    if (q.options.length < 2) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['options'], message: `${q.type} requires at least 2 options` })
    } else if (!q.options.includes(q.correctAnswer)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['correctAnswer'], message: 'correctAnswer must be one of the options' })
    }
  })
export type PracticeQuestion = z.infer<typeof practiceQuestionSchema>

export const practiceQuizOutputSchema = z.object({
  questions: z.array(practiceQuestionSchema).min(1).max(15),
})

// ── Stored student blob (lc_class_insights_student.content) ───────────

export interface StudentInsightQuiz {
  interactionId: string
  title: string
  /** Full review content — questions, correct answers, explanations.
   *  Quiz content, not PII. */
  questions: Array<{
    id: string
    prompt: string
    choices: Array<{ id: string; text: string }>
    correctChoiceId: string
    concept: string
    explanation: string
  }>
  /** How many students answered (drives suppression; not a list of who). */
  respondentCount: number
  /** Class % correct, 0-100 — null when suppressed (respondentCount < min). */
  classAccuracy: number | null
  comparisonSuppressed: boolean
}

export interface StudentInsightConcept {
  concept: string
  /** Class accuracy on this concept, 0-100 — null when suppressed. */
  correctRate: number | null
  respondentCount: number
  suppressed: boolean
}

export interface StudentInsightsContent {
  version: 1
  /** True when the session produced nothing worth a study pack. */
  empty: boolean
  /** True once the deterministic content is stored but the LLM extras
   *  (summary/flashcards/practice quiz) are still being generated. Lets the
   *  view render the study content immediately and show the extras as pending. */
  extrasPending: boolean
  /** True when the session had interactions (so it isn't `empty`) but no usable
   *  lecture material (no transcript, no slide text), so the AI extras are
   *  intentionally skipped to avoid hallucinating from an empty context. The
   *  view shows a graceful note instead of the summary/flashcards/practice quiz. */
  noMaterials: boolean
  meta: {
    durationMinutes: number
    slideCount: number | null
    slidesWithTranscript: number
    deckCount: number
  }
  // Deterministic (written first) ──
  quizzes: StudentInsightQuiz[]
  concepts: StudentInsightConcept[]
  // AI-generated (patched in once ready; null until then) ──
  summary: string | null
  summaryFailed: boolean
  flashcards: Flashcard[] | null
  flashcardsFailed: boolean
  practiceQuiz: { questions: PracticeQuestion[] } | null
  practiceQuizFailed: boolean
}
