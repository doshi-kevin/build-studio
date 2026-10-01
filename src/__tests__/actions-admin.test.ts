// Tests for admin server actions — student/professor CRUD auth checks.
// Verifies that all admin actions reject unauthenticated and non-admin users.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Module-Level Mock References ─────────────────────────────

const mockGetUser = vi.fn()
const mockAdminClient = vi.fn()
const mockGetProfileById = vi.fn()

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: (...args: unknown[]) => mockAdminClient(...args),
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
vi.mock('@/lib/supabase/queries', () => ({
  profileQueries: {
    getProfileById: (...args: unknown[]) => mockGetProfileById(...args),
  },
  studentQueries: {
    getByEmail: vi.fn(),
    getByCwid: vi.fn(),
  },
}))
vi.mock('@/lib/email', () => ({
  sendStudentCredentials: vi.fn().mockResolvedValue({ success: true }),
  sendProfessorInvite: vi.fn().mockResolvedValue({ success: true }),
}))
vi.mock('@/lib/validations/student', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/validations/student')>()
  return {
    ...orig,
    generateSecurePassword: vi.fn().mockReturnValue('SecurePass123!'),
  }
})

// ── Test Setup ───────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createStudent: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let deleteStudent: any

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockAdminClient.mockReset()
  mockGetProfileById.mockReset()

  const mod = await import('@/app/(dashboard)/admin/students/actions')
  createStudent = mod.createStudent
  deleteStudent = mod.deleteStudent
})

function mockUnauthenticated() {
  mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'No user' } })
}

function mockStudentRole() {
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
  mockGetProfileById.mockResolvedValue({ id: 'user-1', role: 'student' })
}

function mockProfessorRole() {
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
  mockGetProfileById.mockResolvedValue({ id: 'user-1', role: 'professor' })
}

// ── createStudent Auth Checks ────────────────────────────────

describe('createStudent', () => {
  const validInput = {
    email: 'test@university.edu',
    first_name: 'Test',
    last_name: 'Student',
    cwid: '12345678',
  }

  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const result = await createStudent(validInput)
    expect(result.error).toBe('Not authenticated')
  })

  it('rejects student role', async () => {
    mockStudentRole()
    const result = await createStudent(validInput)
    expect(result.error).toBe('Unauthorized — admin access required')
  })

  it('rejects professor role', async () => {
    mockProfessorRole()
    const result = await createStudent(validInput)
    expect(result.error).toBe('Unauthorized — admin access required')
  })

  it('rejects invalid input (bad email)', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'admin-1', app_metadata: { institution_status: 'active' } } },
      error: null,
    })
    mockGetProfileById.mockResolvedValue({ id: 'admin-1', role: 'institution_admin', institution_id: 'inst-test-1' })

    const result = await createStudent({ ...validInput, email: 'not-email' })
    expect(result.error).toBe('Must be a valid email address')
    expect(result.success).toBeUndefined()
  })

  it('rejects invalid CWID (not 8 digits)', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'admin-1', app_metadata: { institution_status: 'active' } } },
      error: null,
    })
    mockGetProfileById.mockResolvedValue({ id: 'admin-1', role: 'institution_admin', institution_id: 'inst-test-1' })

    const result = await createStudent({ ...validInput, cwid: '123' })
    expect(result.error).toBe('CWID must be exactly 8 digits')
  })
})

// ── deleteStudent Auth Checks ────────────────────────────────

describe('deleteStudent', () => {
  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const result = await deleteStudent('student-1')
    expect(result.error).toBe('Not authenticated')
  })

  it('rejects non-admin roles', async () => {
    mockStudentRole()
    const result = await deleteStudent('student-1')
    expect(result.error).toBe('Unauthorized — admin access required')
  })
})

