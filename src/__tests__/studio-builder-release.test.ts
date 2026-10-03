/**
 * The Save card's next step (builder/service.ts): what it offers for a saved version, and
 * Add to this course / Use this version followed by Studio's browser checks. Placement,
 * ownership and the version review are lifecycle.ts's, tested in studio-lifecycle.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/jobs/enqueue', () => ({ kickWorker: vi.fn() }))
vi.mock('@/lib/studio/lifecycle', () => ({ publishDraft: vi.fn(), addVersionToCourse: vi.fn(), versionPlacement: vi.fn() }))
vi.mock('@/lib/studio/validator/service', () => ({ requestRuntimeValidation: vi.fn(), currentVerdict: vi.fn() }))
vi.mock('@/lib/studio/db', () => ({ loadInstallation: vi.fn(), loadVersion: vi.fn() }))

const { addVersionToCourse, versionPlacement } = await import('@/lib/studio/lifecycle')
const { requestRuntimeValidation, currentVerdict } = await import('@/lib/studio/validator/service')
const db = await import('@/lib/studio/db')
const { GOOD_MANIFEST } = await import('@/lib/studio/validator/fixtures')
const service = await import('@/lib/studio/builder/service')

const SECTION = crypto.randomUUID()
const VERSION = crypto.randomUUID()
const CURRENT = crypto.randomUUID()
const INSTALLATION = crypto.randomUUID()
const versionRow = (id: string, manifest: unknown) => ({ id, projectId: 'p', institutionId: 'i', version: '1.0.0', bridgeVersion: 'v1', manifest })

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(addVersionToCourse).mockResolvedValue({ ok: true, value: { installationId: INSTALLATION, added: true, changed: true } })
  vi.mocked(requestRuntimeValidation).mockResolvedValue({ ok: true, status: 'running' })
})

describe('what the Save card offers', () => {
  it('a course without the tool: Add, with the version’s card', async () => {
    vi.mocked(versionPlacement).mockResolvedValue({ ok: true, value: { mode: 'add', installationId: null, visible: false } })
    vi.mocked(db.loadVersion).mockResolvedValue(versionRow(VERSION, GOOD_MANIFEST))
    const r = await service.versionRelease({ sectionId: SECTION, versionId: VERSION })
    expect(r).toMatchObject({ ok: true, value: { mode: 'add', visible: false, card: { name: 'Exit ticket' }, added: [] } })
  })

  it('a course on another version: Use, listing only what this version adds', async () => {
    vi.mocked(versionPlacement).mockResolvedValue({ ok: true, value: { mode: 'use', installationId: INSTALLATION, visible: true } })
    vi.mocked(db.loadInstallation).mockResolvedValue({ id: INSTALLATION, institutionId: 'i', sectionId: SECTION, projectId: 'p', status: 'active', currentVersionId: CURRENT, studentVisibility: 'visible' })
    const older = { ...GOOD_MANIFEST, collections: {} }
    vi.mocked(db.loadVersion).mockImplementation(async (id) => (id === VERSION ? versionRow(VERSION, GOOD_MANIFEST) : versionRow(CURRENT, older)))
    const r = await service.versionRelease({ sectionId: SECTION, versionId: VERSION })
    expect(r).toMatchObject({ ok: true, value: { mode: 'use', visible: true } })
    if (!r.ok) return
    expect(r.value.added).toContainEqual(expect.stringMatching(/^Saves responses:/))
    // Nothing the course's version could already do is listed as new.
    vi.mocked(db.loadVersion).mockImplementation(async (id) => versionRow(id, GOOD_MANIFEST))
    expect(await service.versionRelease({ sectionId: SECTION, versionId: VERSION })).toMatchObject({ ok: true, value: { added: [] } })
  })

  it('passes the placement’s refusal through untouched', async () => {
    vi.mocked(versionPlacement).mockResolvedValue({ ok: false, error: 'This isn’t available.' })
    expect(await service.versionRelease({ sectionId: SECTION, versionId: VERSION })).toEqual({ ok: false, error: 'This isn’t available.' })
    expect(db.loadVersion).not.toHaveBeenCalled()
  })
})

describe('Add to this course, then the browser checks', () => {
  it('starts the browser checks for the installation on their own', async () => {
    const r = await service.addSavedVersionToCourse({ sectionId: SECTION, versionId: VERSION })
    expect(r).toEqual({ ok: true, value: { installationId: INSTALLATION, added: true, checks: expect.stringMatching(/running/) } })
    expect(requestRuntimeValidation).toHaveBeenCalledWith({ sectionId: SECTION, installationId: INSTALLATION })
  })

  it('a refused check never undoes the step; the professor is told why', async () => {
    vi.mocked(currentVerdict).mockResolvedValue({ status: 'unavailable', reason: 'runtime_not_checked' })
    vi.mocked(requestRuntimeValidation).mockResolvedValue({ ok: false, error: 'Your school has used today’s browser checks.' })
    expect(await service.addSavedVersionToCourse({ sectionId: SECTION, versionId: VERSION })).toMatchObject({
      ok: true,
      value: { added: true, checks: 'Your school has used today’s browser checks.' },
    })
  })

  it('checks held for a reviewer are explained as that, not as a refusal', async () => {
    vi.mocked(currentVerdict).mockResolvedValue({ status: 'needs_review', runId: 'r', checkIds: ['edtech.purpose'] })
    vi.mocked(requestRuntimeValidation).mockResolvedValue({ ok: false, error: 'The automatic checks have to pass before the browser checks can run.' })
    expect(await service.addSavedVersionToCourse({ sectionId: SECTION, versionId: VERSION })).toMatchObject({
      ok: true,
      value: { checks: expect.stringMatching(/^Studio’s checks are waiting for a Scholera reviewer/) },
    })
    expect(currentVerdict).toHaveBeenCalledWith(VERSION)
  })

  it('code checks still to finish read as that, with no retry promised', async () => {
    vi.mocked(currentVerdict).mockResolvedValue({ status: 'unavailable', reason: 'checking' })
    vi.mocked(requestRuntimeValidation).mockResolvedValue({ ok: false, error: 'The checks just ran. Try again in a minute.' })
    expect(await service.addSavedVersionToCourse({ sectionId: SECTION, versionId: VERSION })).toMatchObject({
      ok: true,
      value: { checks: 'Studio’s checks haven’t finished yet. The tool’s page shows where they are.' },
    })
  })

  it('a refused step starts no checks and passes its warnings through', async () => {
    const warnings = [{ code: 'unreleased_material' as const, message: 'm' }]
    vi.mocked(addVersionToCourse).mockResolvedValue({ ok: false, error: 'Read the warnings before students see this version.', warnings })
    expect(await service.addSavedVersionToCourse({ sectionId: SECTION, versionId: VERSION })).toMatchObject({ ok: false, warnings })
    expect(requestRuntimeValidation).not.toHaveBeenCalled()
  })
})
