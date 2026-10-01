// uploadCellImage is a professor/TA-only storage write. The client is untrusted, so
// the server must enforce: signed-in, staff on THIS section, the assignment belongs to
// the section (no cross-section IDOR), and file size/MIME limits (SVG excluded). These
// tests assert those guards fire before any storage upload — a client control is not a
// server control (same PR #198 lesson as saveAssignmentRubric / gradeSubmission).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockAdminClient } from './helpers/mock-supabase'

const mockGetUser = vi.fn()
const mockVerifySectionAccess = vi.fn()
let adminClient: ReturnType<typeof createMockAdminClient>

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}))
vi.mock('@/lib/auth/section-access', () => ({
  verifySectionAccess: (...args: unknown[]) => mockVerifySectionAccess(...args),
  canWriteAsStaff: (role: string) => role === 'professor' || role === 'ta',
}))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mod: any

const pngFile = (opts: { size?: number; type?: string; name?: string } = {}) => {
  const size = opts.size ?? 1024
  const file = new File([new Uint8Array(size)], opts.name ?? 'chart.png', {
    type: opts.type ?? 'image/png',
  })
  return file
}

const formWith = (file: File | null) => {
  const fd = new FormData()
  if (file) fd.set('image', file)
  return fd
}

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset().mockResolvedValue({ data: { user: { id: 'prof-1' } }, error: null })
  adminClient = createMockAdminClient({
    assignments: { data: { id: 'asg-1', section_id: 'sec-1' }, error: null },
  })
  mockVerifySectionAccess
    .mockReset()
    .mockResolvedValue({ ok: true, role: 'professor', adminDb: adminClient })
  mod = await import('@/app/(dashboard)/professor/courses/[sectionId]/assignments/actions')
})

describe('uploadCellImage — access control', () => {
  it('rejects an unauthenticated caller and uploads nothing', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null })
    const res = await mod.uploadCellImage('sec-1', 'asg-1', formWith(pngFile()))
    expect(res).toEqual({ error: expect.any(String) })
    expect(adminClient.storage.from).not.toHaveBeenCalled()
  })

  it('rejects a caller who lacks staff write access on the section', async () => {
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'student', adminDb: adminClient })
    const res = await mod.uploadCellImage('sec-1', 'asg-1', formWith(pngFile()))
    expect(res).toEqual({ error: expect.stringContaining('permission') })
    expect(adminClient.storage.from).not.toHaveBeenCalled()
  })

  it('rejects when the assignment belongs to a different section (no cross-section IDOR)', async () => {
    adminClient = createMockAdminClient({
      assignments: { data: { id: 'asg-1', section_id: 'other-sec' }, error: null },
    })
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb: adminClient })
    const res = await mod.uploadCellImage('sec-1', 'asg-1', formWith(pngFile()))
    expect(res).toEqual({ error: expect.stringContaining('not found') })
    expect(adminClient.storage.from).not.toHaveBeenCalled()
  })
})

describe('uploadCellImage — input validation', () => {
  it('rejects a missing file', async () => {
    const res = await mod.uploadCellImage('sec-1', 'asg-1', formWith(null))
    expect(res).toEqual({ error: expect.any(String) })
    expect(adminClient.storage.from).not.toHaveBeenCalled()
  })

  it('rejects a file over the 5 MB cap', async () => {
    const res = await mod.uploadCellImage('sec-1', 'asg-1', formWith(pngFile({ size: 6 * 1024 * 1024 })))
    expect(res).toEqual({ error: expect.stringContaining('5 MB') })
    expect(adminClient.storage.from).not.toHaveBeenCalled()
  })

  it('rejects a disallowed MIME type (SVG excluded on purpose)', async () => {
    const res = await mod.uploadCellImage('sec-1', 'asg-1', formWith(pngFile({ type: 'image/svg+xml' })))
    expect(res).toEqual({ error: expect.any(String) })
    expect(adminClient.storage.from).not.toHaveBeenCalled()
  })
})

describe('uploadCellImage — happy path', () => {
  it('uploads a valid image and returns its public URL', async () => {
    const res = await mod.uploadCellImage('sec-1', 'asg-1', formWith(pngFile()))
    expect(res).toEqual({ success: true, url: expect.any(String) })
    expect(adminClient.storage.from).toHaveBeenCalledWith('assignment-cell-images')
  })
})
