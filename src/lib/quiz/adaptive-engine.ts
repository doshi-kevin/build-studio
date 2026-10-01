// Adaptive Quiz Engine — pure functions for Elo rating, cohort assignment,
// difficulty selection, and adaptive question picking.
// Ported from SkillSignal-AI/quiz/adaptive_logic.py.

import { createHash } from 'crypto'
import type { DifficultyLevel } from '@/lib/validations/quiz'
import { shuffleArray } from './utils'

// ── Types ────────────────────────────────────────────────────

export interface EloUpdateParams {
  userRating: number
  questionRating: number
  isCorrect: boolean
  timeTaken: number      // seconds
  expectedTime: number   // seconds
  optionChanges: number
  tabSwitches: number
  copyAttempts: number
  kFactor?: number       // default 32
}

export interface EloUpdateResult {
  newRating: number
  ratingChange: number
  expectedScore: number
  actualScoreAdjusted: number
  penaltyApplied: number
  bonusApplied: boolean
}

export interface DifficultySelectParams {
  currentRating: number
  isCorrect: boolean
  timeTaken: number
  expectedTime: number
  optionChanges: number
  tabSwitches: number
}

export interface AdaptiveQuestion {
  id: string
  difficulty: DifficultyLevel
  eloRating: number
}

export interface AdaptiveSelectionParams {
  availableQuestions: AdaptiveQuestion[]
  answeredIds: string[]
  currentRating: number
  lastEvent?: {
    isCorrect: boolean
    timeTaken: number
    expectedTime: number
    optionChanges: number
    tabSwitches: number
  } | null
}

export interface ControlDistribution {
  easy: number
  medium: number
  hard: number
}

export interface ControlSelectionParams {
  allQuestions: AdaptiveQuestion[]
  distribution: ControlDistribution
}

// ── Constants ────────────────────────────────────────────────

const MIN_RATING = 800
const MAX_RATING = 2400
const DEFAULT_K_FACTOR = 32
const DEFAULT_START_RATING = 1200

// Rating thresholds for base difficulty
const EASY_THRESHOLD = 1100
const HARD_THRESHOLD = 1300

// Behavioral penalty thresholds
const TIME_SEVERE_MULTIPLIER = 2.0
const TIME_MODERATE_MULTIPLIER = 1.5
const TIME_SEVERE_PENALTY = 0.15
const TIME_MODERATE_PENALTY = 0.08

const OPTION_CHANGES_SEVERE = 4
const OPTION_CHANGES_MODERATE = 2
const OPTION_CHANGES_SEVERE_PENALTY = 0.12
const OPTION_CHANGES_MODERATE_PENALTY = 0.06

const TAB_SWITCHES_SEVERE = 3
const TAB_SWITCHES_MODERATE = 1
const TAB_SWITCHES_SEVERE_PENALTY = 0.20
const TAB_SWITCHES_MODERATE_PENALTY = 0.10

const COPY_ATTEMPTS_PENALTY = 0.25

const SPEED_BONUS_THRESHOLD = 0.7
const SPEED_BONUS = 0.15

export { DEFAULT_START_RATING, MIN_RATING, MAX_RATING }

// ── Cohort Assignment ────────────────────────────────────────

/**
 * Deterministic cohort assignment using MD5 hash of (studentId, sectionId).
 * Same student + section always produces the same cohort.
 */
export function assignCohort(
  studentId: string,
  sectionId: string,
  adaptiveRatio: number = 60,
): 'adaptive' | 'control' {
  const hashInput = `${studentId}-${sectionId}`
  const hash = createHash('md5').update(hashInput).digest('hex')
  // Take first 8 hex chars → integer, mod 100
  const hashValue = parseInt(hash.slice(0, 8), 16)
  return (hashValue % 100) < adaptiveRatio ? 'adaptive' : 'control'
}

// ── Elo Rating Calculation ───────────────────────────────────

/**
 * Calculate new Elo rating after a question attempt, applying behavioral
 * penalties for tab switches, copy attempts, slow time, and answer changes.
 * Direct port of SkillSignal's calculate_elo_update().
 */
export function calculateEloUpdate(params: EloUpdateParams): EloUpdateResult {
  const {
    userRating,
    questionRating,
    isCorrect,
    timeTaken,
    expectedTime,
    optionChanges,
    tabSwitches,
    copyAttempts,
    kFactor = DEFAULT_K_FACTOR,
  } = params

  // Expected score using Elo formula
  const expectedScore = 1.0 / (1.0 + Math.pow(10, (questionRating - userRating) / 400.0))

  // Base actual score
  let actualScore = isCorrect ? 1.0 : 0.0

  // Calculate behavioral penalty
  let penalty = 0.0

  // Time penalty: taking too long suggests guessing or struggling
  if (timeTaken > expectedTime * TIME_SEVERE_MULTIPLIER) {
    penalty += TIME_SEVERE_PENALTY
  } else if (timeTaken > expectedTime * TIME_MODERATE_MULTIPLIER) {
    penalty += TIME_MODERATE_PENALTY
  }

  // Option changes penalty: indicates uncertainty
  if (optionChanges >= OPTION_CHANGES_SEVERE) {
    penalty += OPTION_CHANGES_SEVERE_PENALTY
  } else if (optionChanges >= OPTION_CHANGES_MODERATE) {
    penalty += OPTION_CHANGES_MODERATE_PENALTY
  }

  // Tab switching penalty: academic integrity concern
  if (tabSwitches >= TAB_SWITCHES_SEVERE) {
    penalty += TAB_SWITCHES_SEVERE_PENALTY
  } else if (tabSwitches >= TAB_SWITCHES_MODERATE) {
    penalty += TAB_SWITCHES_MODERATE_PENALTY
  }

  // Copy attempt penalty: academic integrity violation
  if (copyAttempts >= 1) {
    penalty += COPY_ATTEMPTS_PENALTY
  }

  // Bonus for speed and confidence (only if correct)
  let bonusApplied = false
  if (isCorrect && timeTaken < expectedTime * SPEED_BONUS_THRESHOLD && optionChanges === 0) {
    actualScore = Math.min(1.2, actualScore + SPEED_BONUS)
    bonusApplied = true
  }

  // Apply penalties (clamp between 0 and max — max is 1.2 if bonus applied, else 1.0)
  const maxScore = bonusApplied ? 1.2 : 1.0
  const actualScoreAdjusted = Math.max(0.0, Math.min(maxScore, actualScore - penalty))

  // Calculate rating change
  const ratingChange = kFactor * (actualScoreAdjusted - expectedScore)
  const newRating = clampRating(Math.round(userRating + ratingChange))

  return {
    newRating,
    ratingChange: newRating - userRating,
    expectedScore,
    actualScoreAdjusted,
    penaltyApplied: penalty,
    bonusApplied,
  }
}

// ── Difficulty Selection ─────────────────────────────────────

/**
 * Determine next question difficulty based on current Elo rating and
 * performance on the last question (time, correctness, behavior).
 */
export function selectNextDifficulty(params: DifficultySelectParams): DifficultyLevel {
  const { currentRating, isCorrect, timeTaken, expectedTime, optionChanges, tabSwitches } = params

  const timeRatio = timeTaken / Math.max(expectedTime, 1)

  // Base difficulty from rating ranges
  let baseDifficulty: DifficultyLevel
  if (currentRating < EASY_THRESHOLD) {
    baseDifficulty = 'easy'
  } else if (currentRating < HARD_THRESHOLD) {
    baseDifficulty = 'medium'
  } else {
    baseDifficulty = 'hard'
  }

  if (isCorrect) {
    // Fast, confident, clean answer → step up
    if (timeRatio < 0.8 && optionChanges === 0 && tabSwitches === 0) {
      return stepUpDifficulty(baseDifficulty)
    }
    // Correct but slow/uncertain → stay at current level
    return baseDifficulty
  }

  // Incorrect → step down
  return stepDownDifficulty(baseDifficulty)
}

// ── Adaptive Question Selection ──────────────────────────────

/**
 * Select the next question for an adaptive cohort student.
 * First question is always medium. Subsequent questions are chosen
 * based on Elo rating and performance via selectNextDifficulty().
 * Returns question ID or null if pool exhausted.
 */
export function selectAdaptiveQuestion(params: AdaptiveSelectionParams): string | null {
  const { availableQuestions, answeredIds, currentRating, lastEvent } = params

  // Exclude already-answered questions
  const answeredSet = new Set(answeredIds)
  const pool = availableQuestions.filter(q => !answeredSet.has(q.id))

  if (pool.length === 0) return null

  // First question → medium difficulty
  if (!lastEvent) {
    return pickFromDifficultyPool(pool, 'medium')
  }

  // Determine desired difficulty from last performance
  const desiredDifficulty = selectNextDifficulty({
    currentRating,
    isCorrect: lastEvent.isCorrect,
    timeTaken: lastEvent.timeTaken,
    expectedTime: lastEvent.expectedTime,
    optionChanges: lastEvent.optionChanges,
    tabSwitches: lastEvent.tabSwitches,
  })

  return pickFromDifficultyPool(pool, desiredDifficulty)
}

// ── Control Group Question Selection ─────────────────────────

/**
 * Select questions for a control cohort student with a fixed
 * difficulty distribution (e.g., 3 easy, 3 medium, 4 hard).
 * Returns shuffled array of question IDs.
 */
export function selectControlQuestions(params: ControlSelectionParams): string[] {
  const { allQuestions, distribution } = params
  const selected: string[] = []

  const byDifficulty = groupByDifficulty(allQuestions)

  // Pick from each difficulty level
  for (const [difficulty, count] of Object.entries(distribution) as [DifficultyLevel, number][]) {
    const pool = byDifficulty[difficulty] || []
    const shuffled = shuffleArray([...pool])
    selected.push(...shuffled.slice(0, count).map(q => q.id))
  }

  return shuffleArray(selected)
}

// ── Helpers ──────────────────────────────────────────────────

function clampRating(rating: number): number {
  return Math.max(MIN_RATING, Math.min(MAX_RATING, rating))
}

function stepUpDifficulty(d: DifficultyLevel): DifficultyLevel {
  if (d === 'easy') return 'medium'
  return 'hard' // medium or hard → hard
}

function stepDownDifficulty(d: DifficultyLevel): DifficultyLevel {
  if (d === 'hard') return 'medium'
  return 'easy' // medium or easy → easy
}

function groupByDifficulty(questions: AdaptiveQuestion[]): Record<DifficultyLevel, AdaptiveQuestion[]> {
  const groups: Record<DifficultyLevel, AdaptiveQuestion[]> = { easy: [], medium: [], hard: [] }
  for (const q of questions) {
    groups[q.difficulty].push(q)
  }
  return groups
}

/**
 * Pick a random question from the pool matching the desired difficulty.
 * If the desired difficulty is exhausted, tries smart fallback order:
 *   easy → medium → hard
 *   hard → medium → easy
 *   medium → easy → hard
 */
function pickFromDifficultyPool(pool: AdaptiveQuestion[], desired: DifficultyLevel): string | null {
  const byDifficulty = groupByDifficulty(pool)

  // Try desired difficulty first
  if (byDifficulty[desired].length > 0) {
    const shuffled = shuffleArray([...byDifficulty[desired]])
    return shuffled[0].id
  }

  // Smart fallback order — prefer closer difficulties
  const fallbackOrder = getFallbackOrder(desired)
  for (const fallback of fallbackOrder) {
    if (byDifficulty[fallback].length > 0) {
      const shuffled = shuffleArray([...byDifficulty[fallback]])
      return shuffled[0].id
    }
  }

  return null
}

function getFallbackOrder(desired: DifficultyLevel): DifficultyLevel[] {
  switch (desired) {
    case 'easy': return ['medium', 'hard']
    case 'hard': return ['medium', 'easy']
    case 'medium': return ['easy', 'hard']
  }
}
