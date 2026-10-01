import { describe, it, expect, vi, beforeEach } from 'vitest'

// signAnnouncementAttachments resolves a storage path per attachment, re-signs
// them in one signMany round-trip, and maps the fresh URL back onto each
// attachment while preserving shape. Mock only the admin client so the real
// resolvePath + signMany + extractPathFromPublicUrl + remap logic runs — that
// remap logic is the part with real, silent failure modes (dropped attachment,
// stale-URL 403, lost sibling fields).

const mockCreateSignedUrls = vi.fn()

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    storage: { from: () => ({ createSignedUrls: mockCreateSignedUrls }) },
  }),
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

import { signAnnouncementAttachments, signMany } from '@/lib/supabase/signed-urls'

const PUBLIC_URL_PREFIX =
  'https://proj.supabase.co/storage/v1/object/public/course-materials/'

beforeEach(() => {
  mockCreateSignedUrls.mockReset()
  // Sign every requested path as `signed:<path>`, except paths flagged
  // 'unsignable' (signMany omits those from its Map).
  mockCreateSignedUrls.mockImplementation(async (paths: string[]) => ({
    data: paths.map((path) => ({
      path,
      signedUrl: path.includes('unsignable') ? null : `signed:${path}`,
    })),
    error: null,
  }))
})

// The Modules board signs a whole course at once (hundreds of paths), so signMany
// splits the set across requests. The point of splitting is blast radius: one bad
// request must not blank every file link on the page.
describe('signMany — batching', () => {
  const paths = (n: number, prefix = 'p') => Array.from({ length: n }, (_, i) => `${prefix}${i}.pdf`)

  it('splits a large set across requests and merges every response into one map', async () => {
    const all = paths(250)

    const result = await signMany('course-materials', all)

    expect(mockCreateSignedUrls.mock.calls.map((c) => c[0].length)).toEqual([100, 100, 50])
    // No path is dropped or duplicated at a batch seam.
    expect(result.size).toBe(250)
    expect(result.get('p0.pdf')).toBe('signed:p0.pdf')
    expect(result.get('p99.pdf')).toBe('signed:p99.pdf')
    expect(result.get('p100.pdf')).toBe('signed:p100.pdf')
    expect(result.get('p249.pdf')).toBe('signed:p249.pdf')
  })

  it('keeps the other batches when one request fails', async () => {
    // Fail only the batch containing p100 — previously one error killed the whole page.
    mockCreateSignedUrls.mockImplementation(async (batch: string[]) => {
      if (batch.includes('p100.pdf')) return { data: null, error: { message: 'boom' } }
      return { data: batch.map((path) => ({ path, signedUrl: `signed:${path}` })), error: null }
    })

    const result = await signMany('course-materials', paths(250))

    expect(result.size).toBe(150)
    expect(result.get('p0.pdf')).toBe('signed:p0.pdf')
    expect(result.get('p249.pdf')).toBe('signed:p249.pdf')
    expect(result.has('p100.pdf')).toBe(false)
    expect(result.has('p199.pdf')).toBe(false)
  })

  it('keeps the other batches when one request THROWS rather than returning an error', async () => {
    // storage-js returns StorageErrors but rethrows anything else (a fetch
    // failure, a timeout). An uncaught throw rejects Promise.all and loses
    // every URL — the exact outcome batching exists to prevent.
    mockCreateSignedUrls.mockImplementation(async (batch: string[]) => {
      if (batch.includes('p100.pdf')) throw new Error('socket hang up')
      return { data: batch.map((path) => ({ path, signedUrl: `signed:${path}` })), error: null }
    })

    const result = await signMany('course-materials', paths(250))

    expect(result.size).toBe(150)
    expect(result.get('p0.pdf')).toBe('signed:p0.pdf')
    expect(result.get('p249.pdf')).toBe('signed:p249.pdf')
    expect(result.has('p100.pdf')).toBe(false)
  })

  it('de-duplicates and drops empty paths before batching', async () => {
    const result = await signMany('course-materials', ['a.pdf', 'a.pdf', null, '', undefined, 'b.pdf'])

    expect(mockCreateSignedUrls).toHaveBeenCalledTimes(1)
    expect(mockCreateSignedUrls.mock.calls[0][0]).toEqual(['a.pdf', 'b.pdf'])
    expect(result.size).toBe(2)
  })
})

describe('signAnnouncementAttachments', () => {
  it('returns empty input untouched without signing', async () => {
    const rows: Record<string, unknown>[] = []
    const result = await signAnnouncementAttachments(rows)
    expect(result).toBe(rows)
    expect(mockCreateSignedUrls).not.toHaveBeenCalled()
  })

  it('signs via filePath, replacing a stale fileUrl and preserving other fields', async () => {
    const rows = [
      {
        id: 'a1',
        title: 'Welcome',
        attachments: [
          {
            filePath: 'sec/att1.pdf',
            fileUrl: 'https://old/stale-and-expired',
            name: 'notes.pdf',
          },
        ],
      },
    ]

    const [row] = await signAnnouncementAttachments(rows)

    expect(row.id).toBe('a1')
    expect(row.title).toBe('Welcome')
    expect(row.attachments[0]).toEqual({
      filePath: 'sec/att1.pdf',
      fileUrl: 'signed:sec/att1.pdf',
      name: 'notes.pdf',
    })
  })

  it('falls back to extracting the path from a legacy public fileUrl', async () => {
    const rows = [
      { attachments: [{ fileUrl: `${PUBLIC_URL_PREFIX}sec/legacy.pdf` }] },
    ]

    const [row] = await signAnnouncementAttachments(rows)

    expect(row.attachments[0]).toEqual({
      fileUrl: 'signed:sec/legacy.pdf',
      filePath: 'sec/legacy.pdf',
    })
  })

  it('leaves an unresolvable attachment untouched but signs its resolvable sibling', async () => {
    const rows = [
      {
        attachments: [
          { fileUrl: 'https://external.example/not-in-bucket.pdf', name: 'ext' },
          { filePath: 'sec/good.pdf', name: 'good' },
        ],
      },
    ]

    const [row] = await signAnnouncementAttachments(rows)

    // unresolvable: kept exactly as-is
    expect(row.attachments[0]).toEqual({
      fileUrl: 'https://external.example/not-in-bucket.pdf',
      name: 'ext',
    })
    // resolvable: re-signed
    expect(row.attachments[1].fileUrl).toBe('signed:sec/good.pdf')
  })

  it('keeps an attachment whose path resolves but fails to sign', async () => {
    const rows = [
      { attachments: [{ filePath: 'sec/unsignable.pdf', fileUrl: 'orig' }] },
    ]

    const [row] = await signAnnouncementAttachments(rows)

    expect(row.attachments[0]).toEqual({
      filePath: 'sec/unsignable.pdf',
      fileUrl: 'orig',
    })
  })

  it('signs every path across all rows in a single round-trip', async () => {
    const rows: Array<{ attachments?: Array<{ filePath?: string; fileUrl?: string }>; title?: string }> = [
      { attachments: [{ filePath: 'sec/one.pdf' }, { filePath: 'sec/two.pdf' }] },
      { attachments: [] },
      { attachments: [{ filePath: 'sec/three.pdf' }] },
      { title: 'no attachments field' },
    ]

    const result = await signAnnouncementAttachments(rows)

    expect(mockCreateSignedUrls).toHaveBeenCalledTimes(1)
    expect(mockCreateSignedUrls.mock.calls[0][0]).toEqual([
      'sec/one.pdf',
      'sec/two.pdf',
      'sec/three.pdf',
    ])
    expect(result[0].attachments?.[0]?.fileUrl).toBe('signed:sec/one.pdf')
    expect(result[2].attachments?.[0]?.fileUrl).toBe('signed:sec/three.pdf')
    // rows without signable attachments pass through unchanged
    expect(result[3]).toEqual({ title: 'no attachments field' })
  })

  it('returns the original array when no attachment path is resolvable', async () => {
    const rows = [
      { attachments: [{ fileUrl: 'https://external.example/x.pdf' }] },
      { title: 'plain' },
    ]

    const result = await signAnnouncementAttachments(rows)

    expect(result).toBe(rows)
    expect(mockCreateSignedUrls).not.toHaveBeenCalled()
  })
})
