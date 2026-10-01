/**
 * deleteCourseAssistant (#725 part 2).
 *
 * Professors and students both had a delete path; course assistants did not. They could be
 * revoked from their sections, but the profile stayed forever, so test and mistaken accounts
 * accumulated with no way to clear them short of a direct DB delete.
 *
 * Three properties, and the last one is the reason this file exists:
 *
 *   1. It refuses while an assignment is still active. Deletion must never be the thing that
 *      silently ends someone's access to a live course — revoke first, like deleteProfessor
 *      refusing while sections are assigned.
 *
 *   2. It refuses on any role but course_assistant. Without that check the staff surface
 *      becomes a way to delete a professor or a student while bypassing the guards those
 *      paths carry.
 *
 *   3. It deletes the PROFILE first and the auth user last. deleteProfessor does the
 *      opposite, and profiles cascade from auth.users, so the profile is already gone when
 *      the second delete runs, it reports zero rows, and the action returns "Failed to
 *      delete" for work that actually succeeded (#723). Asserting the ORDER is the only way
 *      to keep that from being reintroduced, since both orders "work" on the happy path and
 *      only differ in what they report.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockVerifyAdmin = vi.fn()
const mockAssertTenantOwns = vi.fn()

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
vi.mock('@/lib/email', () => ({ sendStaffInvite: vi.fn(), sendStaffRequestDecision: vi.fn() }))
vi.mock('@/lib/auth/admin-context', () => ({
  verifyInstitutionAdmin: (...a: unknown[]) => mockVerifyAdmin(...a),
}))
vi.mock('@/lib/auth/assert-tenant-owns', () => ({
  assertTenantOwns: (...a: unknown[]) => mockAssertTenantOwns(...a),
  assertTenantOwnsVia: vi.fn(async () => ({ ok: true })),
}))

let adminDouble: ReturnType<typeof makeAdmin>
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => adminDouble }))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let deleteCourseAssistant: any

/** Records the order of destructive calls so the sequence can be asserted. */
function makeAdmin(opts: {
  role?: string | null
  activeRows?: unknown[]
  profileDeleteError?: unknown
}) {
  const order: string[] = []
  const deleteUser = vi.fn(async () => {
    order.push('authUser')
    return { error: null }
  })
  const admin = {
    order,
    auth: { admin: { deleteUser } },
    from: (table: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {}
      chain.select = () => chain
      chain.eq = () => chain
      chain.maybeSingle = async () =>
        opts.role === null
          ? { data: null, error: null }
          : { data: { id: 'ca-1', role: opts.role ?? 'course_assistant' }, error: null }
      chain.delete = () => {
        order.push(`delete:${table}`)
        return { eq: async () => ({ error: opts.profileDeleteError ?? null }) }
      }
      chain.then = (f: (v: unknown) => unknown) =>
        Promise.resolve({ data: opts.activeRows ?? [], error: null }).then(f)
      return chain
    },
  }
  return admin
}

beforeEach(async () => {
  vi.resetModules()
  mockVerifyAdmin.mockResolvedValue({ userId: 'admin-1', institutionId: 'inst-1' })
  mockAssertTenantOwns.mockResolvedValue({ ok: true })
  const mod = await import('@/app/(dashboard)/admin/staff-requests/actions')
  deleteCourseAssistant = mod.deleteCourseAssistant
})

describe('deleteCourseAssistant (#725 part 2)', () => {
  it('deletes the profile BEFORE the auth user', async () => {
    adminDouble = makeAdmin({ activeRows: [] })

    const res = await deleteCourseAssistant('ca-1')

    expect(res).toEqual({ success: true })
    /* The order deleteProfessor gets wrong: auth first cascades the profile away, the
       follow-up delete matches zero rows, and the action reports a failure for work that
       succeeded (#723). */
    expect(adminDouble.order).toEqual(['delete:profiles', 'authUser'])
  })

  it('refuses while the assistant still has an active assignment', async () => {
    adminDouble = makeAdmin({ activeRows: [{ id: 's-1' }, { id: 's-2' }] })

    const res = await deleteCourseAssistant('ca-1')

    expect(res.error).toContain('still assigned to 2')
    // Nothing destructive may run on the refusal path.
    expect(adminDouble.order).toEqual([])
  })

  it('refuses to delete a profile that is not a course assistant', async () => {
    adminDouble = makeAdmin({ role: 'professor', activeRows: [] })

    const res = await deleteCourseAssistant('ca-1')

    expect(res.error).toContain('not a course assistant')
    expect(adminDouble.order).toEqual([])
  })

  it('refuses when the caller is not an institution admin', async () => {
    mockVerifyAdmin.mockResolvedValue({ error: 'Not authorized' })
    adminDouble = makeAdmin({ activeRows: [] })

    const res = await deleteCourseAssistant('ca-1')

    expect(res.error).toBe('Not authorized')
    expect(adminDouble.order).toEqual([])
  })

  it('refuses a cross-tenant profile', async () => {
    mockAssertTenantOwns.mockResolvedValue({ ok: false, error: 'Not found' })
    adminDouble = makeAdmin({ activeRows: [] })

    const res = await deleteCourseAssistant('ca-1')

    expect(res.error).toBe('Not found')
    expect(adminDouble.order).toEqual([])
  })
})
