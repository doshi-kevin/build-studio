// Integration tests for extractPdf against the lab fixture
// (test-pdf/lecture 3.pdf, 91 pages, 27 images). Pins:
//   - text extraction returns 91 pages, non-zero word count
//   - image extraction returns exactly 27 images
//   - every image has bbox + pixelWidth/pixelHeight
//   - Storage "uploads" are captured by a stub client, so this test
//     runs offline and doesn't touch local or prod Supabase.

import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { describe, it, expect } from 'vitest'

import { extractPdf } from '@/lib/document-parser/pdf'

const FIXTURE_PATH = path.resolve(process.cwd(), 'test-pdf/lecture 3.pdf')

// These pin exact extraction counts against a specific 91-page lecture PDF
// that isn't committed (large binary). Run them wherever the fixture exists;
// skip — rather than red-fail — in CI and fresh clones that lack it.
const hasFixture = existsSync(FIXTURE_PATH)

// ── Minimal admin client stub ────────────────────────────────
// Captures uploaded PNGs in memory so tests can assert count and shape
// without needing a real Supabase instance. Shape matches the subset
// of SupabaseClient that extractPdf actually touches.

interface UploadCall { path: string; contentLength: number; contentType: string }

function makeStubAdmin() {
  const uploads: UploadCall[] = []
  const stub = {
    storage: {
      from: () => ({
        async upload(uploadPath: string, buffer: Buffer, options: { contentType?: string }) {
          uploads.push({
            path: uploadPath,
            contentLength: buffer.length,
            contentType: options.contentType ?? 'application/octet-stream',
          })
          return { error: null }
        },
        getPublicUrl(uploadPath: string) {
          return { data: { publicUrl: `https://stub.test/${uploadPath}` } }
        },
      }),
    },
  }
  return { stub, uploads }
}

// ── Tests ─────────────────────────────────────────────────────

describe.skipIf(!hasFixture)('extractPdf', () => {
  it('extracts 91 pages and 27 images from the SVM lecture fixture', async () => {
    const buffer = await readFile(FIXTURE_PATH)
    const { stub, uploads } = makeStubAdmin()

    const result = await extractPdf(buffer, {
      sectionId: 'sec-test',
      moduleItemId: 'item-test',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      adminClient: stub as any,
    })

    expect(result.status).toBe('completed')
    expect(result.textStatus).toBe('completed')
    expect(result.imagesStatus).toBe('completed')
    expect(result.pages).toHaveLength(91)
    expect(result.metadata.pageCount).toBe(91)
    expect(result.metadata.wordCount).toBeGreaterThan(0)

    // 27/27 is the core invariant — the script 12 win from the lab.
    expect(result.images).toBeDefined()
    expect(result.images!).toHaveLength(27)
    expect(result.metadata.imageCount).toBe(27)

    // Every image must carry bbox + pixel dims — that's what the
    // downstream UI uses to place extracted images next to their pages.
    for (const img of result.images!) {
      expect(img.pageNumber).toBeGreaterThanOrEqual(1)
      expect(img.pageNumber).toBeLessThanOrEqual(91)
      expect(img.storagePath).toContain('extracted-images/sec-test/item-test/')
      expect(img.storageUrl).toMatch(/^https:\/\//)
      expect(img.pixelWidth).toBeGreaterThan(0)
      expect(img.pixelHeight).toBeGreaterThan(0)
      expect(img.bbox).toBeDefined()
    }

    // Each image should have been uploaded exactly once.
    expect(uploads).toHaveLength(27)
    for (const u of uploads) {
      expect(u.contentType).toBe('image/png')
      expect(u.contentLength).toBeGreaterThan(0)
    }
  }, 60_000) // 60s budget — well above the observed 7.6s

  it('skips oversized images rather than OOMing sharp', async () => {
    const buffer = await readFile(FIXTURE_PATH)
    const { stub } = makeStubAdmin()

    // Set the cap absurdly low so every image trips it. Result should
    // still be 'completed' for text, with images array empty.
    const result = await extractPdf(buffer, {
      sectionId: 'sec-test',
      moduleItemId: 'item-test',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      adminClient: stub as any,
      maxImagePixels: 10, // smaller than any real image
    })

    expect(result.status).toBe('completed')
    expect(result.images).toBeUndefined()
    expect(result.metadata.imageCount).toBe(0)
  }, 60_000)
})
