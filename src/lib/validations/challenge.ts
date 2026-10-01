/**
 * Challenge Board Validation Schemas — enums, labels, and Zod schemas
 * for challenge CRUD, claim review, submission, proposals, and badges.
 */

import { z } from 'zod'

// ── Enums ──────────────────────────────────────────────────────

export const CHALLENGE_TYPES = ['general', 'coding', 'puzzle', 'research', 'creative', 'discussion'] as const
export type ChallengeType = (typeof CHALLENGE_TYPES)[number]

export const CHALLENGE_DIFFICULTIES = ['easy', 'medium', 'hard', 'expert'] as const
export type ChallengeDifficulty = (typeof CHALLENGE_DIFFICULTIES)[number]

export const CHALLENGE_VISIBILITIES = ['draft', 'published', 'archived'] as const
export type ChallengeVisibility = (typeof CHALLENGE_VISIBILITIES)[number]

export const CHALLENGE_SOURCES = ['instructor', 'student_proposed'] as const
export type ChallengeSource = (typeof CHALLENGE_SOURCES)[number]

export const CLAIM_STATUSES = ['claimed', 'submitted', 'approved', 'rejected', 'withdrawn'] as const
export type ClaimStatus = (typeof CLAIM_STATUSES)[number]

export const SUBMISSION_TYPES = ['text', 'link', 'file', 'github'] as const
export type SubmissionType = (typeof SUBMISSION_TYPES)[number]

// ── Labels ─────────────────────────────────────────────────────

export const CHALLENGE_TYPE_LABELS: Record<ChallengeType, string> = {
  general: 'General',
  coding: 'Coding',
  puzzle: 'Puzzle',
  research: 'Research',
  creative: 'Creative',
  discussion: 'Discussion',
}

export const CHALLENGE_DIFFICULTY_LABELS: Record<ChallengeDifficulty, string> = {
  easy: 'Easy',
  medium: 'Medium',
  hard: 'Hard',
  expert: 'Expert',
}

/** How strongly completing a challenge of each difficulty nudges a student's
 *  skill mastery. Fed to the mastery engine as the evidence "stake": harder
 *  challenges move the score more, but all stay at/below a single quiz's weight
 *  so an optional challenge never overwrites real assessment history.
 *  Effective pull toward 100 per completion ≈ 0.3 × stake → ~9% / 15% / 22% / 30%. */
export const CHALLENGE_DIFFICULTY_STAKE: Record<ChallengeDifficulty, number> = {
  easy: 0.3,
  medium: 0.5,
  hard: 0.75,
  expert: 1.0,
}

export const CHALLENGE_VISIBILITY_LABELS: Record<ChallengeVisibility, string> = {
  draft: 'Draft',
  published: 'Published',
  archived: 'Archived',
}

export const CLAIM_STATUS_LABELS: Record<ClaimStatus, string> = {
  claimed: 'Claimed',
  submitted: 'Submitted',
  approved: 'Approved',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
}

export const SUBMISSION_TYPE_LABELS: Record<SubmissionType, string> = {
  text: 'Text',
  link: 'Link',
  file: 'File',
  github: 'GitHub',
}

// ── Professor Schemas ──────────────────────────────────────────

/* Every numeric bound carries its own message (#703 part 6). `title` already had them; the number
   fields did not, so Zod's own text reached the professor as a toast: "Too big: expected number to
   be <=1000". Same family as #617 and #717 part 4, and the same fix: the validator should never be
   the thing talking to the user about itself. */
export const createChallengeSchema = z.object({
  title: z.string().min(1, 'Title is required').max(200, 'Title must be at most 200 characters').trim(),
  description: z.string().max(5000, 'Description must be at most 5,000 characters').trim().optional().default(''),
  type: z.enum(CHALLENGE_TYPES).default('general'),
  difficulty: z.enum(CHALLENGE_DIFFICULTIES).default('medium'),
  points: z.coerce
    .number()
    .int('Points must be a whole number')
    .min(0, 'Points cannot be negative')
    .max(1000, 'Points must be 1,000 or fewer')
    .default(10),
  bonus_points: z.coerce
    .number()
    .int('Bonus points must be a whole number')
    .min(0, 'Bonus points cannot be negative')
    .max(500, 'Bonus points must be 500 or fewer')
    .default(0),
  badge_id: z.string().uuid().nullable().optional(),
  max_claims: z.coerce
    .number()
    .int('Max claims must be a whole number')
    .min(1, 'Max claims must be at least 1')
    .max(500, 'Max claims must be 500 or fewer')
    .nullable()
    .optional(),
  due_at: z.string().nullable().optional(),
  // Skills this challenge builds — approving a claim folds a gentle mastery
  // signal into each (Slice A). Optional; empty = challenge not skill-linked.
  skill_ids: z.array(z.string().uuid()).max(20, 'Link at most 20 skills').optional().default([]),
})

export const updateChallengeSchema = createChallengeSchema.partial()

export type CreateChallengeInput = z.infer<typeof createChallengeSchema>
export type UpdateChallengeInput = z.infer<typeof updateChallengeSchema>

// ── Review Schema ──────────────────────────────────────────────

export const reviewClaimSchema = z.object({
  status: z.enum(['approved', 'rejected']),
  reviewer_note: z.string().max(2000, 'Note must be at most 2,000 characters').trim().optional().default(''),
})

export type ReviewClaimInput = z.infer<typeof reviewClaimSchema>

// ── Student Submission Schema ──────────────────────────────────

export const submitSolutionSchema = z.object({
  submission_type: z.enum(SUBMISSION_TYPES),
  content: z.string().max(10000, 'Content must be at most 10,000 characters').trim().optional().default(''),
  /* .url() alone is not enough: `javascript:alert(1)` IS a syntactically valid URL, so
     Zod accepted it, it was stored, and it rendered as a real anchor on both the
     student's My Claims board and the professor's review panel (#700). The only thing
     preventing execution was React 19's own href guard — a framework behaviour the app
     doesn't control and wouldn't keep on any other render path (an export, an email, a
     PDF, a server-rendered link). Scheme refine copied verbatim from
     validations/announcement.ts, which had the same hole closed earlier. */
  url: z
    .string()
    .url('Must be a valid URL')
    .refine((u) => /^https?:\/\//i.test(u), 'Link must start with http:// or https://')
    .optional()
    .or(z.literal('')),
  file_url: z.string().optional(),
  file_path: z.string().optional(),
  file_name: z.string().optional(),
  file_size: z.number().optional(),
})

export type SubmitSolutionInput = z.infer<typeof submitSolutionSchema>

// ── Student Proposal Schema ────────────────────────────────────

export const proposeChallengeSchema = z.object({
  title: z.string().min(1, 'Title is required').max(200).trim(),
  description: z.string().max(5000).trim().optional().default(''),
  type: z.enum(CHALLENGE_TYPES).default('general'),
  difficulty: z.enum(CHALLENGE_DIFFICULTIES).default('medium'),
  points: z.coerce
    .number()
    .int('Points must be a whole number')
    .min(0, 'Points cannot be negative')
    .max(1000, 'Points must be 1,000 or fewer')
    .default(10),
})

export type ProposeChallengeInput = z.infer<typeof proposeChallengeSchema>

// ── Badge Schemas ──────────────────────────────────────────────

export const createBadgeSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100).trim(),
  description: z.string().max(500).trim().optional().default(''),
  icon: z.string().max(10).default('🏆'),
})

export const awardBadgeSchema = z.object({
  badge_id: z.string().uuid(),
  user_id: z.string().uuid(),
  reason: z.string().max(500).trim().optional().default(''),
})

export type CreateBadgeInput = z.infer<typeof createBadgeSchema>
export type AwardBadgeInput = z.infer<typeof awardBadgeSchema>
