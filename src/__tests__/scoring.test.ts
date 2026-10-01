// Tests for the quiz scoring engine (gradeAnswer, gradeAttempt, resolveQuestionPool).
// Covers all question types, negative marking, bonus/extra credit, partial credit,
// edge cases, and question pool resolution.

import { describe, it, expect, vi } from 'vitest'
import { gradeAnswer, gradeAttempt, resolveQuestionPool } from '@/lib/quiz/scoring'
import {
  buildQuestion,
  buildMCQMultipleQuestion,
  buildTrueFalseQuestion,
  buildShortAnswerQuestion,
  buildFillInBlankQuestion,
  buildAnswer,
  buildQuizAttempt,
} from '@/__tests__/helpers/test-data-builders'

// Mock shuffleArray to return input unchanged for deterministic pool resolution
vi.mock('@/lib/quiz/utils', () => ({
  shuffleArray: <T>(arr: T[]): T[] => [...arr],
}))

// ── gradeAnswer ──────────────────────────────────────────────────

describe('gradeAnswer', () => {
  // ── Multiple Choice (single correct) ───────────────────────

  describe('multiple choice (single correct)', () => {
    const question = buildQuestion() // default: c-2 is correct, 10 points

    it('awards full points for a correct answer', () => {
      const answer = buildAnswer({ selectedChoiceIds: ['c-2'] })
      const result = gradeAnswer(question, answer)
      expect(result).toEqual({ isCorrect: true, earnedPoints: 10, countTowardTotal: true })
    })

    it('awards zero points for a wrong answer (no negative marking)', () => {
      const answer = buildAnswer({ selectedChoiceIds: ['c-1'] })
      const result = gradeAnswer(question, answer)
      expect(result).toEqual({ isCorrect: false, earnedPoints: 0, countTowardTotal: true })
    })

    it('awards zero points when no choice is selected', () => {
      const answer = buildAnswer({ selectedChoiceIds: [] })
      const result = gradeAnswer(question, answer)
      expect(result).toEqual({ isCorrect: false, earnedPoints: 0, countTowardTotal: true })
    })

    it('awards zero points when selectedChoiceIds is undefined', () => {
      const answer = buildAnswer({ selectedChoiceIds: undefined })
      const result = gradeAnswer(question, answer)
      expect(result).toEqual({ isCorrect: false, earnedPoints: 0, countTowardTotal: true })
    })

    it('marks wrong when multiple choices selected for single-correct', () => {
      const answer = buildAnswer({ selectedChoiceIds: ['c-1', 'c-2'] })
      const result = gradeAnswer(question, answer)
      expect(result.isCorrect).toBe(false)
    })

    it('applies default negative marking penalty (0.25) on wrong answer', () => {
      const answer = buildAnswer({ selectedChoiceIds: ['c-1'] })
      const result = gradeAnswer(question, answer, { negativeMarking: true })
      expect(result).toEqual({ isCorrect: false, earnedPoints: -3, countTowardTotal: true })
      // -Math.round(10 * 0.25) = -3
    })

    it('applies custom negative marking penalty', () => {
      const answer = buildAnswer({ selectedChoiceIds: ['c-3'] })
      const result = gradeAnswer(question, answer, {
        negativeMarking: true,
        negativeMarkingPenalty: 0.5,
      })
      expect(result.earnedPoints).toBe(-5) // -Math.round(10 * 0.5)
    })

    it('does not apply negative marking on unanswered question', () => {
      const answer = buildAnswer({ selectedChoiceIds: [] })
      const result = gradeAnswer(question, answer, { negativeMarking: true })
      expect(result.earnedPoints).toBe(0)
    })

    it('does not apply negative marking on correct answer', () => {
      const answer = buildAnswer({ selectedChoiceIds: ['c-2'] })
      const result = gradeAnswer(question, answer, { negativeMarking: true })
      expect(result.earnedPoints).toBe(10)
      expect(result.isCorrect).toBe(true)
    })

    it('does not apply negative marking when disabled even if wrong', () => {
      const answer = buildAnswer({ selectedChoiceIds: ['c-1'] })
      const result = gradeAnswer(question, answer, { negativeMarking: false })
      expect(result.earnedPoints).toBe(0)
    })
  })

  // ── Multiple Choice (allow multiple) ───────────────────────

  describe('multiple choice (allow multiple)', () => {
    // Default: c-1 (2), c-2 (3), c-4 (5) are correct; c-3 (4) is incorrect. 10 points.
    const question = buildMCQMultipleQuestion()

    it('awards full points when all correct choices selected', () => {
      const answer = buildAnswer({ selectedChoiceIds: ['c-1', 'c-2', 'c-4'] })
      const result = gradeAnswer(question, answer)
      expect(result).toEqual({ isCorrect: true, earnedPoints: 10, countTowardTotal: true })
    })

    it('awards partial credit for some correct choices', () => {
      // 2 correct, 0 incorrect out of 3 correct total => score = 2/3
      const answer = buildAnswer({ selectedChoiceIds: ['c-1', 'c-2'] })
      const result = gradeAnswer(question, answer)
      expect(result.isCorrect).toBe(false)
      expect(result.earnedPoints).toBe(Math.round(10 * (2 / 3))) // 7
    })

    it('reduces score for incorrect selections', () => {
      // 2 correct, 1 incorrect => (2-1)/3 = 1/3
      const answer = buildAnswer({ selectedChoiceIds: ['c-1', 'c-2', 'c-3'] })
      const result = gradeAnswer(question, answer)
      expect(result.earnedPoints).toBe(Math.round(10 * (1 / 3))) // 3
      expect(result.isCorrect).toBe(false)
    })

    it('floors score at zero when incorrect exceeds correct selections', () => {
      // 1 correct, 1 incorrect => (1-1)/3 = 0
      const answer = buildAnswer({ selectedChoiceIds: ['c-1', 'c-3'] })
      const result = gradeAnswer(question, answer)
      expect(result.earnedPoints).toBe(0)
      expect(result.isCorrect).toBe(false)
    })

    it('awards zero when only incorrect choices selected', () => {
      // 0 correct, 1 incorrect => max(0, 0-1)/3 = 0
      const answer = buildAnswer({ selectedChoiceIds: ['c-3'] })
      const result = gradeAnswer(question, answer)
      expect(result.earnedPoints).toBe(0)
    })

    it('awards zero points for no selections', () => {
      const answer = buildAnswer({ selectedChoiceIds: [] })
      const result = gradeAnswer(question, answer)
      expect(result.earnedPoints).toBe(0)
      expect(result.isCorrect).toBe(false)
    })

    it('applies negative marking only when answered, not correct, and earned is 0', () => {
      // 0 correct, 1 incorrect => earned = 0, answered = true => negative marking applies
      const answer = buildAnswer({ selectedChoiceIds: ['c-3'] })
      const result = gradeAnswer(question, answer, { negativeMarking: true })
      expect(result.earnedPoints).toBe(-3) // -Math.round(10 * 0.25)
    })

    it('does not apply negative marking when partial credit is earned', () => {
      // 2 correct, 0 incorrect => earned = 7 (not 0), so no negative marking
      const answer = buildAnswer({ selectedChoiceIds: ['c-1', 'c-2'] })
      const result = gradeAnswer(question, answer, { negativeMarking: true })
      expect(result.earnedPoints).toBe(7)
      expect(result.isCorrect).toBe(false)
    })

    it('does not apply negative marking when unanswered', () => {
      const answer = buildAnswer({ selectedChoiceIds: [] })
      const result = gradeAnswer(question, answer, { negativeMarking: true })
      expect(result.earnedPoints).toBe(0)
    })

    it('does not apply negative marking when all correct', () => {
      const answer = buildAnswer({ selectedChoiceIds: ['c-1', 'c-2', 'c-4'] })
      const result = gradeAnswer(question, answer, { negativeMarking: true })
      expect(result.earnedPoints).toBe(10)
      expect(result.isCorrect).toBe(true)
    })

    it('applies custom negative marking penalty for multi-select', () => {
      const answer = buildAnswer({ selectedChoiceIds: ['c-3'] })
      const result = gradeAnswer(question, answer, {
        negativeMarking: true,
        negativeMarkingPenalty: 0.5,
      })
      expect(result.earnedPoints).toBe(-5)
    })

    it('handles selecting all choices (3 correct, 1 incorrect)', () => {
      // (3-1)/3 = 2/3 => Math.round(10 * 2/3) = 7
      const answer = buildAnswer({ selectedChoiceIds: ['c-1', 'c-2', 'c-3', 'c-4'] })
      const result = gradeAnswer(question, answer)
      expect(result.earnedPoints).toBe(7)
      expect(result.isCorrect).toBe(false)
    })

    it('returns 0 points when no choices are marked correct (division-by-zero guard)', () => {
      const misconfigured = buildQuestion({
        questionText: 'Misconfigured question',
        content: {
          questionType: 'multiple_choice' as const,
          allowMultiple: true,
          choices: [
            { id: 'c-1', text: 'A', isCorrect: false },
            { id: 'c-2', text: 'B', isCorrect: false },
          ],
        },
      })
      const answer = buildAnswer({ selectedChoiceIds: ['c-1'] })
      const result = gradeAnswer(misconfigured, answer)
      expect(result.isCorrect).toBe(false)
      expect(result.earnedPoints).toBe(0)
      expect(Number.isNaN(result.earnedPoints)).toBe(false)
    })
  })

  // ── True/False ──────────────────────────────────────────────

  describe('true/false', () => {
    const question = buildTrueFalseQuestion() // correctAnswer = true, 10 points

    it('awards full points for a correct answer (true)', () => {
      const answer = buildAnswer({ booleanAnswer: true })
      const result = gradeAnswer(question, answer)
      expect(result).toEqual({ isCorrect: true, earnedPoints: 10, countTowardTotal: true })
    })

    it('awards zero points for a wrong answer', () => {
      const answer = buildAnswer({ booleanAnswer: false })
      const result = gradeAnswer(question, answer)
      expect(result).toEqual({ isCorrect: false, earnedPoints: 0, countTowardTotal: true })
    })

    it('awards zero points when booleanAnswer is undefined (unanswered)', () => {
      const answer = buildAnswer({ booleanAnswer: undefined })
      const result = gradeAnswer(question, answer)
      expect(result.isCorrect).toBe(false)
      expect(result.earnedPoints).toBe(0)
    })

    it('applies negative marking for wrong answer', () => {
      const answer = buildAnswer({ booleanAnswer: false })
      const result = gradeAnswer(question, answer, { negativeMarking: true })
      expect(result.earnedPoints).toBe(-3)
    })

    it('does not apply negative marking when unanswered', () => {
      const answer = buildAnswer({ booleanAnswer: undefined })
      const result = gradeAnswer(question, answer, { negativeMarking: true })
      expect(result.earnedPoints).toBe(0)
    })

    it('does not apply negative marking for correct answer', () => {
      const answer = buildAnswer({ booleanAnswer: true })
      const result = gradeAnswer(question, answer, { negativeMarking: true })
      expect(result.earnedPoints).toBe(10)
    })

    it('handles correctAnswer = false', () => {
      const q = buildTrueFalseQuestion({
        content: { questionType: 'true_false' as const, correctAnswer: false },
      })
      const correctAnswer = buildAnswer({ booleanAnswer: false })
      const wrongAnswer = buildAnswer({ booleanAnswer: true })

      expect(gradeAnswer(q, correctAnswer).isCorrect).toBe(true)
      expect(gradeAnswer(q, wrongAnswer).isCorrect).toBe(false)
    })

    it('applies custom negative marking penalty', () => {
      const answer = buildAnswer({ booleanAnswer: false })
      const result = gradeAnswer(question, answer, {
        negativeMarking: true,
        negativeMarkingPenalty: 1.0,
      })
      expect(result.earnedPoints).toBe(-10)
    })
  })

  // ── Short Answer ────────────────────────────────────────────

  describe('short answer', () => {
    const question = buildShortAnswerQuestion() // acceptedAnswers: ['Paris'], caseSensitive: false

    it('awards full points for an exact match (case-insensitive)', () => {
      const answer = buildAnswer({ textAnswer: 'paris' })
      const result = gradeAnswer(question, answer)
      expect(result).toEqual({ isCorrect: true, earnedPoints: 10, countTowardTotal: true })
    })

    it('awards full points for case-different match when case-insensitive', () => {
      const answer = buildAnswer({ textAnswer: 'PARIS' })
      const result = gradeAnswer(question, answer)
      expect(result.isCorrect).toBe(true)
    })

    it('awards zero points for wrong answer', () => {
      const answer = buildAnswer({ textAnswer: 'London' })
      const result = gradeAnswer(question, answer)
      expect(result).toEqual({ isCorrect: false, earnedPoints: 0, countTowardTotal: true })
    })

    it('awards zero points for empty answer', () => {
      const answer = buildAnswer({ textAnswer: '' })
      const result = gradeAnswer(question, answer)
      expect(result.isCorrect).toBe(false)
    })

    it('awards zero points for undefined textAnswer', () => {
      const answer = buildAnswer({ textAnswer: undefined })
      const result = gradeAnswer(question, answer)
      expect(result.isCorrect).toBe(false)
    })

    it('trims whitespace from student answer', () => {
      const answer = buildAnswer({ textAnswer: '  Paris  ' })
      const result = gradeAnswer(question, answer)
      expect(result.isCorrect).toBe(true)
    })

    it('trims whitespace from accepted answers', () => {
      const q = buildShortAnswerQuestion({
        content: {
          questionType: 'short_answer' as const,
          acceptedAnswers: ['  Paris  '],
          caseSensitive: false,
        },
      })
      const answer = buildAnswer({ textAnswer: 'Paris' })
      expect(gradeAnswer(q, answer).isCorrect).toBe(true)
    })

    it('never applies negative marking for short answer', () => {
      const answer = buildAnswer({ textAnswer: 'London' })
      const result = gradeAnswer(question, answer, { negativeMarking: true })
      expect(result.earnedPoints).toBe(0) // not negative
    })

    it('handles case-sensitive mode correctly', () => {
      const q = buildShortAnswerQuestion({
        content: {
          questionType: 'short_answer' as const,
          acceptedAnswers: ['Paris'],
          caseSensitive: true,
        },
      })
      expect(gradeAnswer(q, buildAnswer({ textAnswer: 'Paris' })).isCorrect).toBe(true)
      expect(gradeAnswer(q, buildAnswer({ textAnswer: 'paris' })).isCorrect).toBe(false)
      expect(gradeAnswer(q, buildAnswer({ textAnswer: 'PARIS' })).isCorrect).toBe(false)
    })

    it('accepts any of multiple accepted answers', () => {
      const q = buildShortAnswerQuestion({
        content: {
          questionType: 'short_answer' as const,
          acceptedAnswers: ['4', 'four', 'Four'],
          caseSensitive: false,
        },
      })
      expect(gradeAnswer(q, buildAnswer({ textAnswer: '4' })).isCorrect).toBe(true)
      expect(gradeAnswer(q, buildAnswer({ textAnswer: 'four' })).isCorrect).toBe(true)
      expect(gradeAnswer(q, buildAnswer({ textAnswer: 'FOUR' })).isCorrect).toBe(true)
      expect(gradeAnswer(q, buildAnswer({ textAnswer: '5' })).isCorrect).toBe(false)
    })
  })

  // ── Fill in the Blank ───────────────────────────────────────

  describe('fill in the blank', () => {
    const question = buildFillInBlankQuestion()
    // Default: 1 blank ('blank-1'), acceptedAnswers: ['mitochondria', 'mitochondrion'], caseSensitive: false

    it('awards full points when the blank is answered correctly', () => {
      const answer = buildAnswer({ blankAnswers: { 'blank-1': 'mitochondria' } })
      const result = gradeAnswer(question, answer)
      expect(result).toEqual({ isCorrect: true, earnedPoints: 10, countTowardTotal: true })
    })

    it('accepts alternative accepted answers', () => {
      const answer = buildAnswer({ blankAnswers: { 'blank-1': 'mitochondrion' } })
      const result = gradeAnswer(question, answer)
      expect(result.isCorrect).toBe(true)
    })

    it('is case-insensitive by default', () => {
      const answer = buildAnswer({ blankAnswers: { 'blank-1': 'MITOCHONDRIA' } })
      const result = gradeAnswer(question, answer)
      expect(result.isCorrect).toBe(true)
    })

    it('awards zero points for wrong blank answer', () => {
      const answer = buildAnswer({ blankAnswers: { 'blank-1': 'nucleus' } })
      const result = gradeAnswer(question, answer)
      expect(result).toEqual({ isCorrect: false, earnedPoints: 0, countTowardTotal: true })
    })

    it('awards zero points for empty blankAnswers', () => {
      const answer = buildAnswer({ blankAnswers: {} })
      const result = gradeAnswer(question, answer)
      expect(result.isCorrect).toBe(false)
      expect(result.earnedPoints).toBe(0)
    })

    it('awards zero points for undefined blankAnswers', () => {
      const answer = buildAnswer({ blankAnswers: undefined })
      const result = gradeAnswer(question, answer)
      expect(result.isCorrect).toBe(false)
    })

    it('trims whitespace from blank answers', () => {
      const answer = buildAnswer({ blankAnswers: { 'blank-1': '  mitochondria  ' } })
      expect(gradeAnswer(question, answer).isCorrect).toBe(true)
    })

    it('never applies negative marking for fill in blank', () => {
      const answer = buildAnswer({ blankAnswers: { 'blank-1': 'wrong' } })
      const result = gradeAnswer(question, answer, { negativeMarking: true })
      expect(result.earnedPoints).toBe(0) // not negative
    })

    it('handles case-sensitive blanks', () => {
      const q = buildFillInBlankQuestion({
        content: {
          questionType: 'fill_in_blank' as const,
          blanks: [
            { id: 'b-1', acceptedAnswers: ['DNA'], caseSensitive: true },
          ],
        },
      })
      expect(gradeAnswer(q, buildAnswer({ blankAnswers: { 'b-1': 'DNA' } })).isCorrect).toBe(true)
      expect(gradeAnswer(q, buildAnswer({ blankAnswers: { 'b-1': 'dna' } })).isCorrect).toBe(false)
    })

    it('awards partial credit for multi-blank questions', () => {
      const q = buildFillInBlankQuestion({
        content: {
          questionType: 'fill_in_blank' as const,
          blanks: [
            { id: 'b-1', acceptedAnswers: ['hydrogen'], caseSensitive: false },
            { id: 'b-2', acceptedAnswers: ['oxygen'], caseSensitive: false },
            { id: 'b-3', acceptedAnswers: ['water'], caseSensitive: false },
          ],
        },
        points: 9,
      })
      // 2 out of 3 correct
      const answer = buildAnswer({
        blankAnswers: { 'b-1': 'hydrogen', 'b-2': 'nitrogen', 'b-3': 'water' },
      })
      const result = gradeAnswer(q, answer)
      expect(result.isCorrect).toBe(false)
      expect(result.earnedPoints).toBe(Math.round(9 * (2 / 3))) // 6
    })

    it('awards full points when all blanks correct in multi-blank', () => {
      const q = buildFillInBlankQuestion({
        content: {
          questionType: 'fill_in_blank' as const,
          blanks: [
            { id: 'b-1', acceptedAnswers: ['hydrogen'], caseSensitive: false },
            { id: 'b-2', acceptedAnswers: ['oxygen'], caseSensitive: false },
          ],
        },
        points: 10,
      })
      const answer = buildAnswer({
        blankAnswers: { 'b-1': 'hydrogen', 'b-2': 'oxygen' },
      })
      const result = gradeAnswer(q, answer)
      expect(result.isCorrect).toBe(true)
      expect(result.earnedPoints).toBe(10)
    })

    it('awards zero when all blanks wrong in multi-blank', () => {
      const q = buildFillInBlankQuestion({
        content: {
          questionType: 'fill_in_blank' as const,
          blanks: [
            { id: 'b-1', acceptedAnswers: ['hydrogen'], caseSensitive: false },
            { id: 'b-2', acceptedAnswers: ['oxygen'], caseSensitive: false },
          ],
        },
        points: 10,
      })
      const answer = buildAnswer({
        blankAnswers: { 'b-1': 'wrong1', 'b-2': 'wrong2' },
      })
      const result = gradeAnswer(q, answer)
      expect(result.isCorrect).toBe(false)
      expect(result.earnedPoints).toBe(0)
    })

    it('handles missing blank answers gracefully (treats as empty string)', () => {
      const q = buildFillInBlankQuestion({
        content: {
          questionType: 'fill_in_blank' as const,
          blanks: [
            { id: 'b-1', acceptedAnswers: ['yes'], caseSensitive: false },
            { id: 'b-2', acceptedAnswers: ['no'], caseSensitive: false },
          ],
        },
        points: 10,
      })
      // Only answer one blank
      const answer = buildAnswer({ blankAnswers: { 'b-1': 'yes' } })
      const result = gradeAnswer(q, answer)
      expect(result.isCorrect).toBe(false)
      expect(result.earnedPoints).toBe(5) // 1/2 correct
    })
  })

  // ── Bonus / Extra Credit ────────────────────────────────────

  describe('bonus and extra credit', () => {
    it('sets countTowardTotal = false for bonus questions', () => {
      const q = buildQuestion({ isBonus: true })
      const answer = buildAnswer({ selectedChoiceIds: ['c-2'] })
      const result = gradeAnswer(q, answer)
      expect(result.countTowardTotal).toBe(false)
      expect(result.isCorrect).toBe(true)
      expect(result.earnedPoints).toBe(10)
    })

    it('sets countTowardTotal = false for extra credit questions', () => {
      const q = buildQuestion({ isExtraCredit: true })
      const answer = buildAnswer({ selectedChoiceIds: ['c-2'] })
      const result = gradeAnswer(q, answer)
      expect(result.countTowardTotal).toBe(false)
    })

    it('sets countTowardTotal = true for normal questions', () => {
      const q = buildQuestion({ isBonus: false, isExtraCredit: false })
      const answer = buildAnswer({ selectedChoiceIds: ['c-2'] })
      const result = gradeAnswer(q, answer)
      expect(result.countTowardTotal).toBe(true)
    })

    it('bonus question with wrong answer still has countTowardTotal = false', () => {
      const q = buildQuestion({ isBonus: true })
      const answer = buildAnswer({ selectedChoiceIds: ['c-1'] })
      const result = gradeAnswer(q, answer)
      expect(result.countTowardTotal).toBe(false)
      expect(result.isCorrect).toBe(false)
    })
  })

  // ── Default / Unknown Question Type ─────────────────────────

  describe('default case (unknown question type)', () => {
    it('returns zero points for an unknown question type', () => {
      const q = buildQuestion({
        content: { questionType: 'essay' as never } as never,
      })
      const answer = buildAnswer({})
      const result = gradeAnswer(q, answer)
      expect(result).toEqual({ isCorrect: false, earnedPoints: 0, countTowardTotal: true })
    })
  })

  // ── Points variations ───────────────────────────────────────

  describe('point value variations', () => {
    it('handles high-point questions correctly', () => {
      const q = buildQuestion({ points: 100 })
      const answer = buildAnswer({ selectedChoiceIds: ['c-2'] })
      expect(gradeAnswer(q, answer).earnedPoints).toBe(100)
    })

    it('handles 1-point questions correctly', () => {
      const q = buildQuestion({ points: 1 })
      const answer = buildAnswer({ selectedChoiceIds: ['c-2'] })
      expect(gradeAnswer(q, answer).earnedPoints).toBe(1)
    })

    it('calculates negative marking correctly for small point values', () => {
      const q = buildQuestion({ points: 1 })
      const answer = buildAnswer({ selectedChoiceIds: ['c-1'] })
      const result = gradeAnswer(q, answer, { negativeMarking: true })
      // -Math.round(1 * 0.25) = -0 (JS negative zero)
      expect(result.earnedPoints).toBe(-0)
    })

    it('calculates negative marking correctly for 4-point questions', () => {
      const q = buildQuestion({ points: 4 })
      const answer = buildAnswer({ selectedChoiceIds: ['c-1'] })
      const result = gradeAnswer(q, answer, { negativeMarking: true })
      // -Math.round(4 * 0.25) = -1
      expect(result.earnedPoints).toBe(-1)
    })
  })
})

// ── gradeAttempt ─────────────────────────────────────────────────

describe('gradeAttempt', () => {
  it('grades a simple attempt with one correct answer', () => {
    const questions = [buildQuestion({ id: 'q-1', points: 10 })]
    const attempt = buildQuizAttempt({
      answers: {
        'q-1': buildAnswer({ questionId: 'q-1', selectedChoiceIds: ['c-2'] }),
      },
    })
    const result = gradeAttempt(questions, attempt)
    expect(result).toEqual({
      score: 100,
      earnedPoints: 10,
      totalPoints: 10,
      perQuestion: { 'q-1': { isCorrect: true, earnedPoints: 10 } },
    })
  })

  it('grades a simple attempt with one wrong answer', () => {
    const questions = [buildQuestion({ id: 'q-1', points: 10 })]
    const attempt = buildQuizAttempt({
      answers: {
        'q-1': buildAnswer({ questionId: 'q-1', selectedChoiceIds: ['c-1'] }),
      },
    })
    const result = gradeAttempt(questions, attempt)
    expect(result.score).toBe(0)
    expect(result.earnedPoints).toBe(0)
    expect(result.totalPoints).toBe(10)
  })

  it('grades multiple questions with mixed results', () => {
    const questions = [
      buildQuestion({ id: 'q-1', points: 10 }),
      buildTrueFalseQuestion({ id: 'q-2', points: 5 }),
      buildShortAnswerQuestion({ id: 'q-3', points: 5 }),
    ]
    const attempt = buildQuizAttempt({
      answers: {
        'q-1': buildAnswer({ questionId: 'q-1', selectedChoiceIds: ['c-2'] }), // correct
        'q-2': buildAnswer({ questionId: 'q-2', booleanAnswer: false }),       // wrong (correct=true)
        'q-3': buildAnswer({ questionId: 'q-3', textAnswer: 'Paris' }),        // correct
      },
    })
    const result = gradeAttempt(questions, attempt)
    expect(result.earnedPoints).toBe(15) // 10 + 0 + 5
    expect(result.totalPoints).toBe(20)  // 10 + 5 + 5
    expect(result.score).toBe(75)        // Math.round(15/20 * 100)
    expect(result.perQuestion['q-1'].isCorrect).toBe(true)
    expect(result.perQuestion['q-2'].isCorrect).toBe(false)
    expect(result.perQuestion['q-3'].isCorrect).toBe(true)
  })

  it('handles unanswered questions (counts toward total but earns zero)', () => {
    const questions = [
      buildQuestion({ id: 'q-1', points: 10 }),
      buildQuestion({ id: 'q-2', points: 10 }),
    ]
    const attempt = buildQuizAttempt({
      answers: {
        'q-1': buildAnswer({ questionId: 'q-1', selectedChoiceIds: ['c-2'] }),
        // q-2 is unanswered
      },
    })
    const result = gradeAttempt(questions, attempt)
    expect(result.totalPoints).toBe(20)
    expect(result.earnedPoints).toBe(10)
    expect(result.score).toBe(50)
    expect(result.perQuestion['q-2']).toEqual({ isCorrect: false, earnedPoints: 0 })
  })

  it('excludes bonus questions from totalPoints', () => {
    const questions = [
      buildQuestion({ id: 'q-1', points: 10 }),
      buildQuestion({ id: 'q-bonus', points: 5, isBonus: true }),
    ]
    const attempt = buildQuizAttempt({
      answers: {
        'q-1': buildAnswer({ questionId: 'q-1', selectedChoiceIds: ['c-2'] }),
        'q-bonus': buildAnswer({ questionId: 'q-bonus', selectedChoiceIds: ['c-2'] }),
      },
    })
    const result = gradeAttempt(questions, attempt)
    expect(result.totalPoints).toBe(10) // bonus not counted
    expect(result.earnedPoints).toBe(15) // 10 + 5
    // Score can exceed 100% with bonus, but gets clamped
    expect(result.score).toBe(100) // clamped to 100
  })

  it('excludes extra credit questions from totalPoints', () => {
    const questions = [
      buildQuestion({ id: 'q-1', points: 10 }),
      buildQuestion({ id: 'q-ec', points: 5, isExtraCredit: true }),
    ]
    const attempt = buildQuizAttempt({
      answers: {
        'q-1': buildAnswer({ questionId: 'q-1', selectedChoiceIds: ['c-2'] }),
        'q-ec': buildAnswer({ questionId: 'q-ec', selectedChoiceIds: ['c-2'] }),
      },
    })
    const result = gradeAttempt(questions, attempt)
    expect(result.totalPoints).toBe(10)
    expect(result.earnedPoints).toBe(15)
    expect(result.score).toBe(100) // clamped
  })

  it('handles all-bonus quiz (totalPoints = 0, uses bonusTotal)', () => {
    const questions = [
      buildQuestion({ id: 'q-b1', points: 10, isBonus: true }),
      buildQuestion({ id: 'q-b2', points: 10, isBonus: true }),
    ]
    const attempt = buildQuizAttempt({
      answers: {
        'q-b1': buildAnswer({ questionId: 'q-b1', selectedChoiceIds: ['c-2'] }),
        'q-b2': buildAnswer({ questionId: 'q-b2', selectedChoiceIds: ['c-1'] }), // wrong
      },
    })
    const result = gradeAttempt(questions, attempt)
    expect(result.totalPoints).toBe(0)
    expect(result.earnedPoints).toBe(10)
    expect(result.score).toBe(50) // 10/20 * 100
  })

  it('handles all-extra-credit quiz (totalPoints = 0, uses bonusTotal)', () => {
    const questions = [
      buildQuestion({ id: 'q-ec1', points: 5, isExtraCredit: true }),
    ]
    const attempt = buildQuizAttempt({
      answers: {
        'q-ec1': buildAnswer({ questionId: 'q-ec1', selectedChoiceIds: ['c-2'] }),
      },
    })
    const result = gradeAttempt(questions, attempt)
    expect(result.totalPoints).toBe(0)
    expect(result.earnedPoints).toBe(5)
    expect(result.score).toBe(100)
  })

  it('returns score 0 when all-bonus quiz has zero earned and zero bonus total', () => {
    // Edge case: all bonus, no questions at all would never happen,
    // but if bonusTotal = 0, score should be 0
    const questions: ReturnType<typeof buildQuestion>[] = []
    const attempt = buildQuizAttempt({ answers: {} })
    const result = gradeAttempt(questions, attempt)
    expect(result.score).toBe(0)
    expect(result.totalPoints).toBe(0)
    expect(result.earnedPoints).toBe(0)
  })

  it('clamps score to minimum 0 (negative marking scenario)', () => {
    const questions = [
      buildQuestion({ id: 'q-1', points: 10 }),
      buildQuestion({ id: 'q-2', points: 10 }),
    ]
    const attempt = buildQuizAttempt({
      answers: {
        'q-1': buildAnswer({ questionId: 'q-1', selectedChoiceIds: ['c-1'] }), // wrong
        'q-2': buildAnswer({ questionId: 'q-2', selectedChoiceIds: ['c-3'] }), // wrong
      },
    })
    const result = gradeAttempt(questions, attempt, { negativeMarking: true })
    // Both wrong: -3 + -3 = -6 earned, 20 total => -30% => clamped to 0
    expect(result.score).toBe(0)
    expect(result.earnedPoints).toBe(-6)
  })

  it('clamps score to maximum 100', () => {
    const questions = [
      buildQuestion({ id: 'q-1', points: 10 }),
      buildQuestion({ id: 'q-bonus', points: 20, isBonus: true }),
    ]
    const attempt = buildQuizAttempt({
      answers: {
        'q-1': buildAnswer({ questionId: 'q-1', selectedChoiceIds: ['c-2'] }),
        'q-bonus': buildAnswer({ questionId: 'q-bonus', selectedChoiceIds: ['c-2'] }),
      },
    })
    const result = gradeAttempt(questions, attempt)
    // earned = 30, total = 10 => 300% => clamped to 100
    expect(result.score).toBe(100)
  })

  it('passes grade options through to gradeAnswer', () => {
    const questions = [buildQuestion({ id: 'q-1', points: 10 })]
    const attempt = buildQuizAttempt({
      answers: {
        'q-1': buildAnswer({ questionId: 'q-1', selectedChoiceIds: ['c-1'] }),
      },
    })
    const result = gradeAttempt(questions, attempt, {
      negativeMarking: true,
      negativeMarkingPenalty: 0.5,
    })
    expect(result.perQuestion['q-1'].earnedPoints).toBe(-5)
    expect(result.earnedPoints).toBe(-5)
  })

  it('handles unanswered bonus questions (no penalty, no total contribution)', () => {
    const questions = [
      buildQuestion({ id: 'q-1', points: 10 }),
      buildQuestion({ id: 'q-bonus', points: 5, isBonus: true }),
    ]
    const attempt = buildQuizAttempt({
      answers: {
        'q-1': buildAnswer({ questionId: 'q-1', selectedChoiceIds: ['c-2'] }),
        // q-bonus unanswered
      },
    })
    const result = gradeAttempt(questions, attempt)
    expect(result.totalPoints).toBe(10)
    expect(result.earnedPoints).toBe(10)
    expect(result.score).toBe(100)
    expect(result.perQuestion['q-bonus']).toEqual({ isCorrect: false, earnedPoints: 0 })
  })

  it('handles a large mixed attempt correctly', () => {
    const questions = [
      buildQuestion({ id: 'q-mcq', points: 10 }),
      buildTrueFalseQuestion({ id: 'q-tf', points: 5 }),
      buildShortAnswerQuestion({ id: 'q-sa', points: 10 }),
      buildFillInBlankQuestion({ id: 'q-fib', points: 5 }),
      buildQuestion({ id: 'q-bonus', points: 10, isBonus: true }),
    ]
    const attempt = buildQuizAttempt({
      answers: {
        'q-mcq': buildAnswer({ questionId: 'q-mcq', selectedChoiceIds: ['c-2'] }),   // correct: 10
        'q-tf': buildAnswer({ questionId: 'q-tf', booleanAnswer: true }),              // correct: 5
        'q-sa': buildAnswer({ questionId: 'q-sa', textAnswer: 'Paris' }),              // correct: 10
        'q-fib': buildAnswer({ questionId: 'q-fib', blankAnswers: { 'blank-1': 'mitochondria' } }), // correct: 5
        'q-bonus': buildAnswer({ questionId: 'q-bonus', selectedChoiceIds: ['c-1'] }), // wrong bonus: 0
      },
    })
    const result = gradeAttempt(questions, attempt)
    expect(result.totalPoints).toBe(30) // 10+5+10+5, bonus excluded
    expect(result.earnedPoints).toBe(30) // 10+5+10+5+0
    expect(result.score).toBe(100)
  })

  it('records per-question results for every question', () => {
    const questions = [
      buildQuestion({ id: 'q-a', points: 5 }),
      buildQuestion({ id: 'q-b', points: 5 }),
      buildQuestion({ id: 'q-c', points: 5 }),
    ]
    const attempt = buildQuizAttempt({
      answers: {
        'q-a': buildAnswer({ questionId: 'q-a', selectedChoiceIds: ['c-2'] }),
        // q-b unanswered
        'q-c': buildAnswer({ questionId: 'q-c', selectedChoiceIds: ['c-1'] }),
      },
    })
    const result = gradeAttempt(questions, attempt)
    expect(Object.keys(result.perQuestion)).toHaveLength(3)
    expect(result.perQuestion['q-a']).toEqual({ isCorrect: true, earnedPoints: 5 })
    expect(result.perQuestion['q-b']).toEqual({ isCorrect: false, earnedPoints: 0 })
    expect(result.perQuestion['q-c']).toEqual({ isCorrect: false, earnedPoints: 0 })
  })

  it('handles attempt with no questions', () => {
    const result = gradeAttempt([], buildQuizAttempt({ answers: {} }))
    expect(result).toEqual({ score: 0, earnedPoints: 0, totalPoints: 0, perQuestion: {} })
  })

  it('rounds score to integer', () => {
    const questions = [
      buildQuestion({ id: 'q-1', points: 3 }),
      buildQuestion({ id: 'q-2', points: 3 }),
      buildQuestion({ id: 'q-3', points: 3 }),
    ]
    const attempt = buildQuizAttempt({
      answers: {
        'q-1': buildAnswer({ questionId: 'q-1', selectedChoiceIds: ['c-2'] }), // 3
        'q-2': buildAnswer({ questionId: 'q-2', selectedChoiceIds: ['c-1'] }), // 0
        'q-3': buildAnswer({ questionId: 'q-3', selectedChoiceIds: ['c-1'] }), // 0
      },
    })
    const result = gradeAttempt(questions, attempt)
    // 3/9 * 100 = 33.333... => Math.round => 33
    expect(result.score).toBe(33)
    expect(Number.isInteger(result.score)).toBe(true)
  })

  it('handles negative marking with unanswered questions (no penalty for unanswered)', () => {
    const questions = [
      buildQuestion({ id: 'q-1', points: 10 }),
      buildQuestion({ id: 'q-2', points: 10 }),
    ]
    const attempt = buildQuizAttempt({
      answers: {
        // q-1 unanswered: should not get negative marking
        'q-2': buildAnswer({ questionId: 'q-2', selectedChoiceIds: ['c-1'] }), // wrong
      },
    })
    const result = gradeAttempt(questions, attempt, { negativeMarking: true })
    // q-1: 0 earned (unanswered, no penalty), q-2: -3 (wrong with negative marking)
    expect(result.earnedPoints).toBe(-3)
    expect(result.totalPoints).toBe(20)
    expect(result.perQuestion['q-1']).toEqual({ isCorrect: false, earnedPoints: 0 })
    expect(result.perQuestion['q-2'].earnedPoints).toBe(-3)
  })
})

// ── resolveQuestionPool ──────────────────────────────────────────

describe('resolveQuestionPool', () => {
  const allQuestions = [
    buildQuestion({ id: 'q-math-1', tags: ['math'] }),
    buildQuestion({ id: 'q-math-2', tags: ['math', 'algebra'] }),
    buildQuestion({ id: 'q-math-3', tags: ['Math'] }), // different case
    buildQuestion({ id: 'q-science-1', tags: ['science'] }),
    buildQuestion({ id: 'q-science-2', tags: ['science', 'biology'] }),
    buildQuestion({ id: 'q-history-1', tags: ['history'] }),
  ]

  it('returns question IDs matching the pool tag', () => {
    const pool = { id: 'pool-1', tag: 'math', count: 10 }
    const result = resolveQuestionPool(pool, allQuestions)
    expect(result).toEqual(['q-math-1', 'q-math-2', 'q-math-3'])
  })

  it('performs case-insensitive tag matching', () => {
    const pool = { id: 'pool-1', tag: 'MATH', count: 10 }
    const result = resolveQuestionPool(pool, allQuestions)
    expect(result).toEqual(['q-math-1', 'q-math-2', 'q-math-3'])
  })

  it('limits results to pool.count', () => {
    const pool = { id: 'pool-1', tag: 'math', count: 2 }
    const result = resolveQuestionPool(pool, allQuestions)
    expect(result).toHaveLength(2)
    // With mock shuffle (identity), should take first 2
    expect(result).toEqual(['q-math-1', 'q-math-2'])
  })

  it('returns fewer than count if not enough questions match', () => {
    const pool = { id: 'pool-1', tag: 'history', count: 5 }
    const result = resolveQuestionPool(pool, allQuestions)
    expect(result).toEqual(['q-history-1'])
  })

  it('returns empty array when no questions match the tag', () => {
    const pool = { id: 'pool-1', tag: 'philosophy', count: 3 }
    const result = resolveQuestionPool(pool, allQuestions)
    expect(result).toEqual([])
  })

  it('matches questions with the tag among multiple tags', () => {
    const pool = { id: 'pool-1', tag: 'algebra', count: 10 }
    const result = resolveQuestionPool(pool, allQuestions)
    expect(result).toEqual(['q-math-2'])
  })

  it('returns empty array when allQuestions is empty', () => {
    const pool = { id: 'pool-1', tag: 'math', count: 3 }
    const result = resolveQuestionPool(pool, [])
    expect(result).toEqual([])
  })

  it('handles count of 1', () => {
    const pool = { id: 'pool-1', tag: 'science', count: 1 }
    const result = resolveQuestionPool(pool, allQuestions)
    expect(result).toHaveLength(1)
    expect(result).toEqual(['q-science-1'])
  })

  it('returns IDs (strings), not question objects', () => {
    const pool = { id: 'pool-1', tag: 'math', count: 1 }
    const result = resolveQuestionPool(pool, allQuestions)
    expect(typeof result[0]).toBe('string')
  })
})
