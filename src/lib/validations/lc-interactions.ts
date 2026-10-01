// Validation schemas for the unified Live Classroom interactions model.
// One row in lc_interactions covers polls, quizzes, and Q&A questions —
// the shape of `payload` varies by `kind`.

import { z } from 'zod'

export const INTERACTION_KINDS = ['poll', 'quiz', 'question'] as const
export type InteractionKind = (typeof INTERACTION_KINDS)[number]

export const INTERACTION_STATUSES = ['draft', 'open', 'closed'] as const
export type InteractionStatus = (typeof INTERACTION_STATUSES)[number]

// ── Poll payload ─────────────────────────────────────────────────────

export const pollChoiceSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1).max(500),
})

export const pollPayloadSchema = z.object({
  question: z.string().min(1).max(1000),
  pollType: z.enum(['single_choice', 'multiple_choice', 'word_cloud']).default('single_choice'),
  choices: z.array(pollChoiceSchema).min(2).max(10).optional(),
})

// ── Quiz payload ─────────────────────────────────────────────────────

export const quizQuestionSchema = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1).max(1000),
  choices: z.array(pollChoiceSchema).min(2).max(6),
  correctChoiceId: z.string().min(1),
  // Human-readable concept this question assesses — the label the live-quiz
  // report / concept-analytics group by (falls back to "General" when absent).
  // AI quizzes set it directly; manual authoring derives it from the tagged
  // skill. Independent of `skillIds`, which is the machine mastery link.
  concept: z.string().max(200).optional(),
  // Optional reasoning shown to students AFTER the quiz closes (manual quizzes;
  // AI quizzes insert their own explanation directly, bypassing this schema).
  explanation: z.string().max(2000).optional(),
  // Section skill(s) this question assesses — the skill-mastery link, and the
  // source the reconcile pass reads to populate activity_skills(live_quiz) for
  // coverage. AI generation maps the question's concept onto the section skill
  // pool; manual authoring lets the professor pick. Empty/absent → the recompute
  // engine falls back to name-matching the quiz title. Skill ids are validated
  // against the section pool server-side before use, so a stale id scores nothing.
  skillIds: z.array(z.string().uuid()).max(20).optional(),
})

export const quizPayloadSchema = z.object({
  title: z.string().min(1).max(200),
  questions: z.array(quizQuestionSchema).min(1).max(20),
  timeLimitSeconds: z.number().int().min(10).max(600).default(60),
  // When true, each student sees the correct answers + reasoning the moment
  // they submit (immediate feedback), instead of waiting for the professor to
  // close the quiz. Default off to preserve anti-cheat on graded checks.
  revealAnswers: z.boolean().default(false),
})

// ── Question (Q&A) payload ───────────────────────────────────────────

export const questionPayloadSchema = z.object({
  text: z.string().min(1).max(1000),
  anonymous: z.boolean().default(false),
  upvotes: z.number().int().nonnegative().default(0),
  upvotedBy: z.array(z.string().uuid()).default([]),
  answered: z.boolean().default(false),
  answeredBy: z.string().uuid().nullable().default(null),
  // The professor's written answer (replyToQuestion). Absent until they reply;
  // replying again overwrites it, so there is one instructor answer per question.
  reply: z.string().max(1000).optional(),
  replyAuthorName: z.string().max(200).optional(),
  repliedAt: z.string().optional(),
})

// ── Discriminated unions on `kind` ───────────────────────────────────

export const createInteractionSchema = z.discriminatedUnion('kind', [
  z.object({
    roomId: z.string().uuid(),
    kind: z.literal('poll'),
    payload: pollPayloadSchema,
  }),
  z.object({
    roomId: z.string().uuid(),
    kind: z.literal('quiz'),
    payload: quizPayloadSchema,
  }),
])
export type CreateInteractionInput = z.infer<typeof createInteractionSchema>

export const openInteractionSchema = z.object({
  interactionId: z.string().uuid(),
})
export type OpenInteractionInput = z.infer<typeof openInteractionSchema>

export const closeInteractionSchema = z.object({
  interactionId: z.string().uuid(),
})
export type CloseInteractionInput = z.infer<typeof closeInteractionSchema>

export const deleteInteractionSchema = z.object({
  interactionId: z.string().uuid(),
})
export type DeleteInteractionInput = z.infer<typeof deleteInteractionSchema>

export const listPreparedInteractionsSchema = z.object({
  roomId: z.string().uuid(),
})
export type ListPreparedInteractionsInput = z.infer<typeof listPreparedInteractionsSchema>

export const listReusableInteractionsSchema = z.object({
  roomId: z.string().uuid(),
})
export type ListReusableInteractionsInput = z.infer<typeof listReusableInteractionsSchema>

// Response shapes per interaction kind.
export const pollResponseSchema = z.object({
  choiceIds: z.array(z.string().min(1)).min(1).max(10).optional(),
  text: z.string().min(1).max(500).optional(),
}).refine((d) => !!d.choiceIds || !!d.text, {
  message: 'Poll response must include choiceIds or text',
})

export const quizResponseSchema = z.object({
  answers: z.record(z.string().min(1), z.string().min(1)),
})

export const submitResponseSchema = z.object({
  interactionId: z.string().uuid(),
  response: z.union([pollResponseSchema, quizResponseSchema]),
})
export type SubmitResponseInput = z.infer<typeof submitResponseSchema>

export const askQuestionSchema = z.object({
  roomId: z.string().uuid(),
  text: z.string().min(1).max(1000),
  anonymous: z.boolean().default(false),
})
export type AskQuestionInput = z.infer<typeof askQuestionSchema>

export const upvoteQuestionSchema = z.object({
  interactionId: z.string().uuid(),
})
export type UpvoteQuestionInput = z.infer<typeof upvoteQuestionSchema>

export const markAnsweredSchema = z.object({
  interactionId: z.string().uuid(),
})
export type MarkAnsweredInput = z.infer<typeof markAnsweredSchema>

export const replyToQuestionSchema = z.object({
  interactionId: z.string().uuid(),
  text: z.string().trim().min(1).max(1000),
})
export type ReplyToQuestionInput = z.infer<typeof replyToQuestionSchema>
