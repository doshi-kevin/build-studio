// uploadAssignmentAttachment is a professor/TA-only storage write + assignment mutation
// (the in-context Athena panel's "attach a file" path). The client is untrusted, so the
// server must enforce: signed-in, staff on THIS section, the assignment belongs to the
// section (no cross-section IDOR), the attachment cap, and type/size limits (SVG excluded).
// It must also roll the uploaded object back if the settings update fails. These tests pin
// those guards fire before/around the storage write — a client control is not a server
// control (same lesson as uploadCellImage / saveAssignmentRubric / gradeSubmission).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildFullChain } from './helpers/mock-supabase'
import { MAX_ASSIGNMENT_PDFS } from '@/lib/validations/assignment'

const mockGetUser = vi.fn()
const mockVerifySectionAccess = vi.fn()

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

const pdfFile = (opts: { size?: number; type?: string; name?: string } = {}) =>
  new File([new Uint8Array(opts.size ?? 1024)], opts.name ?? 'brief.pdf', {
    type: opts.type ?? 'application/pdf',
  })

const formWith = (file: File | null) => {
  const fd = new FormData()
  if (file) fd.set('file', file)
  return fd
}

// Admin client: the 'assignments' chain serves the ownership select .maybeSingle() (reads .data),
// and the settings write goes through the merge_assignment_settings RPC (reads .error). updateError
// now drives the rpc result so the rollback assertion still exercises the write-failure path.
// Storage upload/remove are tracked for the "nothing uploaded" and rollback assertions.
function makeAdmin(opts: {
  assignment: unknown
  updateError?: unknown
  uploadError?: unknown
} = { assignment: { id: 'asg-1', section_id: 'sec-1', settings: {} } }) {
  const upload = vi.fn().mockResolvedValue({ data: { path: 'p' }, error: opts.uploadError ?? null })
  const remove = vi.fn().mockResolvedValue({ data: null, error: null })
  const storageFrom = vi.fn().mockReturnValue({ upload, remove })
  return {
    from: vi.fn(() => buildFullChain({ data: opts.assignment, error: null })),
    rpc: vi.fn().mockResolvedValue({ error: opts.updateError ?? null }),
    storage: { from: storageFrom },
    _upload: upload,
    _remove: remove,
    _storageFrom: storageFrom,
  }
}

let admin: ReturnType<typeof makeAdmin>

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset().mockResolvedValue({ data: { user: { id: 'prof-1' } }, error: null })
  admin = makeAdmin({ assignment: { id: 'asg-1', section_id: 'sec-1', settings: {} } })
  mockVerifySectionAccess.mockReset().mockResolvedValue({ ok: true, role: 'professor', adminDb: admin })
  mod = await import('@/app/(dashboard)/professor/courses/[sectionId]/assignments/actions')
})

describe('uploadAssignmentAttachment — access control', () => {
  it('rejects an unauthenticated caller and uploads nothing', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null })
    const res = await mod.uploadAssignmentAttachment('sec-1', 'asg-1', formWith(pdfFile()))
    expect(res).toEqual({ error: expect.any(String) })
    expect(admin._storageFrom).not.toHaveBeenCalled()
  })

  it('rejects a caller who lacks staff write access on the section', async () => {
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'student', adminDb: admin })
    const res = await mod.uploadAssignmentAttachment('sec-1', 'asg-1', formWith(pdfFile()))
    expect(res).toEqual({ error: expect.stringContaining('permission') })
    expect(admin._storageFrom).not.toHaveBeenCalled()
  })

  it('rejects when the assignment belongs to a different section (no cross-section IDOR)', async () => {
    admin = makeAdmin({ assignment: { id: 'asg-1', section_id: 'other-sec', settings: {} } })
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb: admin })
    const res = await mod.uploadAssignmentAttachment('sec-1', 'asg-1', formWith(pdfFile()))
    expect(res).toEqual({ error: expect.stringContaining('not found') })
    expect(admin._storageFrom).not.toHaveBeenCalled()
  })
})

describe('uploadAssignmentAttachment — input validation', () => {
  it('rejects a missing file', async () => {
    const res = await mod.uploadAssignmentAttachment('sec-1', 'asg-1', formWith(null))
    expect(res).toEqual({ error: expect.any(String) })
    expect(admin._storageFrom).not.toHaveBeenCalled()
  })

  it('rejects a disallowed type (SVG excluded on purpose) before any upload', async () => {
    const res = await mod.uploadAssignmentAttachment(
      'sec-1',
      'asg-1',
      formWith(pdfFile({ name: 'x.svg', type: 'image/svg+xml' })),
    )
    expect(res).toEqual({ error: expect.any(String) })
    expect(admin._storageFrom).not.toHaveBeenCalled()
  })

  it('rejects once the attachment cap is reached', async () => {
    const full = Array.from({ length: MAX_ASSIGNMENT_PDFS }, (_, i) => ({ path: `p${i}`, name: `n${i}` }))
    admin = makeAdmin({ assignment: { id: 'asg-1', section_id: 'sec-1', settings: { pdfs: full } } })
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb: admin })
    const res = await mod.uploadAssignmentAttachment('sec-1', 'asg-1', formWith(pdfFile()))
    expect(res).toEqual({ error: expect.stringContaining(String(MAX_ASSIGNMENT_PDFS)) })
    expect(admin._storageFrom).not.toHaveBeenCalled()
  })
})

describe('uploadAssignmentAttachment — happy path & rollback', () => {
  it('uploads a valid PDF and returns the updated pdfs list + name', async () => {
    const res = await mod.uploadAssignmentAttachment('sec-1', 'asg-1', formWith(pdfFile({ name: 'brief.pdf' })))
    expect(res).toEqual({ success: true, pdfs: expect.any(Array), name: 'brief.pdf' })
    expect(res.pdfs.at(-1)).toMatchObject({ name: 'brief.pdf' })
    expect(admin._upload).toHaveBeenCalledTimes(1)
    expect(admin._remove).not.toHaveBeenCalled()
  })

  it('rolls the uploaded object back when the settings update fails', async () => {
    admin = makeAdmin({
      assignment: { id: 'asg-1', section_id: 'sec-1', settings: {} },
      updateError: { message: 'db down' },
    })
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb: admin })
    const res = await mod.uploadAssignmentAttachment('sec-1', 'asg-1', formWith(pdfFile()))
    expect(res).toEqual({ error: expect.any(String) })
    expect(admin._upload).toHaveBeenCalledTimes(1)
    expect(admin._remove).toHaveBeenCalledTimes(1) // rollback removed the orphaned object
  })
})
