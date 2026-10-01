// Pure per-question review summarizer for the student tutor's get_my_quiz_review
// tool: given a question (type + content) and the student's stored answer, render
// a human-readable "your answer" vs "correct answer" pair. No I/O — the tool does
// the scoped reads and maps rows through this; kept pure so it's unit-testable.

export interface ReviewQuestion {
  question_type: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  content: any
}
export interface ReviewAnswer {
  selected_choice_ids?: string[] | null
  boolean_answer?: boolean | null
  text_answer?: string | null
  blank_answers?: Record<string, unknown> | null
}

const NONE = '(no answer recorded)'

/** Resolve the student's answer and the correct answer to display strings,
 *  per question type. Robust to missing/malformed content (returns '(…)'). */
export function reviewAnswer(q: ReviewQuestion, a: ReviewAnswer): { yourAnswer: string; correctAnswer: string } {
  const c = q.content ?? {}
  switch (q.question_type) {
    case 'multiple_choice': {
      const choices: Array<{ id?: string; text?: string; isCorrect?: boolean }> = Array.isArray(c.choices) ? c.choices : []
      const textOf = (ids: string[] | null | undefined) => {
        const set = new Set(ids ?? [])
        const picked = choices.filter((ch) => ch.id && set.has(ch.id)).map((ch) => ch.text ?? '')
        return picked.length ? picked.join(', ') : NONE
      }
      const correct = choices.filter((ch) => ch.isCorrect).map((ch) => ch.text ?? '').join(', ')
      return { yourAnswer: textOf(a.selected_choice_ids), correctAnswer: correct || '(unknown)' }
    }
    case 'true_false': {
      // Resolve explicitly: a bare `c.correctAnswer ? …` reports a definite 'False'
      // when the field is absent/null (every other branch says '(unknown)' there),
      // and inverts a JSONB value stored as the STRING 'false' (which is truthy).
      const ca = c.correctAnswer
      const correctAnswer =
        ca == null
          ? '(unknown)'
          : typeof ca === 'string'
            ? ca.trim().toLowerCase() === 'true' ? 'True' : 'False'
            : ca ? 'True' : 'False'
      return {
        yourAnswer: a.boolean_answer == null ? NONE : a.boolean_answer ? 'True' : 'False',
        correctAnswer,
      }
    }
    case 'short_answer':
      return {
        yourAnswer: a.text_answer && a.text_answer.trim() ? a.text_answer : NONE,
        correctAnswer: (Array.isArray(c.acceptedAnswers) ? c.acceptedAnswers : []).join(' / ') || '(unknown)',
      }
    case 'fill_in_blank': {
      const blanks: Array<{ acceptedAnswers?: string[] }> = Array.isArray(c.blanks) ? c.blanks : []
      const yours = a.blank_answers && Object.keys(a.blank_answers).length
        ? Object.values(a.blank_answers).map(String).join(', ')
        : NONE
      const correct = blanks.map((b) => (Array.isArray(b.acceptedAnswers) ? b.acceptedAnswers.join('/') : '')).filter(Boolean).join(', ')
      return { yourAnswer: yours, correctAnswer: correct || '(unknown)' }
    }
    default:
      return { yourAnswer: a.text_answer && a.text_answer.trim() ? a.text_answer : NONE, correctAnswer: '(see the materials)' }
  }
}
