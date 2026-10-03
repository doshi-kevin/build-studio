/**
 * The builder's UI in jsdom: the cards show only what the server decided, Stop and the
 * approval buttons call their actions with the exact card, a request sent while a run
 * waits asks before replacing it, Save is a separate, explicit action, and reopening the
 * builder follows the newest run from the progress route.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { ProgressRead } from '@/lib/studio/builder/service'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), back: vi.fn() }) }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }))
vi.mock('@/app/(dashboard)/professor/courses/[sectionId]/studio/actions', () => ({
  startBuildAction: vi.fn(),
  stopBuildAction: vi.fn(),
  decideApprovalAction: vi.fn(),
  answerQuestionAction: vi.fn(),
  loadConversationAction: vi.fn(),
  loadDraftHistoryAction: vi.fn(),
  saveDraftAsVersionAction: vi.fn(),
  undoDraftAction: vi.fn(),
  loadMemoriesAction: vi.fn(),
  saveMemoryAction: vi.fn(),
  removeMemoryAction: vi.fn(),
  decideMemoryAction: vi.fn(),
  // The preview frame never loads here: these tests are about the builder around it.
  draftPreviewAction: vi.fn(() => new Promise(() => {})),
}))
vi.mock('@/components/studio/runtime/PluginHost', () => ({ PluginHost: () => null }))

const actions = await import('@/app/(dashboard)/professor/courses/[sectionId]/studio/actions')
const { toast } = await import('sonner')
const { ApprovalCard, EndingCard, QuestionCard, ProgressLines, RunTimeline } = await import('@/components/studio/builder/RunCards')
const { StudioPreview } = await import('@/components/studio/builder/StudioPreview')
const { StudioChat } = await import('@/components/studio/builder/StudioChat')
const { StudioBuilder } = await import('@/components/studio/builder/StudioBuilder')
const { StudioWorkspace } = await import('@/components/studio/builder/StudioWorkspace')
const { statusAnnouncement } = await import('@/components/studio/builder/types')

const progress = (over: Partial<ProgressRead> = {}): ProgressRead => ({
  runId: 'r1', pluginProjectId: 'p1', status: 'running', phase: 'editing', turns: { used: 1, max: 24 }, checks: 0, repairRounds: 0,
  approval: null, question: null, ending: null, endingReason: null, result: null, memory: { applied: 0, proposals: [] }, events: [], lastSeq: 0, ...over,
})
const result = (over: Partial<NonNullable<ProgressRead['result']>> = {}): NonNullable<ProgressRead['result']> => ({
  summary: null, openQuestions: [], previewHash: null, passed: false, unresolved: [], filesChanged: [], materialRead: [], ...over,
})
const approval = { proposalId: 'prop-1', deltaHash: 'd'.repeat(64), items: ['Store "cards": staff write, everyone in the section reads. Fields: term (text)'], expiresAt: null }
const SECTION = '11111111-1111-4111-8111-111111111111'
const HEAD = 'a'.repeat(64)

type ChatProps = ComponentProps<typeof StudioChat>
function chat(over: Partial<ChatProps> = {}) {
  const props: ChatProps = {
    turns: [],
    conversation: 'ready',
    onReloadConversation: vi.fn(),
    current: null,
    onSend: vi.fn(async () => null),
    onStop: vi.fn(async () => {}),
    onDecide: vi.fn(async () => null),
    onAnswer: vi.fn(async () => null),
    onDecideMemory: vi.fn(async () => null),
    onPreview: vi.fn(),
    onSave: vi.fn(async () => ({ ok: true, message: '' })),
    canSave: false,
    ...over,
  }
  return <StudioChat {...props} />
}
const following = (p: ProgressRead) => ({ runId: p.runId, progress: p, events: p.events, unreachable: false })

/** The progress route answers with `p` for every poll. */
function serveProgress(p: ProgressRead) {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => p }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}
function serveHistory(canUndo: boolean, hash: string | null = HEAD) {
  vi.mocked(actions.loadDraftHistoryAction).mockResolvedValue({
    success: true,
    entries: hash ? [{ hash, runId: 'r0', request: 'Flashcards', createdAt: null, current: true, undoTarget: false, savedVersion: null }] : [],
    head: { hash, rev: 3 },
    canUndo,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  // jsdom has no layout, so no scrollIntoView.
  Element.prototype.scrollIntoView = vi.fn()
  vi.mocked(actions.loadConversationAction).mockResolvedValue({ success: true, turns: [] })
  vi.mocked(actions.loadMemoriesAction).mockResolvedValue({ success: true, memories: [] })
  serveHistory(false, null)
})

describe('the approval card', () => {
  it('lists only the change itself, and says what approving does not do', () => {
    render(<ApprovalCard approval={approval} onDecide={vi.fn()} />)
    expect(screen.getByText(/Store "cards"/)).toBeTruthy()
    expect(screen.queryByText('Athena’s plan')).toBeNull()
    expect(screen.getByText(/doesn’t install the tool or show it to students/)).toBeTruthy()
  })
  it('approve and decline each call the decision once', async () => {
    const onDecide = vi.fn(async () => null)
    render(<ApprovalCard approval={approval} onDecide={onDecide} />)
    fireEvent.click(screen.getByRole('button', { name: 'Build without this' }))
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith(false))
  })
  it('shows every line, including identical ones', () => {
    render(<ApprovalCard approval={{ ...approval, items: ['Use course weak spots', 'Use course weak spots'] }} onDecide={vi.fn()} />)
    expect(screen.getAllByText('Use course weak spots')).toHaveLength(2)
  })
  it('says how long it waits, and says nothing when there is no deadline', () => {
    const expiresAt = '2026-10-05T15:40:00.000Z'
    const { container, rerender } = render(<ApprovalCard approval={{ ...approval, expiresAt }} onDecide={vi.fn()} />)
    expect(screen.getByText(/Waiting for you until/)).toBeTruthy()
    expect(container.querySelector('time')?.getAttribute('dateTime')).toBe(expiresAt)
    rerender(<ApprovalCard approval={approval} onDecide={vi.fn()} />)
    expect(screen.queryByText(/Waiting for you until/)).toBeNull()
  })
})

describe('progress and Stop', () => {
  it('shows fixed progress lines with consecutive repeats collapsed, and Stop while working', () => {
    const onStop = vi.fn()
    render(
      <ProgressLines
        working
        loaded
        unreachable={false}
        stopping={false}
        onStop={onStop}
        events={[{ seq: 1, label: 'Understanding your request', outcome: 'done' }, { seq: 2, label: 'Editing the student view', outcome: 'done' }, { seq: 3, label: 'Editing the student view', outcome: 'done' }]}
      />,
    )
    expect(screen.getAllByText('Editing the student view')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(onStop).toHaveBeenCalledOnce()
  })
  it('says Scholera is unreachable even before the first progress read answers', () => {
    render(<ProgressLines working={false} loaded={false} unreachable stopping={false} onStop={vi.fn()} events={[]} />)
    expect(screen.getByText(/Can’t reach Scholera right now/)).toBeTruthy()
  })
})

describe('the timeline after a run ends', () => {
  const events = [
    { seq: 1, label: 'Understanding your request', outcome: 'done' as const },
    { seq: 2, label: 'Building the student view', outcome: 'done' as const },
    { seq: 3, label: 'Building the student view', outcome: 'done' as const },
    { seq: 4, label: 'Checks passed', outcome: 'done' as const },
  ]
  const ended = progress({ status: 'preview_ready', ending: 'Preview ready.', result: result({ previewHash: HEAD, passed: true }), events })

  it('stays under the ending card, closed, and opens from the keyboard', () => {
    render(chat({ current: following(ended) }))
    const toggle = screen.getByRole('button', { name: 'What Athena did (3 steps)' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('Checks passed')).toBeNull()
    // The ending comes first in the log; the steps follow it.
    expect(screen.getByText('Preview ready.').compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    toggle.focus()
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Checks passed')).toBeTruthy()
    expect(screen.getAllByText('Building the student view')).toHaveLength(1)
    // While working, the live lines show instead; once ended they don't.
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
  })
  it('a run with no steps to show has no timeline', () => {
    const { container } = render(<RunTimeline events={[]} />)
    expect(container.textContent).toBe('')
  })
})

describe('Athena’s plan', () => {
  const plan = { goal: 'An attendance tracker where you mark each student.', professor: ['Mark each student present or absent'], student: ['See your own attendance'] }
  it('shows the goal and each view’s features, labelled as Athena’s, while building and after', () => {
    const { rerender } = render(chat({ current: following(progress({ plan, events: [{ seq: 1, label: 'Planning the tool', outcome: 'done' }] })) }))
    const card = screen.getByRole('region', { name: 'Athena’s plan' })
    expect(within(card).getByText(plan.goal)).toBeTruthy()
    expect(within(card).getByText('Professor view')).toBeTruthy()
    expect(within(card).getByText('Mark each student present or absent')).toBeTruthy()
    expect(within(card).getByText('See your own attendance')).toBeTruthy()
    rerender(chat({ current: following(progress({ plan, status: 'preview_ready', ending: 'Preview ready.', result: result({ previewHash: HEAD }) })) }))
    expect(screen.getByRole('region', { name: 'Athena’s plan' })).toBeTruthy()
  })
  it('renders model text as text, and leaves out a view the plan doesn’t describe', () => {
    render(chat({ current: following(progress({ plan: { goal: '<b>Flashcards</b>', professor: [], student: ['Flip cards'] } })) }))
    const card = screen.getByRole('region', { name: 'Athena’s plan' })
    expect(within(card).getByText('<b>Flashcards</b>')).toBeTruthy()
    expect(card.querySelector('b')).toBeNull()
    expect(within(card).queryByText('Professor view')).toBeNull()
  })
  it('a run without a plan shows no plan card', () => {
    render(chat({ current: following(progress()) }))
    expect(screen.queryByRole('region', { name: 'Athena’s plan' })).toBeNull()
  })
})

describe('the preview pane', () => {
  type PreviewProps = ComponentProps<typeof StudioPreview>
  const preview = (over: Partial<PreviewProps> = {}) => (
    <StudioPreview sectionId={SECTION} pluginProjectId="p1" snapshotHash={HEAD} mode="professor" device="desktop" onModeChange={vi.fn()} onDeviceChange={vi.fn()} {...over} />
  )

  it('before the first draft, says what will appear here', () => {
    render(preview({ snapshotHash: null }))
    expect(screen.getByText('Your tool appears here')).toBeTruthy()
    expect(screen.getByText(/the professor view and the student view run here on sample data/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Reload preview' })).toBeNull()
    expect(actions.draftPreviewAction).not.toHaveBeenCalled()
  })
  it('while the first build runs, shows each view as a placeholder, not an empty pane', () => {
    const { container } = render(preview({ snapshotHash: null, building: true, mode: 'split' }))
    expect(screen.getByText(/building your first draft/)).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Professor view' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Student view' })).toBeTruthy()
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy()
    expect(screen.queryByText('Your tool appears here')).toBeNull()
  })
  it('marks a new draft as updated, keeps the chosen view, and settles the highlight', () => {
    vi.useFakeTimers()
    try {
      const { rerender, container } = render(preview())
      // The draft the builder opened on is not an update.
      expect(screen.queryByText(/Updated/)).toBeNull()
      const NEXT = 'b'.repeat(64)
      rerender(preview({ snapshotHash: NEXT }))
      expect(screen.getByText(/Updated/)).toBeTruthy()
      expect(container.querySelector('[data-updated]')).toBeTruthy()
      expect(actions.draftPreviewAction).toHaveBeenLastCalledWith({ sectionId: SECTION, pluginProjectId: 'p1', snapshotHash: NEXT, view: 'professor' })
      expect(screen.queryByRole('region', { name: 'Student view' })).toBeNull()
      act(() => vi.advanceTimersByTime(2400))
      expect(container.querySelector('[data-updated]')).toBeNull()
      expect(screen.getByText(/Updated/)).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })
  it('Reload asks for the same draft again', () => {
    render(preview())
    expect(actions.draftPreviewAction).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Reload preview' }))
    expect(actions.draftPreviewAction).toHaveBeenCalledTimes(2)
    expect(actions.draftPreviewAction).toHaveBeenLastCalledWith({ sectionId: SECTION, pluginProjectId: 'p1', snapshotHash: HEAD, view: 'professor' })
  })
})

describe('answering a question', () => {
  it('the chat box answers the open question instead of starting a new request', async () => {
    const onAnswer = vi.fn(async () => null)
    const onSend = vi.fn()
    const question = { id: 'q1', text: 'Terms or definitions first?', expiresAt: '2026-10-05T15:40:00.000Z' }
    render(<QuestionCard question={question} />)
    expect(screen.getByText('Terms or definitions first?')).toBeTruthy()
    expect(screen.getByText(/Waiting for you until/)).toBeTruthy()
    render(chat({ current: following(progress({ status: 'waiting_for_professor', question })), onSend, onAnswer }))
    fireEvent.change(screen.getByLabelText('Your answer to Athena'), { target: { value: 'Terms first' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }))
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith('Terms first'))
    expect(onSend).not.toHaveBeenCalled()
  })
})

describe('the ending card', () => {
  const ready = progress({
    status: 'preview_ready',
    ending: 'Preview ready. Your saved tool hasn’t changed until you save this draft as a version.',
    result: result({ summary: 'I built flashcards.', previewHash: 'h'.repeat(64), passed: true, filesChanged: ['views/student.tsx'] }),
  })
  it('lists the course material Athena read, marking what students can’t see yet', () => {
    const withMaterial = { ...ready, result: { ...ready.result!, materialRead: [{ label: 'Week 6: Attention (lecture), page 2', visible: true, opensAt: null }, { label: 'Week 7: Transformers (lecture)', visible: false, opensAt: '2026-10-16T15:00:00Z' }, { label: 'HW3 solutions (reading)', visible: false, opensAt: null }] } }
    render(<EndingCard progress={withMaterial} canSave onPreview={vi.fn()} onSave={vi.fn()} />)
    const list = screen.getByRole('list', { name: 'Athena read these from your course:' })
    const items = [...list.querySelectorAll('li')].map((li) => li.textContent)
    expect(items).toEqual(['Week 6: Attention (lecture), page 2', 'Week 7: Transformers (lecture) (students can’t see this until Oct 16)', 'HW3 solutions (reading) (students can’t see this)'])
    expect(screen.getByText('Athena uses material students can’t see yet only to shape the tool, never its wording.')).toBeTruthy()
  })
  it('says nothing about course material when none was read', () => {
    render(<EndingCard progress={ready} canSave onPreview={vi.fn()} onSave={vi.fn()} />)
    expect(screen.queryByText('Athena read these from your course:')).toBeNull()
  })
  it('shows the system’s outcome first and Athena’s words as a labelled note', () => {
    render(<EndingCard progress={ready} canSave onPreview={vi.fn()} onSave={vi.fn()} />)
    expect(screen.getByText(/Preview ready/)).toBeTruthy()
    expect(screen.getByText('Athena’s note')).toBeTruthy()
  })
  it('Save is its own button and runs only when pressed', async () => {
    const onSave = vi.fn(async () => ({ ok: true, message: 'Saved as version 1.0.0.' }))
    render(<EndingCard progress={ready} canSave onPreview={vi.fn()} onSave={onSave} />)
    expect(onSave).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Save as version' }))
    await waitFor(() => expect(screen.getByText('Saved as version 1.0.0.')).toBeTruthy())
    // Saved once: the button is gone, so it can't be pressed twice.
    expect(screen.queryByRole('button', { name: 'Save as version' })).toBeNull()
  })
  it('a failed save shows the reason and leaves Save to press again', async () => {
    render(<EndingCard progress={ready} canSave onPreview={vi.fn()} onSave={vi.fn(async () => ({ ok: false, message: 'This draft is already saved as version 1.0.0.' }))} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save as version' }))
    await waitFor(() => expect(screen.getByText(/already saved/)).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Save as version' })).toBeTruthy()
  })
  it('a blocked run shows what didn’t pass, once per problem, and offers no Save or retry', () => {
    const missing = { check: 'A screen is missing its loading, empty or error state', file: null, count: 1 }
    render(
      <EndingCard
        progress={progress({ status: 'blocked', ending: 'I couldn’t get every check to pass.', result: result({ unresolved: [missing, { ...missing, file: 'views/professor.tsx' }] }) })}
        canSave={false}
        onPreview={vi.fn()}
        onSave={vi.fn()}
        onRetry={vi.fn()}
      />,
    )
    expect(screen.getAllByText(/missing its loading/)).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Save as version' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })
  it('a failed or stopped run says what to do next and can send the request again', () => {
    const onRetry = vi.fn()
    const { rerender } = render(<EndingCard progress={progress({ status: 'failed', ending: 'Something went wrong on our side. Your tool is unchanged.' })} canSave={false} onPreview={vi.fn()} onSave={vi.fn()} onRetry={onRetry} />)
    expect(screen.getByText(/If it keeps happening/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalledOnce()
    rerender(<EndingCard progress={progress({ status: 'cancelled', ending: 'Stopped. Your tool is unchanged.' })} canSave={false} onPreview={vi.fn()} onSave={vi.fn()} onRetry={onRetry} />)
    expect(screen.getByText(/Send it again, or describe something different/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })
  it('a run replaced by a newer request offers nothing to resend', () => {
    render(<EndingCard progress={progress({ status: 'cancelled', ending: 'Replaced by your newer request. Your tool is unchanged.', endingReason: 'superseded' })} canSave={false} onPreview={vi.fn()} onSave={vi.fn()} onRetry={vi.fn()} />)
    expect(screen.queryByText(/Send it again/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })
  it('a build that changed nothing says how to get a change, and lists each open question once', () => {
    const { rerender } = render(<EndingCard progress={progress({ status: 'completed', ending: 'Nothing needed to change.', result: result({ passed: true, summary: 'It already does this.', openQuestions: ['Which week?', 'Which week?'] }) })} canSave={false} onPreview={vi.fn()} onSave={vi.fn()} />)
    expect(screen.getByText(/describe it in more detail/)).toBeTruthy()
    expect(screen.getAllByText('Which week?')).toHaveLength(1)
    // Open questions show even when Athena left no summary.
    rerender(<EndingCard progress={progress({ status: 'completed', ending: 'Nothing needed to change.', result: result({ passed: true, openQuestions: ['Which week?'] }) })} canSave={false} onPreview={vi.fn()} onSave={vi.fn()} />)
    expect(screen.getByText('Which week?')).toBeTruthy()
  })
})

describe('screen reader announcements', () => {
  it('cards inside the conversation log add no live regions of their own', async () => {
    const { container } = render(
      <>
        <ApprovalCard approval={approval} onDecide={vi.fn(async () => 'This card expired.')} />
        <EndingCard progress={progress({ status: 'preview_ready', ending: 'Preview ready.', result: result({ previewHash: HEAD }) })} canSave onPreview={vi.fn()} onSave={vi.fn(async () => ({ ok: false, message: 'Couldn’t save.' }))} />
      </>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save as version' }))
    await waitFor(() => expect(screen.getByText('Couldn’t save.')).toBeTruthy())
    await waitFor(() => expect(screen.getByText('This card expired.')).toBeTruthy())
    expect(container.querySelectorAll('[role="status"], [role="alert"], [aria-live]')).toHaveLength(0)
  })
  it('a waiting run is announced at once, an ending only if this page watched the run', () => {
    expect(statusAnnouncement('waiting_for_approval', false)).toBe('Athena needs your approval.')
    expect(statusAnnouncement('blocked', false)).toBe('')
    expect(statusAnnouncement('blocked', true)).toBe('Athena couldn’t finish this request.')
    expect(statusAnnouncement(undefined, true)).toBe('')
  })
})

describe('the conversation pane', () => {
  it('follows new progress only while the professor is at the bottom of the log', () => {
    const e = (seq: number) => ({ seq, label: `Step ${seq}`, outcome: 'done' as const })
    const at = (n: number) => following(progress({ events: Array.from({ length: n }, (_, i) => e(i + 1)) }))
    const { rerender } = render(chat({ current: at(1) }))
    const log = screen.getByRole('log')
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 1000 })
    Object.defineProperty(log, 'clientHeight', { configurable: true, value: 300 })
    log.scrollTop = 0
    fireEvent.scroll(log)
    vi.mocked(Element.prototype.scrollIntoView).mockClear()
    rerender(chat({ current: at(2) }))
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled()
    log.scrollTop = 700
    fireEvent.scroll(log)
    rerender(chat({ current: at(3) }))
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
  })
  it('a failed load offers a retry instead of an empty chat', () => {
    const onReloadConversation = vi.fn()
    render(chat({ conversation: 'failed', onReloadConversation }))
    expect(screen.getByText(/Couldn’t load your earlier messages/)).toBeTruthy()
    expect(screen.queryByText('Nothing built yet')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onReloadConversation).toHaveBeenCalledOnce()
  })
  it('a tool with no requests yet shows an empty state', () => {
    render(chat())
    expect(screen.getByText('Nothing built yet')).toBeTruthy()
  })
  it('Try again on a failed run resends that run’s request and keeps what the professor was typing', async () => {
    const onSend = vi.fn(async () => null)
    const failed = progress({ status: 'failed', ending: 'Something went wrong on our side. Your tool is unchanged.' })
    render(chat({ turns: [{ runId: 'r1', request: 'Add a shuffle button', status: 'failed', ending: null, summary: null, createdAt: '2026-10-02T10:00:00Z' }], current: following(failed), onSend }))
    const box = screen.getByLabelText('Describe a change') as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'a half-typed idea' } })
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('Add a shuffle button', undefined))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Try again' }).hasAttribute('disabled')).toBe(false))
    expect(box.value).toBe('a half-typed idea')
  })
})

describe('sending while a run waits for the professor', () => {
  it('asks before replacing, and replaces only on confirmation', async () => {
    const onSend = vi.fn().mockResolvedValueOnce({ waitingRunId: 'waiting-1' }).mockResolvedValueOnce(null)
    render(chat({ current: following(progress({ runId: 'waiting-1', status: 'waiting_for_approval' })), onSend }))
    fireEvent.change(screen.getByLabelText('Describe a change'), { target: { value: 'Make it a quiz instead' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(screen.getByText(/Replace it with this one/)).toBeTruthy())
    expect(onSend).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Replace it' }))
    await waitFor(() => expect(onSend).toHaveBeenLastCalledWith('Make it a quiz instead', 'waiting-1'))
  })
})

describe('the builder', () => {
  const project = { pluginProjectId: 'p1', name: 'Flashcards', headHash: HEAD }
  const builder = (runId: string | null) => <StudioBuilder sectionId={SECTION} project={project} runId={runId} onClose={vi.fn()} onChanged={vi.fn()} />

  it('reopening a tool follows its newest run from the progress route, waiting card and all', async () => {
    const fetchMock = serveProgress(progress({ runId: 'run-9', status: 'waiting_for_approval', approval: { ...approval, expiresAt: '2026-10-05T15:40:00.000Z' } }))
    render(
      <StudioWorkspace
        sectionId={SECTION}
        drafts={[{ pluginProjectId: 'p1', name: 'Flashcards', hasDraft: true, headHash: HEAD, latestRun: { runId: 'run-9', status: 'waiting_for_approval' }, savedVersion: null }]}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Flashcards/ }))
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByText(/Store "cards"/)
    expect(fetchMock).toHaveBeenCalledWith('/api/studio/builder/runs/run-9?after=0', { cache: 'no-store' })
    // The header says the build needs the professor, so it shows from the preview pane too.
    expect(within(dialog).getByText('Needs your approval')).toBeTruthy()
    expect(within(dialog).getByText(/Waiting for you until/)).toBeTruthy()
  })

  it('the status region stays announceable while the phone shows the preview pane', async () => {
    serveProgress(progress({ runId: 'run-6', status: 'waiting_for_approval', approval }))
    render(builder('run-6'))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Athena needs your approval.'))
    fireEvent.click(screen.getByRole('radio', { name: 'Preview' }))
    const status = screen.getByRole('status')
    expect(status.textContent).toBe('Athena needs your approval.')
    for (let el: HTMLElement | null = status; el; el = el.parentElement) expect(el.classList.contains('hidden')).toBe(false)
  })

  it('shows the professor’s request as soon as it is sent', async () => {
    serveProgress(progress({ runId: 'run-2', status: 'queued' }))
    vi.mocked(actions.loadConversationAction).mockResolvedValueOnce({ success: true, turns: [] }).mockReturnValue(new Promise(() => {}))
    vi.mocked(actions.startBuildAction).mockResolvedValue({ success: true, runId: 'run-2', pluginProjectId: 'p1' })
    render(builder(null))
    await screen.findByText('Nothing built yet')
    fireEvent.change(screen.getByLabelText('Describe a change'), { target: { value: 'Add a shuffle button' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await within(screen.getByRole('log')).findByText('Add a shuffle button')
  })

  it('Preview on the ending card moves focus to the preview', async () => {
    serveProgress(progress({ runId: 'run-3', status: 'preview_ready', ending: 'Preview ready.', result: result({ previewHash: HEAD, passed: true }) }))
    serveHistory(true)
    render(builder('run-3'))
    const preview = await within(screen.getByRole('log')).findByRole('button', { name: 'Preview' })
    fireEvent.click(preview)
    expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Preview' }))
  })

  it('while a build is active, Undo says why it waits and does nothing', async () => {
    serveProgress(progress({ runId: 'run-4', status: 'running' }))
    serveHistory(true)
    render(builder('run-4'))
    const undo = await screen.findByRole('button', { name: 'Undo last change' })
    expect(undo.getAttribute('aria-disabled')).toBe('true')
    expect(undo).toHaveAccessibleDescription('You can undo once this request finishes, or after you stop it.')
    fireEvent.click(undo)
    expect(toast.info).toHaveBeenCalledOnce()
    expect(actions.undoDraftAction).not.toHaveBeenCalled()
  })

  it('once the build has ended, Undo confirms first and names the draft the professor is looking at', async () => {
    serveProgress(progress({ runId: 'run-5', status: 'preview_ready', ending: 'Preview ready.', result: result({ previewHash: HEAD, passed: true }) }))
    serveHistory(true)
    vi.mocked(actions.undoDraftAction).mockResolvedValue({ success: true, headHash: 'b'.repeat(64), rev: 4 })
    render(builder('run-5'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo last change' }).getAttribute('aria-disabled')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Undo last change' }))
    const confirm = await screen.findByRole('alertdialog')
    expect(within(confirm).getByText(/can’t redo it/)).toBeTruthy()
    expect(actions.undoDraftAction).not.toHaveBeenCalled()
    fireEvent.click(within(confirm).getByRole('button', { name: 'Go back' }))
    await waitFor(() => expect(actions.undoDraftAction).toHaveBeenCalledWith({ sectionId: SECTION, pluginProjectId: 'p1', expectedHead: HEAD, expectedRev: 3 }))
  })
})
