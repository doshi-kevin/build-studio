/**
 * The conversation, Save and Add to course server actions. The services own every rule
 * and are tested in studio-builder-service.test.ts and studio-lifecycle.test.ts; these
 * check the action layer itself: no session or no professor reaches no service, Add to
 * course acknowledges warnings only on an exact true, and only a real add refreshes the
 * course for professors and students.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetUser = vi.fn()
const mockRequireProfessor = vi.fn()
const mockLoadConversation = vi.fn()
const mockSaveDraftAsVersion = vi.fn()
const mockVersionRelease = vi.fn()
const mockAddSavedVersionToCourse = vi.fn()
const mockRevalidatePath = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}))
vi.mock('@/lib/studio/context', () => ({ requireProfessor: (...a: unknown[]) => mockRequireProfessor(...a) }))
vi.mock('next/cache', () => ({ revalidatePath: (...a: unknown[]) => mockRevalidatePath(...a) }))
vi.mock('@/lib/studio/builder/service', () => ({
  loadConversation: (...a: unknown[]) => mockLoadConversation(...a),
  saveDraftAsVersion: (...a: unknown[]) => mockSaveDraftAsVersion(...a),
  versionRelease: (...a: unknown[]) => mockVersionRelease(...a),
  addSavedVersionToCourse: (...a: unknown[]) => mockAddSavedVersionToCourse(...a),
}))

type Actions = typeof import('@/app/(dashboard)/professor/courses/[sectionId]/studio/actions')

const SECTION = '11111111-1111-4111-8111-111111111111'
const PROJECT = '22222222-2222-4222-8222-222222222222'
const VERSION = '33333333-3333-4333-8333-333333333333'
const INSTALLATION = '44444444-4444-4444-8444-444444444444'
const HEAD = 'b'.repeat(64)
const NOT_AVAILABLE = { error: 'This isn’t available.' }

let actions: Actions

beforeEach(async () => {
  vi.resetModules()
  for (const m of [mockGetUser, mockRequireProfessor, mockLoadConversation, mockSaveDraftAsVersion, mockVersionRelease, mockAddSavedVersionToCourse, mockRevalidatePath]) m.mockReset()
  mockGetUser.mockResolvedValue({ data: { user: { id: 'prof-1' } }, error: null })
  mockRequireProfessor.mockResolvedValue({ userId: 'prof-1', sectionId: SECTION, institutionId: 'inst-1' })
  mockLoadConversation.mockResolvedValue([])
  mockSaveDraftAsVersion.mockResolvedValue({ ok: true, value: { versionId: VERSION, version: '1.0.0' } })
  mockVersionRelease.mockResolvedValue({ ok: true, value: { mode: 'add', visible: false, installationId: null, card: {}, added: [] } })
  mockAddSavedVersionToCourse.mockResolvedValue({ ok: true, value: { installationId: INSTALLATION, added: true, checks: 'Studio’s automatic checks are running. This can take a few minutes.' } })
  actions = await import('@/app/(dashboard)/professor/courses/[sectionId]/studio/actions')
})

const calls: [string, () => Promise<unknown>, ReturnType<typeof vi.fn>][] = [
  ['loadConversationAction', () => actions.loadConversationAction({ sectionId: SECTION, pluginProjectId: PROJECT }), mockLoadConversation],
  ['saveDraftAsVersionAction', () => actions.saveDraftAsVersionAction({ sectionId: SECTION, pluginProjectId: PROJECT, snapshotHash: HEAD }), mockSaveDraftAsVersion],
  ['versionReleaseAction', () => actions.versionReleaseAction({ sectionId: SECTION, versionId: VERSION }), mockVersionRelease],
  ['addVersionToCourseAction', () => actions.addVersionToCourseAction({ sectionId: SECTION, versionId: VERSION, acknowledgeWarnings: true }), mockAddSavedVersionToCourse],
]

describe('who reaches the services', () => {
  it.each(calls)('%s: without a session, reaches no service and refreshes nothing', async (_name, act, service) => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no session' } })
    expect(await act()).toEqual(NOT_AVAILABLE)
    expect(mockRequireProfessor).not.toHaveBeenCalled()
    expect(service).not.toHaveBeenCalled()
    expect(mockRevalidatePath).not.toHaveBeenCalled()
  })

  it.each(calls)('%s: a signed-in user who isn’t the section’s professor reaches no service', async (_name, act, service) => {
    mockRequireProfessor.mockResolvedValue(null)
    expect(await act()).toEqual(NOT_AVAILABLE)
    expect(mockRequireProfessor).toHaveBeenCalledWith(SECTION)
    expect(service).not.toHaveBeenCalled()
    expect(mockRevalidatePath).not.toHaveBeenCalled()
  })

  it.each(calls)('%s: the section’s professor reaches the service once', async (_name, act, service) => {
    await act()
    expect(service).toHaveBeenCalledTimes(1)
  })
})

describe('addVersionToCourseAction', () => {
  it('acknowledges warnings only when the client sent exactly true, and passes no other field', async () => {
    const input = { sectionId: SECTION, versionId: VERSION, acknowledgeWarnings: 'yes', institutionId: 'inst-2' } as unknown as Parameters<Actions['addVersionToCourseAction']>[0]
    await actions.addVersionToCourseAction(input)
    await actions.addVersionToCourseAction({ sectionId: SECTION, versionId: VERSION, acknowledgeWarnings: true })
    expect(mockAddSavedVersionToCourse.mock.calls[0][0]).toEqual({ sectionId: SECTION, versionId: VERSION, acknowledgeWarnings: false })
    expect(mockAddSavedVersionToCourse.mock.calls[1][0]).toEqual({ sectionId: SECTION, versionId: VERSION, acknowledgeWarnings: true })
  })

  it('a refusal passes its blockers and warnings back and refreshes nothing', async () => {
    const blockers = [{ code: 'release_gate', message: 'Showing tools to students isn’t available yet.' }]
    const warnings = [{ code: 'unreleased_material', message: 'Athena read course material students can’t see yet.' }]
    mockAddSavedVersionToCourse.mockResolvedValue({ ok: false, error: 'Read the warnings before students see this version.', blockers, warnings })
    expect(await actions.addVersionToCourseAction({ sectionId: SECTION, versionId: VERSION, acknowledgeWarnings: false })).toEqual({
      error: 'Read the warnings before students see this version.',
      blockers,
      warnings,
    })
    expect(mockRevalidatePath).not.toHaveBeenCalled()
  })

  it('an added version refreshes the studio page, both course layouts and the tool’s page', async () => {
    expect(await actions.addVersionToCourseAction({ sectionId: SECTION, versionId: VERSION, acknowledgeWarnings: false })).toEqual({
      success: true,
      installationId: INSTALLATION,
      added: true,
      checks: 'Studio’s automatic checks are running. This can take a few minutes.',
    })
    expect(mockRevalidatePath.mock.calls).toEqual(
      expect.arrayContaining([
        [`/professor/courses/${SECTION}/studio`],
        [`/professor/courses/${SECTION}`, 'layout'],
        [`/student/courses/${SECTION}`, 'layout'],
        [`/professor/courses/${SECTION}/studio/${INSTALLATION}`],
      ]),
    )
  })
})
