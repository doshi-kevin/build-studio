/**
 * The QuizStudio ↔ Athena WRITE seam (`onAthenaFill`) — the one part of the quiz
 * Athena surface that the pure-adapter tests can't reach, because its invariants live in
 * the studio's own React state, form, and generation lifecycle.
 *
 * What each test guards, and why a refactor would be dangerous without it:
 *  1. The generation lock. A run appends questions server-side with the assignment sync
 *     suspended; an edit landing in that window can leave questions created-but-unlinked.
 *     The refusal is enforced HERE (not in the prompt), and it is the one path browser QA
 *     can't hold open on demand.
 *  2. changed=0 ⇒ applied:false. The adapter reports `changed`; the STUDIO is what turns it
 *     into "did not apply", and that's what stops Athena claiming she edited a blank canvas.
 *  3. Undo. Both fills capture their own before-state (a question array snapshot / the form
 *     values) — a fill Athena can't revert is a fill the professor can't trust.
 *  4. The refs Athena reads through. getScreen/onFill are stable callbacks, so they read
 *     `questionsRef`/`generatingRef` rather than a closure. Reverting those to plain
 *     closures would still typecheck and would silently serve a stale quiz.
 *
 * The registration path is real: the real dock provider, the real useAthenaSurface, the
 * real studio. Only the chat PANEL is stubbed — it's what hands the two callbacks over,
 * and standing up useChat here would test the SDK, not this seam.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { QuizStudio } from '@/components/professor/quizzes/wizard/QuizStudio'
import { AssignmentAthenaProvider } from '@/components/professor/assignments/athena/AssignmentAthenaDock'
import type { FillResult } from '@/components/professor/assignments/athena/AssignmentAthenaDock'
import type { AssignmentScreen, AssignmentFillTool } from '@/lib/ai/assignment-assistant/schemas'
import type { QuizOp } from '@/lib/ai/assignment-assistant/templates/registry'
import { buildQuiz, buildQuestion } from './helpers/test-data-builders'

const { getQuizGenerationState, seam } = vi.hoisted(() => ({
  getQuizGenerationState: vi.fn(),
  // Filled in by the stub panel below: the exact two callbacks the real panel is handed.
  seam: {} as {
    getScreen?: () => AssignmentScreen
    onFill?: (tool: AssignmentFillTool, payload: unknown) => FillResult
  },
}))

vi.mock('@/components/professor/assignments/athena/AssignmentAthenaPanel', () => ({
  AssignmentAthenaPanel: (props: {
    getScreen: () => AssignmentScreen
    onFill: (tool: AssignmentFillTool, payload: unknown) => FillResult
  }) => {
    seam.getScreen = props.getScreen
    seam.onFill = props.onFill
    return null
  },
}))

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

const MCQ = {
  questionType: 'multiple_choice' as const,
  questionText: 'What is 2 + 2?',
  choices: [
    { text: '4', isCorrect: true },
    { text: '5', isCorrect: false },
  ],
}

const draftQuiz = () =>
  buildQuiz({
    id: 'q1',
    status: 'draft',
    title: 'Athena Quiz',
    maxAttempts: 1,
    timeLimitMinutes: null,
    questionIds: [],
  } as Parameters<typeof buildQuiz>[0])

/** One saved question already on the quiz, so index 0 is NOT the question Athena touches. */
const EXISTING = buildQuestion({
  id: 'q-existing',
  questionText: 'Existing question',
  content: { questionType: 'true_false', correctAnswer: true },
} as Parameters<typeof buildQuestion>[0])

function renderStudio(
  props: { initiallyGenerating?: boolean; initialQuestions?: Parameters<typeof buildQuestion>[0][] } = {},
) {
  const { initialQuestions = [], ...rest } = props
  return render(
    <AssignmentAthenaProvider sectionId="sec-1">
      <QuizStudio
        sectionId="sec-1"
        mode="edit"
        quizId="q1"
        initialQuiz={draftQuiz()}
        initialQuestions={initialQuestions as Parameters<typeof QuizStudio>[0]['initialQuestions']}
        allBankQuestions={[]}
        {...rest}
      />
    </AssignmentAthenaProvider>,
  )
}

/** Call the registered fill exactly as the panel does, inside act() so the studio commits. */
function fill(tool: AssignmentFillTool, payload: unknown): FillResult {
  let res: FillResult | undefined
  act(() => {
    res = seam.onFill!(tool, payload)
  })
  return res!
}

const meta = () => seam.getScreen!().authoring?.meta ?? {}
const components = () => seam.getScreen!().authoring?.components ?? []
const insert = (question: unknown): QuizOp[] => [{ op: 'insert', question } as QuizOp]

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(async () => {
  vi.clearAllMocks()
  sessionStorage.clear()
  delete seam.onFill
  delete seam.getScreen
  getQuizGenerationState.mockResolvedValue({ data: { generating: true, questionIds: [], total: 5 } })
  // Generation posts to the streaming route; a not-ok response makes startAIGeneration bail
  // right after the request, so the request body is all we need to inspect.
  fetchMock = vi.fn().mockResolvedValue({ ok: false, body: null })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('QuizStudio — Athena registers the quiz as her surface', () => {
  it('hands the dock a getScreen + onFill for kind=quiz', async () => {
    renderStudio({ initiallyGenerating: false })
    await waitFor(() => expect(seam.onFill).toBeTypeOf('function'))
    expect(seam.getScreen).toBeTypeOf('function')
    expect(seam.getScreen!().authoring?.kind).toBe('quiz')
  })
})

describe('QuizStudio — Athena fills while a generation run is in flight', () => {
  it('refuses every tool, changes nothing, and never starts a second run', async () => {
    renderStudio({ initiallyGenerating: true })
    await waitFor(() => expect(getQuizGenerationState).toHaveBeenCalled())
    expect(await screen.findByText(/generating (questions with ai|in the background)/i)).toBeInTheDocument()
    await waitFor(() => expect(seam.onFill).toBeTypeOf('function'))

    // The snapshot Athena reads must say a run is live — that's what makes her explanation
    // to the professor match the refusal she's about to get.
    expect(meta().isGenerating).toBe(true)

    const locked = /locked while questions are generating/i
    const edits = fill('apply_edits', { ops: insert(MCQ) })
    expect(edits.applied).toBe(false)
    expect(edits.summary).toMatch(locked)
    expect(edits.undo).toBeUndefined()

    const settings = fill('set_quiz_settings', { maxAttempts: 3 })
    expect(settings.applied).toBe(false)
    expect(settings.summary).toMatch(locked)

    const gen = fill('generate_questions', { moduleItemIds: ['mi-1'], count: 5 })
    expect(gen.applied).toBe(false)
    expect(gen.summary).toMatch(locked)

    // Nothing landed on the canvas, the form, or the generation route.
    expect(components()).toHaveLength(0)
    expect(meta().maxAttempts).toBe(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('QuizStudio — apply_edits', () => {
  beforeEach(async () => {
    renderStudio({ initiallyGenerating: false, initialQuestions: [EXISTING] })
    await waitFor(() => expect(seam.onFill).toBeTypeOf('function'))
  })

  it('lands the question in real studio state, opens it in the canvas, and reverts on undo', () => {
    // The canvas opens on questions[0] by default, so it starts on the existing question.
    expect(screen.getByDisplayValue('Existing question')).toBeInTheDocument()

    const res = fill('apply_edits', { ops: insert(MCQ) })

    expect(res.applied).not.toBe(false)
    expect(res.summary).toMatch(/added 1 question/i)
    expect(components()).toHaveLength(2)
    // Only the SELECTED question renders an editor card. The inserted one is at index 1, so
    // seeing ITS stem in the question textarea proves the studio selected the question the
    // ops actually touched — a `touchedId` that doesn't exist in the committed array would
    // fall back to questions[0] and leave the professor looking at the wrong card.
    expect(screen.getByDisplayValue('What is 2 + 2?')).toBeInTheDocument()
    expect(screen.queryByDisplayValue('Existing question')).not.toBeInTheDocument()

    expect(res.undo).toBeTypeOf('function')
    act(() => res.undo!())
    expect(components()).toHaveLength(1)
    expect(screen.queryByDisplayValue('What is 2 + 2?')).not.toBeInTheDocument()
    expect(screen.getByDisplayValue('Existing question')).toBeInTheDocument()
  })

  it('reports applied:false when nothing in the batch can land, so Athena can’t claim a false success', () => {
    const res = fill('apply_edits', {
      ops: [
        { op: 'update', id: 'ghost', question: { points: 4 } },
        { op: 'insert', question: { questionText: 'no type' } },
      ] as QuizOp[],
    })

    expect(res.applied).toBe(false)
    expect(res.undo).toBeUndefined()
    expect(res.summary).toMatch(/^Nothing changed —/)
    expect(components()).toHaveLength(1)
  })

  it('refuses an empty op list', () => {
    const res = fill('apply_edits', { ops: [] })
    expect(res.applied).toBe(false)
  })

  it('refuses an undo whose snapshot is no longer safe to restore, instead of silently deleting', () => {
    // Undo restores a WHOLE array snapshot. If anything landed after the fill (a generation
    // batch appending persisted questions, or a later fill), restoring would drop it from
    // the quiz — and the next autosave's destructive assignment rewrite would unlink it for
    // real. The stale undo must decline, not delete.
    const first = fill('apply_edits', { ops: insert(MCQ) })
    fill('apply_edits', { ops: insert({ ...MCQ, questionText: 'Later arrival' }) })
    expect(components()).toHaveLength(3)

    act(() => first.undo!())

    expect(components()).toHaveLength(3)
    expect(screen.getByDisplayValue('Later arrival')).toBeInTheDocument()
  })

  it('passes the quiz’s live Adaptive setting through, so an AI-graded question warns instead of silently blocking publish', () => {
    // adaptiveMode is off on this draft. The question lands (the professor may be about to
    // turn Adaptive on) but the summary has to say it can't be saved yet — the studio is
    // what reads the current form value and hands it to the adapter.
    const res = fill('apply_edits', {
      ops: insert({
        questionType: 'explanation',
        questionText: 'Explain gradient descent.',
        rubric: [{ concept: 'iterative minimization' }],
      }),
    })

    expect(res.applied).not.toBe(false)
    expect(res.summary).toMatch(/Adaptive mode must be turned on/i)
  })
})

describe('QuizStudio — set_quiz_settings', () => {
  beforeEach(async () => {
    renderStudio({ initiallyGenerating: false })
    await waitFor(() => expect(seam.onFill).toBeTypeOf('function'))
  })

  it('writes through the studio form and puts every value back on undo', () => {
    const res = fill('set_quiz_settings', { title: 'Rewritten', maxAttempts: 3, timeLimitMinutes: 30 })

    expect(res.applied).not.toBe(false)
    expect(screen.getByLabelText('Quiz title')).toHaveValue('Rewritten')
    expect(meta()).toMatchObject({ title: 'Rewritten', maxAttempts: 3, timeLimitMinutes: 30 })

    act(() => res.undo!())
    expect(screen.getByLabelText('Quiz title')).toHaveValue('Athena Quiz')
    expect(meta().maxAttempts).toBe(1)
    // The quiz had no time limit: undo must restore the NULL, which the snapshot omits
    // rather than sending as null.
    expect(meta().timeLimitMinutes).toBeUndefined()
  })

  it('reports applied:false when the values already match', () => {
    const res = fill('set_quiz_settings', { maxAttempts: 1 })
    expect(res.applied).toBe(false)
    expect(res.undo).toBeUndefined()
  })
})

describe('QuizStudio — generate_questions', () => {
  beforeEach(async () => {
    renderStudio({ initiallyGenerating: false })
    await waitFor(() => expect(seam.onFill).toBeTypeOf('function'))
  })

  it('refuses with no source file and starts nothing', () => {
    const res = fill('generate_questions', { moduleItemIds: [], count: 10 })
    expect(res.applied).toBe(false)
    expect(res.summary).toMatch(/at least one lecture file/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('hands off to the existing streaming run, clamps the count, and offers no undo', async () => {
    // The tool schema caps count at 50, but the payload reaching this client callback is
    // model-authored — the clamp here is the only thing that actually bounds the run.
    const res = fill('generate_questions', { moduleItemIds: ['mi-1'], count: 500 })

    expect(res.applied).not.toBe(false)
    expect(res.summary).toMatch(/generating 50 questions/i)
    // A run already streaming server-side can't be reverted — no Undo affordance for it.
    expect(res.undo).toBeUndefined()

    // The lock closes on the HAND-OFF, not when `generating` finally flips: starting a run
    // does async work first (draft creation, a create-in-flight poll), and an edit arriving
    // in that window would slip past the check above.
    const raced = fill('apply_edits', { ops: insert(MCQ) })
    expect(raced.applied).toBe(false)
    expect(raced.summary).toMatch(/locked while questions are generating/i)

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }]
    expect(url).toBe('/api/quizzes/generate-stream')
    expect(JSON.parse(init.body)).toMatchObject({
      sectionId: 'sec-1',
      quizId: 'q1',
      moduleItemIds: ['mi-1'],
      questionCount: 50,
    })
  })
})
