/**
 * The two plugin pages' own authorization: who gets a 404, and what the frame and the
 * bridge are given. The professor runtime page, and the student tools page. Their
 * dependencies are mocked; each has its own tests.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import exitTicket from '@/lib/studio/fixtures/exit-ticket/plugin.manifest.json'
import type { StudioViewer } from '@/lib/studio/context'

const NOT_FOUND = new Error('NEXT_NOT_FOUND')
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw NOT_FOUND
  },
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/auth/section-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/section-access')>()),
  verifySectionAccess: vi.fn(),
}))
vi.mock('@/lib/studio/context', () => ({ resolveViewer: vi.fn(), candidateVersion: vi.fn() }))
vi.mock('@/lib/studio/runtime/frame-ticket', () => ({ issueFrameUrl: vi.fn() }))
vi.mock('@/lib/studio/access', () => ({ studioKillSwitchEngaged: vi.fn() }))
vi.mock('@/lib/studio/student-visibility', () => ({ getPublicationPanel: vi.fn() }))

const { createClient } = await import('@/lib/supabase/server')
const { verifySectionAccess } = await import('@/lib/auth/section-access')
const { resolveViewer, candidateVersion } = await import('@/lib/studio/context')
const { issueFrameUrl } = await import('@/lib/studio/runtime/frame-ticket')
const { studioKillSwitchEngaged } = await import('@/lib/studio/access')
const { getPublicationPanel } = await import('@/lib/studio/student-visibility')
const { default: StudioRuntimePage } = await import('@/app/(dashboard)/professor/courses/[sectionId]/studio/[installationId]/page')
const { default: StudentToolPage } = await import('@/app/(dashboard)/student/courses/[sectionId]/tools/[installationId]/page')

const USER = crypto.randomUUID()
const SECTION = crypto.randomUUID()
const INSTALLATION = crypto.randomUUID()
const VERSION = crypto.randomUUID()
const viewer = {
  userId: USER,
  role: 'professor',
  sectionId: SECTION,
  installationId: INSTALLATION,
  versionId: VERSION,
  installationState: 'active',
  manifest: exitTicket,
  writable: true,
  readOnlyReason: null,
} as unknown as StudioViewer
const PANEL = {
  status: 'active' as const,
  visibility: 'hidden' as const,
  card: { name: 'Exit ticket' },
  blockers: [{ code: 'validator_unavailable', message: 'Not yet.' }],
  warnings: [],
  versions: [{ id: VERSION, version: '1.0.0' }],
}

function render(view?: string, installationId = INSTALLATION, version?: string) {
  return StudioRuntimePage({
    params: Promise.resolve({ sectionId: SECTION, installationId }),
    searchParams: Promise.resolve({ ...(view ? { view } : {}), ...(version ? { version } : {}) }),
  }) as Promise<ReactElement<Record<string, unknown>>>
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(createClient).mockResolvedValue({ auth: { getUser: async () => ({ data: { user: { id: USER } } }) } } as never)
  vi.mocked(verifySectionAccess).mockResolvedValue({ ok: true, role: 'professor', adminDb: {} })
  vi.mocked(resolveViewer).mockResolvedValue(viewer)
  vi.mocked(issueFrameUrl).mockResolvedValue('http://127.0.0.1:3000/studio-frame/v1/x/professor?t=ticket')
  vi.mocked(studioKillSwitchEngaged).mockResolvedValue(false)
  vi.mocked(getPublicationPanel).mockResolvedValue({ ok: true, value: PANEL } as never)
})

describe('who reaches the runtime page', () => {
  it.each([
    ['no session', () => vi.mocked(createClient).mockResolvedValue({ auth: { getUser: async () => ({ data: { user: null } }) } } as never)],
    ['a TA', () => vi.mocked(verifySectionAccess).mockResolvedValue({ ok: true, role: 'ta', adminDb: {} })],
    ['a grader', () => vi.mocked(verifySectionAccess).mockResolvedValue({ ok: true, role: 'grader', adminDb: {} })],
    ['no section access', () => vi.mocked(verifySectionAccess).mockResolvedValue({ ok: false, adminDb: {} })],
    ['an installation Step 3 refuses', () => vi.mocked(resolveViewer).mockResolvedValue(null)],
    ['an installation in another section', () => vi.mocked(resolveViewer).mockResolvedValue({ ...viewer, sectionId: crypto.randomUUID() } as StudioViewer)],
  ])('404s for %s, before any frame ticket is issued', async (_label, arrange) => {
    arrange()
    await expect(render()).rejects.toBe(NOT_FOUND)
    expect(issueFrameUrl).not.toHaveBeenCalled()
  })

  it('404s for an installation ID that isn’t a UUID, before any lookup', async () => {
    await expect(render(undefined, 'not-a-uuid')).rejects.toBe(NOT_FOUND)
    expect(resolveViewer).not.toHaveBeenCalled()
  })
})

describe('what the professor gets', () => {
  it('their own view on the real bridge, limited to what the manifest allows', async () => {
    const page = await render()
    expect(issueFrameUrl).toHaveBeenCalledWith(INSTALLATION, 'professor', undefined)
    expect(page.props).toMatchObject({ view: 'professor', installationId: INSTALLATION, versionId: VERSION, readOnly: false, preview: undefined })
    // The fixture's professor view declares course.skills, course.weakSpots, ui.resize and
    // ui.toast. course.weakSpots isn't a bridge method yet, so it isn't offered.
    expect(page.props.allowedMethods).toEqual([
      'context.get', 'course.skills', 'records.list', 'records.get', 'records.create', 'records.update', 'records.delete', 'ui.resize', 'ui.toast',
    ])
  })

  it('a student-view preview: the student bundle, on the preview bridge with the manifest', async () => {
    const page = await render('student')
    expect(issueFrameUrl).toHaveBeenCalledWith(INSTALLATION, 'student', undefined)
    expect(page.props).toMatchObject({ view: 'student', preview: exitTicket })
  })

  it('read-only whenever Step 3 says the professor may not write, with the reason in a sentence', async () => {
    vi.mocked(resolveViewer).mockResolvedValue({ ...viewer, writable: false, readOnlyReason: 'not_entitled' } as StudioViewer)
    const page = await render()
    expect(page.props.readOnly).toBe(true)
    expect(page.props.readOnlyNotice).toMatch(/plan no longer includes Studio/)
  })

  it('the publication panel for this section and installation, with the versions to preview', async () => {
    const page = await render()
    expect(getPublicationPanel).toHaveBeenCalledWith({ sectionId: SECTION, installationId: INSTALLATION })
    expect(page.props.publication).toMatchObject({ status: 'active', visibility: 'hidden', blockers: [{ code: 'validator_unavailable' }] })
    expect(page.props).toMatchObject({ versions: PANEL.versions, activeVersionId: VERSION })
  })

  it('no controls when the panel can’t be read, rather than wrong ones', async () => {
    vi.mocked(getPublicationPanel).mockResolvedValue({ ok: false, error: 'This isn’t available.' })
    expect((await render()).props.publication).toBeNull()
  })

  it('a paused state, not a frame, while the kill switch is engaged', async () => {
    vi.mocked(studioKillSwitchEngaged).mockResolvedValue(true)
    const page = await render()
    expect(JSON.stringify(page)).toContain('Studio is paused right now')
    expect(resolveViewer).not.toHaveBeenCalled()
    expect(issueFrameUrl).not.toHaveBeenCalled()
  })

  it('never tells a non-professor that Studio is paused: they get the same 404', async () => {
    vi.mocked(studioKillSwitchEngaged).mockResolvedValue(true)
    vi.mocked(verifySectionAccess).mockResolvedValue({ ok: true, role: 'ta', adminDb: {} })
    await expect(render()).rejects.toBe(NOT_FOUND)
  })

  it('a clear message, not a broken frame, when the runtime origin isn’t configured', async () => {
    vi.mocked(issueFrameUrl).mockResolvedValue(null)
    expect((await render()).props.frameUrl).toBeNull()
  })
})

describe('previewing another version before activating it', () => {
  const CANDIDATE = crypto.randomUUID()
  const candidateManifest = { ...exitTicket, version: '1.1.0' }

  it('signs a ticket for that version and runs it on the preview bridge', async () => {
    vi.mocked(candidateVersion).mockResolvedValue({ versionId: CANDIDATE, manifest: candidateManifest } as never)
    const page = await render(undefined, INSTALLATION, CANDIDATE)
    expect(candidateVersion).toHaveBeenCalledWith(viewer, CANDIDATE)
    expect(issueFrameUrl).toHaveBeenCalledWith(INSTALLATION, 'professor', CANDIDATE)
    expect(page.props).toMatchObject({ versionId: CANDIDATE, preview: candidateManifest, candidate: { versionId: CANDIDATE, version: '1.1.0' } })
  })

  it.each([
    ['a version Step 3 refuses', CANDIDATE],
    ['a version that isn’t a UUID', 'not-a-uuid'],
  ])('404s for %s, before any ticket is issued', async (_label, version) => {
    vi.mocked(candidateVersion).mockResolvedValue(null)
    await expect(render(undefined, INSTALLATION, version)).rejects.toBe(NOT_FOUND)
    expect(issueFrameUrl).not.toHaveBeenCalled()
  })
})

describe('the student tools page', () => {
  const student = { ...viewer, role: 'student' } as unknown as StudioViewer

  function renderStudent(installationId = INSTALLATION, sectionId = SECTION) {
    return StudentToolPage({ params: Promise.resolve({ sectionId, installationId }) }) as Promise<ReactElement<Record<string, unknown>>>
  }

  beforeEach(() => vi.mocked(resolveViewer).mockResolvedValue(student))

  it('runs the student view only, on the real bridge, limited to what the student view allows', async () => {
    const page = await renderStudent()
    expect(issueFrameUrl).toHaveBeenCalledWith(INSTALLATION, 'student')
    expect(page.props).toMatchObject({ installationId: INSTALLATION, versionId: VERSION, readOnly: false, sectionId: SECTION })
    // The fixture's student view declares context.get and ui.resize; records come with
    // its collections. Nothing class-wide.
    expect(page.props.allowedMethods).not.toContain('course.skills')
    expect(page.props).not.toHaveProperty('preview')
  })

  it.each([
    ['Step 3 refuses (hidden, not enrolled, released gate closed, kill switch)', () => vi.mocked(resolveViewer).mockResolvedValue(null)],
    ['a professor', () => vi.mocked(resolveViewer).mockResolvedValue(viewer)],
    ['an installation from another section', () => vi.mocked(resolveViewer).mockResolvedValue({ ...student, sectionId: crypto.randomUUID() } as StudioViewer)],
  ])('404s for %s, before any frame ticket is issued', async (_label, arrange) => {
    arrange()
    await expect(renderStudent()).rejects.toBe(NOT_FOUND)
    expect(issueFrameUrl).not.toHaveBeenCalled()
  })

  it('404s for an installation ID that isn’t a UUID, before any lookup', async () => {
    await expect(renderStudent('../professor')).rejects.toBe(NOT_FOUND)
    expect(resolveViewer).not.toHaveBeenCalled()
  })

  it('read-only for a student who may not write (completed enrollment, archived, lost entitlement)', async () => {
    vi.mocked(resolveViewer).mockResolvedValue({ ...student, writable: false } as StudioViewer)
    expect((await renderStudent()).props.readOnly).toBe(true)
  })
})
