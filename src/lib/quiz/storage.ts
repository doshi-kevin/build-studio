/**
 * Quiz persistence layer — repository interface definition.
 *
 * The localStorage implementation has been removed. All quiz data is now
 * persisted via Supabase through server actions:
 *   - Professor: src/app/(dashboard)/professor/courses/[sectionId]/quizzes/actions.ts
 *   - Student:   src/app/(dashboard)/student/courses/[sectionId]/quizzes/actions.ts
 *
 * This file retains the QuizRepository interface for documentation purposes.
 */

import type {
  Question,
  Quiz,
  QuizAttempt,
  QuizInsights,
} from '@/lib/validations/quiz'

// ── Repository Interface (for documentation) ────────────────

export interface QuizRepository {
  // Questions (Question Bank)
  getQuestions(sectionId: string): Question[]
  getQuestionById(sectionId: string, questionId: string): Question | null
  saveQuestion(question: Question): void
  deleteQuestion(sectionId: string, questionId: string): void

  // Quizzes
  getQuizzes(sectionId: string): Quiz[]
  getQuizById(sectionId: string, quizId: string): Quiz | null
  saveQuiz(quiz: Quiz): void
  deleteQuiz(sectionId: string, quizId: string): void

  // Attempts
  getAttempts(sectionId: string, quizId: string, studentId?: string): QuizAttempt[]
  getAttemptById(attemptId: string, sectionId: string): QuizAttempt | null
  saveAttempt(attempt: QuizAttempt): void

  // Insights (computed from attempts)
  getInsights(sectionId: string, quizId: string, questions: Question[]): QuizInsights
}
