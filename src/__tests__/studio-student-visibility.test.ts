/**
 * Showing an installation to students and hiding it (student-visibility.ts), with the
 * professor context, database layer and Studio access mocked. prepublish.ts is the REAL
 * module unless a test says otherwise, reading a mocked validator service, so how a
 * verdict becomes a blocker is checked against the code that ships. The database's own
 * refusals are tested in db/studio-publication.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import exitTicket from '@/lib/studio/fixtures/exit-ticket/plugin.manifest.json'
import type { StudioProfessor } from '@/lib/studio/context'
import type { ValidationSummary } from '@/lib/studio/validator/service'
import type { VersionVerdict } from '@/lib/studio/validator/verdict'

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
vi.mock('@/lib/studio/context', () => ({ requireProfessor: vi.fn() }))
vi.mock('@/lib/studio/access', () => ({
  studioAccess: vi.fn(),
  studentAccessReleased: vi.fn(),
  STUDIO_PAUSED: 'Studio is paused right now. Try again later.',
}))
vi.mock('@/lib/studio/prepublish', () => ({ prePublishVerdict: vi.fn() }))
vi.mock('@/lib/studio/validator/service', () => ({ currentVerdict: vi.fn(), validationSummary: vi.fn() }))
vi.mock('@/lib/studio/builder/course-retriever', () => ({ loadGuardSources: vi.fn() }))
vi.mock('@/lib/studio/db', () => ({
  loadVersionMaterial: vi.fn(),
  loadOwnerRosterFullNames: vi.fn(),
  loadInstallation: vi.fn(),
  loadVersion: vi.fn(),
  loadVersionBundle: vi.fn(),
  loadSectionState: vi.fn(),
  loadUsage: vi.fn(),
  loadQuotaLimits: vi.fn(),
  loadLatestProjectVersion: vi.fn(),
  listProjectVersions: vi.fn(),
  listSectionInstallations: vi.fn(),
  setStudentVisibility: vi.fn(),
  listSkillBindings: vi.fn(),
  listBindableSkills: vi.fn(),
}))

const { revalidatePath } = await import('next/cache')
const { logEvent } = await import('@/lib/supabase/event-logger')
const { requireProfessor } = await import('@/lib/studio/context')
const { studioAccess, studentAccessReleased } = await import('@/lib/studio/access')
const { prePublishVerdict } = await import('@/lib/studio/prepublish')
const { currentVerdict, validationSummary } = await import('@/lib/studio/validator/service')
const db = await import('@/lib/studio/db')
const { loadGuardSources } = await import('@/lib/studio/builder/course-retriever')
const { GOOD_MANIFEST } = await import('@/lib/studio/validator/fixtures')
/** A current-format manifest with nothing to link, so only what a test breaks blocks. */
const V2 = { ...GOOD_MANIFEST, skillSlots: [] }
const service = await import('@/lib/studio/student-visibility')
const realValidator = await vi.importActual<typeof import('@/lib/studio/prepublish')>('@/lib/studio/prepublish')
const { VISIBILITY_NOT_AVAILABLE } = service

const PROFESSOR = { userId: crypto.randomUUID(), sectionId: crypto.randomUUID(), institutionId: crypto.randomUUID() }
const PROJECT = crypto.randomUUID()
const VERSION = crypto.randomUUID()
const INSTALLATION = {
  id: crypto.randomUUID(),
  institutionId: PROFESSOR.institutionId,
  sectionId: PROFESSOR.sectionId,
  projectId: PROJECT,
  status: 'active' as const,
  currentVersionId: VERSION,
  studentVisibility: 'hidden' as const,
}
const VERSION_ROW = { id: VERSION, projectId: PROJECT, institutionId: PROFESSOR.institutionId, version: '1.0.0', bridgeVersion: 'v1', manifest: V2 as unknown }
const input = { sectionId: PROFESSOR.sectionId, installationId: INSTALLATION.id }

/** Every check passes, the validator included. Tests then break one thing. */
function allClear() {
  vi.mocked(prePublishVerdict).mockResolvedValue({ status: 'passed' })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireProfessor).mockResolvedValue(PROFESSOR as StudioProfessor)
  // The shipped validator, unless a test overrides it.
  vi.mocked(prePublishVerdict).mockImplementation(realValidator.prePublishVerdict)
  vi.mocked(studioAccess).mockResolvedValue('full')
  vi.mocked(studentAccessReleased).mockReturnValue(true)
  vi.mocked(db.loadInstallation).mockResolvedValue(INSTALLATION)
  vi.mocked(db.loadVersion).mockResolvedValue(VERSION_ROW)
  vi.mocked(db.loadVersionBundle).mockResolvedValue({ code: 'student()', name: 'Exit ticket' })
  vi.mocked(db.loadSectionState).mockResolvedValue({ institutionId: PROFESSOR.institutionId, archived: false })
  vi.mocked(db.loadUsage).mockResolvedValue({ records: 0, bytes: 0 })
  vi.mocked(db.loadQuotaLimits).mockResolvedValue({
    installationMaxRecords: 50_000,
    installationMaxBytes: 50 * 1024 * 1024,
    studentMaxRecords: 1000,
    studentMaxBytes: 1024 * 1024,
  })
  vi.mocked(db.loadLatestProjectVersion).mockResolvedValue({ id: VERSION, version: '1.0.0' })
  vi.mocked(db.listSectionInstallations).mockResolvedValue([])
  vi.mocked(db.setStudentVisibility).mockResolvedValue({ ok: true, value: true })
  vi.mocked(db.listProjectVersions).mockResolvedValue([{ id: VERSION, version: '1.0.0', publishedAt: '2026-10-01T00:00:00Z' }])
  vi.mocked(db.listSkillBindings).mockResolvedValue([])
  vi.mocked(db.listBindableSkills).mockResolvedValue([])
  // A freshly published version: nothing has cleared it yet.
  vi.mocked(currentVerdict).mockResolvedValue({ status: 'unavailable', reason: 'not_checked' })
  vi.mocked(validationSummary).mockResolvedValue(null)
  // The version's builder read nothing from the course.
  vi.mocked(db.loadVersionMaterial).mockResolvedValue({ sources: [], incomplete: false })
  vi.mocked(db.loadOwnerRosterFullNames).mockResolvedValue([])
  vi.mocked(loadGuardSources).mockResolvedValue([])
})

const codes = (r: { ok: boolean; blockers?: { code: string }[] }) => (r.ok ? [] : (r.blockers ?? []).map((b) => b.code))

describe('who may change visibility', () => {
  it.each([
    ['someone requireProfessor refuses (TA, grader, student, stranger)', () => vi.mocked(requireProfessor).mockResolvedValue(null)],
    ['an installation in another section', () => vi.mocked(db.loadInstallation).mockResolvedValue({ ...INSTALLATION, sectionId: crypto.randomUUID() })],
    ['an installation that doesn’t exist', () => vi.mocked(db.loadInstallation).mockResolvedValue(null)],
  ])('refuses %s with the same message, and changes nothing', async (_label, arrange) => {
    allClear()
    arrange()
    for (const act of [() => service.showToStudents(input), () => service.hideFromStudents(input), () => service.getPublicationPanel(input)]) {
      expect(await act()).toEqual({ ok: false, error: VISIBILITY_NOT_AVAILABLE })
    }
    expect(db.setStudentVisibility).not.toHaveBeenCalled()
    expect(logEvent).not.toHaveBeenCalled()
  })

  it('refuses a request that tries to name the actor or the visibility', async () => {
    expect(await service.showToStudents({ ...input, actorId: crypto.randomUUID() } as never)).toEqual({ ok: false, error: VISIBILITY_NOT_AVAILABLE })
    expect(await service.hideFromStudents({ ...input, visibility: 'visible' } as never)).toEqual({ ok: false, error: VISIBILITY_NOT_AVAILABLE })
    expect(requireProfessor).not.toHaveBeenCalled()
  })
})

describe('showing to students: hard blockers', () => {
  it('refuses a version the validator hasn’t cleared', async () => {
    const result = await service.showToStudents(input)
    expect(codes(result)).toEqual(['validator_unavailable'])
    expect(db.setStudentVisibility).not.toHaveBeenCalled()
  })

  it.each([
    [{ status: 'unavailable', reason: 'runtime_not_checked' }, 'validator_unavailable', /Run the browser checks/],
    [{ status: 'unavailable', reason: 'checking' }, 'validator_unavailable', /still running/],
    [{ status: 'unavailable', reason: 'below_minimum_ruleset' }, 'validator_unavailable', /being re-checked/],
    [{ status: 'failed', reason: 'artifact_mismatch' }, 'validator_failed', /didn’t pass/],
    [{ status: 'needs_review', runId: 'r', checkIds: ['edtech.purpose'] }, 'validator_review', /Waiting for a Scholera reviewer\. You don’t need to do anything/],
  ] satisfies [VersionVerdict, string, RegExp][])('a %o verdict blocks as %s', async (verdict, code, message) => {
    vi.mocked(currentVerdict).mockResolvedValue(verdict)
    const result = await service.showToStudents({ ...input, acknowledgeWarnings: true })
    expect(result).toMatchObject({ ok: false, blockers: [{ code, message: expect.stringMatching(message) }] })
  })

  it('fails closed when the verdict can’t be read', async () => {
    vi.mocked(currentVerdict).mockRejectedValue(new Error('connection reset'))
    expect(codes(await service.showToStudents(input))).toEqual(['validator_unavailable'])
  })

  it('passes the gate only on a passed verdict', async () => {
    vi.mocked(currentVerdict).mockResolvedValue({ status: 'passed', staticRunId: 'a', runtimeRunId: 'b', rulesetVersion: 1 })
    expect(await service.showToStudents(input)).toEqual({ ok: true, value: { changed: true } })
  })

  it('blocks a version 2 tool until each skill slot is linked to a course skill', async () => {
    allClear()
    const skill = { id: crypto.randomUUID(), name: 'Photosynthesis' }
    vi.mocked(db.loadVersion).mockResolvedValue({ ...VERSION_ROW, manifest: GOOD_MANIFEST })
    vi.mocked(db.listBindableSkills).mockResolvedValue([skill])
    expect(await service.showToStudents(input)).toMatchObject({
      ok: false,
      blockers: [{ code: 'skill_binding_missing', message: expect.stringMatching(/The topic this ticket is about/) }],
    })
    vi.mocked(db.listSkillBindings).mockResolvedValue([{ slotKey: 'topic', skillId: skill.id }])
    expect(await service.showToStudents(input)).toEqual({ ok: true, value: { changed: true } })
  })

  it.each([
    ['validator_failed', () => vi.mocked(prePublishVerdict).mockResolvedValue({ status: 'failed', reason: 'static_failed' })],
    ['kill_switch', () => vi.mocked(studioAccess).mockResolvedValue('off')],
    ['release_gate', () => vi.mocked(studentAccessReleased).mockReturnValue(false)],
    ['not_entitled', () => vi.mocked(studioAccess).mockResolvedValue('read_only')],
    ['not_active', () => vi.mocked(db.loadInstallation).mockResolvedValue({ ...INSTALLATION, status: 'archived' })],
    ['section_archived', () => vi.mocked(db.loadSectionState).mockResolvedValue({ institutionId: PROFESSOR.institutionId, archived: true })],
    ['version_missing', () => vi.mocked(db.loadVersion).mockResolvedValue(null)],
    ['version_mismatch', () => vi.mocked(db.loadVersion).mockResolvedValue({ ...VERSION_ROW, projectId: crypto.randomUUID() })],
    ['manifest_invalid', () => vi.mocked(db.loadVersion).mockResolvedValue({ ...VERSION_ROW, manifest: { ...exitTicket, views: {} } })],
    ['bridge_unsupported', () => vi.mocked(db.loadVersion).mockResolvedValue({ ...VERSION_ROW, bridgeVersion: 'v0' })],
    ['student_bundle_missing', () => vi.mocked(db.loadVersionBundle).mockResolvedValue({ code: '   ', name: 'Exit ticket' })],
    ['over_quota', () => vi.mocked(db.loadUsage).mockResolvedValue({ records: 50_000, bytes: 0 })],
    ['quota_unavailable', () => vi.mocked(db.loadQuotaLimits).mockResolvedValue(null)],
  ])('%s blocks, writes nothing, and is logged by code only', async (code, arrange) => {
    allClear()
    arrange()
    const result = await service.showToStudents({ ...input, acknowledgeWarnings: true })
    expect(codes(result)).toEqual([code])
    expect(db.setStudentVisibility).not.toHaveBeenCalled()
    expect(logEvent).toHaveBeenCalledTimes(1)
    const event = vi.mocked(logEvent).mock.calls[0][0]
    expect(event).toMatchObject({ eventType: 'studio.installation.show_blocked', userId: PROFESSOR.userId })
    expect(event.metadata).toEqual({ installationId: INSTALLATION.id, versionId: VERSION, blockers: code })
  })

  it('reports every blocker at once, and acknowledging warnings never bypasses one', async () => {
    vi.mocked(studioAccess).mockResolvedValue('read_only')
    vi.mocked(studentAccessReleased).mockReturnValue(false)
    const result = await service.showToStudents({ ...input, acknowledgeWarnings: true })
    expect(codes(result)).toEqual(['release_gate', 'not_entitled', 'validator_unavailable'])
  })
})

describe('showing to students: warnings', () => {
  beforeEach(allClear)

  it.each([
    ['near_quota', () => vi.mocked(db.loadUsage).mockResolvedValue({ records: 0, bytes: 45 * 1024 * 1024 })],
    ['newer_version', () => vi.mocked(db.loadLatestProjectVersion).mockResolvedValue({ id: crypto.randomUUID(), version: '1.0.10' })],
    [
      'duplicate_label',
      () =>
        vi.mocked(db.listSectionInstallations).mockResolvedValue([
          { id: crypto.randomUUID(), status: 'active', studentVisibility: 'visible', currentVersionId: crypto.randomUUID(), name: exitTicket.name },
        ]),
    ],
  ])('%s holds the change until the professor acknowledges it', async (code, arrange) => {
    arrange()
    const first = await service.showToStudents(input)
    expect(first).toMatchObject({ ok: false, warnings: [{ code }] })
    expect(db.setStudentVisibility).not.toHaveBeenCalled()
    expect(await service.showToStudents({ ...input, acknowledgeWarnings: true })).toEqual({ ok: true, value: { changed: true } })
  })

  it('no warning when the active version is the latest', async () => {
    expect(await service.showToStudents(input)).toEqual({ ok: true, value: { changed: true } })
    expect(db.loadLatestProjectVersion).toHaveBeenCalledWith(PROJECT)
  })

  it('the installation itself doesn’t count as a duplicate name', async () => {
    vi.mocked(db.listSectionInstallations).mockResolvedValue([
      { id: INSTALLATION.id, status: 'active', studentVisibility: 'visible', currentVersionId: VERSION, name: exitTicket.name },
    ])
    expect(await service.showToStudents(input)).toEqual({ ok: true, value: { changed: true } })
  })
})

describe('the version review: Step 10 checks', () => {
  beforeEach(allClear)
  const scheduled = { key: 'item:1', label: 'Week 6: Midterm review (slides)', disclosure: 'scheduled' as const, opensAt: '2026-10-09T13:00:00Z', text: 'x' }

  it('an older-format (v1) manifest blocks explicitly', async () => {
    vi.mocked(db.loadVersion).mockResolvedValue({ ...VERSION_ROW, manifest: exitTicket })
    expect(await service.showToStudents({ ...input, acknowledgeWarnings: true })).toMatchObject({
      ok: false,
      blockers: [{ code: 'manifest_v1', message: expect.stringMatching(/older Studio format/) }],
    })
  })

  it('names each source the builder read that students can’t see yet, with its date, and holds until acknowledged', async () => {
    vi.mocked(db.loadVersionMaterial).mockResolvedValue({ sources: [{ k: 'item:1', s: PROFESSOR.sectionId }, { k: 'item:2', s: PROFESSOR.sectionId }], incomplete: false })
    vi.mocked(loadGuardSources).mockResolvedValue([scheduled, { ...scheduled, key: 'item:2', label: 'Week 1: Syllabus', disclosure: 'released', opensAt: null }])
    const first = await service.showToStudents(input)
    expect(first).toMatchObject({
      ok: false,
      warnings: [{ code: 'unreleased_material', sources: [{ label: 'Week 6: Midterm review (slides)', opensAt: '2026-10-09T13:00:00Z', note: expect.stringMatching(/^not visible to students yet/) }] }],
    })
    expect(loadGuardSources).toHaveBeenCalledWith(PROFESSOR.institutionId, expect.any(Array), [], PROFESSOR.userId)
    expect(db.setStudentVisibility).not.toHaveBeenCalled()
    expect(await service.showToStudents({ ...input, acknowledgeWarnings: true })).toEqual({ ok: true, value: { changed: true } })
  })

  it('material released since the version was saved no longer warns', async () => {
    vi.mocked(db.loadVersionMaterial).mockResolvedValue({ sources: [{ k: 'item:1', s: PROFESSOR.sectionId }], incomplete: false })
    vi.mocked(loadGuardSources).mockResolvedValue([{ ...scheduled, disclosure: 'released', opensAt: null }])
    expect(await service.showToStudents(input)).toEqual({ ok: true, value: { changed: true } })
  })

  it.each([
    ['the provenance can’t be read', () => vi.mocked(db.loadVersionMaterial).mockResolvedValue(null)],
    ['the material can’t be read', () => {
      vi.mocked(db.loadVersionMaterial).mockResolvedValue({ sources: [{ k: 'item:1', s: PROFESSOR.sectionId }], incomplete: false })
      vi.mocked(loadGuardSources).mockResolvedValue(null)
    }],
    ['the list was cut short at Save', () => vi.mocked(db.loadVersionMaterial).mockResolvedValue({ sources: [], incomplete: true })],
  ])('warns rather than staying silent when %s', async (_label, arrange) => {
    arrange()
    expect(await service.showToStudents(input)).toMatchObject({ ok: false, warnings: [{ code: 'unreleased_material' }] })
  })
})

describe('showing to students: the change', () => {
  beforeEach(allClear)

  it('the session professor becomes the actor, in their own section; it is audited and both sidebars refresh', async () => {
    expect(await service.showToStudents(input)).toEqual({ ok: true, value: { changed: true } })
    expect(db.setStudentVisibility).toHaveBeenCalledWith(INSTALLATION.id, PROFESSOR.sectionId, 'visible', PROFESSOR.userId, VERSION)
    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'studio.installation.shown', metadata: { installationId: INSTALLATION.id, versionId: VERSION } }),
    )
    expect(revalidatePath).toHaveBeenCalledWith(`/professor/courses/${PROFESSOR.sectionId}`, 'layout')
    expect(revalidatePath).toHaveBeenCalledWith(`/student/courses/${PROFESSOR.sectionId}`, 'layout')
  })

  it('showing something already shown changes and logs nothing', async () => {
    vi.mocked(db.setStudentVisibility).mockResolvedValue({ ok: true, value: false })
    expect(await service.showToStudents(input)).toEqual({ ok: true, value: { changed: false } })
    expect(logEvent).not.toHaveBeenCalled()
  })

  it('explains the database’s own refusal when the installation was archived in the meantime', async () => {
    vi.mocked(db.setStudentVisibility).mockResolvedValue({
      ok: false,
      error: { code: '23514', message: 'An archived installation can\'t be shown to students' },
    })
    const result = await service.showToStudents(input)
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/removed from the course/) })
  })
})

describe('hiding from students', () => {
  it.each([
    ['the kill switch is engaged', () => vi.mocked(studioAccess).mockResolvedValue('off')],
    ['the school lost the entitlement', () => vi.mocked(studioAccess).mockResolvedValue('read_only')],
    ['the release gate is closed', () => vi.mocked(studentAccessReleased).mockReturnValue(false)],
    ['the installation is archived', () => vi.mocked(db.loadInstallation).mockResolvedValue({ ...INSTALLATION, status: 'archived', studentVisibility: 'visible' })],
  ])('still works when %s: it only reduces what students reach', async (_label, arrange) => {
    arrange()
    expect(await service.hideFromStudents(input)).toEqual({ ok: true, value: { changed: true } })
    expect(db.setStudentVisibility).toHaveBeenCalledWith(INSTALLATION.id, PROFESSOR.sectionId, 'hidden', PROFESSOR.userId)
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'studio.installation.hidden' }))
  })

  it('runs none of the publication checks', async () => {
    await service.hideFromStudents(input)
    expect(studioAccess).not.toHaveBeenCalled()
    expect(prePublishVerdict).not.toHaveBeenCalled()
  })
})

describe('the panel on the professor’s runtime page', () => {
  it('gives the professor the state, blockers, warnings, plugin card and versions, and changes nothing', async () => {
    vi.mocked(db.loadUsage).mockResolvedValue({ records: 45_000, bytes: 2048 })
    const result = await service.getPublicationPanel(input)
    expect(result).toMatchObject({
      ok: true,
      value: {
        status: 'active',
        visibility: 'hidden',
        blockers: [{ code: 'validator_unavailable' }],
        warnings: [{ code: 'near_quota' }],
        card: { name: exitTicket.name, version: '1.0.0', storage: { used: '45,000 of 50,000 saved entries, 2 KB of 50 MB' } },
        versions: [{ id: VERSION, version: '1.0.0' }],
      },
    })
    expect(db.setStudentVisibility).not.toHaveBeenCalled()
    expect(logEvent).not.toHaveBeenCalled()
  })

  it('carries the validator summary, and each skill slot with what it is linked to', async () => {
    const summary: ValidationSummary = {
      verdict: { status: 'unavailable', reason: 'runtime_not_checked' },
      stages: { static: { status: 'passed', findings: [] }, runtime: null },
      canRequestRuntime: true,
      runnerAvailable: false,
    }
    const skill = { id: crypto.randomUUID(), name: 'Photosynthesis' }
    vi.mocked(validationSummary).mockResolvedValue(summary)
    vi.mocked(db.loadVersion).mockResolvedValue({ ...VERSION_ROW, manifest: GOOD_MANIFEST })
    vi.mocked(db.listSkillBindings).mockResolvedValue([{ slotKey: 'topic', skillId: skill.id }])
    vi.mocked(db.listBindableSkills).mockResolvedValue([skill])
    const result = await service.getPublicationPanel(input)
    expect(result).toMatchObject({
      ok: true,
      value: {
        validation: summary,
        skillSlots: [{ key: 'topic', label: 'The topic this ticket is about', skillId: skill.id }],
        sectionSkills: [skill],
      },
    })
    expect(validationSummary).toHaveBeenCalledWith(VERSION)
  })

  it('lists no course skills for a tool without skill slots', async () => {
    vi.mocked(db.listBindableSkills).mockResolvedValue([{ id: crypto.randomUUID(), name: 'Photosynthesis' }])
    expect(await service.getPublicationPanel(input)).toMatchObject({ ok: true, value: { skillSlots: [], sectionSkills: [] } })
  })

  it('has no card when the stored manifest no longer parses, but still lists the blocker', async () => {
    vi.mocked(db.loadVersion).mockResolvedValue({ ...VERSION_ROW, manifest: { ...exitTicket, views: {} } })
    const result = await service.getPublicationPanel(input)
    expect(result).toMatchObject({ ok: true, value: { card: null, blockers: expect.arrayContaining([{ code: 'manifest_invalid', message: expect.any(String) }]) } })
  })
})
