// Guard for the generation-marker RECOVERY path — the piece that must keep
// working when the dead /quizzes/new create-mode handoff (the marker's
// `pendingRequest` overlay) is removed. A studio that lost its live stream
// (reload / navigation / a fresh tab while a run is still going) must reattach
// to the run and show the generating banner again, driven by EITHER this tab's
// gen marker OR the server's initiallyGenerating truth at page load.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QuizStudio } from '@/components/professor/quizzes/wizard/QuizStudio'
import { buildQuiz } from './helpers/test-data-builders'

// vi.hoisted so the mock factory (itself hoisted) can reference it.
const { getQuizGenerationState } = vi.hoisted(() => ({ getQuizGenerationState: vi.fn() }))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}))
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}))
vi.mock('@/app/(dashboard)/professor/courses/[sectionId]/quizzes/actions', () => ({
  createQuizFull: vi.fn().mockResolvedValue({ data: { id: 'q1' } }),
  updateQuiz: vi.fn().mockResolvedValue({ data: {} }),
  updateQuizQuestions: vi.fn().mockResolvedValue({ success: true }),
  publishQuiz: vi.fn().mockResolvedValue({ success: true }),
  unpublishQuiz: vi.fn().mockResolvedValue({ success: true }),
  deleteQuiz: vi.fn().mockResolvedValue({ success: true }),
  bulkCreateQuestions: vi.fn().mockResolvedValue({ data: [] }),
  bulkUpdateQuestionContent: vi.fn().mockResolvedValue({ success: true }),
  getQuestions: vi.fn().mockResolvedValue({ data: [] }),
  getQuizGenerationState,
  registerQuizUpload: vi.fn(),
}))
vi.mock('@/lib/roadmap/placement-actions', () => ({
  getPlacementModules: vi.fn().mockResolvedValue({ data: [] }),
  getResourcePlacement: vi.fn().mockResolvedValue({ data: null }),
  setResourcePlacement: vi.fn().mockResolvedValue({ success: true }),
}))
vi.mock('@/lib/supabase/storage', () => ({ deleteFile: vi.fn(), uploadFile: vi.fn() }))
vi.mock('@/components/ui/file-upload', () => ({ FileUpload: () => null }))

Element.prototype.scrollIntoView = vi.fn()

const draftQuiz = () => buildQuiz({ status: 'draft', title: 'Reattach Quiz' } as Parameters<typeof buildQuiz>[0])

function renderEditStudio(props: { initiallyGenerating?: boolean } = {}) {
  return render(
    <QuizStudio
      sectionId="sec-1"
      mode="edit"
      quizId="q1"
      initialQuiz={draftQuiz()}
      initialQuestions={[]}
      allBankQuestions={[]}
      {...props}
    />,
  )
}

const bannerText = /generating (questions with ai|in the background)/i

beforeEach(() => {
  vi.clearAllMocks()
  sessionStorage.clear()
  // A run in flight when the studio (re)mounts.
  getQuizGenerationState.mockResolvedValue({ data: { generating: true, questionIds: [], total: 5 } })
})

describe('QuizStudio — reattach to a detached generation', () => {
  it('reattaches from this tab’s gen marker (no pendingRequest) and shows the generating banner', async () => {
    // A plain recovery marker — the shape left AFTER a run starts (NOT the old
    // /quizzes/new handoff, which also stashed a pendingRequest).
    sessionStorage.setItem('scholera-gen-sec-1', JSON.stringify({ quizId: 'q1', at: Date.now() }))

    renderEditStudio()

    await waitFor(() => expect(getQuizGenerationState).toHaveBeenCalledWith('sec-1', 'q1'))
    expect(await screen.findByText(bannerText)).toBeInTheDocument()
  })

  it('reattaches from the server initiallyGenerating flag (fresh tab / expired marker, no marker present)', async () => {
    renderEditStudio({ initiallyGenerating: true })

    await waitFor(() => expect(getQuizGenerationState).toHaveBeenCalledWith('sec-1', 'q1'))
    expect(await screen.findByText(bannerText)).toBeInTheDocument()
  })

  it('does NOT reattach when there is no marker and the server reports no run', async () => {
    renderEditStudio({ initiallyGenerating: false })

    // Give any mount effects a tick to (not) fire.
    await waitFor(() => expect(screen.queryByText(bannerText)).not.toBeInTheDocument())
    expect(getQuizGenerationState).not.toHaveBeenCalled()
  })

  it('disables Publish while a run is in flight (Save/Publish can’t rewrite assignments mid-generation)', async () => {
    // The generation route appends batches server-side; letting Save/Publish run
    // now would rewrite the assignment set from this tab's possibly-stale view
    // and orphan just-generated questions. The button must be disabled while
    // `generating` (genActive || genReattaching).
    renderEditStudio({ initiallyGenerating: true })

    await waitFor(() => expect(getQuizGenerationState).toHaveBeenCalled())
    expect(await screen.findByText(bannerText)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^publish$/i })).toBeDisabled()
  })
})
