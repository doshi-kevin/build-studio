// Authorization tests for the submission-file viewers. The viewer actions read
// arbitrary `submissionId` / `filePath` from the client, so authorizeSubmissionFile
// must (a) allow only the owning student or section staff, and (b) confirm the path
// actually belongs to the submission — otherwise a student could mint a read of a
// classmate's file (the IDOR class the dedicated bucket exists to prevent).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockAdminClient } from './helpers/mock-supabase'

const mockGetUser = vi.fn()
const mockAdminClient = vi.fn()
const mockVerifySectionAccess = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: (...args: unknown[]) => mockAdminClient(...args),
}))
vi.mock('@/lib/auth/section-access', () => ({
  verifySectionAccess: (...args: unknown[]) => mockVerifySectionAccess(...args),
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mod: any

const SUBMISSION = {
  id: 'sub-1',
  student_id: 'student-1',
  files: [{ path: 'sec/asg/student-1/a.zip', name: 'a.zip', size: 10, type: 'application/zip' }],
  assignment: { section_id: 'sec-1' },
}

function setup(submission: unknown = SUBMISSION) {
  mockAdminClient.mockReturnValue(
    createMockAdminClient({ assignment_submissions: { data: submission, error: null } }),
  )
}

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset().mockResolvedValue({ data: { user: { id: 'student-1' } }, error: null })
  mockAdminClient.mockReset()
  mockVerifySectionAccess.mockReset()
  mod = await import('@/lib/assignments/viewer-auth')
})

describe('authorizeSubmissionFile', () => {
  it('rejects an unauthenticated caller', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null })
    setup()
    const res = await mod.authorizeSubmissionFile('sub-1', 'sec/asg/student-1/a.zip')
    expect(res).toEqual({ error: expect.any(String) })
  })

  it('rejects a path that is not one of the submission files (IDOR guard)', async () => {
    setup() // caller is the owner, so only the path check can fail
    const res = await mod.authorizeSubmissionFile('sub-1', 'sec/asg/student-2/secret.zip')
    expect(res).toEqual({ error: 'File not found.' })
  })

  it('allows the owning student with a valid path', async () => {
    setup()
    const res = await mod.authorizeSubmissionFile('sub-1', 'sec/asg/student-1/a.zip')
    expect(res.error).toBeUndefined()
    expect(res.path).toBe('sec/asg/student-1/a.zip')
    expect(res.fileName).toBe('a.zip')
    expect(mockVerifySectionAccess).not.toHaveBeenCalled() // owner short-circuits the staff check
  })

  it('rejects a non-owner who is not section staff', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'intruder' } }, error: null })
    mockVerifySectionAccess.mockResolvedValue({ ok: false })
    setup()
    const res = await mod.authorizeSubmissionFile('sub-1', 'sec/asg/student-1/a.zip')
    expect(res).toEqual({ error: 'You do not have access to this submission.' })
  })

  it('allows a non-owner who is section staff', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'ta-1' } }, error: null })
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'ta' })
    setup()
    const res = await mod.authorizeSubmissionFile('sub-1', 'sec/asg/student-1/a.zip')
    expect(res.error).toBeUndefined()
    expect(res.path).toBe('sec/asg/student-1/a.zip')
    expect(mockVerifySectionAccess).toHaveBeenCalledWith('sec-1', 'ta-1')
  })
})
