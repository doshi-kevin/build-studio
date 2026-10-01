/**
 * Lifecycle wrappers, with the professor context and database layer mocked. The
 * database's own refusals are tested in db/studio-storage.test.ts; here we check who
 * may call what, what reaches the database, and how refusals are explained.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import exitTicket from '@/lib/studio/fixtures/exit-ticket/plugin.manifest.json'
import type { StudioProfessor } from '@/lib/studio/context'
import type { VersionVerdict } from '@/lib/studio/validator/verdict'

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
vi.mock('@/lib/studio/access', () => ({ studioAccess: vi.fn(), STUDIO_PAUSED: 'Studio is paused right now. Try again later.' }))
vi.mock('@/lib/studio/validator/service', () => ({ validateAfterPublish: vi.fn(), currentVerdict: vi.fn() }))
vi.mock('@/lib/studio/skill-bindings', () => ({ skillBindingIssues: vi.fn() }))

const { requireProfessor } = await import('@/lib/studio/context')
const { studioAccess } = await import('@/lib/studio/access')
const db = await import('@/lib/studio/db')
const { logEvent } = await import('@/lib/supabase/event-logger')
const { validateAfterPublish, currentVerdict } = await import('@/lib/studio/validator/service')
const { skillBindingIssues } = await import('@/lib/studio/skill-bindings')
const { artifactHash } = await import('@/lib/studio/validator/artifact')
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
    bridgeVersion: 'v1',
    manifest: exitTicket,
  })
  vi.mocked(studioAccess).mockResolvedValue('full')
  vi.mocked(db.installPlugin).mockResolvedValue({ ok: true, value: INSTALLATION })
  vi.mocked(db.loadInstallation).mockResolvedValue({
    id: INSTALLATION,
    institutionId: PROFESSOR.institutionId,
    sectionId: PROFESSOR.sectionId,
    projectId: PROJECT,
    status: 'active',
    currentVersionId: VERSION,
    studentVisibility: 'hidden',
  })
  vi.mocked(db.activateVersion).mockResolvedValue({ ok: true, value: null })
  vi.mocked(currentVerdict).mockResolvedValue({ status: 'passed', staticRunId: crypto.randomUUID(), runtimeRunId: crypto.randomUUID(), rulesetVersion: 1 })
  vi.mocked(skillBindingIssues).mockResolvedValue({ ok: true })
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
      studentVisibility: 'hidden',
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

describe('new work needs full Studio access', () => {
  const installationInput = { sectionId: PROFESSOR.sectionId, installationId: INSTALLATION, versionId: VERSION }
  const newWork: [string, () => Promise<{ ok: boolean; error?: string }>][] = [
    ['create a project', () => lifecycle.createProject({ sectionId: PROFESSOR.sectionId, slug: 'quiz', name: 'Quiz' })],
    ['publish a version', () => lifecycle.publishVersion(publishInput)],
    ['install', () => lifecycle.installPlugin({ sectionId: PROFESSOR.sectionId, versionId: VERSION })],
    ['upgrade', () => lifecycle.approveAndActivateVersion(installationInput)],
    ['roll back', () => lifecycle.rollbackVersion(installationInput)],
  ]

  it.each(newWork)('refuses to %s while the kill switch is engaged, and writes nothing', async (_label, act) => {
    vi.mocked(studioAccess).mockResolvedValue('off')
    expect(await act()).toEqual({ ok: false, error: 'Studio is paused right now. Try again later.' })
    for (const write of [db.insertProject, db.insertVersion, db.installPlugin, db.activateVersion]) {
      expect(write).not.toHaveBeenCalled()
    }
    expect(logEvent).not.toHaveBeenCalled()
  })

  it.each(newWork)('refuses to %s when the school lacks the Studio entitlement', async (_label, act) => {
    vi.mocked(studioAccess).mockResolvedValue('read_only')
    const result = await act()
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not part of your institution's plan/)
    expect(db.insertProject).not.toHaveBeenCalled()
    expect(db.activateVersion).not.toHaveBeenCalled()
  })

  it.each(['off', 'read_only'] as const)('still archives an installation when access is %s', async (access) => {
    vi.mocked(studioAccess).mockResolvedValue(access)
    vi.mocked(db.archiveInstallation).mockResolvedValue({ ok: true, value: true })
    expect(await lifecycle.archiveInstallation({ sectionId: PROFESSOR.sectionId, installationId: INSTALLATION })).toEqual({
      ok: true,
      value: null,
    })
  })

  it('asks about the professor’s own institution, and only after confirming who they are', async () => {
    vi.mocked(db.insertProject).mockResolvedValue({ ok: true, value: PROJECT })
    vi.mocked(requireProfessor).mockResolvedValue(null)
    await lifecycle.createProject({ sectionId: PROFESSOR.sectionId, slug: 'quiz', name: 'Quiz' })
    expect(studioAccess).not.toHaveBeenCalled()
    vi.mocked(requireProfessor).mockResolvedValue(PROFESSOR as StudioProfessor)
    await lifecycle.createProject({ sectionId: PROFESSOR.sectionId, slug: 'quiz', name: 'Quiz' })
    expect(studioAccess).toHaveBeenCalledWith(PROFESSOR.institutionId)
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

  it('publish stores the hash of exactly what was published, then runs Stage 1 on that version', async () => {
    await lifecycle.publishVersion(publishInput)
    const { manifest, source, studentBundle, professorBundle } = publishInput
    expect(db.insertVersion).toHaveBeenCalledWith(
      expect.objectContaining({ artifactSha256: artifactHash({ manifest, source, studentBundle, professorBundle }) }),
    )
    expect(validateAfterPublish).toHaveBeenCalledWith(VERSION, PROFESSOR.userId)
  })

  it.each([
    ['an oversized bundle', { studentBundle: 'x'.repeat(256 * 1024 + 1) }],
    ['an oversized source file', { source: { 'a.ts': 'x'.repeat(128 * 1024 + 1) } }],
    ['too many source files', { source: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`f${i}.ts`, ''])) }],
  ])('publish refuses %s before anything is stored', async (_, change) => {
    expect(await lifecycle.publishVersion({ ...publishInput, ...change })).toEqual({ ok: false, error: LIFECYCLE_NOT_AVAILABLE })
    expect(db.insertVersion).not.toHaveBeenCalled()
    expect(validateAfterPublish).not.toHaveBeenCalled()
  })

  it('install, upgrade and rollback pass the session professor as the actor', async () => {
    await lifecycle.installPlugin({ sectionId: PROFESSOR.sectionId, versionId: VERSION })
    const input = { sectionId: PROFESSOR.sectionId, installationId: INSTALLATION, versionId: VERSION }
    await lifecycle.approveAndActivateVersion(input)
    await lifecycle.rollbackVersion(input)

    expect(db.installPlugin).toHaveBeenCalledWith(PROFESSOR.sectionId, VERSION, PROFESSOR.userId)
    expect(vi.mocked(db.activateVersion).mock.calls).toEqual([
      [INSTALLATION, VERSION, PROFESSOR.userId, true, 'hidden'],
      [INSTALLATION, VERSION, PROFESSOR.userId, false, 'hidden'],
    ])
    expect(vi.mocked(logEvent).mock.calls.map(([e]) => e.eventType)).toEqual([
      'studio.plugin.installed',
      'studio.version.activated',
      'studio.version.rolled_back',
    ])
  })
})

describe('switching versions while students can see the tool', () => {
  const input = { sectionId: PROFESSOR.sectionId, installationId: INSTALLATION, versionId: VERSION }
  const visible = () =>
    vi.mocked(db.loadInstallation).mockResolvedValue({
      id: INSTALLATION,
      institutionId: PROFESSOR.institutionId,
      sectionId: PROFESSOR.sectionId,
      projectId: PROJECT,
      status: 'active',
      currentVersionId: VERSION,
      studentVisibility: 'visible',
    })

  it.each([
    { status: 'unavailable', reason: 'runtime_not_checked' },
    { status: 'needs_review', runId: crypto.randomUUID(), checkIds: ['data.answer_key'] },
    { status: 'failed', reason: 'static_failed' },
  ] satisfies VersionVerdict[])('refuses upgrade and rollback to a version whose verdict is $status', async (verdict) => {
    visible()
    vi.mocked(currentVerdict).mockResolvedValue(verdict)
    for (const act of [lifecycle.approveAndActivateVersion, lifecycle.rollbackVersion]) {
      expect(await act(input)).toMatchObject({ ok: false, error: expect.stringMatching(/pass Studio’s automatic checks/) })
    }
    expect(db.activateVersion).not.toHaveBeenCalled()
  })

  it('refuses a passing version whose skill slots are not linked in this course', async () => {
    visible()
    vi.mocked(skillBindingIssues).mockResolvedValue({ ok: false, unbound: ['Topic'] })
    expect(await lifecycle.approveAndActivateVersion(input)).toMatchObject({ ok: false, error: expect.stringMatching(/skill slots/) })
    expect(db.activateVersion).not.toHaveBeenCalled()
  })

  it('allows a passing, fully linked version', async () => {
    visible()
    expect(await lifecycle.approveAndActivateVersion(input)).toEqual({ ok: true, value: null })
    expect(currentVerdict).toHaveBeenCalledWith(VERSION)
  })

  it('gates the version being switched to, not the one already active', async () => {
    visible()
    const TARGET = crypto.randomUUID()
    vi.mocked(currentVerdict).mockImplementation(async (id) =>
      id === VERSION
        ? { status: 'passed', staticRunId: 'a', runtimeRunId: 'b', rulesetVersion: 1 }
        : { status: 'unavailable', reason: 'runtime_not_checked' },
    )
    expect(await lifecycle.approveAndActivateVersion({ ...input, versionId: TARGET })).toMatchObject({ ok: false })
    expect(currentVerdict).toHaveBeenCalledWith(TARGET)
    expect(db.activateVersion).not.toHaveBeenCalled()
  })

  it('refuses a passing version whose manifest no longer parses', async () => {
    visible()
    vi.mocked(db.loadVersion).mockResolvedValue({ id: VERSION, projectId: PROJECT, institutionId: PROFESSOR.institutionId, version: '1.0.0', bridgeVersion: 'v1', manifest: { manifestVersion: 9 } })
    expect(await lifecycle.approveAndActivateVersion(input)).toEqual({ ok: false, error: 'That version can’t be used.' })
    expect(db.activateVersion).not.toHaveBeenCalled()
  })

  it('fails closed when skill links can’t be read', async () => {
    visible()
    vi.mocked(skillBindingIssues).mockResolvedValue({ ok: false, unreadable: true })
    expect(await lifecycle.approveAndActivateVersion(input)).toMatchObject({ ok: false })
    expect(db.activateVersion).not.toHaveBeenCalled()
  })

  it('tells the database what visibility it checked, and explains a change in between', async () => {
    visible()
    vi.mocked(db.activateVersion).mockResolvedValue({ ok: false, error: { code: '40001', message: 'Studio installation x changed while it was being checked' } })
    expect(await lifecycle.approveAndActivateVersion(input)).toEqual({ ok: false, error: 'This tool changed while it was being checked. Try again.' })
    expect(db.activateVersion).toHaveBeenCalledWith(INSTALLATION, VERSION, PROFESSOR.userId, true, 'visible')
  })

  it('does not consult the validator while the tool is hidden from students', async () => {
    vi.mocked(currentVerdict).mockResolvedValue({ status: 'unavailable', reason: 'not_checked' })
    expect(await lifecycle.approveAndActivateVersion(input)).toEqual({ ok: true, value: null })
    expect(currentVerdict).not.toHaveBeenCalled()
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
