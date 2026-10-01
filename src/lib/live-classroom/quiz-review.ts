// Pure logic for reviewing a closed live-classroom quiz. Maps a quiz's
// questions + a student's submitted answers into a per-question right/wrong
// breakdown with the correct answer and optional reasoning, plus a score.
// Shared by the in-session reveal-on-close and the after-class history.
//
// IMPORTANT: this exposes the correct answer, so callers must ONLY build a
// review for a CLOSED quiz — never pass an open/draft quiz's data to a student.

export interface QuizReviewQuestion {
  id: string
  prompt: string
  choices: Array<{ id: string; text: string }>
  correctChoiceId: string
  concept?: string
  explanation?: string
}

export interface QuizReviewPayload {
  title?: string
  questions: QuizReviewQuestion[]
}

export interface ReviewChoice {
  id: string
  text: string
  isCorrect: boolean
  isPicked: boolean
}

export interface ReviewQuestion {
  id: string
  prompt: string
  choices: ReviewChoice[]
  /** The choice the student picked, or null if they didn't answer this one. */
  pickedChoiceId: string | null
  correctChoiceId: string
  answered: boolean
  isCorrect: boolean
  explanation?: string
}

export interface QuizReviewModel {
  title: string
  questions: ReviewQuestion[]
  correctCount: number
  totalCount: number
  /** round(correct / total * 100); 0 when the quiz has no questions. */
  scorePct: number
}

/**
 * Build the review model for a closed quiz given the student's answers.
 * Choices are kept in authored order (not the per-student shuffle). A question
 * with no entry in `studentAnswers` is treated as unanswered and counts wrong.
 */
export function buildQuizReview(
  payload: QuizReviewPayload,
  studentAnswers: Record<string, string> | null | undefined,
): QuizReviewModel {
  const answers = studentAnswers ?? {}

  const questions: ReviewQuestion[] = (payload.questions ?? []).map((q) => {
    const picked = Object.prototype.hasOwnProperty.call(answers, q.id)
      ? answers[q.id]
      : null
    const answered = picked != null && picked !== ''
    const isCorrect = answered && picked === q.correctChoiceId

    return {
      id: q.id,
      prompt: q.prompt,
      choices: q.choices.map((c) => ({
        id: c.id,
        text: c.text,
        isCorrect: c.id === q.correctChoiceId,
        isPicked: answered && c.id === picked,
      })),
      pickedChoiceId: answered ? picked : null,
      correctChoiceId: q.correctChoiceId,
      answered,
      isCorrect,
      explanation: q.explanation,
    }
  })

  const totalCount = questions.length
  const correctCount = questions.filter((q) => q.isCorrect).length
  const scorePct = totalCount > 0 ? Math.round((correctCount / totalCount) * 100) : 0

  return {
    title: payload.title ?? 'Quiz',
    questions,
    correctCount,
    totalCount,
    scorePct,
  }
}
