/**
 * Zod schema for the Verbal Assessment config persisted in
 * assignments.settings.verbalAssessment. Validated at the server-action boundary.
 */
import { z } from 'zod'

const optionSchema = z.object({
  id: z.string().min(1).max(64),
  text: z.string().max(500),
})

const cellSchema = z.object({
  id: z.string().min(1).max(64),
  type: z.enum(['greeting', 'question', 'mcq', 'ai_followup']),
  prompt: z.string().max(2000).default(''),
  answerType: z.enum(['short', 'long']).optional(),
  allowFollowUps: z.boolean().optional(),
  audioPath: z.string().max(500).optional(),
  options: z.array(optionSchema).max(10).optional(),
  correctOptionId: z.string().max(64).optional(),
  followUps: z
    .object({
      correct: z.string().max(2000).optional(),
      incorrect: z.string().max(2000).optional(),
    })
    .optional(),
})

export const verbalAssessmentSchema = z.object({
  version: z.number().int().default(2),
  topic: z.string().max(200).default(''),
  voiceId: z.string().min(1).max(64),
  maxFollowUpDepth: z.number().int().min(0).max(5).default(2),
  timeLimitMinutes: z.number().int().min(1).max(120).default(10),
  cells: z.array(cellSchema).max(50).default([]),
})

export type VerbalAssessmentInput = z.input<typeof verbalAssessmentSchema>

/** Parse the stored verbal config out of an assignment's settings JSON (null if absent/invalid). */
export function parseVerbalAssessment(settings: unknown): z.infer<typeof verbalAssessmentSchema> | null {
  const raw = (settings as Record<string, unknown> | null)?.verbalAssessment
  if (!raw) return null
  const parsed = verbalAssessmentSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/**
 * One student answer per cell, stored in assignment_submissions.answers. The recorded video
 * is the authoritative artifact; the transcript is convenience text from in-browser STT.
 */
export const verbalAnswerSchema = z.object({
  cellId: z.string().min(1).max(64),
  type: z.enum(['greeting', 'question', 'mcq', 'ai_followup']),
  prompt: z.string().max(2000).default(''),
  transcript: z.string().max(20000).default(''),
  selectedOptionId: z.string().max(64).optional(),
  selectedOptionText: z.string().max(500).optional(),
  /** Seconds from the start of the recording where this question began (for grading seek). */
  videoOffset: z.number().min(0).max(100000).optional(),
})

export const verbalSubmissionAnswersSchema = z.array(verbalAnswerSchema).max(100)

export type VerbalAnswer = z.infer<typeof verbalAnswerSchema>
