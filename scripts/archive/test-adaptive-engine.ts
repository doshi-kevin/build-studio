/**
 * Internal test script for the adaptive quiz engine.
 * Run with: npx tsx scripts/test-adaptive-engine.ts
 *
 * Tests all pure functions: assignCohort, calculateEloUpdate,
 * selectNextDifficulty, selectAdaptiveQuestion, selectControlQuestions.
 */

import {
  assignCohort,
  calculateEloUpdate,
  selectNextDifficulty,
  selectAdaptiveQuestion,
  selectControlQuestions,
  DEFAULT_START_RATING,
  MIN_RATING,
  MAX_RATING,
} from '../../src/lib/quiz/adaptive-engine'
import type { AdaptiveQuestion } from '../../src/lib/quiz/adaptive-engine'

// ── Test Utilities ──────────────────────────────────────────

let passed = 0
let failed = 0
let total = 0

function assert(condition: boolean, message: string) {
  total++
  if (condition) {
    passed++
    console.log(`  ✓ ${message}`)
  } else {
    failed++
    console.log(`  ✗ FAIL: ${message}`)
  }
}

function assertApprox(actual: number, expected: number, tolerance: number, message: string) {
  assert(Math.abs(actual - expected) <= tolerance, `${message} (got ${actual}, expected ~${expected})`)
}

function section(name: string) {
  console.log(`\n── ${name} ──`)
}

// ── Mock Question Pool ──────────────────────────────────────

const mockQuestions: AdaptiveQuestion[] = [
  { id: 'e1', difficulty: 'easy', eloRating: 800 },
  { id: 'e2', difficulty: 'easy', eloRating: 850 },
  { id: 'e3', difficulty: 'easy', eloRating: 900 },
  { id: 'm1', difficulty: 'medium', eloRating: 1200 },
  { id: 'm2', difficulty: 'medium', eloRating: 1250 },
  { id: 'm3', difficulty: 'medium', eloRating: 1150 },
  { id: 'h1', difficulty: 'hard', eloRating: 1600 },
  { id: 'h2', difficulty: 'hard', eloRating: 1700 },
  { id: 'h3', difficulty: 'hard', eloRating: 1500 },
]

// ═══════════════════════════════════════════════════════════════
// TEST SUITE
// ═══════════════════════════════════════════════════════════════

section('1. Cohort Assignment')

// Test determinism — same inputs always produce same output
const cohort1a = assignCohort('student-abc', 'section-123', 60)
const cohort1b = assignCohort('student-abc', 'section-123', 60)
assert(cohort1a === cohort1b, 'Same inputs produce same cohort (deterministic)')

// Test different students get different cohorts (probabilistic, but with enough students we should see both)
const cohorts = new Set<string>()
for (let i = 0; i < 100; i++) {
  cohorts.add(assignCohort(`student-${i}`, 'section-test', 60))
}
assert(cohorts.has('adaptive') && cohorts.has('control'), '100 students split into both cohorts')

// Test ratio edge cases
const allAdaptive = Array.from({ length: 100 }, (_, i) =>
  assignCohort(`s-${i}`, 'sec-1', 100),
)
assert(allAdaptive.every(c => c === 'adaptive'), 'Ratio 100 → all adaptive')

const allControl = Array.from({ length: 100 }, (_, i) =>
  assignCohort(`s-${i}`, 'sec-1', 0),
)
assert(allControl.every(c => c === 'control'), 'Ratio 0 → all control')

// Test approximate distribution with 60/40 ratio
let adaptiveCount = 0
const sampleSize = 1000
for (let i = 0; i < sampleSize; i++) {
  if (assignCohort(`student-dist-${i}`, 'section-dist', 60) === 'adaptive') {
    adaptiveCount++
  }
}
const adaptivePercent = (adaptiveCount / sampleSize) * 100
assert(
  adaptivePercent >= 45 && adaptivePercent <= 75,
  `60/40 ratio produces ~60% adaptive (got ${adaptivePercent.toFixed(1)}%)`,
)

// Test different sections produce different cohorts for same student
const sectionCohorts = new Set<string>()
for (let i = 0; i < 50; i++) {
  sectionCohorts.add(assignCohort('same-student', `section-${i}`, 50))
}
assert(sectionCohorts.size === 2, 'Same student, different sections → both cohorts appear')


section('2. Elo Rating Calculation — Basic Correctness')

// Correct answer against equal-rated question → rating should increase
// timeTaken: 35 is above the speed bonus threshold (0.7*45=31.5)
const eloBasicCorrect = calculateEloUpdate({
  userRating: 1200,
  questionRating: 1200,
  isCorrect: true,
  timeTaken: 35,
  expectedTime: 45,
  optionChanges: 0,
  tabSwitches: 0,
  copyAttempts: 0,
})
assert(eloBasicCorrect.newRating > 1200, `Correct answer → rating increases (${1200} → ${eloBasicCorrect.newRating})`)
assert(eloBasicCorrect.ratingChange > 0, `Rating change is positive: +${eloBasicCorrect.ratingChange}`)
assertApprox(eloBasicCorrect.expectedScore, 0.5, 0.01, 'Equal ratings → expected score ~0.5')

// Incorrect answer against equal-rated question → rating should decrease
const eloBasicIncorrect = calculateEloUpdate({
  userRating: 1200,
  questionRating: 1200,
  isCorrect: false,
  timeTaken: 30,
  expectedTime: 45,
  optionChanges: 0,
  tabSwitches: 0,
  copyAttempts: 0,
})
assert(eloBasicIncorrect.newRating < 1200, `Incorrect answer → rating decreases (${1200} → ${eloBasicIncorrect.newRating})`)
assert(eloBasicIncorrect.ratingChange < 0, `Rating change is negative: ${eloBasicIncorrect.ratingChange}`)

// Symmetric: |gain| ≈ |loss| for equal conditions
assert(
  Math.abs(eloBasicCorrect.ratingChange + eloBasicIncorrect.ratingChange) <= 5,
  `Symmetric gains/losses (gain: ${eloBasicCorrect.ratingChange}, loss: ${eloBasicIncorrect.ratingChange})`,
)


section('3. Elo Rating Calculation — Expected Score Formula')

// Higher-rated user against lower-rated question → high expected score
const eloHighUser = calculateEloUpdate({
  userRating: 1600,
  questionRating: 1000,
  isCorrect: true,
  timeTaken: 20,
  expectedTime: 30,
  optionChanges: 0,
  tabSwitches: 0,
  copyAttempts: 0,
})
assert(eloHighUser.expectedScore > 0.8, `High user vs low question → expected > 0.8 (got ${eloHighUser.expectedScore.toFixed(3)})`)
assert(
  eloHighUser.ratingChange < eloBasicCorrect.ratingChange,
  `Less gain for "easy" correct (${eloHighUser.ratingChange} < ${eloBasicCorrect.ratingChange})`,
)

// Lower-rated user against higher-rated question → low expected score
const eloLowUser = calculateEloUpdate({
  userRating: 1000,
  questionRating: 1600,
  isCorrect: true,
  timeTaken: 40,
  expectedTime: 60,
  optionChanges: 0,
  tabSwitches: 0,
  copyAttempts: 0,
})
assert(eloLowUser.expectedScore < 0.2, `Low user vs hard question → expected < 0.2 (got ${eloLowUser.expectedScore.toFixed(3)})`)
assert(
  eloLowUser.ratingChange > eloBasicCorrect.ratingChange,
  `More gain for "upset" correct (${eloLowUser.ratingChange} > ${eloBasicCorrect.ratingChange})`,
)


section('4. Elo Rating Calculation — Behavioral Penalties')

// Tab switches penalty
const eloWithTabs = calculateEloUpdate({
  userRating: 1200,
  questionRating: 1200,
  isCorrect: true,
  timeTaken: 30,
  expectedTime: 45,
  optionChanges: 0,
  tabSwitches: 3, // severe
  copyAttempts: 0,
})
assert(
  eloWithTabs.newRating < eloBasicCorrect.newRating,
  `Tab switches reduce gain (${eloWithTabs.newRating} < ${eloBasicCorrect.newRating})`,
)
assert(eloWithTabs.penaltyApplied >= 0.20, `Tab switches ≥3 apply ≥0.20 penalty (got ${eloWithTabs.penaltyApplied})`)

// Copy attempts penalty
const eloWithCopy = calculateEloUpdate({
  userRating: 1200,
  questionRating: 1200,
  isCorrect: true,
  timeTaken: 30,
  expectedTime: 45,
  optionChanges: 0,
  tabSwitches: 0,
  copyAttempts: 1,
})
assert(eloWithCopy.penaltyApplied >= 0.25, `Copy attempt applies ≥0.25 penalty (got ${eloWithCopy.penaltyApplied})`)

// Option changes penalty
const eloWithOptions = calculateEloUpdate({
  userRating: 1200,
  questionRating: 1200,
  isCorrect: true,
  timeTaken: 30,
  expectedTime: 45,
  optionChanges: 4, // severe
  tabSwitches: 0,
  copyAttempts: 0,
})
assert(eloWithOptions.penaltyApplied >= 0.12, `Option changes ≥4 apply ≥0.12 penalty (got ${eloWithOptions.penaltyApplied})`)

// Slow time penalty
const eloSlowTime = calculateEloUpdate({
  userRating: 1200,
  questionRating: 1200,
  isCorrect: true,
  timeTaken: 100, // >2x expected
  expectedTime: 45,
  optionChanges: 0,
  tabSwitches: 0,
  copyAttempts: 0,
})
assert(eloSlowTime.penaltyApplied >= 0.15, `Slow time (>2x) applies ≥0.15 penalty (got ${eloSlowTime.penaltyApplied})`)

// Stacked penalties — all bad behaviors
const eloAllBad = calculateEloUpdate({
  userRating: 1200,
  questionRating: 1200,
  isCorrect: true,
  timeTaken: 100,
  expectedTime: 45,
  optionChanges: 5,
  tabSwitches: 4,
  copyAttempts: 2,
})
assert(
  eloAllBad.penaltyApplied >= 0.70,
  `All penalties stacked ≥0.70 (got ${eloAllBad.penaltyApplied.toFixed(2)})`,
)
assert(
  eloAllBad.newRating < 1200,
  `Stacked penalties can turn correct answer into rating loss (${eloAllBad.newRating})`,
)


section('5. Elo Rating Calculation — Speed Bonus')

const eloFastClean = calculateEloUpdate({
  userRating: 1200,
  questionRating: 1200,
  isCorrect: true,
  timeTaken: 20, // < 0.7 * 45 = 31.5
  expectedTime: 45,
  optionChanges: 0,
  tabSwitches: 0,
  copyAttempts: 0,
})
assert(eloFastClean.bonusApplied === true, 'Fast + clean + correct → speed bonus applied')
assert(
  eloFastClean.newRating > eloBasicCorrect.newRating,
  `Speed bonus increases gain (${eloFastClean.newRating} > ${eloBasicCorrect.newRating})`,
)

// Speed bonus NOT applied when incorrect
const eloFastIncorrect = calculateEloUpdate({
  userRating: 1200,
  questionRating: 1200,
  isCorrect: false,
  timeTaken: 20,
  expectedTime: 45,
  optionChanges: 0,
  tabSwitches: 0,
  copyAttempts: 0,
})
assert(eloFastIncorrect.bonusApplied === false, 'Fast but incorrect → no speed bonus')

// Speed bonus NOT applied when option changes > 0
const eloFastWithChanges = calculateEloUpdate({
  userRating: 1200,
  questionRating: 1200,
  isCorrect: true,
  timeTaken: 20,
  expectedTime: 45,
  optionChanges: 1,
  tabSwitches: 0,
  copyAttempts: 0,
})
assert(eloFastWithChanges.bonusApplied === false, 'Fast but changed answer → no speed bonus')


section('6. Elo Rating Calculation — Clamping')

// Rating should not go below MIN_RATING
const eloFloor = calculateEloUpdate({
  userRating: MIN_RATING,
  questionRating: 2000,
  isCorrect: false,
  timeTaken: 120,
  expectedTime: 45,
  optionChanges: 5,
  tabSwitches: 5,
  copyAttempts: 3,
})
assert(eloFloor.newRating >= MIN_RATING, `Rating clamped at floor ${MIN_RATING} (got ${eloFloor.newRating})`)

// Rating should not go above MAX_RATING
const eloCeiling = calculateEloUpdate({
  userRating: MAX_RATING,
  questionRating: 800,
  isCorrect: true,
  timeTaken: 10,
  expectedTime: 60,
  optionChanges: 0,
  tabSwitches: 0,
  copyAttempts: 0,
})
assert(eloCeiling.newRating <= MAX_RATING, `Rating clamped at ceiling ${MAX_RATING} (got ${eloCeiling.newRating})`)


section('7. Difficulty Selection')

// Low rating + incorrect → easy
const diffLowIncorrect = selectNextDifficulty({
  currentRating: 1000,
  isCorrect: false,
  timeTaken: 30,
  expectedTime: 30,
  optionChanges: 0,
  tabSwitches: 0,
})
assert(diffLowIncorrect === 'easy', `Rating 1000 + incorrect → easy (got ${diffLowIncorrect})`)

// Medium rating + correct + fast + clean → step up to hard
const diffMedCorrectFast = selectNextDifficulty({
  currentRating: 1200,
  isCorrect: true,
  timeTaken: 20, // < 0.8 * 45
  expectedTime: 45,
  optionChanges: 0,
  tabSwitches: 0,
})
assert(diffMedCorrectFast === 'hard', `Rating 1200 + correct + fast → hard (got ${diffMedCorrectFast})`)

// Medium rating + correct + slow → stay medium
const diffMedCorrectSlow = selectNextDifficulty({
  currentRating: 1200,
  isCorrect: true,
  timeTaken: 40, // > 0.8 * 45 = 36
  expectedTime: 45,
  optionChanges: 0,
  tabSwitches: 0,
})
assert(diffMedCorrectSlow === 'medium', `Rating 1200 + correct + slow → medium (got ${diffMedCorrectSlow})`)

// High rating + incorrect → step down to medium
const diffHighIncorrect = selectNextDifficulty({
  currentRating: 1400,
  isCorrect: false,
  timeTaken: 30,
  expectedTime: 30,
  optionChanges: 0,
  tabSwitches: 0,
})
assert(diffHighIncorrect === 'medium', `Rating 1400 + incorrect → medium (got ${diffHighIncorrect})`)

// Medium rating + correct + tab switches → stay medium (not step up)
const diffMedWithTabs = selectNextDifficulty({
  currentRating: 1200,
  isCorrect: true,
  timeTaken: 20,
  expectedTime: 45,
  optionChanges: 0,
  tabSwitches: 2,
})
assert(diffMedWithTabs === 'medium', `Rating 1200 + correct but tab switches → medium (got ${diffMedWithTabs})`)

// Easy difficulty + correct fast → step up to medium
const diffEasyCorrectFast = selectNextDifficulty({
  currentRating: 900,
  isCorrect: true,
  timeTaken: 15,
  expectedTime: 30,
  optionChanges: 0,
  tabSwitches: 0,
})
assert(diffEasyCorrectFast === 'medium', `Rating 900 + correct + fast → medium (got ${diffEasyCorrectFast})`)


section('8. Adaptive Question Selection — First Question')

// First question (no lastEvent) should be medium difficulty
const firstQ = selectAdaptiveQuestion({
  availableQuestions: mockQuestions,
  answeredIds: [],
  currentRating: 1200,
  lastEvent: null,
})
assert(firstQ !== null, 'First question selected (not null)')
const firstQData = mockQuestions.find(q => q.id === firstQ)
assert(firstQData?.difficulty === 'medium', `First question is medium difficulty (got ${firstQData?.difficulty})`)


section('9. Adaptive Question Selection — Subsequent Questions')

// After correct fast answer, should select harder question
const nextQAfterCorrect = selectAdaptiveQuestion({
  availableQuestions: mockQuestions,
  answeredIds: ['m1'],
  currentRating: 1250,
  lastEvent: {
    isCorrect: true,
    timeTaken: 20,
    expectedTime: 45,
    optionChanges: 0,
    tabSwitches: 0,
  },
})
assert(nextQAfterCorrect !== null, 'Next question after correct selected')
assert(nextQAfterCorrect !== 'm1', 'Does not re-select answered question')
const nextQData1 = mockQuestions.find(q => q.id === nextQAfterCorrect)
assert(
  nextQData1?.difficulty === 'hard',
  `After correct+fast at 1250 → hard question (got ${nextQData1?.difficulty})`,
)

// After incorrect answer, should select easier question
const nextQAfterIncorrect = selectAdaptiveQuestion({
  availableQuestions: mockQuestions,
  answeredIds: ['m1', 'h1'],
  currentRating: 1100,
  lastEvent: {
    isCorrect: false,
    timeTaken: 50,
    expectedTime: 45,
    optionChanges: 2,
    tabSwitches: 1,
  },
})
assert(nextQAfterIncorrect !== null, 'Next question after incorrect selected')
const nextQData2 = mockQuestions.find(q => q.id === nextQAfterIncorrect)
assert(
  nextQData2?.difficulty === 'easy',
  `After incorrect at 1100 → easy question (got ${nextQData2?.difficulty})`,
)


section('10. Adaptive Question Selection — Pool Exhaustion')

// All questions answered → null
const exhausted = selectAdaptiveQuestion({
  availableQuestions: mockQuestions,
  answeredIds: mockQuestions.map(q => q.id),
  currentRating: 1200,
  lastEvent: null,
})
assert(exhausted === null, 'All questions answered → null returned')

// Only one difficulty left, should fallback
const onlyEasy = mockQuestions.filter(q => q.difficulty === 'easy')
const fallbackQ = selectAdaptiveQuestion({
  availableQuestions: onlyEasy,
  answeredIds: [],
  currentRating: 1200,
  lastEvent: null, // Wants medium, but only easy available
})
assert(fallbackQ !== null, 'Fallback works when desired difficulty unavailable')
const fallbackData = mockQuestions.find(q => q.id === fallbackQ)
assert(fallbackData?.difficulty === 'easy', `Fallback to easy when medium unavailable (got ${fallbackData?.difficulty})`)


section('11. Adaptive Question Selection — No Repeats Across Many Picks')

// Simulate a full adaptive quiz — should never repeat a question
const answeredSoFar: string[] = []
let allUnique = true
for (let i = 0; i < mockQuestions.length; i++) {
  const picked = selectAdaptiveQuestion({
    availableQuestions: mockQuestions,
    answeredIds: answeredSoFar,
    currentRating: 1200,
    lastEvent: i === 0 ? null : {
      isCorrect: i % 2 === 0,
      timeTaken: 30,
      expectedTime: 45,
      optionChanges: 0,
      tabSwitches: 0,
    },
  })
  if (picked === null) break
  if (answeredSoFar.includes(picked)) {
    allUnique = false
    break
  }
  answeredSoFar.push(picked)
}
assert(allUnique, `No question repeated across ${answeredSoFar.length} adaptive picks`)
assert(answeredSoFar.length === mockQuestions.length, `All ${mockQuestions.length} questions eventually selected`)


section('12. Control Group Question Selection')

const controlIds = selectControlQuestions({
  allQuestions: mockQuestions,
  distribution: { easy: 2, medium: 2, hard: 2 },
})
assert(controlIds.length === 6, `Control selection picks correct total (got ${controlIds.length}, expected 6)`)

// Verify distribution
const controlQuestions = controlIds.map(id => mockQuestions.find(q => q.id === id)!)
const easyCount = controlQuestions.filter(q => q.difficulty === 'easy').length
const medCount = controlQuestions.filter(q => q.difficulty === 'medium').length
const hardCount = controlQuestions.filter(q => q.difficulty === 'hard').length
assert(easyCount === 2, `Control: 2 easy questions (got ${easyCount})`)
assert(medCount === 2, `Control: 2 medium questions (got ${medCount})`)
assert(hardCount === 2, `Control: 2 hard questions (got ${hardCount})`)

// All unique
const uniqueControl = new Set(controlIds)
assert(uniqueControl.size === controlIds.length, 'Control selection: all unique questions')

// Test over-request — requesting more than available should take what's available
const overRequest = selectControlQuestions({
  allQuestions: mockQuestions,
  distribution: { easy: 10, medium: 10, hard: 10 }, // only 3 of each
})
const overEasy = overRequest.map(id => mockQuestions.find(q => q.id === id)!).filter(q => q.difficulty === 'easy').length
assert(overEasy === 3, `Over-request caps at available: 3 easy (got ${overEasy})`)


section('13. Elo Simulation — 10-Question Adaptive Quiz')

// Simulate a student who gets questions 1-7 right (improving) then 8-10 wrong
let simRating = DEFAULT_START_RATING
const simHistory: { q: number; correct: boolean; rating: number; change: number }[] = []
const questionRatings = [1200, 1200, 1250, 1300, 1350, 1400, 1500, 1600, 1500, 1400]

for (let i = 0; i < 10; i++) {
  const isCorrect = i < 7
  const result = calculateEloUpdate({
    userRating: simRating,
    questionRating: questionRatings[i],
    isCorrect,
    timeTaken: isCorrect ? 25 : 50,
    expectedTime: 45,
    optionChanges: isCorrect ? 0 : 2,
    tabSwitches: 0,
    copyAttempts: 0,
  })
  simHistory.push({ q: i + 1, correct: isCorrect, rating: result.newRating, change: result.ratingChange })
  simRating = result.newRating
}

assert(simRating > DEFAULT_START_RATING, `7/10 correct → final rating above start (${simRating} > ${DEFAULT_START_RATING})`)

// Rating should peak around Q7 and decline after
const peakRating = Math.max(...simHistory.map(h => h.rating))
const peakQ = simHistory.findIndex(h => h.rating === peakRating) + 1
assert(peakQ >= 6 && peakQ <= 8, `Rating peaks around Q7 (peaked at Q${peakQ})`)

console.log('\n  Simulation trajectory:')
for (const h of simHistory) {
  const marker = h.correct ? '✓' : '✗'
  const sign = h.change >= 0 ? '+' : ''
  console.log(`    Q${h.q}: ${marker}  ${sign}${h.change}  → ${h.rating}`)
}


section('14. Edge Cases')

// Zero expected time should not crash
const eloZeroTime = calculateEloUpdate({
  userRating: 1200,
  questionRating: 1200,
  isCorrect: true,
  timeTaken: 30,
  expectedTime: 0,
  optionChanges: 0,
  tabSwitches: 0,
  copyAttempts: 0,
})
assert(Number.isFinite(eloZeroTime.newRating), `Zero expected time doesn't crash (rating: ${eloZeroTime.newRating})`)

// Empty question pool
const emptyPool = selectAdaptiveQuestion({
  availableQuestions: [],
  answeredIds: [],
  currentRating: 1200,
  lastEvent: null,
})
assert(emptyPool === null, 'Empty pool returns null')

// Empty control distribution
const emptyControl = selectControlQuestions({
  allQuestions: mockQuestions,
  distribution: { easy: 0, medium: 0, hard: 0 },
})
assert(emptyControl.length === 0, 'Zero distribution returns empty array')

// Very high K-factor amplifies changes
const eloHighK = calculateEloUpdate({
  userRating: 1200,
  questionRating: 1200,
  isCorrect: true,
  timeTaken: 30,
  expectedTime: 45,
  optionChanges: 0,
  tabSwitches: 0,
  copyAttempts: 0,
  kFactor: 64,
})
assert(
  Math.abs(eloHighK.ratingChange) > Math.abs(eloBasicCorrect.ratingChange),
  `Higher K-factor amplifies change (K64: ${eloHighK.ratingChange} vs K32: ${eloBasicCorrect.ratingChange})`,
)


// ═══════════════════════════════════════════════════════════════
// RESULTS
// ═══════════════════════════════════════════════════════════════

console.log('\n══════════════════════════════════════════')
console.log(`Results: ${passed}/${total} passed, ${failed} failed`)
if (failed > 0) {
  console.log('⚠ Some tests failed!')
  process.exit(1)
} else {
  console.log('All tests passed!')
}
