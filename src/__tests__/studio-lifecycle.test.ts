/**
 * Lifecycle wrappers, with the professor context and database layer mocked. The
 * database's own refusals are tested in db/studio-storage.test.ts; here we check who
 * may call what, what reaches the database, and how refusals are explained.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import exitTicket from '@/lib/studio/fixtures/exit-ticket/plugin.manifest.json'
import type { StudioProfessor } from '@/lib/studio/context'

vi.mock('@/lib/studio/context', () => ({ requireProfessor: vi.fn() }))
vi.mock('@/lib/studio/db', () => ({
  loadProject: vi.fn(),
  loadVersion: vi.fn(),
  loadInstallation: vi.fn(),
  insertProject: vi.fn(),
  insertVersion: vi.fn(),
  installPlugin: vi.fn(),
  activateVersion: vi.fn(),
  archiveInstallation: vi.fn(),
  archiveProject: vi.fn(),
}))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))

const { requireProfessor } = await import('@/lib/studio/context')
const db = await import('@/lib/studio/db')
const { logEvent } = await import('@/lib/supabase/event-logger')
const lifecycle = await import('@/lib/studio/lifecycle')
const { LIFECYCLE_NOT_AVAILABLE } = lifecycle

const PROFESSOR = { userId: crypto.randomUUID(), sectionId: crypto.randomUUID(), institutionId: crypto.randomUUID() }
const PROJECT = crypto.randomUUID()
const VERSION = crypto.randomUUID()
const INSTALLATION = crypto.randomUUID()

const ownProject = {
  id: PROJECT,
  institutionId: PROFESSOR.institutionId,
  ownerId: PROFESSOR.userId,
  slug: 'exit-ticket',
  status: 'active' as const,
}
const publishInput = {
  sectionId: PROFESSOR.sectionId,
  projectId: PROJECT,
  manifest: exitTicket,
  source: { 'views/student.tsx': 'export default () => null' },
  studentBundle: 'student()',
  professorBundle: 'professor()',
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireProfessor).mockResolvedValue(PROFESSOR as StudioProfessor)
  vi.mocked(db.loadProject).mockResolvedValue(ownProject)
  vi.mocked(db.insertVersion).mockResolvedValue({ ok: true, value: VERSION })
  vi.mocked(db.loadVersion).mockResolvedValue({
    id: VERSION,
    projectId: PROJECT,
    institutionId: PROFESSOR.institutionId,
    version: '1.0.0',
    manifest: exitTicket,
  })
  vi.mocked(db.installPlugin).mockResolvedValue({ ok: true, value: INSTALLATION })
  vi.mocked(db.loadInstallation).mockResolvedValue({
    id: INSTALLATION,
    institutionId: PROFESSOR.institutionId,
    sectionId: PROFESSOR.sectionId,
    projectId: PROJECT,
    status: 'active',
    currentVersionId: VERSION,
  })
  vi.mocked(db.activateVersion).mockResolvedValue({ ok: true, value: null })
})

describe('who may act', () => {
  it('refuses anyone requireProfessor refuses, before touching the database', async () => {
    vi.mocked(requireProfessor).mockResolvedValue(null)
    expect(await lifecycle.publishVersion(publishInput)).toEqual({ ok: false, error: LIFECYCLE_NOT_AVAILABLE })
    expect(db.loadProject).not.toHaveBeenCalled()
  })

  it('refuses to publish another professor’s project', async () => {
    vi.mocked(db.loadProject).mockResolvedValue({ ...ownProject, ownerId: crypto.randomUUID() })
    expect(await lifecycle.publishVersion(publishInput)).toEqual({ ok: false, error: LIFECYCLE_NOT_AVAILABLE })
    expect(db.insertVersion).not.toHaveBeenCalled()
  })

  it('refuses to install a version of a project the professor doesn’t own', async () => {
    vi.mocked(db.loadProject).mockResolvedValue({ ...ownProject, ownerId: crypto.randomUUID() })
    expect(await lifecycle.installPlugin({ sectionId: PROFESSOR.sectionId, versionId: VERSION }).then((r) => r.ok)).toBe(false)
    expect(db.installPlugin).not.toHaveBeenCalled()
  })

  it('refuses to change an installation in another section', async () => {
    vi.mocked(db.loadInstallation).mockResolvedValue({
      id: INSTALLATION,
      institutionId: PROFESSOR.institutionId,
      sectionId: crypto.randomUUID(),
      projectId: PROJECT,
      status: 'active',
      currentVersionId: VERSION,
    })
    const input = { sectionId: PROFESSOR.sectionId, installationId: INSTALLATION, versionId: VERSION }
    expect((await lifecycle.rollbackVersion(input)).ok).toBe(false)
    expect((await lifecycle.archiveInstallation({ sectionId: PROFESSOR.sectionId, installationId: INSTALLATION })).ok).toBe(false)
    expect(db.activateVersion).not.toHaveBeenCalled()
    expect(db.archiveInstallation).not.toHaveBeenCalled()
  })

  it('refuses a request that tries to name the actor', async () => {
    const result = await lifecycle.installPlugin({ sectionId: PROFESSOR.sectionId, versionId: VERSION, actorId: crypto.randomUUID() } as never)
    expect(result.ok).toBe(false)
    expect(requireProfessor).not.toHaveBeenCalled()
  })
})

describe('what reaches the database', () => {
  it('publish validates the manifest first and returns its issues', async () => {
    const result = await lifecycle.publishVersion({ ...publishInput, manifest: { ...exitTicket, views: { student: exitTicket.views.student } } })
    expect(result).toMatchObject({ ok: false, issues: ['views.professor: Every plugin needs a professor view'] })
    expect(db.insertVersion).not.toHaveBeenCalled()
  })

  it('publish takes version and bridge from the manifest and the publisher from the session', async () => {
    await lifecycle.publishVersion(publishInput)
    expect(db.insertVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT,
        institutionId: PROFESSOR.institutionId,
        version: '1.0.0',
        bridgeVersion: 'v1',
        publishedBy: PROFESSOR.userId,
        bundleSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    )
  })

  it('install, upgrade and rollback pass the session professor as the actor', async () => {
    await lifecycle.installPlugin({ sectionId: PROFESSOR.sectionId, versionId: VERSION })
    const input = { sectionId: PROFESSOR.sectionId, installationId: INSTALLATION, versionId: VERSION }
    await lifecycle.approveAndActivateVersion(input)
    await lifecycle.rollbackVersion(input)

    expect(db.installPlugin).toHaveBeenCalledWith(PROFESSOR.sectionId, VERSION, PROFESSOR.userId)
    expect(vi.mocked(db.activateVersion).mock.calls).toEqual([
      [INSTALLATION, VERSION, PROFESSOR.userId, true],
      [INSTALLATION, VERSION, PROFESSOR.userId, false],
    ])
    expect(vi.mocked(logEvent).mock.calls.map(([e]) => e.eventType)).toEqual([
      'studio.plugin.installed',
      'studio.version.activated',
      'studio.version.rolled_back',
    ])
  })
})

describe('database refusals in plain language', () => {
  it.each([
    ['Version 1.0.5 must be higher than the last published version 1.1.0', '23514', /higher than the last one/],
    ['Collection responses changed or was removed; breaking collection changes aren\'t supported yet', '23514', /add new ones instead/],
    ['insert or update violates foreign key constraint "studio_plugin_installations_current_version_approved"', '23503', /can’t be used here/],
    ['something unexpected', 'XX000', /Something went wrong/],
  ])('%s', async (message, code, expected) => {
    vi.mocked(db.insertVersion).mockResolvedValue({ ok: false, error: { code, message } })
    const result = await lifecycle.publishVersion(publishInput)
    expect(result).toEqual({ ok: false, error: expect.stringMatching(expected) })
    expect(logEvent).not.toHaveBeenCalled()
  })

  it('explains duplicates from the classification db.ts gives, not from constraint names', async () => {
    vi.mocked(db.installPlugin).mockResolvedValue({ ok: false, error: { code: '23505', message: 'x', duplicate: 'installation' } })
    expect(await lifecycle.installPlugin({ sectionId: PROFESSOR.sectionId, versionId: VERSION })).toEqual({
      ok: false,
      error: 'This plugin is already installed in this course.',
    })
  })

  it('archiving an installation that is already archived is refused, not reported as done', async () => {
    vi.mocked(db.archiveInstallation).mockResolvedValue({ ok: true, value: false })
    expect(await lifecycle.archiveInstallation({ sectionId: PROFESSOR.sectionId, installationId: INSTALLATION })).toEqual({
      ok: false,
      error: LIFECYCLE_NOT_AVAILABLE,
    })
    expect(logEvent).not.toHaveBeenCalled()
  })
})
