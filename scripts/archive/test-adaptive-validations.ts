/**
 * Internal test script for adaptive quiz Zod validation schemas.
 * Run with: npx tsx scripts/test-adaptive-validations.ts
 *
 * Tests schema parsing for: submitAdaptiveAnswer, adaptiveSettings,
 * cohortOverride, quiz adaptive fields, question adaptive fields.
 */

import { z } from 'zod'
import {
  submitAdaptiveAnswerSchema,
  adaptiveSettingsSchema,
  cohortOverrideSchema,
  behavioralSignalsSchema,
} from '../../src/lib/validations/adaptive'
import {
  createQuizFullServerSchema,
  createQuestionServerSchema,
  saveAnswerServerSchema,
  quizSchema,
} from '../../src/lib/validations/quiz'

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

function section(name: string) {
  console.log(`\n── ${name} ──`)
}

function shouldParse(schema: z.ZodSchema, data: unknown, label: string) {
  const result = schema.safeParse(data)
  assert(result.success, `${label} → parses OK`)
  return result
}

function shouldReject(schema: z.ZodSchema, data: unknown, label: string) {
  const result = schema.safeParse(data)
  assert(!result.success, `${label} → correctly rejected`)
  if (!result.success) {
    const issues = result.error.issues.map(i => i.message).join(', ')
    console.log(`    Reason: ${issues}`)
  }
  return result
}

// ═══════════════════════════════════════════════════════════════
// TEST SUITE
// ═══════════════════════════════════════════════════════════════

section('1. submitAdaptiveAnswerSchema — Valid Inputs')

shouldParse(submitAdaptiveAnswerSchema, {
  selectedChoiceIds: ['choice-1', 'choice-2'],

  timeSpentSeconds: 30,
  optionChanges: 2,
  tabSwitches: 1,
  copyAttempts: 0,
}, 'MC answer with behavioral signals')

shouldParse(submitAdaptiveAnswerSchema, {
  booleanAnswer: true,
  timeSpentSeconds: 15,
  optionChanges: 0,
  tabSwitches: 0,
  copyAttempts: 0,
}, 'T/F answer with clean behavior')

shouldParse(submitAdaptiveAnswerSchema, {
  textAnswer: 'The mitochondria is the powerhouse of the cell',
  timeSpentSeconds: 45,
}, 'Short answer — behavioral fields should default to 0')

shouldParse(submitAdaptiveAnswerSchema, {
  blankAnswers: { 'blank-1': 'oxygen', 'blank-2': 'carbon dioxide' },

  timeSpentSeconds: 60,
  optionChanges: 1,
  tabSwitches: 0,
  copyAttempts: 0,
}, 'Fill-in-blank answer')

// Minimal valid (all optional, just time)
shouldParse(submitAdaptiveAnswerSchema, {
  timeSpentSeconds: 10,
}, 'Minimal valid input (only time)')


section('2. submitAdaptiveAnswerSchema — Invalid Inputs')

shouldReject(submitAdaptiveAnswerSchema, {
  timeSpentSeconds: -5,
}, 'Negative time rejected')

shouldReject(submitAdaptiveAnswerSchema, {
  timeSpentSeconds: 10,
  optionChanges: -1,
}, 'Negative optionChanges rejected')

shouldReject(submitAdaptiveAnswerSchema, {
  timeSpentSeconds: 10,
  tabSwitches: -1,
}, 'Negative tabSwitches rejected')

section('3. submitAdaptiveAnswerSchema — Defaults')

const defaultsResult = submitAdaptiveAnswerSchema.parse({
  timeSpentSeconds: 20,
})
assert(defaultsResult.optionChanges === 0, 'optionChanges defaults to 0')
assert(defaultsResult.tabSwitches === 0, 'tabSwitches defaults to 0')
assert(defaultsResult.copyAttempts === 0, 'copyAttempts defaults to 0')


section('4. adaptiveSettingsSchema — Valid Inputs')

shouldParse(adaptiveSettingsSchema, {
  adaptiveMode: true,
  adaptiveRatio: 60,
  adaptiveQuestionCount: 10,
  controlDistribution: { easy: 3, medium: 3, hard: 4 },
}, 'Standard adaptive settings')

shouldParse(adaptiveSettingsSchema, {
  adaptiveMode: false,
}, 'Adaptive off (defaults should fill in)')

const offDefaults = adaptiveSettingsSchema.parse({ adaptiveMode: false })
assert(offDefaults.adaptiveRatio === 60, 'Default ratio = 60')
assert(offDefaults.adaptiveQuestionCount === 10, 'Default question count = 10')
assert(offDefaults.controlDistribution.easy === 3, 'Default control distribution easy = 3')

shouldParse(adaptiveSettingsSchema, {
  adaptiveMode: true,
  adaptiveRatio: 0,
  adaptiveQuestionCount: 1,
  controlDistribution: { easy: 0, medium: 0, hard: 1 },
}, 'Edge case: ratio 0, 1 question')

shouldParse(adaptiveSettingsSchema, {
  adaptiveMode: true,
  adaptiveRatio: 100,
  adaptiveQuestionCount: 100,
  controlDistribution: { easy: 50, medium: 30, hard: 20 },
}, 'Edge case: ratio 100, max questions')


section('5. adaptiveSettingsSchema — Invalid Inputs')

shouldReject(adaptiveSettingsSchema, {
  adaptiveMode: true,
  adaptiveRatio: 101,
}, 'Ratio > 100 rejected')

shouldReject(adaptiveSettingsSchema, {
  adaptiveMode: true,
  adaptiveRatio: -1,
}, 'Ratio < 0 rejected')

shouldReject(adaptiveSettingsSchema, {
  adaptiveMode: true,
  adaptiveQuestionCount: 0,
}, 'Question count 0 rejected')

shouldReject(adaptiveSettingsSchema, {
  adaptiveMode: true,
  adaptiveQuestionCount: 101,
}, 'Question count > 100 rejected')

shouldReject(adaptiveSettingsSchema, {
  adaptiveMode: true,
  controlDistribution: { easy: -1, medium: 3, hard: 4 },
}, 'Negative distribution rejected')


section('6. cohortOverrideSchema — Valid & Invalid')

shouldParse(cohortOverrideSchema, {
  studentId: '550e8400-e29b-41d4-a716-446655440000',
  cohort: 'adaptive',
}, 'Valid adaptive override')

shouldParse(cohortOverrideSchema, {
  studentId: '550e8400-e29b-41d4-a716-446655440000',
  cohort: 'control',
}, 'Valid control override')

shouldReject(cohortOverrideSchema, {
  studentId: 'not-a-uuid',
  cohort: 'adaptive',
}, 'Non-UUID student ID rejected')

shouldReject(cohortOverrideSchema, {
  studentId: '550e8400-e29b-41d4-a716-446655440000',
  cohort: 'experimental',
}, 'Invalid cohort type rejected')


section('7. behavioralSignalsSchema')

shouldParse(behavioralSignalsSchema, {
  optionChanges: 5,
  tabSwitches: 3,
  copyAttempts: 1,
}, 'All signals present')

const behavioralDefaults = behavioralSignalsSchema.parse({})
assert(behavioralDefaults.optionChanges === 0, 'optionChanges defaults to 0')
assert(behavioralDefaults.tabSwitches === 0, 'tabSwitches defaults to 0')
assert(behavioralDefaults.copyAttempts === 0, 'copyAttempts defaults to 0')


section('8. Quiz Schema — Adaptive Fields (createQuizFullServerSchema)')

// Test that the full quiz server schema accepts adaptive fields
const quizInput = {
  title: 'Adaptive Test Quiz',
  description: 'Test quiz with adaptive mode',
  adaptiveMode: true,
  adaptiveRatio: 70,
  adaptiveQuestionCount: 15,
  controlDistribution: { easy: 5, medium: 5, hard: 5 },
}

const quizResult = createQuizFullServerSchema.safeParse(quizInput)
assert(quizResult.success, `Quiz create schema accepts adaptive fields (${quizResult.success ? 'OK' : quizResult.error?.issues[0]?.message})`)
if (quizResult.success) {
  assert(quizResult.data.adaptiveMode === true, 'adaptiveMode preserved as true')
  assert(quizResult.data.adaptiveRatio === 70, 'adaptiveRatio preserved as 70')
  assert(quizResult.data.adaptiveQuestionCount === 15, 'adaptiveQuestionCount preserved as 15')
}

// Test omitted adaptive fields (all optional)
const quizNoAdaptive = {
  title: 'Normal Quiz',
  description: '',
}
const quizDefaultResult = createQuizFullServerSchema.safeParse(quizNoAdaptive)
assert(quizDefaultResult.success, 'Quiz create schema works without adaptive fields')
if (quizDefaultResult.success) {
  assert(quizDefaultResult.data.adaptiveMode === undefined, 'adaptiveMode is undefined when omitted')
}

// Test the read schema (quizSchema) which has defaults
section('8b. Quiz Schema — Adaptive Defaults (quizSchema / read)')

const quizReadInput = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  sectionId: '550e8400-e29b-41d4-a716-446655440001',
  title: 'Read Test',
  description: '',
  status: 'draft',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}
const quizReadResult = quizSchema.safeParse(quizReadInput)
assert(quizReadResult.success, `quizSchema parses with defaults (${quizReadResult.success ? 'OK' : quizReadResult.error?.issues[0]?.message})`)
if (quizReadResult.success) {
  assert(quizReadResult.data.adaptiveMode === false, 'adaptiveMode defaults to false')
  assert(quizReadResult.data.adaptiveRatio === 60, 'adaptiveRatio defaults to 60')
  assert(quizReadResult.data.adaptiveQuestionCount === 10, 'adaptiveQuestionCount defaults to 10')
}


section('9. Question Schema — Adaptive Fields')

const questionInput = {
  questionText: 'What is 2+2?',
  content: {
    questionType: 'multiple_choice',
    choices: [
      { id: 'c1', text: '3', isCorrect: false },
      { id: 'c2', text: '4', isCorrect: true },
      { id: 'c3', text: '5', isCorrect: false },
    ],
    allowMultiple: false,
  },
  difficulty: 'medium',
  bloomsLevel: null,
  tags: ['math'],
  points: 2,
  explanation: '2+2=4',
  isBonus: false,
  isExtraCredit: false,
  imageUrl: null,
  imagePath: null,
  codeSnippet: null,
  eloRating: 1200,
  expectedTimeSeconds: 30,
}

const qResult = createQuestionServerSchema.safeParse(questionInput)
assert(qResult.success, `Question schema accepts eloRating + expectedTimeSeconds (${qResult.success ? 'OK' : qResult.error?.issues[0]?.message})`)
if (qResult.success) {
  assert(qResult.data.eloRating === 1200, 'eloRating preserved')
  assert(qResult.data.expectedTimeSeconds === 30, 'expectedTimeSeconds preserved')
}

// Default elo values
const qNoElo = { ...questionInput }
delete (qNoElo as Record<string, unknown>).eloRating
delete (qNoElo as Record<string, unknown>).expectedTimeSeconds
const qDefaultResult = createQuestionServerSchema.safeParse(qNoElo)
assert(qDefaultResult.success, 'Question schema works without elo fields')
if (qDefaultResult.success) {
  assert(qDefaultResult.data.eloRating === 1200, 'eloRating defaults to 1200')
  assert(qDefaultResult.data.expectedTimeSeconds === null, 'expectedTimeSeconds defaults to null')
}


section('10. Answer Schema — Behavioral Fields')

const answerInput = {
  isFlagged: false,
  timeSpentSeconds: 25,
  selectedChoiceIds: ['c2'],
  optionChanges: 3,
  tabSwitches: 1,
  copyAttempts: 0,
}

const aResult = saveAnswerServerSchema.safeParse(answerInput)
assert(aResult.success, `Answer schema accepts behavioral fields (${aResult.success ? 'OK' : aResult.error?.issues[0]?.message})`)
if (aResult.success) {
  assert(aResult.data.optionChanges === 3, 'optionChanges preserved')
  assert(aResult.data.tabSwitches === 1, 'tabSwitches preserved')
  assert(aResult.data.copyAttempts === 0, 'copyAttempts preserved')
}

// Without behavioral fields (backward compatibility for non-adaptive quizzes)
const answerNoBehavior = {
  isFlagged: false,
  timeSpentSeconds: 25,
  selectedChoiceIds: ['c2'],
}

const aNoBehaviorResult = saveAnswerServerSchema.safeParse(answerNoBehavior)
assert(aNoBehaviorResult.success, 'Answer schema works without behavioral fields (backward compat)')
if (aNoBehaviorResult.success) {
  assert(aNoBehaviorResult.data.optionChanges === 0, 'optionChanges defaults to 0')
  assert(aNoBehaviorResult.data.tabSwitches === 0, 'tabSwitches defaults to 0')
  assert(aNoBehaviorResult.data.copyAttempts === 0, 'copyAttempts defaults to 0')
}


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
