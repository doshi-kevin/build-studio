// Action-level guard tests for readSubmissionZipEntry. authorizeSubmissionFile (tested
// in viewer-auth.test.ts) validates the OUTER file path against the submission, but the
// INNER entryPath — which file inside the zip the client wants — is attacker-controlled
// and guarded only by isUnsafeEntryPath before any bytes are read. These tests pin that
// guard so a refactor can't silently let a crafted entryPath reach the reader.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockAuthorize = vi.fn()
const mockReadCentralDirectory = vi.fn()
const mockReadEntryBytes = vi.fn()
const mockDownload = vi.fn()

vi.mock('@/lib/assignments/viewer-auth', () => ({
  authorizeSubmissionFile: (...args: unknown[]) => mockAuthorize(...args),
}))
vi.mock('@/lib/assignments/zip-reader', () => ({
  readCentralDirectory: (...args: unknown[]) => mockReadCentralDirectory(...args),
  readEntryBytes: (...args: unknown[]) => mockReadEntryBytes(...args),
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mod: any

/** authorize() succeeds, handing back an admin client whose storage.download works. */
function authorized() {
  mockDownload.mockResolvedValue({
    data: { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer },
    error: null,
  })
  mockAuthorize.mockResolvedValue({
    adminDb: { storage: { from: vi.fn(() => ({ download: mockDownload })) } },
    path: 'sec/asg/student-1/a.zip',
    fileName: 'a.zip',
  })
}

beforeEach(async () => {
  vi.resetModules()
  mockAuthorize.mockReset()
  mockReadCentralDirectory.mockReset()
  mockReadEntryBytes.mockReset()
  mockDownload.mockReset()
  mod = await import('@/lib/assignments/viewer-actions')
})

describe('readSubmissionZipEntry', () => {
  it('rejects an unsafe entryPath before reading anything', async () => {
    authorized()
    const res = await mod.readSubmissionZipEntry('sub-1', 'sec/asg/student-1/a.zip', '../../etc/passwd')
    expect(res).toEqual({ error: 'File not found.' })
    expect(mockDownload).not.toHaveBeenCalled()
    expect(mockReadEntryBytes).not.toHaveBeenCalled()
  })

  it('short-circuits a non-previewable (binary) entry without downloading', async () => {
    authorized()
    const res = await mod.readSubmissionZipEntry('sub-1', 'sec/asg/student-1/a.zip', 'app.exe')
    expect(res).toEqual({ kind: 'binary' })
    expect(mockDownload).not.toHaveBeenCalled()
    expect(mockReadEntryBytes).not.toHaveBeenCalled()
  })

  it('returns text content for a readable text entry', async () => {
    authorized()
    mockReadEntryBytes.mockResolvedValue({ buffer: Buffer.from('print(1)'), truncated: false })
    const res = await mod.readSubmissionZipEntry('sub-1', 'sec/asg/student-1/a.zip', 'src/main.py')
    expect(res).toEqual({ kind: 'text', content: 'print(1)', truncated: false })
  })

  it('parses a .ipynb entry into a rendered notebook', async () => {
    authorized()
    const nbJson = JSON.stringify({
      cells: [{ cell_type: 'code', source: ['print(1)'] }],
      metadata: { language_info: { name: 'python' } },
    })
    mockReadEntryBytes.mockResolvedValue({ buffer: Buffer.from(nbJson), truncated: false })
    const res = await mod.readSubmissionZipEntry('sub-1', 'sec/asg/student-1/a.zip', 'hw.ipynb')
    expect(res.kind).toBe('notebook')
    expect(res.notebook.cells).toHaveLength(1)
  })

  it('propagates an authorization error', async () => {
    mockAuthorize.mockResolvedValue({ error: 'File not found.' })
    const res = await mod.readSubmissionZipEntry('sub-1', 'x', 'src/main.py')
    expect(res).toEqual({ error: 'File not found.' })
    expect(mockReadEntryBytes).not.toHaveBeenCalled()
  })
})
