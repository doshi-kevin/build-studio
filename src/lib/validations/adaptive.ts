// Adaptive quiz validation schemas — schemas specific to adaptive quiz
// server action inputs (cohort overrides, answer submission, settings).

import { z } from 'zod'
import { COHORT_TYPES } from './quiz'

// ── Behavioral Signals (sent with each adaptive answer) ──────

export const behavioralSignalsSchema = z.object({
  optionChanges: z.number().int().min(0).default(0),
  tabSwitches: z.number().int().min(0).default(0),
  copyAttempts: z.number().int().min(0).default(0),
})
export type BehavioralSignals = z.infer<typeof behavioralSignalsSchema>

// ── Submit Adaptive Answer ───────────────────────────────────

export const submitAdaptiveAnswerSchema = z.object({
  // Answer data
  selectedChoiceIds: z.array(z.string()).optional(),
  booleanAnswer: z.boolean().optional(),
  textAnswer: z.string().optional(),
  blankAnswers: z.record(z.string(), z.string()).optional(),
  timeSpentSeconds: z.number().int().min(0).default(0),
  // Behavioral signals (for Elo penalty calculation)
  optionChanges: z.number().int().min(0).default(0),
  tabSwitches: z.number().int().min(0).default(0),
  copyAttempts: z.number().int().min(0).default(0),
})
export type SubmitAdaptiveAnswerInput = z.infer<typeof submitAdaptiveAnswerSchema>

// ── Adaptive Answer Response ─────────────────────────────────

export interface AdaptiveAnswerResult {
  /** The graded result for the submitted question */
  questionResult: {
    isCorrect: boolean
    earnedPoints: number
  }
  /** Updated Elo rating after this question */
  currentRating: number
  /** Rating change from this question */
  ratingChange: number
  /** Next question data (null if quiz complete) */
  nextQuestion: {
    id: string
    questionText: string
    content: unknown
    difficulty: string
    points: number
    imageUrl: string | null
    imagePath: string | null
    codeSnippet: { language: string; code: string } | null
  } | null
  /** Whether the quiz is complete */
  isComplete: boolean
  /** Current question index (0-based) */
  questionIndex: number
  /** Total questions for this attempt */
  totalQuestions: number
}

// ── Cohort Override ──────────────────────────────────────────

export const cohortOverrideSchema = z.object({
  studentId: z.string().uuid(),
  cohort: z.enum(COHORT_TYPES),
})
export type CohortOverrideInput = z.infer<typeof cohortOverrideSchema>

// ── Adaptive Settings (professor configuration) ──────────────

export const adaptiveSettingsSchema = z.object({
  adaptiveMode: z.boolean(),
  adaptiveRatio: z.number().int().min(0).max(100).default(60),
  adaptiveQuestionCount: z.number().int().min(1).max(100).default(10),
  controlDistribution: z.object({
    easy: z.number().int().min(0),
    medium: z.number().int().min(0),
    hard: z.number().int().min(0),
  }).default({ easy: 3, medium: 3, hard: 4 }),
})
export type AdaptiveSettingsInput = z.infer<typeof adaptiveSettingsSchema>

// ── Integrity Flag Levels ────────────────────────────────────

export const INTEGRITY_FLAG_LEVELS = ['HIGH', 'MEDIUM', 'LOW'] as const
export type IntegrityFlagLevel = (typeof INTEGRITY_FLAG_LEVELS)[number]

export interface IntegrityFlag {
  studentId: string
  studentName: string
  level: IntegrityFlagLevel
  totalTabSwitches: number
  totalCopyAttempts: number
  totalOptionChanges: number
  /** From Scholera's ProctoringSummary (if available) */
  proctoringFlags: string[]
}

// ── Adaptive Analytics ───────────────────────────────────────

export interface CohortStats {
  count: number
  avgScore: number
  maxScore: number
  minScore: number
  avgRating: number
  maxRating: number
  minRating: number
}

export interface BehavioralStats {
  avgTimeTaken: number
  avgOptionChanges: number
  avgTabSwitches: number
  avgCopyAttempts: number
  accuracy: number
}

export interface DifficultyPerformance {
  difficulty: string
  totalAttempts: number
  correctCount: number
  accuracy: number
  avgTime: number
}

export interface AdaptiveAnalytics {
  quizId: string
  totalAttempts: number
  adaptive: CohortStats
  control: CohortStats
  adaptiveBehavior: BehavioralStats
  controlBehavior: BehavioralStats
  difficultyPerformance: DifficultyPerformance[]
  integrityFlags: IntegrityFlag[]
  topPerformers: {
    studentId: string
    studentName: string
    finalRating: number
    score: number
  }[]
}
