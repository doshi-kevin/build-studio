// Tests for getSectionExtractedMedia — the flattener feeding the
// lecture library dialog. Locks in:
//   - malformed entries dropped, not thrown
//   - v1 rows (no images/formulas) silently skipped
//   - duplicate-across-slides formulas deduped per lecture
//   - trivially-noisy formulas ('3', '\mathbf{x}', single chars) filtered
//   - lecture order is stable / alphabetized

import { describe, it, expect, vi } from 'vitest'

import { getSectionExtractedMedia } from '@/lib/extraction/library-queries'

// getSectionExtractedMedia internally signs image storage paths via signMany
// (which builds a real admin client). Mock it so this stays a hermetic unit
// test — signed URLs are only mapped onto images, never used in assertions.
vi.mock('@/lib/supabase/signed-urls', () => ({
  signMany: vi.fn(async () => new Map<string, string>()),
  signOne: vi.fn(async () => null),
}))

// ── Fake SupabaseClient ────────────────────────────────────────
// We only need .from().select().eq().eq() to return a data array.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeAdmin(rows: any[]) {
  const builder = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    then: (resolve: (v: { data: unknown; error: null }) => unknown) =>
      Promise.resolve({ data: rows, error: null }).then(resolve),
  }
  return {
    from: vi.fn().mockReturnValue(builder),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

const VALID_IMAGE = {
  pageNumber: 7,
  storagePath: 'extracted-images/sec/mod/page007_img1.png',
  storageUrl: 'https://cdn.example/page007_img1.png',
  pixelWidth: 400,
  pixelHeight: 300,
}

describe('getSectionExtractedMedia', () => {
  it('flattens images + formulas with lecture context', async () => {
    const admin = fakeAdmin([
      {
        id: 'lec-a',
        title: 'SVM Lecture',
        content: {
          extraction: {
            images: [VALID_IMAGE, { ...VALID_IMAGE, pageNumber: 15 }],
            formulas: [
              { pageNumber: 15, latex: '\\frac{a}{b}', kind: 'display', source: 'vision' },
              { pageNumber: 20, latex: 'f = \\mathbf{w}^T \\mathbf{x}', kind: 'inline', source: 'vision' },
            ],
          },
        },
      },
    ])

    const lib = await getSectionExtractedMedia(admin, 'sec-1')
    expect(lib.images).toHaveLength(2)
    expect(lib.images[0].lectureTitle).toBe('SVM Lecture')
    expect(lib.images[0].lectureId).toBe('lec-a')
    expect(lib.formulas).toHaveLength(2)
    expect(lib.formulas[0].latex).toBe('\\frac{a}{b}')
    expect(lib.lectures).toEqual([{ id: 'lec-a', title: 'SVM Lecture' }])
  })

  it('drops malformed image entries without throwing', async () => {
    const admin = fakeAdmin([
      {
        id: 'lec-b',
        title: 'Mixed',
        content: {
          extraction: {
            images: [
              VALID_IMAGE,
              { pageNumber: 1, storagePath: 'p', storageUrl: 'u' /* missing pixelWidth */ },
              null,
            ],
            formulas: [],
          },
        },
      },
    ])

    const lib = await getSectionExtractedMedia(admin, 'sec-1')
    expect(lib.images).toHaveLength(1)
    expect(lib.formulas).toHaveLength(0)
  })

  it('skips v1 rows (no images/formulas) entirely', async () => {
    const admin = fakeAdmin([
      {
        id: 'lec-v1',
        title: 'Legacy',
        content: {
          extraction: {
            status: 'completed',
            pages: [{ pageNumber: 1, text: 'hi', headings: [] }],
          },
        },
      },
    ])

    const lib = await getSectionExtractedMedia(admin, 'sec-1')
    expect(lib.images).toHaveLength(0)
    expect(lib.formulas).toHaveLength(0)
    expect(lib.lectures).toHaveLength(0)
  })

  it('dedupes repeated formulas within a lecture', async () => {
    const admin = fakeAdmin([
      {
        id: 'lec-c',
        title: 'Dup City',
        content: {
          extraction: {
            images: [],
            formulas: [
              { pageNumber: 7, latex: 'f = \\mathbf{w}^T \\mathbf{x}', kind: 'inline', source: 'vision' },
              { pageNumber: 8, latex: 'f = \\mathbf{w}^T \\mathbf{x}', kind: 'inline', source: 'vision' },
              { pageNumber: 9, latex: 'f = \\mathbf{w}^T \\mathbf{x}', kind: 'inline', source: 'vision' },
              { pageNumber: 10, latex: '\\phi = \\mathbf{W}\\mathbf{x}', kind: 'display', source: 'vision' },
            ],
          },
        },
      },
    ])

    const lib = await getSectionExtractedMedia(admin, 'sec-1')
    expect(lib.formulas).toHaveLength(2)
    // First occurrence wins — pageNumber: 7 should be kept, not 8/9
    const svmFormula = lib.formulas.find((f) => f.latex.includes('\\mathbf{w}'))
    expect(svmFormula?.pageNumber).toBe(7)
  })

  it('filters standalone numbers and single-variable noise', async () => {
    const admin = fakeAdmin([
      {
        id: 'lec-n',
        title: 'Noisy',
        content: {
          extraction: {
            formulas: [
              { pageNumber: 1, latex: '3', kind: 'inline', source: 'vision' },
              { pageNumber: 1, latex: '4.835', kind: 'inline', source: 'vision' },
              { pageNumber: 1, latex: '\\mathbf{x}', kind: 'inline', source: 'vision' },
              { pageNumber: 1, latex: 'y', kind: 'inline', source: 'vision' },
              { pageNumber: 1, latex: 'f = \\mathbf{w}^T \\mathbf{x}', kind: 'inline', source: 'vision' },
            ],
          },
        },
      },
    ])

    const lib = await getSectionExtractedMedia(admin, 'sec-1')
    expect(lib.formulas).toHaveLength(1)
    expect(lib.formulas[0].latex).toBe('f = \\mathbf{w}^T \\mathbf{x}')
  })

  it('alphabetizes lectures so the filter dropdown is stable', async () => {
    const admin = fakeAdmin([
      { id: 'l1', title: 'Zeta', content: { extraction: { images: [VALID_IMAGE] } } },
      { id: 'l2', title: 'Alpha', content: { extraction: { images: [VALID_IMAGE] } } },
      { id: 'l3', title: 'Mu', content: { extraction: { images: [VALID_IMAGE] } } },
    ])

    const lib = await getSectionExtractedMedia(admin, 'sec-1')
    expect(lib.lectures.map((l) => l.title)).toEqual(['Alpha', 'Mu', 'Zeta'])
  })
})
