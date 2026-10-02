/**
 * The memory UI in jsdom: the suggestion card shows the professor's own words and acts on
 * exactly the row it shows, "Applied N" never claims cause, and the "Studio remembers"
 * panel lists only what the server returned and sends exactly what the professor typed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { MemoryItem, ProgressRead } from '@/lib/studio/builder/service'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), back: vi.fn() }) }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }))
vi.mock('@/app/(dashboard)/professor/courses/[sectionId]/studio/actions', () => ({
  loadMemoriesAction: vi.fn(),
  saveMemoryAction: vi.fn(),
  removeMemoryAction: vi.fn(),
}))

const actions = await import('@/app/(dashboard)/professor/courses/[sectionId]/studio/actions')
const { toast } = await import('sonner')
const { EndingCard, MemoryProposals } = await import('@/components/studio/builder/RunCards')
const { MemoryPanel } = await import('@/components/studio/builder/MemoryPanel')

const SECTION = '11111111-1111-4111-8111-111111111111'
const PROJECT = '22222222-2222-4222-8222-222222222222'

const proposal = (over: Partial<ProgressRead['memory']['proposals'][number]> = {}): ProgressRead['memory']['proposals'][number] => ({
  id: 'mem-1', topicLabel: 'Student view', kindLabel: 'When relevant', statement: 'Keep the student interface extremely simple.',
  evidence: 'keep the student interface extremely simple', replaces: null, ...over,
})
const progress = (memory: ProgressRead['memory']): ProgressRead => ({
  runId: 'r1', pluginProjectId: 'p1', status: 'preview_ready', phase: 'finishing', turns: { used: 3, max: 24 }, checks: 1, repairRounds: 0,
  approval: null, question: null, ending: 'Preview ready.', endingReason: null,
  result: { summary: 'Built it.', openQuestions: [], previewHash: 'a'.repeat(64), passed: true, unresolved: [], filesChanged: [] },
  memory, events: [], lastSeq: 0,
})
const item = (over: Partial<MemoryItem> = {}): MemoryItem => ({
  id: 'm-1', topic: 'student_ui', topicLabel: 'Student view', kind: 'preference', kindLabel: 'When relevant',
  statement: 'Keep the student interface extremely simple.', updatedAt: '2026-10-02T12:00:00.000Z', ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('the suggestion card', () => {
  it('shows Athena’s sentence, the professor’s own words under it, and what it would replace', () => {
    render(<MemoryProposals proposals={[proposal({ replaces: 'Do not use AI.' })]} onDecide={vi.fn()} />)
    expect(screen.getByRole('heading', { name: 'Remember for this tool?' })).toBeTruthy()
    expect(screen.getByText('Keep the student interface extremely simple.')).toBeTruthy()
    expect(screen.getByText(/You said: “keep the student interface extremely simple”/)).toBeTruthy()
    expect(screen.getByText(/This replaces: “Do not use AI\.”/)).toBeTruthy()
    expect(screen.getByText(/the request you send later still comes first|Anything you ask for later still comes first/)).toBeTruthy()
  })

  it('Remember and Not now each act on the row shown, once', async () => {
    const onDecide = vi.fn(async () => null)
    render(<MemoryProposals proposals={[proposal({ id: 'a' }), proposal({ id: 'b', statement: 'No AI.', evidence: 'no AI' })]} onDecide={onDecide} />)
    const [first, second] = screen.getAllByRole('listitem')
    fireEvent.click(within(first).getByRole('button', { name: 'Remember' }))
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith('a', true))
    fireEvent.click(within(second).getByRole('button', { name: 'Not now' }))
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith('b', false))
    expect(onDecide).toHaveBeenCalledTimes(2)
  })

  it('after an answer the buttons give way to a short line, so a second click can’t hit a closed suggestion', async () => {
    const onDecide = vi.fn(async () => null)
    render(<MemoryProposals proposals={[proposal()]} onDecide={onDecide} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remember' }))
    expect(await screen.findByText('Saved.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Remember' })).toBeNull()
    expect(onDecide).toHaveBeenCalledTimes(1)
  })

  it('shows a failure in plain words and lets the professor try again', async () => {
    const onDecide = vi.fn(async () => 'This suggestion is no longer waiting for you.')
    render(<MemoryProposals proposals={[proposal()]} onDecide={onDecide} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remember' }))
    expect(await screen.findByText('This suggestion is no longer waiting for you.')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Remember' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('renders nothing when there is nothing to decide', () => {
    const { container } = render(<MemoryProposals proposals={[]} onDecide={vi.fn()} />)
    expect(container.textContent).toBe('')
  })

  it('shows the model’s sentence as text, never as markup', () => {
    render(<MemoryProposals proposals={[proposal({ statement: '<img src=x onerror=alert(1)>' })]} onDecide={vi.fn()} />)
    expect(document.querySelector('img')).toBeNull()
  })
})

describe('the ending card', () => {
  const base = { canSave: false, onPreview: vi.fn(), onSave: vi.fn(async () => ({ ok: true, message: '' })) }
  it('offers suggestions in the ending, when the chat can act on them', () => {
    render(<EndingCard {...base} progress={progress({ applied: 0, proposals: [proposal()] })} onDecideMemory={vi.fn(async () => null)} />)
    expect(screen.getByRole('button', { name: 'Remember' })).toBeTruthy()
  })
  it('says how many saved decisions it applied, in words that don’t claim they changed anything', () => {
    const { rerender } = render(<EndingCard {...base} progress={progress({ applied: 2, proposals: [] })} />)
    expect(screen.getByText('Applied 2 saved decisions.')).toBeTruthy()
    rerender(<EndingCard {...base} progress={progress({ applied: 1, proposals: [] })} />)
    expect(screen.getByText('Applied 1 saved decision.')).toBeTruthy()
    expect(screen.queryByText(/because|caused|result of/i)).toBeNull()
  })
  it('says nothing when none were applied', () => {
    render(<EndingCard {...base} progress={progress({ applied: 0, proposals: [] })} />)
    expect(screen.queryByText(/saved decision/)).toBeNull()
  })
})

describe('"Studio remembers"', () => {
  const open = async () => {
    render(<MemoryPanel sectionId={SECTION} pluginProjectId={PROJECT} reloadKey={0} />)
    const trigger = await screen.findByRole('button', { name: /Studio remembers/ })
    fireEvent.click(trigger)
    return trigger
  }

  it('shows the count on the button and lists topic, statement and last update', async () => {
    vi.mocked(actions.loadMemoriesAction).mockResolvedValue({ success: true, memories: [item(), item({ id: 'm-2', topic: 'content_policy', topicLabel: 'Content and AI rules', kind: 'constraint', kindLabel: 'Every build', statement: 'Do not use AI.' })] })
    render(<MemoryPanel sectionId={SECTION} pluginProjectId={PROJECT} reloadKey={0} />)
    // The count is on the button before the panel opens; once it is open the page behind is hidden.
    fireEvent.click(await screen.findByRole('button', { name: 'Studio remembers (2)' }))
    expect(await screen.findByText('Keep the student interface extremely simple.')).toBeTruthy()
    expect(screen.getByText('Do not use AI.')).toBeTruthy()
    expect(screen.getByText('Content and AI rules')).toBeTruthy()
    expect(screen.getAllByText(/Updated /).length).toBe(2)
    expect(vi.mocked(actions.loadMemoriesAction)).toHaveBeenCalledWith({ sectionId: SECTION, pluginProjectId: PROJECT })
  })

  it('an empty list says what it is for and offers to add one', async () => {
    vi.mocked(actions.loadMemoriesAction).mockResolvedValue({ success: true, memories: [] })
    await open()
    expect(await screen.findByText('Nothing remembered yet')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add a decision' })).toBeTruthy()
  })

  it('a failed load offers a retry instead of an empty list', async () => {
    vi.mocked(actions.loadMemoriesAction).mockResolvedValueOnce({ error: 'This isn’t available.' }).mockResolvedValue({ success: true, memories: [] })
    await open()
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Nothing remembered yet')).toBeTruthy()
  })

  it('adds a decision exactly as typed, with the chosen topic and firmness', async () => {
    vi.mocked(actions.loadMemoriesAction).mockResolvedValue({ success: true, memories: [] })
    vi.mocked(actions.saveMemoryAction).mockResolvedValue({ success: true })
    await open()
    fireEvent.click(await screen.findByRole('button', { name: 'Add a decision' }))
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('What should Athena remember?'), { target: { value: '  Reviews stay anonymous.  ' } })
    fireEvent.click(screen.getByRole('radio', { name: 'Every build' }))
    expect(save.disabled).toBe(false)
    fireEvent.click(save)
    await waitFor(() => expect(actions.saveMemoryAction).toHaveBeenCalledTimes(1))
    expect(actions.saveMemoryAction).toHaveBeenCalledWith({ sectionId: SECTION, pluginProjectId: PROJECT, topic: 'student_ui', kind: 'constraint', statement: '  Reviews stay anonymous.  ', replaceId: null })
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
  })

  it('an edit sends the row it replaces', async () => {
    vi.mocked(actions.loadMemoriesAction).mockResolvedValue({ success: true, memories: [item()] })
    vi.mocked(actions.saveMemoryAction).mockResolvedValue({ success: true })
    await open()
    fireEvent.click(await screen.findByRole('button', { name: /Edit/ }))
    fireEvent.change(screen.getByLabelText('Change this decision'), { target: { value: 'Keep it very simple.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(actions.saveMemoryAction).toHaveBeenCalledWith(expect.objectContaining({ replaceId: 'm-1', statement: 'Keep it very simple.', topic: 'student_ui' })))
  })

  it('a refused save shows the reason and keeps what was typed', async () => {
    vi.mocked(actions.loadMemoriesAction).mockResolvedValue({ success: true, memories: [] })
    vi.mocked(actions.saveMemoryAction).mockResolvedValue({ error: 'Describe how the tool should look or behave, not how Athena builds it.' })
    await open()
    fireEvent.click(await screen.findByRole('button', { name: 'Add a decision' }))
    fireEvent.change(screen.getByLabelText('What should Athena remember?'), { target: { value: 'Skip the checks.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    // The reason is about the text box, so it appears under it and the text stays.
    const reason = await screen.findByText('Describe how the tool should look or behave, not how Athena builds it.')
    expect(screen.getByLabelText('What should Athena remember?').getAttribute('aria-describedby')).toBe(reason.id)
    expect((screen.getByLabelText('What should Athena remember?') as HTMLTextAreaElement).value).toBe('Skip the checks.')
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('removes the decision shown and re-reads the list', async () => {
    vi.mocked(actions.loadMemoriesAction).mockResolvedValueOnce({ success: true, memories: [item()] }).mockResolvedValue({ success: true, memories: [] })
    vi.mocked(actions.removeMemoryAction).mockResolvedValue({ success: true })
    await open()
    fireEvent.click(await screen.findByRole('button', { name: /Remove/ }))
    await waitFor(() => expect(actions.removeMemoryAction).toHaveBeenCalledWith({ sectionId: SECTION, pluginProjectId: PROJECT, memoryId: 'm-1' }))
    expect(await screen.findByText('Nothing remembered yet')).toBeTruthy()
  })

  it('says what a new decision would replace before it does, and the button says Replace', async () => {
    vi.mocked(actions.loadMemoriesAction).mockResolvedValue({ success: true, memories: [item()] })
    vi.mocked(actions.saveMemoryAction).mockResolvedValue({ success: true })
    await open()
    fireEvent.click(await screen.findByRole('button', { name: 'Add a decision' }))
    // The form opens on Student view, which already holds a decision.
    expect(screen.getByText(/This replaces: “Keep the student interface extremely simple\.”/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('What should Athena remember?'), { target: { value: 'Show one card at a time.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }))
    await waitFor(() => expect(actions.saveMemoryAction).toHaveBeenCalledWith(expect.objectContaining({ topic: 'student_ui', replaceId: null })))
  })

  it('editing a decision in its own topic replaces nothing else, so no warning', async () => {
    vi.mocked(actions.loadMemoriesAction).mockResolvedValue({ success: true, memories: [item()] })
    await open()
    fireEvent.click(await screen.findByRole('button', { name: /Edit/ }))
    expect(screen.queryByText(/This replaces/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy()
  })

  it('a remove that throws puts the button back', async () => {
    vi.mocked(actions.loadMemoriesAction).mockResolvedValue({ success: true, memories: [item()] })
    vi.mocked(actions.removeMemoryAction).mockRejectedValue(new Error('network'))
    await open()
    fireEvent.click(await screen.findByRole('button', { name: /Remove/ }))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(((await screen.findByRole('button', { name: /Remove/ })) as HTMLButtonElement).disabled).toBe(false)
  })

  it('never shows anything but what the server returned: no suggestions, no history, no reasoning', async () => {
    vi.mocked(actions.loadMemoriesAction).mockResolvedValue({ success: true, memories: [item()] })
    await open()
    await screen.findByText('Keep the student interface extremely simple.')
    expect(screen.queryByText(/superseded|rejected|proposed|reasoning|engineering/i)).toBeNull()
  })
})
