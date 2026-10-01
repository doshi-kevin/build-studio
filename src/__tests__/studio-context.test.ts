/**
 * Trusted contexts are built from the session and the database only. The session,
 * section access, enrollment, publication and Studio tables are mocked; the decisions
 * about which of them to consult, and in what order, are what's under test.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import exitTicket from '@/lib/studio/fixtures/exit-ticket/plugin.manifest.json'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/auth/section-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/section-access')>()),
  verifySectionAccess: vi.fn(),
}))
vi.mock('@/lib/live-classroom/room-auth', () => ({ isEnrolled: vi.fn() }))
vi.mock('@/lib/studio/db', () => ({ loadInstallation: vi.fn(), loadVersion: vi.fn() }))
vi.mock('@/lib/studio/publication', () => ({ isPublishedToStudents: vi.fn() }))

const { createClient } = await import('@/lib/supabase/server')
const { verifySectionAccess } = await import('@/lib/auth/section-access')
const { isEnrolled } = await import('@/lib/live-classroom/room-auth')
const db = await import('@/lib/studio/db')
const { isPublishedToStudents } = await import('@/lib/studio/publication')
const { resolveViewer, requireProfessor } = await import('@/lib/studio/context')

const USER = crypto.randomUUID()
const INSTALLATION = {
  id: crypto.randomUUID(),
  institutionId: crypto.randomUUID(),
  sectionId: crypto.randomUUID(),
  projectId: crypto.randomUUID(),
  status: 'active' as const,
  currentVersionId: crypto.randomUUID(),
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

beforeEach(() => {
  vi.clearAllMocks()
  signedIn(USER)
  vi.mocked(db.loadInstallation).mockResolvedValue(INSTALLATION)
  vi.mocked(db.loadVersion).mockResolvedValue({
    id: INSTALLATION.currentVersionId,
    projectId: INSTALLATION.projectId,
    institutionId: INSTALLATION.institutionId,
    version: '1.0.0',
    manifest: exitTicket,
  })
  vi.mocked(isEnrolled).mockResolvedValue(false)
  vi.mocked(isPublishedToStudents).mockResolvedValue(false)
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

  it('refuses an enrolled student while the installation isn’t published to students (v1: never)', async () => {
    staff(null)
    vi.mocked(isEnrolled).mockResolvedValue(true)
    expect(await resolveViewer(INSTALLATION.id)).toBeNull()
    expect(isPublishedToStudents).toHaveBeenCalledWith(INSTALLATION)
  })

  it('makes an enrolled student a student once the installation is published to students', async () => {
    staff(null)
    vi.mocked(isEnrolled).mockResolvedValue(true)
    vi.mocked(isPublishedToStudents).mockResolvedValue(true)
    expect(await resolveViewer(INSTALLATION.id)).toMatchObject({ role: 'student', userId: USER })
  })

  it('refuses someone who is neither staff nor enrolled, whatever the publication state', async () => {
    staff(null)
    vi.mocked(isPublishedToStudents).mockResolvedValue(true)
    expect(await resolveViewer(INSTALLATION.id)).toBeNull()
  })

  it('refuses when the stored manifest no longer parses', async () => {
    staff('professor')
    vi.mocked(db.loadVersion).mockResolvedValue({
      id: INSTALLATION.currentVersionId,
      projectId: INSTALLATION.projectId,
      institutionId: INSTALLATION.institutionId,
      version: '1.0.0',
      manifest: { ...exitTicket, views: {} },
    })
    expect(await resolveViewer(INSTALLATION.id)).toBeNull()
  })
})

describe('the real publication module', () => {
  it('publishes nothing to students until the publication slice replaces it', async () => {
    const real = await vi.importActual<typeof import('@/lib/studio/publication')>('@/lib/studio/publication')
    expect(await real.isPublishedToStudents(INSTALLATION)).toBe(false)
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
