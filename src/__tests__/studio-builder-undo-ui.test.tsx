/**
 * Undo in the builder, in jsdom: the trigger is disabled while the undo is in flight, so
 * a second confirm can't resend the stale head, and after an undo Save offers the draft
 * the professor went back to rather than hiding.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { DraftHistory, ProgressRead } from '@/lib/studio/builder/service'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)

const actions = vi.hoisted(() => ({
  loadConversationAction: vi.fn(),
  loadDraftHistoryAction: vi.fn(),
  undoDraftAction: vi.fn(),
  saveDraftAsVersionAction: vi.fn(),
  startBuildAction: vi.fn(),
  stopBuildAction: vi.fn(),
  decideApprovalAction: vi.fn(),
  answerQuestionAction: vi.fn(),
  loadMemoriesAction: vi.fn(async () => ({ success: true, memories: [] })),
  saveMemoryAction: vi.fn(),
  removeMemoryAction: vi.fn(),
  decideMemoryAction: vi.fn(),
}))
const preview = vi.hoisted(() => ({ props: { snapshotHash: null } as { snapshotHash: string | null; note?: string } }))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('@/app/(dashboard)/professor/courses/[sectionId]/studio/actions', () => actions)
vi.mock('@/components/studio/builder/StudioPreview', () => ({
  StudioPreview: (p: { snapshotHash: string | null; note?: string }) => {
    preview.props = p
    return <p data-testid="preview">{p.snapshotHash}</p>
  },
}))
const built: ProgressRead = {
  runId: 'r2', pluginProjectId: 'p1', status: 'preview_ready', phase: 'finishing', turns: { used: 3, max: 24 }, checks: 1, repairRounds: 0,
  approval: null, question: null, endingReason: null, ending: 'Preview ready. Students won’t see this until you save it as a version and add it to the course.',
  result: { summary: null, openQuestions: [], previewHash: B, passed: true, unresolved: [], filesChanged: [], materialRead: [] }, memory: { applied: 0, proposals: [] }, events: [], lastSeq: 0,
}
vi.mock('@/components/studio/builder/use-build-run', () => ({
  useBuildRun: () => ({ progress: built, events: [], unreachable: false, refresh: vi.fn() }),
}))

const { StudioBuilder } = await import('@/components/studio/builder/StudioBuilder')

const entry = (hash: string, over: Partial<DraftHistory['entries'][number]> = {}) => ({
  hash, runId: `run-${hash[0]}`, request: 'Make flashcards', createdAt: null, current: false, undoTarget: false, savedVersion: null, ...over,
})
const beforeUndo: DraftHistory = { entries: [entry(B, { current: true }), entry(A, { undoTarget: true })], head: { hash: B, rev: 2 }, canUndo: true }
const afterUndo: DraftHistory = { entries: [entry(B), entry(A, { current: true })], head: { hash: A, rev: 3 }, canUndo: false }

let serverHistory: DraftHistory
beforeEach(() => {
  vi.clearAllMocks()
  Element.prototype.scrollIntoView = vi.fn()
  serverHistory = beforeUndo
  actions.loadConversationAction.mockResolvedValue({ success: true, turns: [] })
  actions.loadDraftHistoryAction.mockImplementation(async () => ({ success: true, ...serverHistory }))
})

function open() {
  render(
    <StudioBuilder sectionId="s1" project={{ pluginProjectId: 'p1', name: 'Flashcards', headHash: B }} runId="r2" onClose={vi.fn()} onChanged={vi.fn()} />,
  )
}

async function confirmUndo() {
  fireEvent.click(await screen.findByRole('button', { name: 'Undo last change' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Go back' }))
}

describe('undo in the builder', () => {
  it('disables the trigger while the undo is in flight, so the stale head is sent once', async () => {
    let finish: (v: unknown) => void = () => {}
    actions.undoDraftAction.mockImplementation(() => new Promise((resolve) => (finish = resolve)))
    open()
    await confirmUndo()
    const trigger = await screen.findByRole('button', { name: 'Going back…' })
    expect((trigger as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(trigger)
    expect(screen.queryByRole('button', { name: 'Go back' })).toBeNull()

    serverHistory = afterUndo
    finish({ success: true, headHash: A, rev: 3 })
    await waitFor(() => expect(screen.queryByRole('button', { name: /Going back|Undo last change/ })).toBeNull())
    expect(actions.undoDraftAction).toHaveBeenCalledTimes(1)
    expect(actions.undoDraftAction).toHaveBeenCalledWith({ sectionId: 's1', pluginProjectId: 'p1', expectedHead: B, expectedRev: 2 })
  })

  it('after an undo, previews and offers to save the earlier draft', async () => {
    actions.undoDraftAction.mockImplementation(async () => {
      serverHistory = afterUndo
      return { success: true, headHash: A, rev: 3 }
    })
    actions.saveDraftAsVersionAction.mockResolvedValue({ success: true, version: '1.0.0' })
    open()
    await confirmUndo()
    await waitFor(() => expect(preview.props.snapshotHash).toBe(A))
    expect(preview.props.note).toMatch(/still in your history/)

    // The card says Save now keeps the current draft, not the build it describes.
    expect(screen.getByText(/Saving keeps your current draft/)).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: 'Save current draft as version' }))
    await waitFor(() => expect(actions.saveDraftAsVersionAction).toHaveBeenCalledWith({ sectionId: 's1', pluginProjectId: 'p1', snapshotHash: A }))
  })

  it('does not offer Save for a current draft that already has a version', async () => {
    serverHistory = { ...beforeUndo, entries: [entry(B, { current: true, savedVersion: '1.0.0' }), entry(A, { undoTarget: true })] }
    open()
    await screen.findByRole('button', { name: 'Undo last change' })
    expect(screen.queryByRole('button', { name: /as version/ })).toBeNull()
  })
})
