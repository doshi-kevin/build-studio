/**
 * Draft schemas for the professor AI assistant tools.
 *
 * These define the shape the MODEL fills when it calls a draft tool. They are
 * intentionally simpler than the strict server-action input schemas in
 * `src/lib/validations/*` — the approve actions (see
 * `src/components/professor/assistant/actions.ts`) translate a draft into the
 * exact action input (adding ids, enums, status:'draft', is_published:false).
 * Keeping the model's contract simple + translating server-side means the model
 * can never produce something the stricter server schema rejects (schema-drift
 * guard). Approve actions re-validate via the real action schemas regardless.
 */

import { z } from 'zod'

// ── draft_announcement ───────────────────────────────────────

export const announcementDraftSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(8000).describe('The announcement body, in the professor\'s tone.'),
})
export type AnnouncementDraft = z.infer<typeof announcementDraftSchema>

// ── draft_reply ──────────────────────────────────────────────

export const replyDraftSchema = z.object({
  studentQuestion: z
    .string()
    .max(4000)
    .optional()
    .describe(
      "The student's ACTUAL message being answered, verbatim, ONLY if the professor provided one. Leave empty for a proactive message the professor initiates (a check-in, outreach, reminder) — there is nothing being replied to. Never put your own reasoning, summary, or framing here.",
    ),
  reply: z.string().min(1).max(4000).describe('The drafted reply, ready for the professor to review and post.'),
})
export type ReplyDraft = z.infer<typeof replyDraftSchema>

// ── draft_module_outline ─────────────────────────────────────

export const moduleItemDraftSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(1500).optional().describe('What this item covers / the talking points.'),
})

export const moduleDraftSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  weekNumber: z.number().int().min(0).max(52).optional(),
  items: z.array(moduleItemDraftSchema).max(20).default([]).describe('Ordered outline items (sub-topics / activities).'),
})
export type ModuleDraft = z.infer<typeof moduleDraftSchema>

// ── draft_discussion ─────────────────────────────────────────
// Ungraded, open-ended discussion prompts — NO answer keys, NO points. A
// distinct artifact from a quiz; posts to a discussion channel for students to
// respond to.

export const discussionDraftSchema = z.object({
  title: z.string().min(1).max(200).describe('Short title for the discussion thread.'),
  prompt: z.string().max(2000).optional().describe('Optional 1–2 sentence framing shown before the questions.'),
  questions: z
    .array(z.string().min(1).max(1000))
    .min(1)
    .max(10)
    .describe('Open-ended discussion questions. No answer keys, no points — these are never auto-graded.'),
})
export type DiscussionDraft = z.infer<typeof discussionDraftSchema>

// ── draft_project ────────────────────────────────────────────
// A course project students complete (individually or in teams). Created in the
// course Projects area on approval — distinct from a lesson plan (module).

export const projectDraftSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional().describe('The project brief shown to students — what it is and why.'),
  guidelines: z
    .string()
    .max(10000)
    .optional()
    .describe('Deliverables, requirements, milestones, and grading expectations.'),
  maxTeamSize: z.number().int().min(1).max(20).default(5).describe('Team size; use 1 for an individual project.'),
  dueDate: z.string().optional().describe('Due date as YYYY-MM-DD, only if the professor gave one.'),
})
export type ProjectDraft = z.infer<typeof projectDraftSchema>

// ── draft_assignment ─────────────────────────────────────────
// An individual student deliverable submitted as written text and/or a file
// upload — a title, instructions, points, an optional due date, and which file
// types are accepted. Distinct from a scored quiz (Q&A with keys, built in the
// Quiz Studio) and
// draft_project (a larger, often team-built deliverable with milestones).
// Created as an UNPUBLISHED assignment on approval via the existing
// createAssignment action. The file-type kinds mirror FILE_TYPE_KINDS in
// src/lib/validations/assignment.ts; the approve action re-validates against
// that strict schema, so an unknown kind is rejected server-side regardless.

export const ASSIGNMENT_FILE_TYPES = ['pdf', 'image', 'doc', 'ppt', 'txt', 'zip'] as const

export const assignmentDraftSchema = z.object({
  title: z.string().min(1).max(200),
  instructions: z
    .string()
    .max(20000)
    .optional()
    .describe('The full prompt/instructions shown to students — what to do and how it is assessed.'),
  dueDate: z.string().optional().describe('Due date as YYYY-MM-DD, only if the professor gave one.'),
  points: z.number().int().min(0).max(1000).default(100).describe('Total points the assignment is worth.'),
  fileTypes: z
    .array(z.enum(ASSIGNMENT_FILE_TYPES))
    .default([])
    .describe(
      'Accepted upload file types (pdf, image, doc, ppt, txt, zip). Leave EMPTY for a written/text-box submission.',
    ),
})
export type AssignmentDraft = z.infer<typeof assignmentDraftSchema>

// ── draft_challenge ──────────────────────────────────────────
// A gamified, points-bearing task on the course Challenge Board. Created as a
// DRAFT (visibility:'draft') on approval; the professor publishes via the UI.
// Note: badge_id is intentionally absent — the model cannot know real badge
// UUIDs; the professor links a badge in the Challenge Board after creation.

export const challengeDraftSchema = z.object({
  title: z.string().min(1).max(200),
  description: z
    .string()
    .max(5000)
    .optional()
    .describe('What the student must do to complete the challenge, and how it counts.'),
  type: z
    .enum(['general', 'coding', 'puzzle', 'research', 'creative', 'discussion'])
    .default('general')
    .describe('The kind of challenge — pick the closest fit to the task.'),
  difficulty: z
    .enum(['easy', 'medium', 'hard', 'expert'])
    .default('medium')
    .describe('Challenge difficulty. Note: challenges support an "expert" tier (quizzes do not).'),
  points: z.number().int().min(0).max(1000).default(10).describe('Base points awarded on approval of a claim.'),
  bonusPoints: z.number().int().min(0).max(500).default(0).describe('Optional extra points for an exceptional submission.'),
  maxClaims: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe('Cap on how many students may claim it (omit for unlimited).'),
  dueDate: z.string().optional().describe('Due date as YYYY-MM-DD, only if the professor gave one.'),
})
export type ChallengeDraft = z.infer<typeof challengeDraftSchema>

// ── draft_rubric ─────────────────────────────────────────────
// A grading rubric (criteria × performance levels). On approval it is appended
// to a professor-selected quiz or project (it has no standalone home). NO score
// is ever assigned to a student — this only defines how work WOULD be graded.

export const rubricLevelDraftSchema = z.object({
  label: z.string().min(1).max(100).describe('Level name, e.g. "Excellent", "Proficient", "Developing".'),
  points: z.number().min(0).max(1000).describe('Points/weight for this level on this criterion.'),
  description: z.string().max(1000).describe('What work at this level looks like.'),
})

export const rubricCriterionDraftSchema = z.object({
  name: z.string().min(1).max(200).describe('The criterion being assessed, e.g. "Thesis & argument".'),
  description: z.string().max(1000).optional().describe('Optional one-line clarification of the criterion.'),
  levels: z.array(rubricLevelDraftSchema).min(2).max(6).describe('Performance levels for this criterion, best → worst.'),
})

export const rubricDraftSchema = z.object({
  title: z.string().min(1).max(200).describe('Rubric title, e.g. "Essay Rubric".'),
  criteria: z.array(rubricCriterionDraftSchema).min(1).max(12).describe('The rows of the rubric.'),
})
export type RubricDraft = z.infer<typeof rubricDraftSchema>

// ── draft_feedback ───────────────────────────────────────────
// Qualitative, encouraging feedback for ONE student, grounded in their
// performance. Delivered via the reply path on approval. There is NO score
// field — Athena never assigns or suggests a grade; the professor grades.

export const feedbackDraftSchema = z.object({
  studentName: z
    .string()
    .max(200)
    .optional()
    .describe('Who the feedback is for (context/label only; not posted as a header).'),
  feedback: z
    .string()
    .min(1)
    .max(4000)
    .describe('The qualitative feedback — strengths, specific next steps. NO numeric or letter grade.'),
})
export type FeedbackDraft = z.infer<typeof feedbackDraftSchema>

// ── draft_differentiated_version ─────────────────────────────
// An alternate version of a piece of content — simplified, ELL/multilingual-
// accessible, or extended/advanced — for scaffolding/accessibility (NOT K-12
// "grade levels"). Saved as a DRAFT announcement on approval.

export const differentiatedDraftSchema = z.object({
  title: z.string().min(1).max(200).describe('Title for the alternate version.'),
  variant: z
    .enum(['simplified', 'ell', 'advanced'])
    .optional()
    .describe('simplified → plainer language/shorter; ell → multilingual/ESL-accessible; advanced → extended depth.'),
  content: z.string().min(1).max(8000).describe('The rewritten content for this version.'),
})
export type DifferentiatedDraft = z.infer<typeof differentiatedDraftSchema>
