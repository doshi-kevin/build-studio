// Regression test for issue #175 (updated for the studio, #332 §4): the AI-graded
// question types (explanation, walkthrough) are adaptive-only — the standard linear flow
// has no chat UI or rubric grader for them, so the bank picker hides them unless the quiz
// is adaptive.
//
// The companion AI-dialog cases were removed with the dialog itself: question types are no
// longer picked from a form. Athena's equivalent guardrail — that those types require a
// rubric and Adaptive mode — is asserted in athena-quiz-adapter.test.ts and
// assignment-assistant-prompts.test.ts.

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PickFromBankDialog } from '@/components/professor/quizzes/wizard/PickFromBankDialog'
import { buildQuestion } from './helpers/test-data-builders'

describe('PickFromBankDialog question-type gating', () => {
  const bank = [
    buildQuestion({ id: 'q-mcq', questionText: 'An objective question' }),
    buildQuestion({
      id: 'q-walk',
      questionText: 'A walkthrough question',
      content: { questionType: 'walkthrough', opening: '', maxTurns: 4 },
    }),
    buildQuestion({
      id: 'q-expl',
      questionText: 'An explanation question',
      content: { questionType: 'explanation' },
    }),
  ]
  const baseProps = {
    open: true,
    onOpenChange: () => {},
    allQuestions: bank,
    existingIds: new Set<string>(),
    onAdd: () => {},
  }

  it('hides walkthrough/explanation bank questions when the quiz is not adaptive', () => {
    render(<PickFromBankDialog {...baseProps} adaptive={false} />)
    expect(screen.getByText('An objective question')).toBeInTheDocument()
    expect(screen.queryByText('A walkthrough question')).not.toBeInTheDocument()
    expect(screen.queryByText('An explanation question')).not.toBeInTheDocument()
  })

  it('shows them when the quiz is adaptive', () => {
    render(<PickFromBankDialog {...baseProps} adaptive />)
    expect(screen.getByText('A walkthrough question')).toBeInTheDocument()
    expect(screen.getByText('An explanation question')).toBeInTheDocument()
  })
})
