// provisionStudentAccount — the ONE place a student account comes into existence
// (admin single-add + bulk roster import both route through it). The account-shape
// flags are load-bearing: email_confirm lets the student log in at all, and
// requires_password_set is what forces SetPasswordDialog on first navigation —
// dropping it would leave imported students on an emailed temp password forever.
// Also asserts the two failure paths return, never throw, and never half-report.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockUpsertProfile = vi.fn()

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('@/lib/supabase/queries', () => ({
  studentQueries: {
    upsertProfile: (...args: unknown[]) => mockUpsertProfile(...args),
  },
}))

import { provisionStudentAccount } from '@/lib/admin/provision-student'

const mockCreateUser = vi.fn()
const adminDb = { auth: { admin: { createUser: (...args: unknown[]) => mockCreateUser(...args) } } }

const INPUT = {
  email: 'new@uni.edu',
  firstName: 'New',
  lastName: 'Kid',
  cwid: null,
  institutionId: 'inst-1',
  invitedBy: 'admin-1',
}

beforeEach(() => {
  mockCreateUser.mockReset()
  mockUpsertProfile.mockReset()
  mockCreateUser.mockResolvedValue({ data: { user: { id: 'stu-new' } }, error: null })
  mockUpsertProfile.mockResolvedValue({ id: 'stu-new' })
})

describe('provisionStudentAccount', () => {
  it('creates a confirmed auth user that is forced to set its own password', async () => {
    const result = await provisionStudentAccount(adminDb, INPUT)

    expect(result).toMatchObject({ ok: true, userId: 'stu-new' })
    const payload = mockCreateUser.mock.calls[0][0]
    expect(payload).toMatchObject({
      email: 'new@uni.edu',
      email_confirm: true,
      app_metadata: { requires_password_set: true },
      user_metadata: { name: 'New Kid', role: 'student' },
    })
    // The returned password is the one the account was created with — it is the
    // only copy (the caller emails it / puts it in the credentials CSV).
    expect(result.ok && result.password).toBe(payload.password)
    expect(typeof payload.password).toBe('string')
    expect(payload.password.length).toBeGreaterThan(8)
  })

  it('upserts the profile into the CALLER-verified tenant, pending and un-onboarded', async () => {
    await provisionStudentAccount(adminDb, { ...INPUT, cwid: '12345678', phone: '555' })

    expect(mockUpsertProfile.mock.calls[0][1]).toMatchObject({
      id: 'stu-new',
      email: 'new@uni.edu',
      name: 'New Kid',
      first_name: 'New',
      last_name: 'Kid',
      cwid: '12345678',
      institution_id: 'inst-1',
      invited_by: 'admin-1',
      invite_status: 'pending',
      onboarding_completed: false,
    })
  })

  it('passes a null cwid through (bulk-import accounts log in by email)', async () => {
    await provisionStudentAccount(adminDb, INPUT)
    expect(mockUpsertProfile.mock.calls[0][1].cwid).toBeNull()
  })

  it('fails generically on an auth error — never echoing it back to the admin', async () => {
    // auth.users is GLOBAL across tenants: echoing "already been registered" would
    // let an admin probe whether an email has an account at another institution.
    mockCreateUser.mockResolvedValue({
      data: null,
      error: { message: 'A user with this email address has already been registered' },
    })

    const result = await provisionStudentAccount(adminDb, INPUT)

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).not.toContain('already been registered')
    expect(result.ok === false && result.error).toBe(
      'Could not create an account for this email — it may already be in use'
    )
    expect(mockUpsertProfile).not.toHaveBeenCalled()
  })

  it('reports a failed profile upsert rather than claiming success', async () => {
    mockUpsertProfile.mockResolvedValue(null)

    const result = await provisionStudentAccount(adminDb, INPUT)

    expect(result).toEqual({ ok: false, error: 'Account created but profile update failed' })
  })
})
