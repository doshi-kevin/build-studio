// Data-loss regression guard: navigating away from a brand-new draft within the
// ~3s autosave debounce used to drop unsaved edits (the back control was a plain
// <Link> that navigated instantly, and the unmount cleanup only *cleared* the
// pending timer). The fix flushes the pending save on both paths:
//   - the back arrow awaits the full saveDraft() before router.push, and
//   - unmount fires the latest saveDraft (best-effort) when a timer is pending.
// These tests fail against the old Link/clear-only behavior.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QuizStudio } from '@/components/professor/quizzes/wizard/QuizStudio'
import { buildQuiz } from './helpers/test-data-builders'
import { createQuizFull } from '@/app/(dashboard)/professor/courses/[sectionId]/quizzes/actions'

// Stable, module-level push so we can assert navigation + call ordering.
const push = vi.fn()
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
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

Element.prototype.scrollIntoView = vi.fn()

const draftQuiz = () =>
  buildQuiz({
    status: 'draft',
    title: '',
    allowFormulaSheet: false,
    formulaSheetPath: null,
    proctoringEnabled: false,
    videoProctoringEnabled: false,
    adaptiveQuestionCount: 10,
    selectLambda: 0.5,
    stopMode: 'fixed',
    targetSe: 0.3,
  } as Parameters<typeof buildQuiz>[0])

// mode="create" with no quizId → draftQuizIdRef starts null, so the first flush
// goes through createQuizFull (the create path that the fast-back bug truncated).
function renderNewStudio() {
  return render(
    <QuizStudio
      sectionId="sec-1"
      mode="create"
      initialQuiz={draftQuiz()}
      initialQuestions={[]}
      allBankQuestions={[]}
    />,
  )
}

const dirtyTitle = () =>
  fireEvent.change(screen.getByLabelText('Quiz title'), {
    target: { value: 'Photosynthesis Quiz' },
  })

beforeEach(() => {
  vi.clearAllMocks()
})

describe('QuizStudio — back arrow flushes a pending save before navigating', () => {
  it('creates the draft, THEN navigates (no lost edits on a fast back click)', async () => {
    renderNewStudio()
    dirtyTitle() // schedules the debounced autosave (timer now pending)

    fireEvent.click(screen.getByRole('button', { name: 'Back to quizzes' }))

    // The save reached the server and navigation happened.
    await waitFor(() => expect(createQuizFull).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith('/professor/courses/sec-1/quizzes'),
    )
    // Ordering is the crux vs. the old <Link>: save is awaited before the push.
    const saveOrder = (createQuizFull as unknown as { mock: { invocationCallOrder: number[] } })
      .mock.invocationCallOrder[0]
    const pushOrder = push.mock.invocationCallOrder[0]
    expect(saveOrder).toBeLessThan(pushOrder)
  })

  it('an untouched studio navigates without creating a phantom draft row', async () => {
    renderNewStudio()

    fireEvent.click(screen.getByRole('button', { name: 'Back to quizzes' }))

    await waitFor(() =>
      expect(push).toHaveBeenCalledWith('/professor/courses/sec-1/quizzes'),
    )
    expect(createQuizFull).not.toHaveBeenCalled()
  })
})

describe('QuizStudio — unmount flushes a pending autosave', () => {
  it('persists edits when the studio unmounts inside the debounce window', async () => {
    const { unmount } = renderNewStudio()
    dirtyTitle() // pending timer, save not yet fired

    unmount() // navigate away before the 3s debounce elapses

    await waitFor(() => expect(createQuizFull).toHaveBeenCalledTimes(1))
  })

  it('does not create a row when an untouched studio unmounts', async () => {
    const { unmount } = renderNewStudio()
    unmount()
    // Give any microtasks a chance; the empty-draft guard must keep this quiet.
    await Promise.resolve()
    expect(createQuizFull).not.toHaveBeenCalled()
  })
})
