// Pins the media entry-name sanitiser in extractPptx (src/lib/document-parser/pptx.ts).
//
// Incident: the media filename comes verbatim out of the uploaded archive's rels XML and
// the zip entry key, both fully attacker-controlled, and was interpolated straight into a
// Storage key written with the SERVICE-ROLE client and upsert:true. supabase-js puts the
// key into the request URL unencoded, so the URL parser normalises `../../..` and the
// write lands in another section's prefix — or another bucket entirely. Upsert means it
// overwrites whatever is already there.
//
// The legacy officeparser path in modules/actions.ts already sanitised this; the v2
// rewrite dropped it. That is exactly the kind of regression that comes back, and it is
// silent — the upload succeeds either way, just into someone else's prefix.

import { describe, it, expect } from 'vitest'
import { zipSync } from 'fflate'
import { extractPptx } from '@/lib/document-parser/pptx'

const SECTION = 'sec-under-test'
const ITEM = 'item-under-test'
const SAFE_PREFIX = `extracted-images/${SECTION}/${ITEM}`

const TINY_PNG = new Uint8Array([
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

function makeStubAdmin() {
  const uploads: string[] = []
  const stub = {
    storage: {
      from: () => ({
        async upload(uploadPath: string) {
          uploads.push(uploadPath)
          return { error: null }
        },
        getPublicUrl: (p: string) => ({ data: { publicUrl: `https://stub.test/${p}` } }),
      }),
    },
  }
  return { stub, uploads }
}

const u8 = (s: string) => new Uint8Array(new TextEncoder().encode(s))

const SLIDE = `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">
  <p:cSld><p:spTree>
    <p:sp><p:txBody><a:p><a:r><a:t>Deck with media</a:t></a:r></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld>
</p:sld>`

function rels(targets: string[]) {
  const rows = targets
    .map((t, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${t}"/>`)
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rows}</Relationships>`
}

/**
 * A deck whose rels point at `mediaNames` and whose zip carries a literal entry at
 * `ppt/media/<name>` for each. A hostile archive can absolutely contain an entry key
 * with `..` segments — the zip format stores the name as an opaque string.
 */
function buildPptx(mediaNames: string[]): Buffer {
  const entries: Record<string, Uint8Array> = {
    'ppt/slides/slide1.xml': u8(SLIDE),
    'ppt/slides/_rels/slide1.xml.rels': u8(rels(mediaNames)),
  }
  for (const name of mediaNames) entries[`ppt/media/${name}`] = TINY_PNG
  return Buffer.from(zipSync(entries))
}

async function run(mediaNames: string[]) {
  const { stub, uploads } = makeStubAdmin()
  const result = await extractPptx(buildPptx(mediaNames), {
    sectionId: SECTION,
    moduleItemId: ITEM,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    adminClient: stub as any,
  })
  return { result, uploads }
}

describe('extractPptx — a traversing media name cannot escape the section prefix', () => {
  it('neutralises ../../../ in the entry name', async () => {
    const { uploads } = await run(['../../../../evil/pwn.png'])

    expect(uploads).toHaveLength(1)
    // Not merely "starts with the prefix": a path containing `..` can start with the
    // right prefix and still normalise out of it, which is the whole trick.
    expect(uploads[0]).not.toContain('..')
    expect(uploads[0].startsWith(`${SAFE_PREFIX}/`)).toBe(true)
    // And it must still resolve inside the prefix after URL normalisation, which is
    // what supabase-js effectively hands the server.
    const normalised = new URL(uploads[0], 'https://x.test/').pathname
    expect(normalised).toBe(`/${SAFE_PREFIX}/pwn.png`)
  })

  it('neutralises a leading-slash absolute name', async () => {
    const { uploads } = await run(['/etc/passwd.png'])
    expect(uploads[0]).toBe(`${SAFE_PREFIX}/passwd.png`)
  })

  it('neutralises a nested subdirectory name', async () => {
    const { uploads } = await run(['other-section/secret/diagram.png'])
    expect(uploads[0]).toBe(`${SAFE_PREFIX}/diagram.png`)
  })

  it('strips characters outside the safe set rather than passing them through', async () => {
    const { uploads } = await run(['my image (1)%20.png'])
    expect(uploads[0]).toBe(`${SAFE_PREFIX}/my_image__1__20.png`)
    expect(uploads[0]).toMatch(new RegExp(`^${SAFE_PREFIX}/[a-zA-Z0-9._-]+$`))
  })

  it('reports the sanitised path on the returned image entry too', async () => {
    // The stored path is what downstream readers use — the return value must not
    // disagree with what was actually written.
    const { result, uploads } = await run(['../../../../evil/pwn.png'])
    expect(result.images).toHaveLength(1)
    expect(result.images![0].storagePath).toBe(uploads[0])
    expect(result.images![0].storagePath).not.toContain('..')
  })
})

describe('extractPptx — dedup happens on the SANITISED name', () => {
  it('does not let two raw names that collapse to one key overwrite each other', async () => {
    // Uploads run with upsert:true, so if dedup keyed on the RAW name these two would
    // both write to `<prefix>/shared.png` and the second would clobber the first.
    const { uploads } = await run(['a/shared.png', 'b/shared.png'])
    expect(uploads).toEqual([`${SAFE_PREFIX}/shared.png`])
  })

  it('skips a name that sanitises to nothing usable', async () => {
    const { uploads } = await run(['../'])
    expect(uploads).toHaveLength(0)
  })
})

describe('extractPptx — ordinary decks are unaffected', () => {
  it('uploads a normal filename unchanged', async () => {
    const { uploads } = await run(['diagram1.png'])
    expect(uploads).toEqual([`${SAFE_PREFIX}/diagram1.png`])
  })

  it('keeps distinct normal filenames distinct', async () => {
    const { uploads } = await run(['image1.png', 'image2.png'])
    expect(uploads).toEqual([
      `${SAFE_PREFIX}/image1.png`,
      `${SAFE_PREFIX}/image2.png`,
    ])
  })
})
