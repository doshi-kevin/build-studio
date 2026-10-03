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
  findActiveInstallation: vi.fn(),
  activateVersion: vi.fn(),
  archiveInstallation: vi.fn(),
  archiveProject: vi.fn(),
}))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
vi.mock('@/lib/studio/access', () => ({ studioAccess: vi.fn(), STUDIO_PAUSED: 'Studio is paused right now. Try again later.' }))
vi.mock('@/lib/studio/validator/service', () => ({ validateAfterPublish: vi.fn() }))
// The version review itself is tested in studio-student-visibility.test.ts.
vi.mock('@/lib/studio/student-visibility', () => ({ reviewVersionForStudents: vi.fn() }))

const { requireProfessor } = await import('@/lib/studio/context')
const { studioAccess } = await import('@/lib/studio/access')
const db = await import('@/lib/studio/db')
const { logEvent } = await import('@/lib/supabase/event-logger')
const { validateAfterPublish } = await import('@/lib/studio/validator/service')
const { reviewVersionForStudents } = await import('@/lib/studio/student-visibility')
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
  const INSTALLATION_ROW = {
    id: INSTALLATION,
    institutionId: PROFESSOR.institutionId,
    sectionId: PROFESSOR.sectionId,
    projectId: PROJECT,
    status: 'active' as const,
    currentVersionId: VERSION,
    studentVisibility: 'visible' as const,
  }
  const visible = () => vi.mocked(db.loadInstallation).mockResolvedValue(INSTALLATION_ROW)
  const material = { code: 'unreleased_material' as const, message: 'Athena read course material students can’t see yet.', sources: [{ label: 'Week 6 slides', opensAt: '2026-10-09T13:00:00Z', note: 'not visible to students yet' }] }

  beforeEach(() => {
    vi.mocked(reviewVersionForStudents).mockResolvedValue({ blockers: [], warnings: [] })
  })

  it('refuses upgrade and rollback when the version review has a blocker, and says which', async () => {
    visible()
    const blockers = [{ code: 'validator_review' as const, message: 'Waiting for a Scholera reviewer.' }]
    vi.mocked(reviewVersionForStudents).mockResolvedValue({ blockers, warnings: [] })
    for (const act of [lifecycle.approveAndActivateVersion, lifecycle.rollbackVersion]) {
      expect(await act({ ...input, acknowledgeWarnings: true })).toMatchObject({ ok: false, error: expect.stringMatching(/same checks as showing it/), blockers })
    }
    expect(db.activateVersion).not.toHaveBeenCalled()
  })

  it('reviews the version being switched to, as the session professor', async () => {
    visible()
    const TARGET = crypto.randomUUID()
    await lifecycle.approveAndActivateVersion({ ...input, versionId: TARGET })
    expect(reviewVersionForStudents).toHaveBeenCalledWith(INSTALLATION_ROW, TARGET, PROFESSOR.userId)
  })

  it('holds an unreleased_material warning until the professor acknowledges it, on upgrade and rollback', async () => {
    visible()
    vi.mocked(reviewVersionForStudents).mockResolvedValue({ blockers: [], warnings: [material] })
    for (const act of [lifecycle.approveAndActivateVersion, lifecycle.rollbackVersion]) {
      expect(await act(input)).toMatchObject({ ok: false, warnings: [material] })
    }
    expect(db.activateVersion).not.toHaveBeenCalled()
    expect(await lifecycle.approveAndActivateVersion({ ...input, acknowledgeWarnings: true })).toEqual({ ok: true, value: null })
    expect(db.activateVersion).toHaveBeenCalledTimes(1)
  })

  it('acknowledging warnings never bypasses a blocker', async () => {
    visible()
    vi.mocked(reviewVersionForStudents).mockResolvedValue({ blockers: [{ code: 'manifest_v1', message: 'older format' }], warnings: [material] })
    expect(await lifecycle.approveAndActivateVersion({ ...input, acknowledgeWarnings: true })).toMatchObject({ ok: false })
    expect(db.activateVersion).not.toHaveBeenCalled()
  })

  it('tells the database what visibility it checked, and explains a change in between', async () => {
    visible()
    vi.mocked(db.activateVersion).mockResolvedValue({ ok: false, error: { code: '40001', message: 'Studio installation x changed while it was being checked' } })
    expect(await lifecycle.approveAndActivateVersion(input)).toEqual({ ok: false, error: 'This tool changed while it was being checked. Try again.' })
    expect(db.activateVersion).toHaveBeenCalledWith(INSTALLATION, VERSION, PROFESSOR.userId, true, 'visible')
  })

  it('does not review the version while the tool is hidden from students', async () => {
    expect(await lifecycle.approveAndActivateVersion(input)).toEqual({ ok: true, value: null })
    expect(reviewVersionForStudents).not.toHaveBeenCalled()
  })
})

describe('Add to this course / Use this version in the course, after Save', () => {
  const NEW_VERSION = crypto.randomUUID()
  const input = { sectionId: PROFESSOR.sectionId, versionId: NEW_VERSION }
  const installed = (over: Partial<{ currentVersionId: string; studentVisibility: 'hidden' | 'visible' }> = {}) => ({
    id: INSTALLATION, institutionId: PROFESSOR.institutionId, sectionId: PROFESSOR.sectionId, projectId: PROJECT,
    status: 'active' as const, currentVersionId: VERSION, studentVisibility: 'hidden' as const, ...over,
  })
  beforeEach(() => {
    vi.mocked(db.loadVersion).mockResolvedValue({ id: NEW_VERSION, projectId: PROJECT, institutionId: PROFESSOR.institutionId, version: '1.1.0', bridgeVersion: 'v1', manifest: exitTicket })
    vi.mocked(reviewVersionForStudents).mockResolvedValue({ blockers: [], warnings: [] })
  })

  it('installs the version when the course doesn’t have the tool', async () => {
    vi.mocked(db.findActiveInstallation).mockResolvedValue(null)
    expect(await lifecycle.addVersionToCourse(input)).toEqual({ ok: true, value: { installationId: INSTALLATION, added: true, changed: true } })
    expect(db.installPlugin).toHaveBeenCalledWith(PROFESSOR.sectionId, NEW_VERSION, PROFESSOR.userId)
    expect(db.findActiveInstallation).toHaveBeenCalledWith(PROFESSOR.sectionId, PROJECT)
  })

  it('makes it the course’s version when the course has another one, approving its card', async () => {
    vi.mocked(db.findActiveInstallation).mockResolvedValue(installed())
    vi.mocked(db.loadInstallation).mockResolvedValue(installed())
    expect(await lifecycle.addVersionToCourse(input)).toEqual({ ok: true, value: { installationId: INSTALLATION, added: false, changed: true } })
    expect(db.activateVersion).toHaveBeenCalledWith(INSTALLATION, NEW_VERSION, PROFESSOR.userId, true, 'hidden')
    expect(db.installPlugin).not.toHaveBeenCalled()
  })

  it('on a tool students see, holds a warning until acknowledged', async () => {
    vi.mocked(db.findActiveInstallation).mockResolvedValue(installed({ studentVisibility: 'visible' }))
    vi.mocked(db.loadInstallation).mockResolvedValue(installed({ studentVisibility: 'visible' }))
    vi.mocked(reviewVersionForStudents).mockResolvedValue({ blockers: [], warnings: [{ code: 'unreleased_material', message: 'm' }] })
    expect(await lifecycle.addVersionToCourse(input)).toMatchObject({ ok: false, warnings: [{ code: 'unreleased_material' }] })
    expect(db.activateVersion).not.toHaveBeenCalled()
    expect(await lifecycle.addVersionToCourse({ ...input, acknowledgeWarnings: true })).toMatchObject({ ok: true })
  })

  it('changes nothing when the course already uses this version', async () => {
    vi.mocked(db.findActiveInstallation).mockResolvedValue(installed({ currentVersionId: NEW_VERSION }))
    expect(await lifecycle.addVersionToCourse(input)).toEqual({ ok: true, value: { installationId: INSTALLATION, added: false, changed: false } })
    expect(db.activateVersion).not.toHaveBeenCalled()
    expect(db.installPlugin).not.toHaveBeenCalled()
  })

  it('refuses a version of someone else’s project without looking for an installation', async () => {
    vi.mocked(db.loadProject).mockResolvedValue({ ...ownProject, ownerId: crypto.randomUUID() })
    expect(await lifecycle.addVersionToCourse(input)).toEqual({ ok: false, error: LIFECYCLE_NOT_AVAILABLE })
    expect(db.findActiveInstallation).not.toHaveBeenCalled()
  })

  it('an unreadable installation is an error, never a second install', async () => {
    vi.mocked(db.findActiveInstallation).mockResolvedValue('error')
    expect(await lifecycle.addVersionToCourse(input)).toMatchObject({ ok: false })
    expect(db.installPlugin).not.toHaveBeenCalled()
  })

  it('placement says what the Save card should offer', async () => {
    vi.mocked(db.findActiveInstallation).mockResolvedValueOnce(null)
    expect(await lifecycle.versionPlacement(input)).toEqual({ ok: true, value: { mode: 'add', installationId: null, visible: false } })
    vi.mocked(db.findActiveInstallation).mockResolvedValueOnce(installed({ studentVisibility: 'visible' }))
    expect(await lifecycle.versionPlacement(input)).toEqual({ ok: true, value: { mode: 'use', installationId: INSTALLATION, visible: true } })
    vi.mocked(db.findActiveInstallation).mockResolvedValueOnce(installed({ currentVersionId: NEW_VERSION }))
    expect(await lifecycle.versionPlacement(input)).toMatchObject({ ok: true, value: { mode: 'current' } })
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
