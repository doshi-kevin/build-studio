// Regression: walkthrough conversation config must survive the studio's
// DB → WizardQuestion → server-input round-trip. wizardToServerInput used to
// hardcode `{ opening: '', maxTurns: 4 }`, so merely opening a quiz containing
// an AI-generated walkthrough wiped its scripted opening on the next autosave.

import { describe, it, expect } from 'vitest'
import { questionToWizard, createBlankQuestion } from '@/components/professor/quizzes/wizard/QuestionEditorCard'
import { wizardToServerInput, wizardToContentUpdate } from '@/components/professor/quizzes/wizard/QuizStudio'
import { buildQuestion } from './helpers/test-data-builders'

describe('walkthrough content round-trip', () => {
  it('preserves a stored opening and maxTurns through load → save', () => {
    const db = buildQuestion({
      id: 'q-walk',
      questionText: 'Walk me through backpropagation.',
      content: { questionType: 'walkthrough', opening: 'Start with the chain rule…', maxTurns: 6 },
    })

    const saved = wizardToServerInput(questionToWizard(db))

    expect(saved.content).toEqual({
      questionType: 'walkthrough',
      opening: 'Start with the chain rule…',
      maxTurns: 6,
    })
  })

  it('clamps authored maxTurns to the schema range (2–8)', () => {
    const q = { ...createBlankQuestion('walkthrough'), opening: 'Hi', maxTurns: 99 }
    expect(wizardToServerInput(q).content).toEqual({
      questionType: 'walkthrough',
      opening: 'Hi',
      maxTurns: 8,
    })
  })

  // The rubric editor keeps blank rows while the professor types; the server
  // schema rejects empty concepts, so save must drop them (all-blank → null).
  it('drops blank rubric rows on save; an all-blank rubric saves as null', () => {
    const q = {
      ...createBlankQuestion('walkthrough'),
      rubric: [{ concept: '  ' }, { concept: 'the inner derivative is the missing factor' }],
    }
    expect(wizardToServerInput(q).rubric).toEqual([
      { concept: 'the inner derivative is the missing factor' },
    ])
    expect(wizardToServerInput({ ...q, rubric: [{ concept: '' }] }).rubric).toBeNull()
  })

  // Regression: the UPDATE payload for already-persisted questions dropped the
  // rubric field entirely, so concepts typed after the question's first autosave
  // (which creates the row while the rubric is still blank) never reached the DB.
  it('includes the rubric in the existing-question content-update payload', () => {
    const q = {
      ...createBlankQuestion('explanation'),
      dbId: 'q-db-1',
      rubric: [{ concept: 'slope of the tangent line' }],
    }
    expect(wizardToContentUpdate(q).rubric).toEqual([{ concept: 'slope of the tangent line' }])
  })

  // Regression: the same update payload also dropped irtA/irtB, so editing the
  // difficulty (b) or discrimination (a) sliders on a saved question never
  // reached the DB — the sidebar values silently reverted.
  it('includes irtA/irtB in the existing-question content-update payload', () => {
    const q = {
      ...createBlankQuestion('multiple_choice'),
      dbId: 'q-db-2',
      irtB: 1.7,
      irtA: 2.1,
    }
    const payload = wizardToContentUpdate(q)
    expect(payload.irtB).toBe(1.7)
    expect(payload.irtA).toBe(2.1)
  })
})
