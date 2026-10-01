/**
 * Revoking a pending invite — professors and students (#723).
 *
 * Revoke is destructive and irreversible: it DELETES the auth user, which
 * cascades the profile row away (profiles_id_fkey ON DELETE CASCADE). That is the
 * point — freeing the email address for a re-invite — but it means the console has
 * no "before" state left to compare against, so there is nothing on screen that
 * would reveal a broken revoke. The two invariants below are the only places the
 * truth is observable at all:
 *
 *   1. A deleteUser failure must SURFACE. The old code logged it and carried on
 *      into a dead `UPDATE profiles SET invite_status='revoked'` — dead because the
 *      cascade had already removed the row, so it matched zero rows and reported no
 *      error. The action then returned { success: true } whether or not anything
 *      had happened. The admin saw "invite revoked", the account stayed live, and
 *      the email stayed taken. Software that lied.
 *
 *   2. The audit event must carry the EMAIL. Once the cascade runs, the event is
 *      the only remaining record of who was revoked — a bare id points at a row
 *      that no longer exists, so dropping the email makes the action permanently
 *      unattributable. Nothing else in the system would ever notice.
 *
 * Both actions get the same tests because they are the same fix applied twice; a
 * regression is overwhelmingly likely to land in one copy and not the other, which
 * is exactly what a shared table of cases catches.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockVerifyAdmin = vi.fn()
const mockLogEvent = vi.fn()
const mockProfessorGetById = vi.fn()
const mockStudentGetById = vi.fn()

/** The auth.admin.deleteUser stub — the whole operation, and the thing that fails. */
const mockDeleteUser = vi.fn()
/** Records the profiles-table delete that backs up the cascade. */
const mockProfileDelete = vi.fn()

const INSTITUTION = 'inst-A'

/* One fake admin client serving three call sites: the real assertTenantOwns
   lookup, the auth.admin.deleteUser call, and the belt-and-suspenders
   profiles.delete(). `tenantOf` is a let so a test can move the row to another
   tenant without rebuilding the client. */
let tenantOf: string | null = INSTITUTION

function makeAdminDb() {
  return {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            tenantOf ? { data: { institution_id: tenantOf }, error: null } : { data: null, error: null },
        }),
      }),
      delete: () => ({
        eq: async (_col: string, id: string) => {
          mockProfileDelete(table, id)
          return { data: null, error: null }
        },
      }),
    }),
    auth: { admin: { deleteUser: (...a: unknown[]) => mockDeleteUser(...a) } },
  }
}

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: vi.fn() } })),
}))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => makeAdminDb() }))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('@/lib/supabase/event-logger', () => ({
  logEvent: (...a: unknown[]) => mockLogEvent(...a),
}))
vi.mock('@/lib/auth/admin-context', () => ({
  verifyInstitutionAdmin: (...a: unknown[]) => mockVerifyAdmin(...a),
}))
/* Whole-module replacement, so every named export either action imports has to be
   present here or the import lands as undefined at call time. */
vi.mock('@/lib/supabase/queries', () => ({
  professorQueries: {
    getById: (...a: unknown[]) => mockProfessorGetById(...a),
    getByEmail: vi.fn(),
    upsertProfile: vi.fn(),
    createDepartmentFaculty: vi.fn(),
    getCascadeCounts: vi.fn(),
    remove: vi.fn(),
    getByIdWithDetails: vi.fn(),
    getAllWithDepartments: vi.fn(),
    updateProfile: vi.fn(),
    updateDepartmentFaculty: vi.fn(),
    removeDepartmentFaculty: vi.fn(),
  },
  studentQueries: {
    getById: (...a: unknown[]) => mockStudentGetById(...a),
    getByEmail: vi.fn(),
    getByCwid: vi.fn(),
    getCascadeCounts: vi.fn(),
    remove: vi.fn(),
    updateProfile: vi.fn(),
    getByIdWithDetails: vi.fn(),
    getAllWithEnrollments: vi.fn(),
  },
  profileQueries: { getProfileById: vi.fn() },
}))
vi.mock('@/lib/email', () => ({
  sendProfessorWelcome: vi.fn(),
  sendStudentCredentials: vi.fn(),
}))
vi.mock('@/lib/admin/provision-student', () => ({ provisionStudentAccount: vi.fn() }))

/* Each row is one revoke action plus the fixtures it needs, so every case below
   runs identically against both. The event type and metadata id key differ, and
   that difference is itself part of the contract. */
interface RevokeCase {
  label: string
  modulePath: string
  exportName: string
  getByIdMock: ReturnType<typeof vi.fn>
  subjectId: string
  email: string
  eventType: string
  idKey: string
  notFoundError: RegExp
}

const CASES: RevokeCase[] = [
  {
    label: 'revokeProfessorInvite',
    modulePath: '@/app/(dashboard)/admin/professors/actions',
    exportName: 'revokeProfessorInvite',
    getByIdMock: mockProfessorGetById,
    subjectId: 'prof-1',
    email: 'newprof@example.com',
    eventType: 'professor.invite_revoked',
    idKey: 'professorId',
    notFoundError: /professor not found/i,
  },
  {
    label: 'revokeStudentInvite',
    modulePath: '@/app/(dashboard)/admin/students/actions',
    exportName: 'revokeStudentInvite',
    getByIdMock: mockStudentGetById,
    subjectId: 'stu-1',
    email: 'newstudent@example.com',
    eventType: 'student.invite_revoked',
    idKey: 'studentId',
    notFoundError: /student not found/i,
  },
]

for (const c of CASES) {
  describe(`${c.label} (#723)`, () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let revoke: any

    beforeEach(async () => {
      vi.resetModules()
      tenantOf = INSTITUTION
      mockVerifyAdmin.mockReset().mockResolvedValue({ userId: 'admin-A', institutionId: INSTITUTION })
      mockLogEvent.mockReset()
      mockDeleteUser.mockReset().mockResolvedValue({ data: { user: null }, error: null })
      mockProfileDelete.mockReset()
      c.getByIdMock.mockReset().mockResolvedValue({
        id: c.subjectId,
        email: c.email,
        invite_status: 'pending',
      })

      const mod = await import(c.modulePath)
      revoke = mod[c.exportName]
    })

    it('deletes the auth user, which is what frees the email for a re-invite', async () => {
      const res = await revoke(c.subjectId)
      expect(res).toEqual({ success: true })
      expect(mockDeleteUser).toHaveBeenCalledWith(c.subjectId)
    })

    /* THE #723 regression. A deleteUser failure means nothing was revoked: the
       account is still live and the address is still taken. Reporting success here
       is worse than reporting nothing, because the admin's next move is to re-invite
       the same address and hit "email already exists" with no explanation. */
    it('reports an error when the auth-user delete fails, instead of a false success', async () => {
      mockDeleteUser.mockResolvedValue({ data: null, error: { message: 'auth service down' } })

      const res = await revoke(c.subjectId)

      expect(res.success).toBeUndefined()
      expect(res.error).toBe('Failed to revoke invite')
    })

    /* The old code's tell: after a failed delete it fell through and still wrote an
       audit event, so the log claimed a revoke that never happened. */
    it('logs no revocation event when the delete failed', async () => {
      mockDeleteUser.mockResolvedValue({ data: null, error: { message: 'auth service down' } })

      await revoke(c.subjectId)

      expect(mockLogEvent).not.toHaveBeenCalled()
    })

    /* The cascade removes the profile, so this event is the last trace of who was
       revoked. Without the email it names a row that no longer exists. */
    it('records the email on the audit event, the only surviving record of who was revoked', async () => {
      await revoke(c.subjectId)

      expect(mockLogEvent).toHaveBeenCalledTimes(1)
      expect(mockLogEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: c.eventType,
          metadata: expect.objectContaining({ [c.idKey]: c.subjectId, email: c.email }),
        }),
      )
    })

    it('refuses to revoke an invite that is no longer pending, and deletes nothing', async () => {
      c.getByIdMock.mockResolvedValue({ id: c.subjectId, email: c.email, invite_status: 'accepted' })

      const res = await revoke(c.subjectId)

      expect(res.error).toMatch(/only revoke pending invites/i)
      expect(mockDeleteUser).not.toHaveBeenCalled()
    })

    it('refuses a subject in another institution before deleting anything', async () => {
      tenantOf = 'inst-B'

      const res = await revoke(c.subjectId)

      /* The behaviour, not the copy: refuse, and touch nothing. Pinning the exact
         string coupled this to wording that has since changed. */
      expect(res.success).toBeUndefined()
      expect(res.error).toBeTruthy()
      expect(mockDeleteUser).not.toHaveBeenCalled()
      expect(mockLogEvent).not.toHaveBeenCalled()
      /* The property that must hold: a cross-tenant id gets the SAME words as a
         stale one, or the message becomes an existence oracle for other tenants'
         rows. Asserted by exclusion — nothing here may hint the row is real. */
      expect(res.error).not.toMatch(/another institution|other tenant|belongs to/i)
    })

    it('returns not-found when the subject does not exist', async () => {
      c.getByIdMock.mockResolvedValue(null)

      const res = await revoke(c.subjectId)

      expect(res.error).toMatch(c.notFoundError)
      expect(mockDeleteUser).not.toHaveBeenCalled()
    })
  })
}
