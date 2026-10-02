/**
 * The undo and draft-history server actions. The service owns every rule and is tested
 * in studio-builder-undo.test.ts; these check the action layer itself: no session or no
 * professor reaches no service, a refusal passes through unchanged, and only a real undo
 * refreshes the page.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetUser = vi.fn()
const mockRequireProfessor = vi.fn()
const mockUndoDraft = vi.fn()
const mockListDraftHistory = vi.fn()
const mockRevalidatePath = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}))
vi.mock('@/lib/studio/context', () => ({ requireProfessor: (...a: unknown[]) => mockRequireProfessor(...a) }))
vi.mock('next/cache', () => ({ revalidatePath: (...a: unknown[]) => mockRevalidatePath(...a) }))
vi.mock('@/lib/studio/builder/service', () => ({
  undoDraft: (...a: unknown[]) => mockUndoDraft(...a),
  listDraftHistory: (...a: unknown[]) => mockListDraftHistory(...a),
  answerQuestion: vi.fn(),
  decideApproval: vi.fn(),
  issueDraftPreview: vi.fn(),
  loadConversation: vi.fn(),
  saveDraftAsVersion: vi.fn(),
  startBuild: vi.fn(),
  stopBuild: vi.fn(),
}))

const SECTION = '11111111-1111-4111-8111-111111111111'
const PROJECT = '22222222-2222-4222-8222-222222222222'
const HEAD = 'b'.repeat(64)
const NOT_AVAILABLE = { error: 'This isn’t available.' }
const undoInput = { sectionId: SECTION, pluginProjectId: PROJECT, expectedHead: HEAD, expectedRev: 2 }

let undoDraftAction: typeof import('@/app/(dashboard)/professor/courses/[sectionId]/studio/actions').undoDraftAction
let loadDraftHistoryAction: typeof import('@/app/(dashboard)/professor/courses/[sectionId]/studio/actions').loadDraftHistoryAction

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockRequireProfessor.mockReset()
  mockUndoDraft.mockReset()
  mockListDraftHistory.mockReset()
  mockRevalidatePath.mockReset()
  mockGetUser.mockResolvedValue({ data: { user: { id: 'prof-1' } }, error: null })
  mockRequireProfessor.mockResolvedValue({ userId: 'prof-1', sectionId: SECTION, institutionId: 'inst-1' })
  const mod = await import('@/app/(dashboard)/professor/courses/[sectionId]/studio/actions')
  undoDraftAction = mod.undoDraftAction
  loadDraftHistoryAction = mod.loadDraftHistoryAction
})

describe('undoDraftAction', () => {
  it('without a session, reaches no service and refreshes nothing', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no session' } })
    expect(await undoDraftAction(undoInput)).toEqual(NOT_AVAILABLE)
    expect(mockUndoDraft).not.toHaveBeenCalled()
    expect(mockRevalidatePath).not.toHaveBeenCalled()
  })

  it('a signed-in user who isn’t the section’s professor reaches no service', async () => {
    mockRequireProfessor.mockResolvedValue(null)
    expect(await undoDraftAction(undoInput)).toEqual(NOT_AVAILABLE)
    expect(mockUndoDraft).not.toHaveBeenCalled()
  })

  it('a malformed section id is refused before any lookup', async () => {
    expect(await undoDraftAction({ ...undoInput, sectionId: 42 as unknown as string })).toEqual(NOT_AVAILABLE)
    expect(mockRequireProfessor).not.toHaveBeenCalled()
    expect(mockUndoDraft).not.toHaveBeenCalled()
  })

  it('a service refusal passes through as is, and the page isn’t refreshed', async () => {
    mockUndoDraft.mockResolvedValue({ ok: false, error: 'This draft changed since you opened it. Look at the latest draft, then try again.' })
    expect(await undoDraftAction(undoInput)).toEqual({ error: 'This draft changed since you opened it. Look at the latest draft, then try again.' })
    expect(mockRevalidatePath).not.toHaveBeenCalled()
  })

  it('a real undo returns the new head and revision and refreshes the studio page', async () => {
    mockUndoDraft.mockResolvedValue({ ok: true, value: { headHash: 'a'.repeat(64), rev: 3 } })
    expect(await undoDraftAction(undoInput)).toEqual({ success: true, headHash: 'a'.repeat(64), rev: 3 })
    expect(mockUndoDraft).toHaveBeenCalledWith(undoInput)
    expect(mockRevalidatePath).toHaveBeenCalledWith(`/professor/courses/${SECTION}/studio`)
  })
})

describe('loadDraftHistoryAction', () => {
  it('without a session, reaches no service', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null })
    expect(await loadDraftHistoryAction({ sectionId: SECTION, pluginProjectId: PROJECT })).toEqual(NOT_AVAILABLE)
    expect(mockListDraftHistory).not.toHaveBeenCalled()
  })

  it('a history the service won’t give (not the owner, a failed read) is the same refusal', async () => {
    mockListDraftHistory.mockResolvedValue(null)
    expect(await loadDraftHistoryAction({ sectionId: SECTION, pluginProjectId: PROJECT })).toEqual(NOT_AVAILABLE)
  })

  it('returns the history with its head and undo flag', async () => {
    const history = { entries: [], head: { hash: HEAD, rev: 2 }, canUndo: true }
    mockListDraftHistory.mockResolvedValue(history)
    expect(await loadDraftHistoryAction({ sectionId: SECTION, pluginProjectId: PROJECT })).toEqual({ success: true, ...history })
  })
})
