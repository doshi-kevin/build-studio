import { describe, it, expect, vi } from 'vitest'
import { resolveAboutAssetUrls, stripPrivateAssetFields } from '@/lib/supabase/about-assets'
import { COURSE_MATERIALS_BUCKET } from '@/lib/supabase/storage'
import type { AboutContentV2 } from '@/lib/validations/course-about'

// Minimal block/content builders — resolveAboutAssetUrls only reads `block.type`
// and the hero's banner/cta paths, so we cast loosely.
function makeContent(blocks: unknown[]): AboutContentV2 {
  return { version: 2, blocks } as unknown as AboutContentV2
}

type Signed = { signedUrl: string } | null
function makeStorage(signed: Signed) {
  const createSignedUrl = vi.fn().mockResolvedValue({
    data: signed,
    error: signed ? null : { message: 'sign failed' },
  })
  const from = vi.fn().mockReturnValue({ createSignedUrl })
  const client = { storage: { from } } as unknown as Parameters<typeof resolveAboutAssetUrls>[0]
  return { client, from, createSignedUrl }
}

const bannerSrcOf = (block: unknown) =>
  (block as { data: { bannerSrc: string } }).data.bannerSrc

describe('resolveAboutAssetUrls', () => {
  it('short-circuits (same ref, never signs) when no hero has a bannerPath', async () => {
    const { client, createSignedUrl } = makeStorage({ signedUrl: 'x' })
    const content = makeContent([
      { id: '1', type: 'text', data: {} },
      { id: '2', type: 'hero', data: { bannerSrc: '' } }, // no bannerPath
    ])

    const out = await resolveAboutAssetUrls(client, content)

    expect(out).toBe(content)
    expect(createSignedUrl).not.toHaveBeenCalled()
  })

  it('re-signs a hero bannerPath against course-materials with a 1h TTL', async () => {
    const { client, from, createSignedUrl } = makeStorage({ signedUrl: 'https://signed/new' })
    const content = makeContent([
      { id: '1', type: 'hero', data: { bannerSrc: 'https://old/expired', bannerPath: 'about/sec/banners/x.png' } },
    ])

    const out = await resolveAboutAssetUrls(client, content)

    expect(from).toHaveBeenCalledWith(COURSE_MATERIALS_BUCKET)
    expect(createSignedUrl).toHaveBeenCalledWith('about/sec/banners/x.png', 3600)
    expect(bannerSrcOf(out.blocks[0])).toBe('https://signed/new')
  })

  it('leaves the block untouched when signing fails', async () => {
    const { client } = makeStorage(null)
    const content = makeContent([
      { id: '1', type: 'hero', data: { bannerSrc: 'https://old/expired', bannerPath: 'p.png' } },
    ])

    const out = await resolveAboutAssetUrls(client, content)

    expect(bannerSrcOf(out.blocks[0])).toBe('https://old/expired')
  })

  it('only re-signs hero blocks, passing others through by reference', async () => {
    const { client } = makeStorage({ signedUrl: 'https://signed/new' })
    const text = { id: 't', type: 'text', data: { foo: 'bar' } }
    const content = makeContent([
      text,
      { id: 'h', type: 'hero', data: { bannerSrc: 'old', bannerPath: 'p.png' } },
    ])

    const out = await resolveAboutAssetUrls(client, content)

    expect(out.blocks[0]).toBe(text)
    expect(bannerSrcOf(out.blocks[1])).toBe('https://signed/new')
  })

  it('does not mutate the input content', async () => {
    const { client } = makeStorage({ signedUrl: 'https://signed/new' })
    const content = makeContent([
      { id: 'h', type: 'hero', data: { bannerSrc: 'old', bannerPath: 'p.png' } },
    ])

    const out = await resolveAboutAssetUrls(client, content)

    expect(out).not.toBe(content)
    expect(bannerSrcOf(content.blocks[0])).toBe('old')
  })
})

/* Pilot #3: the hero action button can now hold an UPLOADED file, not just a
   pasted link. It lands in the same private bucket as the banner, so it needs the
   same render-time re-signing — otherwise "View syllabus" is a dead link about an
   hour after the professor saves the page. */
describe('resolveAboutAssetUrls — action-button files', () => {
  it('re-signs ctaUrl from ctaFilePath', async () => {
    const { client } = makeStorage({ signedUrl: 'https://signed.example/syllabus.pdf' })
    const out = await resolveAboutAssetUrls(
      client,
      makeContent([{ type: 'hero', data: { ctaFilePath: 'sec/about-cta/syllabus.pdf', ctaUrl: 'https://stale.example/expired' } }]),
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((out.blocks[0] as any).data.ctaUrl).toBe('https://signed.example/syllabus.pdf')
  })

  it('leaves a pasted external link alone (no path = not ours to sign)', async () => {
    const { client, createSignedUrl } = makeStorage({ signedUrl: 'https://signed.example/x' })
    const external = 'https://university.edu/syllabus.pdf'
    const out = await resolveAboutAssetUrls(
      client,
      makeContent([{ type: 'hero', data: { ctaUrl: external } }]),
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((out.blocks[0] as any).data.ctaUrl).toBe(external)
    expect(createSignedUrl).not.toHaveBeenCalled()
  })

  it('signs banner and cta independently on the same block', async () => {
    const { client, createSignedUrl } = makeStorage({ signedUrl: 'https://signed.example/a' })
    await resolveAboutAssetUrls(
      client,
      makeContent([{ type: 'hero', data: { bannerPath: 'p/banner.png', ctaFilePath: 'p/cta.pdf' } }]),
    )
    expect(createSignedUrl).toHaveBeenCalledTimes(2)
    expect(client.storage.from).toHaveBeenCalledWith(COURSE_MATERIALS_BUCKET)
  })
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dataOf = (block: unknown) => (block as any).data

describe('stripPrivateAssetFields', () => {
  // BlockPreview is a client component, so every field still on a block when the
  // student route hands it over is serialized into the page the browser receives.
  // The storage paths are editor-only plumbing; a student has no use for the
  // private-bucket layout of their course, so they come off before the handover.

  it('removes the hero storage paths and the uploaded filename', () => {
    const out = stripPrivateAssetFields(
      makeContent([{
        id: 'h', type: 'hero',
        data: {
          bannerSrc: 'https://signed.example/banner',
          bannerPath: 'about/sec-1/banners/banner.png',
          ctaUrl: 'https://signed.example/syllabus',
          ctaFilePath: 'about/sec-1/cta/syllabus.pdf',
          ctaFileName: 'CS101-syllabus-final-v3.pdf',
          title: 'NLP',
        },
      }]),
    )

    expect(dataOf(out.blocks[0]).bannerPath).toBe('')
    expect(dataOf(out.blocks[0]).ctaFilePath).toBe('')
    expect(dataOf(out.blocks[0]).ctaFileName).toBe('')
  })

  it('keeps the signed URLs — those are what actually renders', () => {
    // Stripping these instead would leave the student a broken banner and a dead
    // "View syllabus" button, which is the failure mode to guard against here.
    const out = stripPrivateAssetFields(
      makeContent([{
        id: 'h', type: 'hero',
        data: {
          bannerSrc: 'https://signed.example/banner',
          bannerPath: 'p/banner.png',
          ctaUrl: 'https://signed.example/syllabus',
          ctaFilePath: 'p/cta.pdf',
          title: 'NLP',
        },
      }]),
    )

    expect(dataOf(out.blocks[0]).bannerSrc).toBe('https://signed.example/banner')
    expect(dataOf(out.blocks[0]).ctaUrl).toBe('https://signed.example/syllabus')
    expect(dataOf(out.blocks[0]).title).toBe('NLP')
  })

  it('removes an image block\'s storage path but keeps the rendered src', () => {
    const out = stripPrivateAssetFields(
      makeContent([{
        id: 'i', type: 'image',
        data: { src: 'https://signed.example/fig1', srcPath: 'about/sec-1/images/fig1.png', alt: 'Figure 1', caption: '', alignment: 'center' },
      }]),
    )

    expect(dataOf(out.blocks[0]).srcPath).toBe('')
    expect(dataOf(out.blocks[0]).src).toBe('https://signed.example/fig1')
    expect(dataOf(out.blocks[0]).alt).toBe('Figure 1')
  })

  it('passes every other block type through untouched', () => {
    const content = makeContent([
      { id: 't', type: 'text', data: { content: { type: 'doc', content: [] } } },
      { id: 'd', type: 'divider', data: {} },
    ])
    const out = stripPrivateAssetFields(content)

    expect(out.blocks[0]).toBe(content.blocks[0])
    expect(out.blocks[1]).toBe(content.blocks[1])
  })

  it('does not mutate the content it was given', () => {
    // The professor's own route renders from the same parsed object and still
    // needs the paths — for re-signing on the next render and for cleaning up the
    // old object when a banner is replaced.
    const content = makeContent([
      { id: 'h', type: 'hero', data: { bannerSrc: 's', bannerPath: 'p/banner.png', ctaFilePath: 'p/cta.pdf', ctaFileName: 'f.pdf' } },
    ])

    stripPrivateAssetFields(content)

    expect(dataOf(content.blocks[0]).bannerPath).toBe('p/banner.png')
    expect(dataOf(content.blocks[0]).ctaFilePath).toBe('p/cta.pdf')
    expect(dataOf(content.blocks[0]).ctaFileName).toBe('f.pdf')
  })
})
