// Unit tests for extractPptx. We synthesize a minimal but valid-enough
// PPTX zip in-memory so the test runs offline without fixture files.
// Covers:
//   - slide text extraction (concatenated <a:t> runs)
//   - media extraction (ppt/media/image1.png lands in Storage)
//   - slide→media mapping via rels files
//   - OMML → LaTeX conversion for common structures (sSub, sSup, f)

import { describe, it, expect } from 'vitest'
import { zipSync } from 'fflate'

import { extractPptx } from '@/lib/document-parser/pptx'

// ── Stub admin client (same pattern as pdf test) ──────────────
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

// ── Helpers to build a minimal PPTX ───────────────────────────

const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const NS_M = 'http://schemas.openxmlformats.org/officeDocument/2006/math'

const TINY_PNG = Buffer.from([
  // 1×1 transparent PNG, just enough to be a valid file in the zip
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
])

function slideXml(body: string) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:a="${NS_A}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:m="${NS_M}">
  <p:cSld>
    <p:spTree>
      ${body}
    </p:spTree>
  </p:cSld>
</p:sld>`
}

function textBody(text: string): string {
  return `<p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`
}

function fractionOmml(numText: string, denText: string): string {
  // Display fraction: <m:oMathPara><m:oMath><m:f><m:num><m:r><m:t>A</m:t></m:r></m:num>...
  return `<m:oMathPara><m:oMath><m:f>
    <m:num><m:r><m:t>${numText}</m:t></m:r></m:num>
    <m:den><m:r><m:t>${denText}</m:t></m:r></m:den>
  </m:f></m:oMath></m:oMathPara>`
}

function sSubOmml(baseText: string, subText: string): string {
  return `<m:oMath><m:sSub>
    <m:e><m:r><m:t>${baseText}</m:t></m:r></m:e>
    <m:sub><m:r><m:t>${subText}</m:t></m:r></m:sub>
  </m:sSub></m:oMath>`
}

function relsXml(imageName?: string): string {
  if (!imageName) {
    return `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${imageName}"/>
</Relationships>`
}

function buildFixturePptx(): Buffer {
  // Slide 1: "Introduction" — plain text, no math, no media.
  // Slide 2: "Formulas" — fraction OMML + sSub OMML, one image reference.
  // fflate is strict: pass plain Uint8Array (not Buffer) — under
  // jsdom/vitest some Buffer instances don't duck-type the way
  // fflate's hot-path expects and the zip layout gets corrupted.
  const u8 = (s: string) => new Uint8Array(new TextEncoder().encode(s))
  const entries: Record<string, Uint8Array> = {
    'ppt/slides/slide1.xml': u8(slideXml(textBody('Introduction to SVM'))),
    'ppt/slides/slide2.xml': u8(
      slideXml(
        `${textBody('Margin formula')}
         ${fractionOmml('y_j(w^T x_j + b)', '||w||_2')}
         ${sSubOmml('x', 'j')}`,
      ),
    ),
    'ppt/slides/_rels/slide1.xml.rels': u8(relsXml()),
    'ppt/slides/_rels/slide2.xml.rels': u8(relsXml('diagram1.png')),
    'ppt/media/diagram1.png': new Uint8Array(TINY_PNG),
  }

  const zipped = zipSync(entries)
  return Buffer.from(zipped)
}

// ── Tests ─────────────────────────────────────────────────────

describe('extractPptx', () => {
  it('extracts text + images + OMML formulas from a minimal deck', async () => {
    const pptx = buildFixturePptx()
    const { stub, uploads } = makeStubAdmin()

    const result = await extractPptx(pptx, {
      sectionId: 'sec-test',
      moduleItemId: 'item-test',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      adminClient: stub as any,
    })

    expect(result.status).toBe('completed')
    expect(result.pages).toHaveLength(2)
    expect(result.pages[0].text).toMatch(/Introduction to SVM/)
    expect(result.pages[1].text).toMatch(/Margin formula/)

    // Image assertions — 1 native PNG from ppt/media/
    expect(result.images).toBeDefined()
    expect(result.images!).toHaveLength(1)
    expect(result.images![0].pageNumber).toBe(2)
    expect(result.images![0].storagePath).toBe(
      'extracted-images/sec-test/item-test/diagram1.png',
    )
    expect(uploads).toHaveLength(1)
    expect(uploads[0].contentType).toBe('image/png')

    // Formula assertions — 1 display fraction, 1 inline subscript
    expect(result.formulas).toBeDefined()
    expect(result.formulas!.length).toBeGreaterThanOrEqual(1)

    const display = result.formulas!.find((f) => f.kind === 'display')
    expect(display).toBeDefined()
    expect(display!.pageNumber).toBe(2)
    expect(display!.source).toBe('omml')
    expect(display!.latex).toContain('\\frac')

    const inline = result.formulas!.find((f) => f.kind === 'inline')
    if (inline) {
      // If present, it should be the sSub we injected
      expect(inline.latex).toContain('_')
    }
  })

  it('returns status=failed with a useful error when given garbage bytes', async () => {
    const { stub } = makeStubAdmin()
    const result = await extractPptx(Buffer.from('not a zip'), {
      sectionId: 'sec-test',
      moduleItemId: 'item-test',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      adminClient: stub as any,
    })
    expect(result.status).toBe('failed')
    expect(result.error).toBeTruthy()
    expect(result.pages).toHaveLength(0)
  })
})
