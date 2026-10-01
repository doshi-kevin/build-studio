// Test data builders — factory functions for creating test fixtures.
// Each builder provides sensible defaults; override any field via the partial argument.

import type { Question, Answer, Quiz, QuizAttempt } from '@/lib/validations/quiz'

// ── Quiz Domain ───────────────────────────────────────────────

export function buildChoice(overrides: Partial<{ id: string; text: string; isCorrect: boolean }> = {}) {
  return {
    id: 'choice-1',
    text: 'Default choice',
    isCorrect: false,
    ...overrides,
  }
}

export function buildQuestion(overrides: Partial<Question> = {}): Question {
  return {
    id: 'q-1',
    questionText: 'What is 2 + 2?',
    content: {
      questionType: 'multiple_choice' as const,
      choices: [
        { id: 'c-1', text: '3', isCorrect: false },
        { id: 'c-2', text: '4', isCorrect: true },
        { id: 'c-3', text: '5', isCorrect: false },
      ],
      allowMultiple: false,
    },
    difficulty: 'medium',
    tags: ['math'],
    points: 10,
    explanation: '',
    isBonus: false,
    isExtraCredit: false,
    bloomsLevel: 'remember',
    eloRating: 1200,
    expectedTimeSeconds: 30,
    ...overrides,
  } as Question
}

export function buildMCQMultipleQuestion(overrides: Partial<Question> = {}): Question {
  return buildQuestion({
    id: 'q-mcq-multi',
    questionText: 'Select all prime numbers',
    content: {
      questionType: 'multiple_choice' as const,
      choices: [
        { id: 'c-1', text: '2', isCorrect: true },
        { id: 'c-2', text: '3', isCorrect: true },
        { id: 'c-3', text: '4', isCorrect: false },
        { id: 'c-4', text: '5', isCorrect: true },
      ],
      allowMultiple: true,
    },
    ...overrides,
  })
}

export function buildTrueFalseQuestion(overrides: Partial<Question> = {}): Question {
  return buildQuestion({
    id: 'q-tf',
    questionText: 'The sky is blue.',
    content: {
      questionType: 'true_false' as const,
      correctAnswer: true,
    },
    ...overrides,
  })
}

export function buildShortAnswerQuestion(overrides: Partial<Question> = {}): Question {
  return buildQuestion({
    id: 'q-sa',
    questionText: 'What is the capital of France?',
    content: {
      questionType: 'short_answer' as const,
      acceptedAnswers: ['Paris'],
      caseSensitive: false,
    },
    ...overrides,
  })
}

export function buildFillInBlankQuestion(overrides: Partial<Question> = {}): Question {
  return buildQuestion({
    id: 'q-fib',
    questionText: 'The _____ is the powerhouse of the cell.',
    content: {
      questionType: 'fill_in_blank' as const,
      blanks: [
        {
          id: 'blank-1',
          acceptedAnswers: ['mitochondria', 'mitochondrion'],
          caseSensitive: false,
        },
      ],
    },
    ...overrides,
  })
}

export function buildAnswer(overrides: Partial<Answer> = {}): Answer {
  return {
    questionId: 'q-1',
    selectedChoiceIds: ['c-2'],
    isFlagged: false,
    timeSpentSeconds: 15,
    isCorrect: null,
    earnedPoints: null,
    optionChanges: 0,
    tabSwitches: 0,
    copyAttempts: 0,
    ...overrides,
  } as Answer
}

export function buildQuiz(overrides: Partial<Quiz> = {}): Quiz {
  return {
    id: 'quiz-1',
    title: 'Test Quiz',
    description: 'A test quiz',
    status: 'published',
    questionIds: ['q-1'],
    questionPools: [],
    timeLimitMinutes: null,
    maxAttempts: 1,
    passThreshold: 60,
    dueDate: null,
    showExplanations: 'after_submission',
    shuffleQuestions: false,
    shuffleAnswers: false,
    negativeMarking: false,
    negativeMarkingPenalty: 0.25,
    showLeaderboard: false,
    allowCalculator: false,
    formulaSheetUrl: null,
    mode: 'graded',
    adaptiveMode: false,
    adaptiveRatio: 50,
    showRatingToStudents: false,
    ...overrides,
  } as Quiz
}

export function buildQuizAttempt(overrides: Partial<QuizAttempt> = {}): QuizAttempt {
  return {
    id: 'attempt-1',
    quizId: 'quiz-1',
    studentId: 'student-1',
    status: 'in_progress',
    answers: {},
    score: null,
    totalPoints: null,
    earnedPoints: null,
    startedAt: '2026-01-01T10:00:00Z',
    submittedAt: null,
    isLate: false,
    timeLimitExceeded: false,
    timeSpentSeconds: 0,
    cohort: null,
    cohortAssignedBy: null,
    currentRating: null,
    ...overrides,
  } as QuizAttempt
}

// ── Enrollment Domain ─────────────────────────────────────────

export function buildEnrollment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'enrollment-1',
    student_id: 'student-1',
    section_id: 'section-1',
    status: 'enrolled',
    enrolled_at: '2026-01-01T10:00:00Z',
    ...overrides,
  }
}

export function buildCourseSection(overrides: Record<string, unknown> = {}) {
  return {
    id: 'section-1',
    course_id: 'course-1',
    professor_id: 'professor-user-id',
    status: 'active',
    semester: 'Spring 2026',
    max_capacity: 30,
    ...overrides,
  }
}

// ── Profile Domain ────────────────────────────────────────────

export function buildProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-1',
    email: 'test@university.edu',
    first_name: 'Test',
    last_name: 'User',
    role: 'student',
    avatar_url: null,
    ...overrides,
  }
}
