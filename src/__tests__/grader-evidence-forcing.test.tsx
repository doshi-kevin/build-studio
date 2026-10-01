// Evidence-first review, driven through the real grader UI.
//
// computeWithheldKeys (ai-grading-withheld.test.ts) proves WHICH criteria get forced.
// This file proves what the forcing actually does to the professor's session, which is
// where the feature either works or quietly becomes a rubber stamp:
//
//  - A withheld criterion arrives UNTICKED even though the AI ticked it, and Save is
//    blocked until it is decided. Without this, a half-reviewed draft commits as a
//    finished grade.
//  - Revealing the AI verdict is DISPLAY ONLY. If reveal ever also counted as a decision
//    (or applied the tick), one click would restore exactly the verdict-leads-the-evidence
//    flow the whole feature exists to break — and every other test here would still pass.
//  - Award and No-credit both resolve the criterion in one click, and they disagree about
//    the tick, so a wired-up-wrong button is visible.
//
// Driven through ProfessorAssignmentGrader because the decision state lives in the panel's
// closure; asserting on it any other way would mean testing a shape the professor's clicks
// never take.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import {
  ProfessorAssignmentGrader,
  type StudentEntry,
} from '@/components/professor/assignments/ProfessorAssignmentGrader'
import type { AiGradeSuggestion } from '@/lib/assignments/ai-grading/types'
import type { AssignmentRubric } from '@/lib/validations/assignment'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}))
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() },
}))
// Server actions: importing the real module drags 'server-only' into jsdom.
vi.mock('@/app/(dashboard)/professor/courses/[sectionId]/assignments/actions', () => ({
  gradeSubmission: vi.fn(async () => ({ success: true })),
  requestChanges: vi.fn(async () => ({ success: true })),
  resolveRegradeRequest: vi.fn(async () => ({ success: true })),
  reopenSubmission: vi.fn(async () => ({ success: true })),
  gradeStudent: vi.fn(async () => ({ success: true })),
  suggestGrades: vi.fn(async () => ({ success: true })),
}))
vi.mock('@/components/professor/assignments/athena/AssignmentAthenaDock', () => ({
  useAthenaSurface: () => {},
}))
vi.mock('@/components/professor/assignments/athena/AthenaAskLine', () => ({
  AthenaAskLine: () => null,
}))
vi.mock('@/components/assignments/SubmissionFileViewer', () => ({
  SubmissionFileViewer: () => null,
}))
vi.mock('@/components/professor/assignments/verbal/VerbalSubmissionReview', () => ({
  VerbalSubmissionReview: () => null,
}))

/** 1-point criterion takes the fast path; the 5-point one is high-stakes → withheld. */
const RUBRIC = {
  questions: [
    {
      label: 'Q1',
      points: 6,
      criteria: [
        { description: 'Cites a source', points: 1 },
        { description: 'Proves the invariant', points: 5 },
      ],
    },
  ],
} as AssignmentRubric

/** The AI ticked BOTH criteria — so any tick on 0:1 can only have come from the code. */
const SUGGESTION: AiGradeSuggestion = {
  criteria: [
    { key: '0:0', tick: true, suggestedPoints: 1, rationale: 'A source is cited.', flagged: false, evidence: '', similarity: null },
    { key: '0:1', tick: true, suggestedPoints: 5, rationale: 'The induction step is complete.', flagged: false, evidence: '', similarity: null },
  ],
  suggestedRubricScores: ['0:0', '0:1'],
  suggestedScore: 6,
  feedback: 'Solid proof, tighten the citation.',
  confidence: 'high',
  flaggedCount: 0,
  unmappedQuestionIndexes: [],
  model: 'test-model',
}

function entry(overrides: Partial<NonNullable<StudentEntry['submission']>> = {}): StudentEntry {
  return {
    id: 'stu-1',
    name: 'Ada Lovelace',
    email: 'ada@scholera.dev',
    submission: {
      id: 'sub-1',
      status: 'submitted',
      text: 'The invariant holds at each step.',
      files: [],
      score: null,
      feedback: '',
      submittedAt: '2026-09-06T10:00:00.000Z',
      updatedAt: '2026-09-06T10:00:00.000Z',
      rubricScores: [],
      suggestion: SUGGESTION,
      suggestionUpdatedAt: '2026-09-06T11:00:00.000Z',
      ...overrides,
    },
  }
}

/** Render the grader and open Ada's panel. */
function openPanel(e: StudentEntry) {
  render(
    <ProfessorAssignmentGrader
      sectionId="sec-1"
      assignmentId="asg-1"
      points={6}
      rubric={RUBRIC}
      aiGradingReady
      segments={{ needsGrading: [e], returned: [], graded: [], notSubmitted: [] }}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: /Ada Lovelace/ }))
}

const criterionRow = (name: RegExp) => screen.getByRole('button', { name })
const saveButton = () => screen.getByRole('button', { name: /Save grade/ })

beforeEach(() => {
  vi.clearAllMocks()
})

describe('evidence-first forcing in the grader panel', () => {
  it('pre-ticks the low-stakes criterion, withholds the high-stakes one, and blocks Save', async () => {
    openPanel(entry())

    // The AI ticked both. Only the cheap one is applied for the professor.
    expect(criterionRow(/Cites a source/)).toHaveAttribute('aria-pressed', 'true')
    expect(criterionRow(/Proves the invariant/)).toHaveAttribute('aria-pressed', 'false')

    // ...and the grade cannot be committed while the withheld one is undecided.
    expect(saveButton()).toBeDisabled()
    expect(screen.getByText(/Decide the 1 remaining criterion to save/)).toBeTruthy()

    // The verdict is not on screen until asked for.
    expect(screen.queryByText(/Suggests \+5/)).toBeNull()
  })

  it('reveals the AI verdict WITHOUT deciding or ticking (the rubber-stamp guard)', () => {
    openPanel(entry())

    fireEvent.click(screen.getByRole('button', { name: /AI verdict/ }))

    // The verdict and its rationale are now readable...
    expect(screen.getByText(/Suggests \+5/)).toBeTruthy()
    expect(screen.getByText(/induction step is complete/)).toBeTruthy()
    // ...but nothing was awarded, and the criterion still needs a human decision.
    expect(criterionRow(/Proves the invariant/)).toHaveAttribute('aria-pressed', 'false')
    expect(saveButton()).toBeDisabled()
    expect(screen.getByText(/Decide the 1 remaining criterion to save/)).toBeTruthy()
  })

  it('Award decides the criterion and applies the points', async () => {
    openPanel(entry())

    fireEvent.click(screen.getByRole('button', { name: /Award \+5/ }))

    expect(criterionRow(/Proves the invariant/)).toHaveAttribute('aria-pressed', 'true')
    expect(saveButton()).toBeEnabled()
  })

  it('No credit decides the criterion and leaves it unticked', async () => {
    openPanel(entry())

    fireEvent.click(screen.getByRole('button', { name: /^No credit$/ }))

    expect(criterionRow(/Proves the invariant/)).toHaveAttribute('aria-pressed', 'false')
    expect(saveButton()).toBeEnabled()
    // The decision is spent: the forcing prompt is gone, not merely satisfied once.
    expect(screen.queryByText(/remaining criteri/)).toBeNull()
  })

  it('clicking the criterion row itself counts as the decision (no dead-end for muscle memory)', async () => {
    openPanel(entry())

    fireEvent.click(criterionRow(/Proves the invariant/))

    expect(criterionRow(/Proves the invariant/)).toHaveAttribute('aria-pressed', 'true')
    expect(saveButton()).toBeEnabled()
  })

  it('leaves an already-graded submission alone — forcing is for fresh drafts only', async () => {
    // A committed grade restores its saved ticks and must not be re-gated behind a draft.
    openPanel(entry({ score: 6, rubricScores: ['0:0', '0:1'], feedback: 'Nice work' }))

    expect(criterionRow(/Proves the invariant/)).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByText(/remaining criteri/)).toBeNull()
    expect(screen.getByRole('button', { name: /Update grade/ })).toBeEnabled()
  })
})

describe('feedback pre-fill from a page-loaded suggestion', () => {
  const feedbackBox = () => screen.getByLabelText(/Feedback/i) as HTMLTextAreaElement

  it('pre-fills the AI draft on an ungraded submission, without an in-panel Suggest click', async () => {
    // The bulk-suggest-then-review flow never clicks Suggest inside the panel, so a
    // prefill that only ran on that click left the professor an empty box next to a
    // suggestion the AI had already written.
    openPanel(entry())
    expect(feedbackBox().value).toBe(SUGGESTION.feedback)
  })

  it('never overwrites feedback the professor already saved', async () => {
    openPanel(entry({ score: 4, feedback: 'My own words', rubricScores: ['0:0'] }))
    expect(feedbackBox().value).toBe('My own words')
  })
})
