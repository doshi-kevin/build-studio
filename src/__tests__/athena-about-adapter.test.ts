import { describe, it, expect } from 'vitest'
import {
  serializeAboutForAthena,
  applyAboutOps,
} from '@/components/professor/about/block-editor/athena-about-adapter'
import { aboutOpSchema, type AboutOp } from '@/lib/ai/assignment-assistant/templates/registry'
import type {
  AboutBlock,
  CalloutBlock,
  HeroBlock,
  SyllabusBlock,
  TextBlock,
} from '@/lib/validations/course-about'

// The adapter owns two safety invariants the model cannot be trusted with:
// (1) the hero is a singleton pinned first — remove/reorder ops against it are
//     dropped AND counted, and nothing can be placed above it;
// (2) storage-backed asset fields (bannerPath/ctaFilePath and the signed URLs
//     derived from them) are unreachable from an op and invisible in the screen —
//     a model echo-back of an expiring signed URL must never be able to replace
//     a professor's uploaded banner.
// Plus the phantom-success guard: ops that land nothing must surface in
// `skipped` so the fill chip can say so instead of claiming success.

function hero(): HeroBlock {
  return {
    id: 'hero-1',
    type: 'hero',
    data: {
      bannerSrc: 'https://signed.example/banner?token=abc',
      bannerPath: 'sec-1/about-banners/banner.jpg',
      bannerAlt: 'Campus',
      title: 'Intro to Poetry',
      subtitle: 'Reading and writing verse',
      instructor: 'Dr. Ada Lovelace',
      semester: 'Fall 2026',
      credits: '3 credits',
      introVideoUrl: '',
      ctaText: 'Download syllabus',
      ctaUrl: 'https://signed.example/cta?token=def',
      ctaFilePath: 'sec-1/about-cta/syllabus.pdf',
      ctaFileName: 'syllabus.pdf',
    },
  }
}

function syllabus(): SyllabusBlock {
  return {
    id: 'syl-1',
    type: 'syllabus',
    data: {
      title: 'Weekly Schedule',
      weeks: [{ id: 'w1', week: 1, topic: 'Meter', description: 'Feet and stress', readings: 'Ch. 1' }],
    },
  }
}

function textBlock(): TextBlock {
  return {
    id: 'txt-1',
    type: 'text',
    data: { content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Welcome!' }] }] } },
  }
}

function callout(): CalloutBlock {
  return {
    id: 'cal-1',
    type: 'callout',
    data: {
      variant: 'info',
      title: 'Late work',
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'One free pass.' }] }] },
    },
  }
}

const page = (): AboutBlock[] => [hero(), textBlock(), syllabus()]

describe('serializeAboutForAthena', () => {
  it('renders blocks as id/type/content with kind "about" and never leaks signed URLs', () => {
    const screen = serializeAboutForAthena(page(), true)
    expect(screen.kind).toBe('about')
    expect(screen.components).toHaveLength(3)
    expect(screen.components![0]).toMatchObject({ id: 'hero-1', type: 'hero' })
    const all = screen.components!.map((c) => c.content).join('\n')
    // The screen must carry the FACT of an upload, never its expiring URL or path.
    expect(all).toContain('banner image: uploaded')
    expect(all).toContain('syllabus.pdf')
    expect(all).not.toContain('signed.example')
    expect(all).not.toContain('about-banners')
  })

  it('caps a block rendering at the screen schema limit (4000 chars)', () => {
    const big = textBlock()
    big.data.content = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(9000) }] }],
    }
    const screen = serializeAboutForAthena([big], true)
    expect(screen.components![0].content.length).toBeLessThanOrEqual(4000)
    expect(screen.components![0].content).toContain('(truncated)')
  })
})

describe('applyAboutOps', () => {
  it('inserts a new block with rich-text HTML converted to a Tiptap doc', () => {
    const ops: AboutOp[] = [
      { op: 'insert', blockType: 'text', afterId: 'txt-1', html: '<h2>Policies</h2><p>Be kind.</p>' },
    ]
    const res = applyAboutOps(page(), ops)
    expect(res.changed).toBe(1)
    expect(res.blocks).toHaveLength(4)
    const inserted = res.blocks[2] as TextBlock
    expect(inserted.type).toBe('text')
    const kinds = inserted.data.content.content.map((n) => n.type)
    expect(kinds).toEqual(['heading', 'paragraph'])
    expect(res.summary).toContain('dded 1 section')
  })

  it('replaces syllabus weeks wholesale with fresh ids and defaults', () => {
    const ops: AboutOp[] = [
      {
        op: 'update',
        id: 'syl-1',
        weeks: [
          { week: 1, topic: 'Meter' },
          { week: 2, topic: 'Sonnets', readings: 'Ch. 2' },
        ],
      },
    ]
    const res = applyAboutOps(page(), ops)
    const syl = res.blocks.find((b) => b.id === 'syl-1') as SyllabusBlock
    expect(syl.data.weeks).toHaveLength(2)
    expect(syl.data.weeks[1]).toMatchObject({ week: 2, topic: 'Sonnets', readings: 'Ch. 2', description: '' })
    expect(syl.data.weeks[0].id).not.toBe('w1') // editor-local ids are regenerated
    expect(syl.data.title).toBe('Weekly Schedule') // untouched fields survive
  })

  it('merges hero text fields and CANNOT touch banner/file asset fields', () => {
    const ops: AboutOp[] = [{ op: 'update', id: 'hero-1', hero: { title: 'Poetry 101', semester: 'Spring 2027' } }]
    const res = applyAboutOps(page(), ops)
    const h = res.blocks[0] as HeroBlock
    expect(h.data.title).toBe('Poetry 101')
    expect(h.data.semester).toBe('Spring 2027')
    expect(h.data.subtitle).toBe('Reading and writing verse')
    // The invariant: asset fields are byte-identical after any model edit.
    expect(h.data.bannerPath).toBe('sec-1/about-banners/banner.jpg')
    expect(h.data.bannerSrc).toBe('https://signed.example/banner?token=abc')
    expect(h.data.ctaFilePath).toBe('sec-1/about-cta/syllabus.pdf')
    expect(h.data.ctaUrl).toBe('https://signed.example/cta?token=def')
  })

  it('drops hero remove/reorder and unknown-id ops, and COUNTS them as skipped', () => {
    const ops: AboutOp[] = [
      { op: 'remove', id: 'hero-1' },
      { op: 'reorder', id: 'hero-1', afterId: 'syl-1' },
      { op: 'update', id: 'nope', title: 'x' },
    ]
    const res = applyAboutOps(page(), ops)
    expect(res.changed).toBe(0)
    expect(res.skipped).toBe(3)
    expect(res.blocks[0].type).toBe('hero')
    expect(res.blocks).toHaveLength(3)
    expect(res.summary).toMatch(/skipped 3/i)
  })

  it('never places a block above the pinned hero', () => {
    // reorder with no afterId means "to the top" — which is BELOW the hero.
    const res = applyAboutOps(page(), [{ op: 'reorder', id: 'syl-1' }])
    expect(res.blocks.map((b) => b.id)).toEqual(['hero-1', 'syl-1', 'txt-1'])
  })

  it('is pure: the input block array is not mutated', () => {
    const before = page()
    const snapshot = JSON.stringify(before)
    applyAboutOps(before, [
      { op: 'update', id: 'txt-1', html: '<p>changed</p>' },
      { op: 'remove', id: 'syl-1' },
    ])
    expect(JSON.stringify(before)).toBe(snapshot)
  })

  it('an op carrying nothing the block type understands changes nothing (applied: false path)', () => {
    // `weeks` on a text block is meaningless — must count as skipped, not as an update.
    const res = applyAboutOps(page(), [{ op: 'update', id: 'txt-1', weeks: [{ week: 1, topic: 'x' }] }])
    expect(res.changed).toBe(0)
    expect(res.skipped).toBe(1)
  })
})

describe('the hero singleton is enforced by the OP SCHEMA, not the adapter', () => {
  // applyAboutOps has no hero defense on the insert path at all — it calls
  // createBlock(op.blockType) and splices the result in. The only thing standing
  // between the model and a second hero is ABOUT_INSERT_TYPES omitting it, so the
  // invariant the adapter's header claims to own actually lives here. Adding
  // 'hero' to that enum (or 'image', whose data is upload-only and unfillable)
  // would break it silently, with no other red test.
  it('rejects insert blockType "hero" and "image"', () => {
    expect(aboutOpSchema.safeParse({ op: 'insert', blockType: 'hero' }).success).toBe(false)
    expect(aboutOpSchema.safeParse({ op: 'insert', blockType: 'image' }).success).toBe(false)
    expect(aboutOpSchema.safeParse({ op: 'insert', blockType: 'text', html: '<p>hi</p>' }).success).toBe(true)
  })

  it('still allows the hero to be UPDATED by id (the only way to change it)', () => {
    expect(aboutOpSchema.safeParse({ op: 'update', id: 'hero-1', hero: { title: 'x' } }).success).toBe(true)
  })
})

describe('variant guard — one shared enum spans two block types', () => {
  // The op schema's `variant` is a single 7-value enum covering BOTH callout
  // (info/warning/success/alert) and highlight-box (feature/tip/important), so a
  // schema-VALID op can still carry a variant the target block type has no
  // concept of. mergeFields' includes() check is the only guard, and it is
  // load-bearing beyond cosmetics: aboutContentV2Schema enums these per block
  // type, so a 'tip' written into a callout makes saveAboutContent's safeParse
  // fail — the professor's autosave would break for the WHOLE page, silently.
  it('refuses a highlight variant on a callout and counts the op as skipped', () => {
    const res = applyAboutOps([callout()], [{ op: 'update', id: 'cal-1', variant: 'tip' }])
    expect((res.blocks[0] as CalloutBlock).data.variant).toBe('info')
    expect(res.changed).toBe(0)
    expect(res.skipped).toBe(1)
  })

  it('accepts a variant the block type does understand', () => {
    const res = applyAboutOps([callout()], [{ op: 'update', id: 'cal-1', variant: 'warning' }])
    expect((res.blocks[0] as CalloutBlock).data.variant).toBe('warning')
    expect(res.changed).toBe(1)
  })

  it('a rejected variant does not swallow the other fields in the same op', () => {
    // The op still lands (title applied) — only the bad variant is dropped, and
    // the block keeps a valid one so the page still saves.
    const res = applyAboutOps([callout()], [{ op: 'update', id: 'cal-1', variant: 'important', title: 'Late policy' }])
    const c = res.blocks[0] as CalloutBlock
    expect(c.data.title).toBe('Late policy')
    expect(c.data.variant).toBe('info')
    expect(res.changed).toBe(1)
  })
})

describe('serializeAboutForAthena — the edit gate in <screen>', () => {
  it('reports preview mode as read-only with the arming instruction', () => {
    const screen = serializeAboutForAthena(page(), false)
    expect(String(screen.meta?.pageMode)).toMatch(/PREVIEW/i)
    expect(String(screen.meta?.pageMode)).toMatch(/Edit page/)
  })
  it('reports edit mode as writable', () => {
    const screen = serializeAboutForAthena(page(), true)
    expect(String(screen.meta?.pageMode)).toMatch(/editing/i)
  })
})

describe('applyAboutOps — runaway + insert self-defense (security review fixes)', () => {
  it('refuses to insert a hero or image even if an op names one', () => {
    const resHero = applyAboutOps(page(), [{ op: 'insert', blockType: 'hero' as never }])
    expect(resHero.changed).toBe(0)
    expect(resHero.skipped).toBe(1)
    expect(resHero.blocks.filter((b) => b.type === 'hero')).toHaveLength(1)
    const resImg = applyAboutOps(page(), [{ op: 'insert', blockType: 'image' as never }])
    expect(resImg.changed).toBe(0)
    expect(resImg.skipped).toBe(1)
  })
  it('caps inserts at the runaway ceiling', () => {
    const many: AboutOp[] = Array.from({ length: 250 }, () => ({ op: 'insert', blockType: 'divider' }))
    const res = applyAboutOps(page(), many)
    expect(res.blocks.length).toBeLessThanOrEqual(200)
    expect(res.skipped).toBeGreaterThan(0)
  })
})
