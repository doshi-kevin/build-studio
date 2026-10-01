/**
 * Trusted contexts are built from the session and the database only. The session,
 * section access, enrollment, publication, Studio access and Studio tables are mocked;
 * the decisions about which of them to consult, in what order, and what the viewer may
 * do, are what's under test. The real publication and access modules have their own
 * tests (studio-access.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import exitTicket from '@/lib/studio/fixtures/exit-ticket/plugin.manifest.json'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/auth/section-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/section-access')>()),
  verifySectionAccess: vi.fn(),
}))
vi.mock('@/lib/studio/db', () => ({
  loadInstallation: vi.fn(),
  loadVersion: vi.fn(),
  loadEnrollmentStatus: vi.fn(),
  loadSectionState: vi.fn(),
}))
vi.mock('@/lib/studio/publication', () => ({ isPublishedToStudents: vi.fn() }))
vi.mock('@/lib/studio/access', () => ({ studioAccess: vi.fn() }))

const { createClient } = await import('@/lib/supabase/server')
const { verifySectionAccess } = await import('@/lib/auth/section-access')
const db = await import('@/lib/studio/db')
const { isPublishedToStudents } = await import('@/lib/studio/publication')
const { studioAccess } = await import('@/lib/studio/access')
const { resolveViewer, requireProfessor, candidateVersion } = await import('@/lib/studio/context')

const USER = crypto.randomUUID()
const INSTALLATION = {
  id: crypto.randomUUID(),
  institutionId: crypto.randomUUID(),
  sectionId: crypto.randomUUID(),
  projectId: crypto.randomUUID(),
  status: 'active' as const,
  currentVersionId: crypto.randomUUID(),
  studentVisibility: 'hidden' as const,
}
const VERSION = {
  id: INSTALLATION.currentVersionId,
  projectId: INSTALLATION.projectId,
  institutionId: INSTALLATION.institutionId,
  version: '1.0.0',
  bridgeVersion: 'v1',
  manifest: exitTicket,
}
const adminDb = { from: vi.fn() }

function signedIn(userId: string | null) {
  vi.mocked(createClient).mockResolvedValue({
    auth: { getUser: async () => ({ data: { user: userId ? { id: userId } : null } }) },
  } as never)
}

function staff(role: 'professor' | 'ta' | 'grader' | null) {
  vi.mocked(verifySectionAccess).mockResolvedValue(role ? { ok: true, role, adminDb } : { ok: false, adminDb })
}

/** A student enrolled with this status, on an installation shown to students. */
function student(enrollment: 'enrolled' | 'completed') {
  staff(null)
  vi.mocked(isPublishedToStudents).mockReturnValue(true)
  vi.mocked(db.loadEnrollmentStatus).mockResolvedValue(enrollment)
}

beforeEach(() => {
  vi.clearAllMocks()
  signedIn(USER)
  vi.mocked(db.loadInstallation).mockResolvedValue(INSTALLATION)
  vi.mocked(db.loadVersion).mockResolvedValue(VERSION)
  vi.mocked(db.loadEnrollmentStatus).mockResolvedValue(null)
  vi.mocked(db.loadSectionState).mockResolvedValue({ institutionId: INSTALLATION.institutionId, archived: false })
  vi.mocked(isPublishedToStudents).mockReturnValue(false)
  vi.mocked(studioAccess).mockResolvedValue('full')
})

describe('resolveViewer', () => {
  it('refuses without a session, before loading anything', async () => {
    signedIn(null)
    expect(await resolveViewer(INSTALLATION.id)).toBeNull()
    expect(db.loadInstallation).not.toHaveBeenCalled()
  })

  it('refuses an installation that doesn’t exist', async () => {
    vi.mocked(db.loadInstallation).mockResolvedValue(null)
    expect(await resolveViewer(INSTALLATION.id)).toBeNull()
  })

  it.each(['professor', 'ta', 'grader'] as const)(
    'gives a %s their role, checked against the installation’s own section',
    async (role) => {
      staff(role)
      const viewer = await resolveViewer(INSTALLATION.id)
      expect(viewer).toMatchObject({
        userId: USER,
        role,
        sectionId: INSTALLATION.sectionId,
        institutionId: INSTALLATION.institutionId,
        projectId: INSTALLATION.projectId,
        writable: true,
      })
      expect(verifySectionAccess).toHaveBeenCalledWith(INSTALLATION.sectionId, USER)
    },
  )

  it('always uses the installation’s current version', async () => {
    staff('professor')
    const viewer = await resolveViewer(INSTALLATION.id)
    expect(db.loadVersion).toHaveBeenCalledWith(INSTALLATION.currentVersionId)
    expect(viewer?.versionId).toBe(INSTALLATION.currentVersionId)
  })

  it('refuses a student while the installation isn’t shown to students, without looking up enrollment', async () => {
    staff(null)
    expect(await resolveViewer(INSTALLATION.id)).toBeNull()
    expect(isPublishedToStudents).toHaveBeenCalledWith(INSTALLATION)
    expect(db.loadEnrollmentStatus).not.toHaveBeenCalled()
  })

  it('makes an enrolled student a student once the installation is shown to students', async () => {
    student('enrolled')
    expect(await resolveViewer(INSTALLATION.id)).toMatchObject({ role: 'student', userId: USER, writable: true })
    expect(db.loadEnrollmentStatus).toHaveBeenCalledWith(INSTALLATION.sectionId, USER)
  })

  it('refuses someone who is neither staff nor enrolled, even when the installation is shown', async () => {
    staff(null)
    vi.mocked(isPublishedToStudents).mockReturnValue(true)
    expect(await resolveViewer(INSTALLATION.id)).toBeNull()
  })

  it.each([
    ['a professor', () => staff('professor')],
    ['a student', () => student('enrolled')],
  ])('refuses %s while the Studio kill switch is engaged', async (_label, arrange) => {
    arrange()
    vi.mocked(studioAccess).mockResolvedValue('off')
    expect(await resolveViewer(INSTALLATION.id)).toBeNull()
    expect(studioAccess).toHaveBeenCalledWith(INSTALLATION.institutionId)
  })

  it.each([
    ['the installation is archived', () => vi.mocked(db.loadInstallation).mockResolvedValue({ ...INSTALLATION, status: 'archived' })],
    ['the section is archived', () => vi.mocked(db.loadSectionState).mockResolvedValue({ institutionId: INSTALLATION.institutionId, archived: true })],
    ['the school lost the Studio entitlement', () => vi.mocked(studioAccess).mockResolvedValue('read_only')],
  ])('keeps a professor reading but not writing when %s', async (_label, arrange) => {
    staff('professor')
    arrange()
    expect(await resolveViewer(INSTALLATION.id)).toMatchObject({ role: 'professor', writable: false })
  })

  it('lets a completed student read their history but not write', async () => {
    student('completed')
    expect(await resolveViewer(INSTALLATION.id)).toMatchObject({ role: 'student', writable: false, readOnlyReason: 'enrollment_completed' })
  })

  it.each([
    ['installation_archived', () => vi.mocked(db.loadInstallation).mockResolvedValue({ ...INSTALLATION, status: 'archived' })],
    ['section_archived', () => vi.mocked(db.loadSectionState).mockResolvedValue({ institutionId: INSTALLATION.institutionId, archived: true })],
    ['not_entitled', () => vi.mocked(studioAccess).mockResolvedValue('read_only')],
  ])('says why it is read-only: %s', async (reason, arrange) => {
    staff('professor')
    arrange()
    expect(await resolveViewer(INSTALLATION.id)).toMatchObject({ writable: false, readOnlyReason: reason })
  })

  it('gives no reason when the viewer may write', async () => {
    staff('professor')
    expect(await resolveViewer(INSTALLATION.id)).toMatchObject({ writable: true, readOnlyReason: null })
  })

  it('refuses when the section can’t be read', async () => {
    staff('professor')
    vi.mocked(db.loadSectionState).mockResolvedValue(null)
    expect(await resolveViewer(INSTALLATION.id)).toBeNull()
  })

  it('refuses when the stored manifest no longer parses', async () => {
    staff('professor')
    vi.mocked(db.loadVersion).mockResolvedValue({ ...VERSION, manifest: { ...exitTicket, views: {} } })
    expect(await resolveViewer(INSTALLATION.id)).toBeNull()
  })
})

describe('candidateVersion', () => {
  const CANDIDATE = { ...VERSION, id: crypto.randomUUID(), version: '1.1.0', manifest: { ...exitTicket, version: '1.1.0' } }

  async function viewerAs(role: 'professor' | 'ta') {
    staff(role)
    const viewer = await resolveViewer(INSTALLATION.id)
    vi.mocked(db.loadVersion).mockResolvedValue(CANDIDATE)
    return viewer!
  }

  it('gives the section’s professor another version of the same project to preview', async () => {
    const viewer = await viewerAs('professor')
    expect(await candidateVersion(viewer, CANDIDATE.id)).toMatchObject({ versionId: CANDIDATE.id, manifest: { version: '1.1.0' } })
  })

  it('refuses a TA', async () => {
    expect(await candidateVersion(await viewerAs('ta'), CANDIDATE.id)).toBeNull()
  })

  it.each([
    ['another project', { projectId: crypto.randomUUID() }],
    ['another institution', { institutionId: crypto.randomUUID() }],
    ['a manifest that no longer parses', { manifest: { ...exitTicket, views: {} } }],
  ])('refuses a version from %s', async (_label, change) => {
    const viewer = await viewerAs('professor')
    vi.mocked(db.loadVersion).mockResolvedValue({ ...CANDIDATE, ...change })
    expect(await candidateVersion(viewer, CANDIDATE.id)).toBeNull()
  })
})

describe('requireProfessor', () => {
  const SECTION = crypto.randomUUID()
  const INSTITUTION = crypto.randomUUID()

  beforeEach(() => {
    adminDb.from.mockReturnValue({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { institution_id: INSTITUTION } }) }) }),
    })
  })

  it('gives the section’s professor a context with the section’s institution', async () => {
    staff('professor')
    expect(await requireProfessor(SECTION)).toEqual({ userId: USER, sectionId: SECTION, institutionId: INSTITUTION })
  })

  it.each(['ta', 'grader', null] as const)('refuses %s', async (role) => {
    staff(role)
    expect(await requireProfessor(SECTION)).toBeNull()
  })
})
