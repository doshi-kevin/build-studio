/**
 * Quiz scoring engine — pure functions for grading answers and attempts.
 * No side effects, no dependencies on React or storage.
 *
 * Supports: negative marking, bonus questions, extra credit questions.
 */

import type { Question, Answer, QuizAttempt, QuestionPool } from '@/lib/validations/quiz'
import { shuffleArray } from './utils'

// ── Grade Options ───────────────────────────────────────────

export interface GradeOptions {
  /** Enable negative marking for wrong answers (MCQ/T-F only) */
  negativeMarking?: boolean
  /** Penalty as fraction of points (0-1, e.g. 0.25 = 25%) */
  negativeMarkingPenalty?: number
}

// ── Single Answer Grading ───────────────────────────────────

export interface GradeResult {
  isCorrect: boolean
  earnedPoints: number
  /** false for bonus/extra credit questions — don't count toward total */
  countTowardTotal: boolean
}

export function gradeAnswer(
  question: Question,
  answer: Answer,
  options?: GradeOptions,
): GradeResult {
  const { content } = question
  const maxPoints = question.points
  const countTowardTotal = !question.isBonus && !question.isExtraCredit
  const negativeMarking = options?.negativeMarking ?? false
  const penalty = options?.negativeMarkingPenalty ?? 0.25

  switch (content.questionType) {
    case 'multiple_choice': {
      const selected = answer.selectedChoiceIds ?? []
      const correctIds = content.choices.filter((c) => c.isCorrect).map((c) => c.id)

      if (content.allowMultiple) {
        // Guard: if no correct answers configured, score as incorrect with 0 points
        if (correctIds.length === 0) {
          return { isCorrect: false, earnedPoints: 0, countTowardTotal }
        }
        // Partial credit: ratio of correct selections
        const correctSelected = selected.filter((id) => correctIds.includes(id)).length
        const incorrectSelected = selected.filter((id) => !correctIds.includes(id)).length
        const score = Math.max(0, correctSelected - incorrectSelected) / correctIds.length
        const earned = Math.round(maxPoints * score)
        const isCorrect = earned === maxPoints
        // Negative marking: penalize if answered but not fully correct
        if (!isCorrect && negativeMarking && selected.length > 0 && earned === 0) {
          return { isCorrect: false, earnedPoints: -Math.round(maxPoints * penalty), countTowardTotal }
        }
        return { isCorrect, earnedPoints: earned, countTowardTotal }
      }

      // Single correct: all or nothing
      const isCorrect =
        selected.length === 1 && correctIds.length === 1 && selected[0] === correctIds[0]
      if (!isCorrect && negativeMarking && selected.length > 0) {
        return { isCorrect: false, earnedPoints: -Math.round(maxPoints * penalty), countTowardTotal }
      }
      return { isCorrect, earnedPoints: isCorrect ? maxPoints : 0, countTowardTotal }
    }

    case 'true_false': {
      const isCorrect = answer.booleanAnswer === content.correctAnswer
      if (!isCorrect && negativeMarking && answer.booleanAnswer !== undefined) {
        return { isCorrect: false, earnedPoints: -Math.round(maxPoints * penalty), countTowardTotal }
      }
      return { isCorrect, earnedPoints: isCorrect ? maxPoints : 0, countTowardTotal }
    }

    case 'short_answer': {
      const studentAnswer = (answer.textAnswer ?? '').trim()
      const isCorrect = content.acceptedAnswers.some((accepted) =>
        content.caseSensitive
          ? studentAnswer === accepted.trim()
          : studentAnswer.toLowerCase() === accepted.trim().toLowerCase(),
      )
      // No negative marking for short answer (too subjective)
      return { isCorrect, earnedPoints: isCorrect ? maxPoints : 0, countTowardTotal }
    }

    case 'fill_in_blank': {
      const blankAnswers = answer.blankAnswers ?? {}
      let correctBlanks = 0
      const totalBlanks = content.blanks.length

      for (const blank of content.blanks) {
        const studentAnswer = (blankAnswers[blank.id] ?? '').trim()
        const isBlankCorrect = blank.acceptedAnswers.some((accepted) =>
          blank.caseSensitive
            ? studentAnswer === accepted.trim()
            : studentAnswer.toLowerCase() === accepted.trim().toLowerCase(),
        )
        if (isBlankCorrect) correctBlanks++
      }

      const ratio = totalBlanks > 0 ? correctBlanks / totalBlanks : 0
      const earned = Math.round(maxPoints * ratio)
      // No negative marking for fill-in-blank
      return { isCorrect: correctBlanks === totalBlanks, earnedPoints: earned, countTowardTotal }
    }

    default:
      return { isCorrect: false, earnedPoints: 0, countTowardTotal }
  }
}

// ── Full Attempt Grading ────────────────────────────────────

export interface AttemptGradeResult {
  score: number // percentage 0-100
  earnedPoints: number
  totalPoints: number
  /** Per-question results keyed by questionId */
  perQuestion: Record<string, { isCorrect: boolean; earnedPoints: number }>
}

export function gradeAttempt(
  questions: Question[],
  attempt: QuizAttempt,
  options?: GradeOptions,
): AttemptGradeResult {
  let totalPoints = 0
  let earnedPoints = 0
  const perQuestion: Record<string, { isCorrect: boolean; earnedPoints: number }> = {}

  for (const question of questions) {
    const answer = attempt.answers[question.id]
    if (answer) {
      const result = gradeAnswer(question, answer, options)
      earnedPoints += result.earnedPoints
      // Only count non-bonus/extra-credit toward total
      if (result.countTowardTotal) {
        totalPoints += question.points
      }
      perQuestion[question.id] = { isCorrect: result.isCorrect, earnedPoints: result.earnedPoints }
    } else {
      // Unanswered: no penalty (even with negative marking), but counts toward total if not bonus
      if (!question.isBonus && !question.isExtraCredit) {
        totalPoints += question.points
      }
      perQuestion[question.id] = { isCorrect: false, earnedPoints: 0 }
    }
  }

  // If all questions are bonus/extra-credit, totalPoints is 0.
  // In that case, calculate score based on total bonus points to avoid showing 0%.
  let score: number
  if (totalPoints > 0) {
    score = Math.round((earnedPoints / totalPoints) * 100)
  } else {
    // Sum up max possible bonus points for a meaningful percentage
    const bonusTotal = questions.reduce((sum, q) =>
      (q.isBonus || q.isExtraCredit) ? sum + q.points : sum, 0)
    score = bonusTotal > 0 ? Math.round((earnedPoints / bonusTotal) * 100) : 0
  }

  return { score: Math.max(0, Math.min(100, score)), earnedPoints, totalPoints, perQuestion }
}

// ── Question Pool Resolution ────────────────────────────────

export function resolveQuestionPool(
  pool: QuestionPool,
  allQuestions: Question[],
): string[] {
  const matching = allQuestions.filter((q) =>
    q.tags.some((t) => t.toLowerCase() === pool.tag.toLowerCase()),
  )
  const shuffled = shuffleArray(matching)
  return shuffled.slice(0, pool.count).map((q) => q.id)
}
