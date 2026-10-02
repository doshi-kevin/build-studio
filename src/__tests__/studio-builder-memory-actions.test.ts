/**
 * The four memory server actions. The service owns every rule and is tested in
 * studio-builder-service.test.ts; these check the action layer itself: no session or no
 * professor reaches no service, a refusal passes through unchanged without refreshing the
 * page, and only a real change refreshes it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetUser = vi.fn()
const mockRequireProfessor = vi.fn()
const mockRevalidatePath = vi.fn()
const service = {
  listProjectMemories: vi.fn(),
  saveProjectMemory: vi.fn(),
  removeProjectMemory: vi.fn(),
  decideMemoryProposal: vi.fn(),
}

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })) }))
vi.mock('@/lib/studio/context', () => ({ requireProfessor: (...a: unknown[]) => mockRequireProfessor(...a) }))
vi.mock('next/cache', () => ({ revalidatePath: (...a: unknown[]) => mockRevalidatePath(...a) }))
vi.mock('@/lib/studio/builder/service', () => ({
  listProjectMemories: (...a: unknown[]) => service.listProjectMemories(...a),
  saveProjectMemory: (...a: unknown[]) => service.saveProjectMemory(...a),
  removeProjectMemory: (...a: unknown[]) => service.removeProjectMemory(...a),
  decideMemoryProposal: (...a: unknown[]) => service.decideMemoryProposal(...a),
}))

const SECTION = '11111111-1111-4111-8111-111111111111'
const PROJECT = '22222222-2222-4222-8222-222222222222'
const MEMORY = '33333333-3333-4333-8333-333333333333'
const RUN = '44444444-4444-4444-8444-444444444444'
const NOT_AVAILABLE = { error: 'This isn’t available.' }

type Actions = typeof import('@/app/(dashboard)/professor/courses/[sectionId]/studio/actions')
let actions: Actions

// Each action, its service, what a success returns and whether a success refreshes the page.
const cases = (): [string, () => Promise<unknown>, ReturnType<typeof vi.fn>, unknown, boolean][] => [
  ['loadMemoriesAction', () => actions.loadMemoriesAction({ sectionId: SECTION, pluginProjectId: PROJECT }), service.listProjectMemories, [], false],
  ['saveMemoryAction', () => actions.saveMemoryAction({ sectionId: SECTION, pluginProjectId: PROJECT, topic: 'other', kind: 'preference', statement: 'x', replaceId: null }), service.saveProjectMemory, { ok: true, value: { id: MEMORY } }, true],
  ['removeMemoryAction', () => actions.removeMemoryAction({ sectionId: SECTION, pluginProjectId: PROJECT, memoryId: MEMORY }), service.removeProjectMemory, { ok: true, value: null }, true],
  ['decideMemoryAction', () => actions.decideMemoryAction({ sectionId: SECTION, runId: RUN, memoryId: MEMORY, approve: true }), service.decideMemoryProposal, { ok: true, value: null }, true],
]

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockRequireProfessor.mockReset()
  mockRevalidatePath.mockReset()
  for (const fn of Object.values(service)) fn.mockReset()
  mockGetUser.mockResolvedValue({ data: { user: { id: 'prof-1' } }, error: null })
  mockRequireProfessor.mockResolvedValue({ userId: 'prof-1', sectionId: SECTION, institutionId: 'inst-1' })
  actions = await import('@/app/(dashboard)/professor/courses/[sectionId]/studio/actions')
})

describe('the memory actions', () => {
  it.each([0, 1, 2, 3])('without a session, case %i reaches no service and refreshes nothing', async (i) => {
    const [, call, svc] = cases()[i]
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no session' } })
    expect(await call()).toEqual(NOT_AVAILABLE)
    expect(svc).not.toHaveBeenCalled()
    expect(mockRevalidatePath).not.toHaveBeenCalled()
  })

  it.each([0, 1, 2, 3])('a signed-in user who is not the section’s professor reaches no service, case %i', async (i) => {
    const [, call, svc] = cases()[i]
    mockRequireProfessor.mockResolvedValue(null)
    expect(await call()).toEqual(NOT_AVAILABLE)
    expect(svc).not.toHaveBeenCalled()
  })

  it('a malformed section id is refused before any lookup', async () => {
    expect(await actions.loadMemoriesAction({ sectionId: 42 as unknown as string, pluginProjectId: PROJECT })).toEqual(NOT_AVAILABLE)
    expect(mockRequireProfessor).not.toHaveBeenCalled()
  })

  it.each([1, 2, 3])('a refusal from the service passes through unchanged and refreshes nothing, case %i', async (i) => {
    const [, call, svc] = cases()[i]
    svc.mockResolvedValue({ ok: false, error: 'This tool already keeps 20 decisions. Remove one first.' })
    expect(await call()).toEqual({ error: 'This tool already keeps 20 decisions. Remove one first.' })
    expect(mockRevalidatePath).not.toHaveBeenCalled()
  })

  it.each([1, 2, 3])('a success refreshes the studio page, case %i', async (i) => {
    const [, call, svc, success] = cases()[i]
    svc.mockResolvedValue(success)
    expect(await call()).toEqual({ success: true })
    expect(mockRevalidatePath).toHaveBeenCalledWith(`/professor/courses/${SECTION}/studio`)
  })

  it('loading returns the list, refreshes nothing, and a null list is the same refusal as no access', async () => {
    service.listProjectMemories.mockResolvedValueOnce([{ id: MEMORY }])
    expect(await actions.loadMemoriesAction({ sectionId: SECTION, pluginProjectId: PROJECT })).toEqual({ success: true, memories: [{ id: MEMORY }] })
    service.listProjectMemories.mockResolvedValueOnce(null)
    expect(await actions.loadMemoriesAction({ sectionId: SECTION, pluginProjectId: PROJECT })).toEqual(NOT_AVAILABLE)
    expect(mockRevalidatePath).not.toHaveBeenCalled()
  })
})
