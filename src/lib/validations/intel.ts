/**
 * Intel Validation Schemas — Zod schemas for Course Alumni Intelligence Panel.
 *
 * Used in:
 * 1. Client-side: react-hook-form resolver for instant form validation
 * 2. Server-side: server actions validate input as defense in depth
 */

import { z } from 'zod'

// ── Enums ────────────────────────────────────────────────────────

export const REVIEW_STATUSES = ['active', 'hidden', 'flagged'] as const
export type ReviewStatus = (typeof REVIEW_STATUSES)[number]

export const QUESTION_STATUSES = ['active', 'closed', 'hidden'] as const
export type QuestionStatus = (typeof QUESTION_STATUSES)[number]

export const CONTENT_STATUSES = ['active', 'hidden'] as const
export type ContentStatus = (typeof CONTENT_STATUSES)[number]

export const TIP_CATEGORIES = [
  'study_advice',
  'exam_tips',
  'grading_tricks',
  'general',
  'resources',
  'time_management',
] as const
export type TipCategory = (typeof TIP_CATEGORIES)[number]

export const RESOURCE_CATEGORIES = [
  'notes',
  'cheat_sheet',
  'project_example',
  'study_guide',
  'practice_exam',
  'other',
] as const
export type ResourceCategory = (typeof RESOURCE_CATEGORIES)[number]

export const GRADE_OPTIONS = [
  'A+', 'A', 'A-',
  'B+', 'B', 'B-',
  'C+', 'C', 'C-',
  'D+', 'D', 'D-',
  'F', 'W', 'P', 'NP', 'I',
] as const
export type GradeOption = (typeof GRADE_OPTIONS)[number]

export const RATING_DIMENSIONS = [
  'overall',
  'difficulty',
  'workload',
  'teaching',
  'grading_fairness',
] as const

// ── Labels ───────────────────────────────────────────────────────

export const TIP_CATEGORY_LABELS: Record<TipCategory, string> = {
  study_advice: 'Study Advice',
  exam_tips: 'Exam Tips',
  grading_tricks: 'Grading Insights',
  general: 'General',
  resources: 'Resources',
  time_management: 'Time Management',
}

export const RESOURCE_CATEGORY_LABELS: Record<ResourceCategory, string> = {
  notes: 'Notes',
  cheat_sheet: 'Cheat Sheet',
  project_example: 'Project Example',
  study_guide: 'Study Guide',
  practice_exam: 'Practice Exam',
  other: 'Other',
}

export const RATING_DIMENSION_LABELS: Record<string, string> = {
  overall: 'Overall',
  difficulty: 'Difficulty',
  workload: 'Workload',
  teaching: 'Teaching Quality',
  grading_fairness: 'Grading Fairness',
}

// ── Review Schemas ──────────────────────────────────────────────

export const createReviewSchema = z.object({
  rating_overall: z.coerce.number().int().min(1, 'Required').max(5),
  rating_difficulty: z.coerce.number().int().min(1, 'Required').max(5),
  rating_workload: z.coerce.number().int().min(1, 'Required').max(5),
  rating_teaching: z.coerce.number().int().min(1, 'Required').max(5),
  rating_grading_fairness: z.coerce.number().int().min(1, 'Required').max(5),
  review_text: z
    .string()
    .max(5000, 'Review must be at most 5,000 characters')
    .trim()
    .optional()
    .or(z.literal('')),
  would_take_again: z.boolean().default(true),
  grade_received: z.enum(GRADE_OPTIONS).nullable().optional(),
  hours_per_week: z.coerce
    .number()
    .int()
    /* Bare .min()/.max() render Zod's internal default straight into the UI —
       "Too big: expected number to be <=80" (#741). The ratings above already
       carry written messages; this is the only bound in the file that didn't. */
    .min(0, 'Hours can\'t be negative')
    .max(80, 'Please enter 80 hours or fewer')
    .nullable()
    .optional(),
  is_anonymous: z.boolean().default(false),
})

export const updateReviewSchema = createReviewSchema.partial()

export type CreateReviewInput = z.infer<typeof createReviewSchema>
export type UpdateReviewInput = z.infer<typeof updateReviewSchema>

// ── Question Schemas ────────────────────────────────────────────

export const createQuestionSchema = z.object({
  title: z
    .string()
    .min(1, 'Question title is required')
    .max(300, 'Title must be at most 300 characters')
    .trim(),
  body: z
    .string()
    .max(5000, 'Body must be at most 5,000 characters')
    .trim()
    .optional()
    .or(z.literal('')),
  is_anonymous: z.boolean().default(false),
})

export type CreateQuestionInput = z.infer<typeof createQuestionSchema>

// ── Answer Schemas ──────────────────────────────────────────────

export const createAnswerSchema = z.object({
  body: z
    .string()
    .min(1, 'Answer is required')
    .max(5000, 'Answer must be at most 5,000 characters')
    .trim(),
  is_anonymous: z.boolean().default(false),
})

export type CreateAnswerInput = z.infer<typeof createAnswerSchema>

// ── Tip Schemas ─────────────────────────────────────────────────

export const createTipSchema = z.object({
  category: z.enum(TIP_CATEGORIES).default('general'),
  content: z
    .string()
    .min(1, 'Tip content is required')
    .max(2000, 'Tip must be at most 2,000 characters')
    .trim(),
  is_anonymous: z.boolean().default(false),
})

export type CreateTipInput = z.infer<typeof createTipSchema>

// ── Resource Schemas ────────────────────────────────────────────

export const createResourceSchema = z.object({
  title: z
    .string()
    .min(1, 'Title is required')
    .max(200, 'Title must be at most 200 characters')
    .trim(),
  description: z
    .string()
    .max(2000, 'Description must be at most 2,000 characters')
    .trim()
    .optional()
    .or(z.literal('')),
  category: z.enum(RESOURCE_CATEGORIES).default('notes'),
  is_anonymous: z.boolean().default(false),
})

export type CreateResourceInput = z.infer<typeof createResourceSchema>

// ── Professor Insight Schemas ───────────────────────────────────

export const createProfessorInsightSchema = z.object({
  professor_id: z.string().min(1, 'Professor is required'),
  rating_teaching: z.coerce.number().int().min(1, 'Required').max(5),
  rating_approachability: z.coerce.number().int().min(1, 'Required').max(5),
  rating_clarity: z.coerce.number().int().min(1, 'Required').max(5),
  insight_text: z
    .string()
    .max(3000, 'Insight must be at most 3,000 characters')
    .trim()
    .optional()
    .or(z.literal('')),
  is_anonymous: z.boolean().default(false),
})

export type CreateProfessorInsightInput = z.infer<typeof createProfessorInsightSchema>
