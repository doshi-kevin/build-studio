// Client-side validation for quiz wizard questions, mirroring the server
// `questionContentSchema` rules (src/lib/validations/quiz.ts) so the professor
// gets a clear, blocking message BEFORE publish instead of a question being
// silently skipped server-side and dropped from the quiz (see F-MAJ-1).
//
// Pure + dependency-free so it can be unit-tested in isolation.

import type { WizardQuestion } from '@/components/professor/quizzes/wizard/QuestionEditorCard'
import { countBlankMarkers, blankMarkerMismatchMessage } from '@/lib/quiz/utils'
import { ADAPTIVE_ONLY_TYPES, type QuizItemType } from '@/lib/validations/quiz'

export interface WizardQuestionError {
  /** 1-based position shown to the professor */
  position: number
  clientId: string
  message: string
}

/**
 * The single blocking problem with one question, phrased for an INLINE hint next
 * to the editor (no "Question N" prefix) — or null when the question is publish-
 * ready. Text-missing returns null (it's self-evident + the field is required).
 * Shared by the wizard's per-question inline warning and the whole-quiz validator.
 */
export function wizardQuestionInlineError(q: WizardQuestion): string | null {
  if (!q.questionText.trim()) return null
  switch (q.questionType) {
    case 'multiple_choice': {
      const filled = q.choices.filter((c) => c.text.trim())
      if (filled.length < 2) return 'Add at least 2 answer choices.'
      if (!filled.some((c) => c.isCorrect)) return 'Mark at least one choice as correct.'
      // Ungradeable, not just untidy: the grader demands exactly one correct id in
      // single-answer mode, so every student would be marked wrong. Mirrors the
      // superRefine on multipleChoiceContentSchema so the professor sees it inline
      // instead of hitting a rejected save. Only reachable on questions stored before
      // the editors enforced exclusivity, or written by an import/AI path.
      if (!q.allowMultiple && filled.filter((c) => c.isCorrect).length > 1) {
        return 'Only one choice can be correct — or turn on “Allow multiple correct answers”.'
      }
      return null
    }
    case 'short_answer':
      return q.acceptedAnswers.some((a) => a.value.trim()) ? null : 'Add at least one accepted answer.'
    case 'fill_in_blank': {
      if (q.blanks.length === 0) return 'Add at least one blank — click “Insert blank” where a word is missing.'
      const anyEmpty = q.blanks.some(
        (b) => b.acceptedAnswers.split(',').map((a) => a.trim()).filter(Boolean).length === 0,
      )
      if (anyEmpty) return 'Every blank needs at least one accepted answer — type it inside the blank.'
      const markers = countBlankMarkers(q.questionText)
      if (markers > 0 && markers !== q.blanks.length) {
        return blankMarkerMismatchMessage(q.blanks.length, markers)
      }
      return null
    }
    // AI-graded types: without a rubric the grader has nothing to check and
    // every answer scores 0 (grader.ts: "No rubric configured").
    case 'explanation':
      return (q.rubric ?? []).some((n) => n.concept.trim())
        ? null
        : 'Add at least one rubric concept — the AI grades answers against them.'
    case 'walkthrough':
      return (q.rubric ?? []).some((n) => n.concept.trim())
        ? null
        : 'Add at least one target insight — the tutor guides toward them and grades the conversation against them.'
    default:
      return null
  }
}

/**
 * WHY autosave must hold this question back (shown in the rail's "Not saved"
 * tooltip so a stuck marker explains itself — e.g. the correct-answer mark
 * sitting on an empty choice row is invisible otherwise), or null when the
 * question is savable. Covers every inline error PLUS empty text, which the
 * inline hint deliberately reports as null: without the text check here,
 * blanking a saved question's stem would autosave the empty text straight
 * into a (possibly published) quiz.
 */
export function wizardQuestionUnsavableReason(q: WizardQuestion): string | null {
  if (!q.questionText.trim()) return 'Add the question text.'
  return wizardQuestionInlineError(q)
}

/** True when autosave must hold this question back — editor-only until fixed. */
export function wizardQuestionUnsavable(q: WizardQuestion): boolean {
  return wizardQuestionUnsavableReason(q) !== null
}

/**
 * Validate the wizard's questions for PUBLISH (not draft). Returns one error
 * per invalid question. Rules mirror the server schema, plus two client-only
 * additions the server doesn't enforce:
 *   - "MCQ needs ≥1 correct choice" — an MCQ with no correct answer is
 *     ungradeable (every student marked wrong), so it must never be published.
 *   - "fill-in-blank `_____` markers must match the blank count" — a mismatch
 *     leaves gaps with no input, or inputs with no gap, for the student.
 */
export function validateWizardQuestions(
  questions: WizardQuestion[],
  opts?: {
    /** When explicitly false, Explanation/Walkthrough questions are blocking errors —
     *  only the adaptive engine can grade them, so a standard quiz must not publish them. */
    adaptive?: boolean
  },
): WizardQuestionError[] {
  const errors: WizardQuestionError[] = []

  questions.forEach((q, i) => {
    const position = i + 1
    const push = (message: string) => errors.push({ position, clientId: q.clientId, message })

    if (
      opts?.adaptive === false &&
      (ADAPTIVE_ONLY_TYPES as readonly QuizItemType[]).includes(q.questionType)
    ) {
      push(
        `Question ${position} is an Adaptive-only type — turn Adaptive Mode on in Settings, change its type, or remove it.`,
      )
      return
    }

    if (!q.questionText.trim()) {
      push(`Question ${position} is missing its text.`)
      return
    }

    switch (q.questionType) {
      case 'multiple_choice': {
        const filled = q.choices.filter((c) => c.text.trim())
        if (filled.length < 2) {
          push(`Question ${position} needs at least 2 answer choices.`)
        } else if (!filled.some((c) => c.isCorrect)) {
          push(`Question ${position} needs at least one correct answer marked.`)
        } else if (!q.allowMultiple && filled.filter((c) => c.isCorrect).length > 1) {
          push(
            `Question ${position} has more than one correct answer but doesn't allow multiple — students would all be marked wrong.`,
          )
        }
        break
      }
      case 'short_answer': {
        if (!q.acceptedAnswers.some((a) => a.value.trim())) {
          push(`Question ${position} needs at least one accepted answer.`)
        }
        break
      }
      case 'fill_in_blank': {
        // Reuse the inline hint verbatim so the toast and the message on the
        // card are literally the same sentence (covers missing/empty blanks and
        // the legacy `_____` marker/blank mismatch).
        const msg = wizardQuestionInlineError(q)
        if (msg) push(`Question ${position}: ${msg}`)
        break
      }
      // explanation / walkthrough: AI-graded, no answer key — but they need a
      // rubric or every answer grades 0 (reuses the inline hint verbatim).
      case 'explanation':
      case 'walkthrough': {
        const msg = wizardQuestionInlineError(q)
        if (msg) push(`Question ${position}: ${msg}`)
        break
      }
      // true_false: correctAnswer is always a boolean — nothing to validate.
      case 'true_false':
        break
    }
  })

  return errors
}
