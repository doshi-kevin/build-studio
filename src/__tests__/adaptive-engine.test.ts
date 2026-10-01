// Tests for the adaptive quiz engine — Elo rating, cohort assignment,
// difficulty selection, and adaptive/control question picking.

import { describe, it, expect, vi } from 'vitest'

// Mock shuffleArray to return input unchanged for deterministic tests
vi.mock('@/lib/quiz/utils', () => ({
  shuffleArray: vi.fn(<T>(arr: T[]): T[] => arr),
}))

import {
  assignCohort,
  calculateEloUpdate,
  selectNextDifficulty,
  selectAdaptiveQuestion,
  selectControlQuestions,
  DEFAULT_START_RATING,
  MIN_RATING,
  MAX_RATING,
} from '@/lib/quiz/adaptive-engine'
import type { AdaptiveQuestion } from '@/lib/quiz/adaptive-engine'

// ── Helpers ───────────────────────────────────────────────────

function makeQuestion(id: string, difficulty: 'easy' | 'medium' | 'hard', eloRating = 1200): AdaptiveQuestion {
  return { id, difficulty, eloRating }
}

const baseEloParams = {
  userRating: 1200,
  questionRating: 1200,
  isCorrect: true,
  timeTaken: 30,
  expectedTime: 60,
  optionChanges: 0,
  tabSwitches: 0,
  copyAttempts: 0,
}

// ═════════════════════════════════════════════════════════════
// assignCohort
// ═════════════════════════════════════════════════════════════

describe('assignCohort', () => {
  it('returns adaptive or control (valid enum value)', () => {
    const result = assignCohort('student-1', 'section-1')
    expect(['adaptive', 'control']).toContain(result)
  })

  it('is deterministic — same inputs always produce same result', () => {
    const a = assignCohort('student-1', 'section-1')
    const b = assignCohort('student-1', 'section-1')
    expect(a).toBe(b)
  })

  it('different students can get different cohorts', () => {
    // With enough students, both cohorts should appear
    const results = new Set<string>()
    for (let i = 0; i < 100; i++) {
      results.add(assignCohort(`student-${i}`, 'section-1'))
    }
    expect(results.size).toBe(2)
  })

  it('adaptiveRatio=100 always returns adaptive', () => {
    for (let i = 0; i < 20; i++) {
      expect(assignCohort(`student-${i}`, 'section-1', 100)).toBe('adaptive')
    }
  })

  it('adaptiveRatio=0 always returns control', () => {
    for (let i = 0; i < 20; i++) {
      expect(assignCohort(`student-${i}`, 'section-1', 0)).toBe('control')
    }
  })

  it('default adaptiveRatio is 60', () => {
    // Just verify it works without explicit ratio
    const result = assignCohort('student-1', 'section-1')
    expect(['adaptive', 'control']).toContain(result)
  })
})

// ═════════════════════════════════════════════════════════════
// calculateEloUpdate
// ═════════════════════════════════════════════════════════════

describe('calculateEloUpdate', () => {
  describe('basic correct/incorrect', () => {
    it('increases rating for correct answer', () => {
      const result = calculateEloUpdate({ ...baseEloParams, isCorrect: true })
      expect(result.newRating).toBeGreaterThan(1200)
      expect(result.ratingChange).toBeGreaterThan(0)
    })

    it('decreases rating for incorrect answer', () => {
      const result = calculateEloUpdate({ ...baseEloParams, isCorrect: false })
      expect(result.newRating).toBeLessThan(1200)
      expect(result.ratingChange).toBeLessThan(0)
    })

    it('correct answer against equal-rated question has expectedScore ~0.5', () => {
      const result = calculateEloUpdate({ ...baseEloParams })
      expect(result.expectedScore).toBeCloseTo(0.5, 1)
    })

    it('correct answer against harder question gives bigger gain', () => {
      const easy = calculateEloUpdate({ ...baseEloParams, questionRating: 1000 })
      const hard = calculateEloUpdate({ ...baseEloParams, questionRating: 1400 })
      expect(hard.ratingChange).toBeGreaterThan(easy.ratingChange)
    })
  })

  describe('behavioral penalties', () => {
    it('applies severe time penalty (> 2x expected)', () => {
      const result = calculateEloUpdate({ ...baseEloParams, timeTaken: 130, expectedTime: 60 })
      expect(result.penaltyApplied).toBeCloseTo(0.15, 2)
    })

    it('applies moderate time penalty (1.5x-2x expected)', () => {
      const result = calculateEloUpdate({ ...baseEloParams, timeTaken: 100, expectedTime: 60 })
      expect(result.penaltyApplied).toBeCloseTo(0.08, 2)
    })

    it('no time penalty when under 1.5x', () => {
      const result = calculateEloUpdate({ ...baseEloParams, timeTaken: 80, expectedTime: 60 })
      expect(result.penaltyApplied).toBe(0)
    })

    it('applies severe option changes penalty (>= 4)', () => {
      const result = calculateEloUpdate({ ...baseEloParams, optionChanges: 4 })
      expect(result.penaltyApplied).toBeCloseTo(0.12, 2)
    })

    it('applies moderate option changes penalty (2-3)', () => {
      const result = calculateEloUpdate({ ...baseEloParams, optionChanges: 2 })
      expect(result.penaltyApplied).toBeCloseTo(0.06, 2)
    })

    it('no option changes penalty when < 2', () => {
      const result = calculateEloUpdate({ ...baseEloParams, optionChanges: 1 })
      expect(result.penaltyApplied).toBe(0)
    })

    it('applies severe tab switch penalty (>= 3)', () => {
      const result = calculateEloUpdate({ ...baseEloParams, tabSwitches: 3 })
      expect(result.penaltyApplied).toBeCloseTo(0.20, 2)
    })

    it('applies moderate tab switch penalty (1-2)', () => {
      const result = calculateEloUpdate({ ...baseEloParams, tabSwitches: 1 })
      expect(result.penaltyApplied).toBeCloseTo(0.10, 2)
    })

    it('applies copy attempt penalty', () => {
      const result = calculateEloUpdate({ ...baseEloParams, copyAttempts: 1 })
      expect(result.penaltyApplied).toBeCloseTo(0.25, 2)
    })

    it('stacks multiple penalties', () => {
      const result = calculateEloUpdate({
        ...baseEloParams,
        timeTaken: 130, expectedTime: 60,  // severe time: 0.15
        optionChanges: 4,                   // severe option: 0.12
        tabSwitches: 3,                     // severe tab: 0.20
        copyAttempts: 1,                    // copy: 0.25
      })
      expect(result.penaltyApplied).toBeCloseTo(0.72, 2)
    })
  })

  describe('speed bonus', () => {
    it('applies speed bonus for fast correct answer with no option changes', () => {
      const result = calculateEloUpdate({
        ...baseEloParams,
        isCorrect: true,
        timeTaken: 30,    // < 0.7 * 60 = 42
        expectedTime: 60,
        optionChanges: 0,
      })
      expect(result.bonusApplied).toBe(true)
    })

    it('no speed bonus when incorrect', () => {
      const result = calculateEloUpdate({
        ...baseEloParams,
        isCorrect: false,
        timeTaken: 30,
        expectedTime: 60,
        optionChanges: 0,
      })
      expect(result.bonusApplied).toBe(false)
    })

    it('no speed bonus when too slow', () => {
      const result = calculateEloUpdate({
        ...baseEloParams,
        isCorrect: true,
        timeTaken: 50,    // > 0.7 * 60 = 42
        expectedTime: 60,
        optionChanges: 0,
      })
      expect(result.bonusApplied).toBe(false)
    })

    it('no speed bonus when option changes > 0', () => {
      const result = calculateEloUpdate({
        ...baseEloParams,
        isCorrect: true,
        timeTaken: 30,
        expectedTime: 60,
        optionChanges: 1,
      })
      expect(result.bonusApplied).toBe(false)
    })
  })

  describe('rating clamping', () => {
    it('clamps rating at minimum (800)', () => {
      const result = calculateEloUpdate({
        ...baseEloParams,
        userRating: MIN_RATING,
        questionRating: 2000,
        isCorrect: false,
      })
      expect(result.newRating).toBeGreaterThanOrEqual(MIN_RATING)
    })

    it('clamps rating at maximum (2400)', () => {
      const result = calculateEloUpdate({
        ...baseEloParams,
        userRating: MAX_RATING,
        questionRating: 800,
        isCorrect: true,
      })
      expect(result.newRating).toBeLessThanOrEqual(MAX_RATING)
    })
  })

  describe('custom kFactor', () => {
    it('larger kFactor produces larger rating change', () => {
      const k16 = calculateEloUpdate({ ...baseEloParams, kFactor: 16 })
      const k64 = calculateEloUpdate({ ...baseEloParams, kFactor: 64 })
      expect(Math.abs(k64.ratingChange)).toBeGreaterThan(Math.abs(k16.ratingChange))
    })
  })

  describe('exported constants', () => {
    it('DEFAULT_START_RATING is 1200', () => {
      expect(DEFAULT_START_RATING).toBe(1200)
    })

    it('MIN_RATING is 800', () => {
      expect(MIN_RATING).toBe(800)
    })

    it('MAX_RATING is 2400', () => {
      expect(MAX_RATING).toBe(2400)
    })
  })
})

// ═════════════════════════════════════════════════════════════
// selectNextDifficulty
// ═════════════════════════════════════════════════════════════

describe('selectNextDifficulty', () => {
  const baseDiffParams = {
    currentRating: 1200,
    isCorrect: true,
    timeTaken: 30,
    expectedTime: 60,
    optionChanges: 0,
    tabSwitches: 0,
  }

  describe('base difficulty from rating', () => {
    it('rating < 1100 → easy base', () => {
      const result = selectNextDifficulty({ ...baseDiffParams, currentRating: 1000, isCorrect: false })
      expect(result).toBe('easy') // step down from easy stays easy
    })

    it('rating 1100-1299 → medium base', () => {
      // Incorrect → step down from medium → easy
      const result = selectNextDifficulty({ ...baseDiffParams, currentRating: 1200, isCorrect: false })
      expect(result).toBe('easy')
    })

    it('rating >= 1300 → hard base', () => {
      // Incorrect → step down from hard → medium
      const result = selectNextDifficulty({ ...baseDiffParams, currentRating: 1400, isCorrect: false })
      expect(result).toBe('medium')
    })
  })

  describe('correct answer adjustments', () => {
    it('fast + confident + clean → step up', () => {
      const result = selectNextDifficulty({
        ...baseDiffParams,
        currentRating: 1200, // medium base
        isCorrect: true,
        timeTaken: 30,       // ratio < 0.8
        expectedTime: 60,
        optionChanges: 0,
        tabSwitches: 0,
      })
      expect(result).toBe('hard') // stepped up from medium
    })

    it('correct but slow → stay at base', () => {
      const result = selectNextDifficulty({
        ...baseDiffParams,
        currentRating: 1200,
        isCorrect: true,
        timeTaken: 55,       // ratio 0.917 > 0.8
        expectedTime: 60,
      })
      expect(result).toBe('medium') // stays at base
    })

    it('correct but with option changes → stay at base', () => {
      const result = selectNextDifficulty({
        ...baseDiffParams,
        currentRating: 1200,
        isCorrect: true,
        timeTaken: 30,
        expectedTime: 60,
        optionChanges: 1,   // any changes → no step up
      })
      expect(result).toBe('medium')
    })

    it('correct but with tab switches → stay at base', () => {
      const result = selectNextDifficulty({
        ...baseDiffParams,
        currentRating: 1200,
        isCorrect: true,
        timeTaken: 30,
        expectedTime: 60,
        tabSwitches: 1,
      })
      expect(result).toBe('medium')
    })

    it('step up from hard stays hard', () => {
      const result = selectNextDifficulty({
        ...baseDiffParams,
        currentRating: 1400, // hard base
        isCorrect: true,
        timeTaken: 30,
        expectedTime: 60,
      })
      expect(result).toBe('hard')
    })

    it('step up from easy → medium', () => {
      const result = selectNextDifficulty({
        ...baseDiffParams,
        currentRating: 1000, // easy base
        isCorrect: true,
        timeTaken: 30,
        expectedTime: 60,
      })
      expect(result).toBe('medium')
    })
  })

  describe('incorrect answer adjustments', () => {
    it('incorrect → step down from medium → easy', () => {
      const result = selectNextDifficulty({
        ...baseDiffParams,
        currentRating: 1200,
        isCorrect: false,
      })
      expect(result).toBe('easy')
    })

    it('incorrect → step down from hard → medium', () => {
      const result = selectNextDifficulty({
        ...baseDiffParams,
        currentRating: 1400,
        isCorrect: false,
      })
      expect(result).toBe('medium')
    })

    it('incorrect → step down from easy stays easy', () => {
      const result = selectNextDifficulty({
        ...baseDiffParams,
        currentRating: 1000,
        isCorrect: false,
      })
      expect(result).toBe('easy')
    })
  })
})

// ═════════════════════════════════════════════════════════════
// selectAdaptiveQuestion
// ═════════════════════════════════════════════════════════════

describe('selectAdaptiveQuestion', () => {
  const questions: AdaptiveQuestion[] = [
    makeQuestion('e1', 'easy', 900),
    makeQuestion('e2', 'easy', 950),
    makeQuestion('m1', 'medium', 1200),
    makeQuestion('m2', 'medium', 1250),
    makeQuestion('h1', 'hard', 1500),
    makeQuestion('h2', 'hard', 1600),
  ]

  it('first question (no lastEvent) picks medium difficulty', () => {
    const result = selectAdaptiveQuestion({
      availableQuestions: questions,
      answeredIds: [],
      currentRating: 1200,
      lastEvent: null,
    })
    expect(result).toBe('m1') // first medium question (shuffleArray is identity)
  })

  it('skips already-answered questions', () => {
    const result = selectAdaptiveQuestion({
      availableQuestions: questions,
      answeredIds: ['m1'],
      currentRating: 1200,
      lastEvent: null,
    })
    expect(result).toBe('m2') // m1 skipped, next medium
  })

  it('returns null when pool exhausted', () => {
    const result = selectAdaptiveQuestion({
      availableQuestions: questions,
      answeredIds: ['e1', 'e2', 'm1', 'm2', 'h1', 'h2'],
      currentRating: 1200,
    })
    expect(result).toBeNull()
  })

  it('selects harder question after fast correct answer', () => {
    const result = selectAdaptiveQuestion({
      availableQuestions: questions,
      answeredIds: [],
      currentRating: 1200,
      lastEvent: {
        isCorrect: true,
        timeTaken: 30,
        expectedTime: 60,
        optionChanges: 0,
        tabSwitches: 0,
      },
    })
    // medium base + step up = hard → picks h1
    expect(result).toBe('h1')
  })

  it('selects easier question after incorrect answer', () => {
    const result = selectAdaptiveQuestion({
      availableQuestions: questions,
      answeredIds: [],
      currentRating: 1200,
      lastEvent: {
        isCorrect: false,
        timeTaken: 30,
        expectedTime: 60,
        optionChanges: 0,
        tabSwitches: 0,
      },
    })
    // medium base + step down = easy → picks e1
    expect(result).toBe('e1')
  })

  it('falls back to adjacent difficulty when desired is exhausted', () => {
    const result = selectAdaptiveQuestion({
      availableQuestions: questions,
      answeredIds: ['h1', 'h2'],     // all hard answered
      currentRating: 1200,
      lastEvent: {
        isCorrect: true,
        timeTaken: 30,
        expectedTime: 60,
        optionChanges: 0,
        tabSwitches: 0,
      },
    })
    // Wants hard but none available → falls back to medium → m1
    expect(result).toBe('m1')
  })

  it('handles only one difficulty available', () => {
    const easyOnly = [makeQuestion('e1', 'easy'), makeQuestion('e2', 'easy')]
    const result = selectAdaptiveQuestion({
      availableQuestions: easyOnly,
      answeredIds: [],
      currentRating: 1200,
      lastEvent: null, // wants medium, but only easy available → fallback
    })
    expect(result).toBe('e1')
  })
})

// ═════════════════════════════════════════════════════════════
// selectControlQuestions
// ═════════════════════════════════════════════════════════════

describe('selectControlQuestions', () => {
  const questions: AdaptiveQuestion[] = [
    makeQuestion('e1', 'easy'),
    makeQuestion('e2', 'easy'),
    makeQuestion('e3', 'easy'),
    makeQuestion('m1', 'medium'),
    makeQuestion('m2', 'medium'),
    makeQuestion('m3', 'medium'),
    makeQuestion('h1', 'hard'),
    makeQuestion('h2', 'hard'),
    makeQuestion('h3', 'hard'),
  ]

  it('selects correct number per difficulty', () => {
    const result = selectControlQuestions({
      allQuestions: questions,
      distribution: { easy: 2, medium: 2, hard: 1 },
    })
    expect(result).toHaveLength(5)
  })

  it('handles empty difficulty pool gracefully', () => {
    const easyOnly = [makeQuestion('e1', 'easy'), makeQuestion('e2', 'easy')]
    const result = selectControlQuestions({
      allQuestions: easyOnly,
      distribution: { easy: 2, medium: 2, hard: 1 },
    })
    // Can only pick 2 easy, 0 medium, 0 hard
    expect(result).toHaveLength(2)
  })

  it('handles requesting more than available', () => {
    const result = selectControlQuestions({
      allQuestions: questions,
      distribution: { easy: 5, medium: 5, hard: 5 },
    })
    // 3 easy + 3 medium + 3 hard = 9
    expect(result).toHaveLength(9)
  })

  it('returns question IDs (strings)', () => {
    const result = selectControlQuestions({
      allQuestions: questions,
      distribution: { easy: 1, medium: 1, hard: 1 },
    })
    for (const id of result) {
      expect(typeof id).toBe('string')
    }
  })

  it('distribution { easy: 0, medium: 0, hard: 0 } returns empty', () => {
    const result = selectControlQuestions({
      allQuestions: questions,
      distribution: { easy: 0, medium: 0, hard: 0 },
    })
    expect(result).toHaveLength(0)
  })
})
