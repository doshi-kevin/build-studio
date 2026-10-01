// Studio-level regression tests for save blocking (PR #328 review point #3):
// an invalid question must block EVERY explicit save path — the published
// quiz's "Save Changes" as well as publish — with the specific per-question
// message shown inline on the offending card, and the save server action must
// NOT fire. (The old behavior validated only at publish, after the server had
// silently dropped invalid questions with a vague "No valid questions to
// create".) Drafts have no explicit save — they autosave, and autosave
// deliberately skips still-invalid questions without nagging.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { QuizStudio } from '@/components/professor/quizzes/wizard/QuizStudio'
import { buildQuiz, buildFillInBlankQuestion } from './helpers/test-data-builders'
import { toast } from 'sonner'
import { updateQuiz, publishQuiz } from '@/app/(dashboard)/professor/courses/[sectionId]/quizzes/actions'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}))
vi.mock('@/app/(dashboard)/professor/courses/[sectionId]/quizzes/actions', () => ({
  createQuizFull: vi.fn().mockResolvedValue({ data: { id: 'quiz-1' } }),
  updateQuiz: vi.fn().mockResolvedValue({ data: {} }),
  updateQuizQuestions: vi.fn().mockResolvedValue({ success: true }),
  publishQuiz: vi.fn().mockResolvedValue({ success: true }),
  unpublishQuiz: vi.fn().mockResolvedValue({ success: true }),
  bulkCreateQuestions: vi.fn().mockResolvedValue({ data: [] }),
  bulkUpdateQuestionContent: vi.fn().mockResolvedValue({ success: true }),
  registerQuizUpload: vi.fn(),
}))
vi.mock('@/lib/supabase/storage', () => ({ deleteFile: vi.fn(), uploadFile: vi.fn() }))
vi.mock('@/components/ui/file-upload', () => ({ FileUpload: () => null }))

// jsdom has no scrollIntoView; parts of the editor scroll elements into view.
Element.prototype.scrollIntoView = vi.fn()

/** An inline fill-in-blank question whose one blank has NO accepted answer. */
function invalidFibQuestion() {
  return buildFillInBlankQuestion({
    questionText: 'The {{blank:b1}} is the powerhouse of the cell.',
    content: {
      questionType: 'fill_in_blank',
      blanks: [{ id: 'b1', acceptedAnswers: [], caseSensitive: false }],
    },
  })
}

/** The same question with the answer filled in (valid). */
function validFibQuestion() {
  return buildFillInBlankQuestion({
    questionText: 'The {{blank:b1:mitochondria}} is the powerhouse of the cell.',
    content: {
      questionType: 'fill_in_blank',
      blanks: [{ id: 'b1', acceptedAnswers: ['mitochondria'], caseSensitive: false }],
    },
  })
}

// buildQuiz leaves some studio-form fields unset; quizToFormValues copies them
// verbatim, so fill everything the form schema requires or form.trigger() fails
// before the question-validation path under test is ever reached.
const draftQuiz = (overrides: Partial<Parameters<typeof buildQuiz>[0]> = {}) =>
  buildQuiz({
    status: 'draft',
    allowFormulaSheet: false,
    formulaSheetPath: null,
    proctoringEnabled: false,
    videoProctoringEnabled: false,
    adaptiveQuestionCount: 10,
    selectLambda: 0.5,
    stopMode: 'fixed',
    targetSe: 0.3,
    ...overrides,
  } as Parameters<typeof buildQuiz>[0])

function renderStudio(
  questions = [invalidFibQuestion()],
  quiz: ReturnType<typeof draftQuiz> = draftQuiz(),
) {
  return render(
    <QuizStudio
      sectionId="sec-1"
      mode="edit"
      quizId="quiz-1"
      initialQuiz={quiz}
      initialQuestions={questions}
      allBankQuestions={[]}
    />,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('QuizStudio save blocking (all modes, not just publish)', () => {
  it("blocks a published quiz's Save Changes on an invalid question: specific toast, inline error, no server call", async () => {
    renderStudio([invalidFibQuestion()], draftQuiz({ status: 'published' }))

    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))

    // Specific per-question message, not the old vague publish-time failure
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringMatching(/question 1.*every blank needs at least one accepted answer/i),
      ),
    )
    // The same sentence appears inline on the flagged card (auto-selected in the canvas)
    expect(
      screen.getByText(/every blank needs at least one accepted answer/i),
    ).toBeInTheDocument()
    // And the save never reached the server
    expect(updateQuiz).not.toHaveBeenCalled()
  })

  it('blocks publishing via the publish dialog on an invalid question', async () => {
    renderStudio()

    // Header "Publish" opens the dialog
    fireEvent.click(screen.getByRole('button', { name: /^publish$/i }))
    const dialog = await screen.findByRole('dialog')
    // Confirm — the footer action is the last "Publish" button in the dialog
    const publishButtons = within(dialog).getAllByRole('button', { name: /^publish$/i })
    fireEvent.click(publishButtons[publishButtons.length - 1])

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringMatching(/question 1.*every blank needs at least one accepted answer/i),
      ),
    )
    expect(screen.getByText(/every blank needs at least one accepted answer/i)).toBeInTheDocument()
    // Neither the save nor the publish action fired
    expect(updateQuiz).not.toHaveBeenCalled()
    expect(publishQuiz).not.toHaveBeenCalled()
  })

  it('lets a valid question through: Save Changes reaches the server, nothing flagged', async () => {
    renderStudio([validFibQuestion()], draftQuiz({ status: 'published' }))

    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))

    await waitFor(() => expect(updateQuiz).toHaveBeenCalled())
    expect(toast.error).not.toHaveBeenCalled()
    expect(
      screen.queryByText(/every blank needs at least one accepted answer/i),
    ).not.toBeInTheDocument()
  })
})

// Redesign slice ②: the publish dialog dropped its "Save as draft" pill (drafts
// are automatic via autosave) and now confirms the quiz name at the commit
// point. Publishing an unnamed quiz would show students "Untitled quiz", so the
// dialog's confirm is gated on a non-empty title.
describe('QuizStudio publish dialog gates confirm on a quiz name', () => {
  it('disables confirm while the quiz is unnamed, enables it once a name is typed', async () => {
    render(
      <QuizStudio
        sectionId="sec-1"
        mode="edit"
        quizId="quiz-1"
        initialQuiz={draftQuiz({ title: '' })}
        initialQuestions={[validFibQuestion()]}
        allBankQuestions={[]}
      />,
    )

    // Header "Publish" opens the dialog (no validation gate at open time)
    fireEvent.click(screen.getByRole('button', { name: /^publish$/i }))
    const dialog = await screen.findByRole('dialog')

    // The footer confirm is the last "Publish" button in the dialog
    // ("Publish now" pill doesn't match the anchored /^publish$/).
    const confirm = () => {
      const btns = within(dialog).getAllByRole('button', { name: /^publish$/i })
      return btns[btns.length - 1]
    }

    // Unnamed → confirm blocked
    expect(confirm()).toBeDisabled()

    // Typing a name into the dialog's quiz-name field re-enables confirm
    fireEvent.change(within(dialog).getByLabelText(/quiz name/i), {
      target: { value: 'Midterm Quiz' },
    })
    await waitFor(() => expect(confirm()).toBeEnabled())
  })
})
