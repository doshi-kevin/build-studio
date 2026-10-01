// Phase 4 — citation primitive (src/lib/extraction/citation.ts).
import { describe, it, expect } from 'vitest'
import { formatCitation, normalizeBbox, citationTrust, parseCitations, citationPages, matchCitationDoc } from '@/lib/extraction/citation'

const ctx = {
  role: 'student' as const,
  sectionId: 'sec1',
  moduleId: 'mod1',
  moduleItemId: 'item-9',
  title: 'Transformers',
  isSlides: true,
}

describe('#659 — abbreviated page markers must still parse', () => {
  /* One abbreviation used to strip EVERY citation from an answer, not just its own chip:
     the "N sources · M pages" block is built from the same matches, so an answer with 10
     abbreviated markers rendered 10 raw brackets and no sources line. Nothing constrains
     the model to spell out "page", so this is phrasing variance — the same question
     rendered 12 chips one time and none the next. */
  it.each([
    ['[Test, p. 35]', 'Test', 35],
    ['[Test, pp. 35]', 'Test', 35],
    ['[Test, pg. 35]', 'Test', 35],
    ['[Test, pgs. 35]', 'Test', 35],
    ['[Test, p 35]', 'Test', 35],
    ['[Test, sl. 4]', 'Test', 4],
    ['[Test, page 35]', 'Test', 35],
    ['[Test, slide 4]', 'Test', 4],
  ])('parses %s', (marker, title, page) => {
    const [c] = parseCitations(`See ${marker} for the proof.`)
    expect(c).toBeDefined()
    expect(c.title).toBe(title)
    expect(c.page).toBe(page)
  })

  it('parses a multi-page abbreviated marker', () => {
    const out = parseCitations('Both [Deck, pp. 44, 51] cover it.')
    expect(out.map((c) => c.page)).toEqual([44, 51])
  })

  it('still handles a comma inside the title', () => {
    const [c] = parseCitations('See [Lecture 3, Intro, p. 5].')
    expect(c.title).toBe('Lecture 3, Intro')
    expect(c.page).toBe(5)
  })

  it('does NOT match a bare number or an unrelated unit', () => {
    // Too ambiguous to be a page reference — matching these would turn ordinary
    // bracketed prose into broken chips.
    expect(parseCitations('See [Test, 35].')).toHaveLength(0)
    expect(parseCitations('See [Test, paragraph 35].')).toHaveLength(0)
  })

  it('recovers every citation in an answer that mixes spellings', () => {
    const answer = 'First [A, page 1], then [B, p. 2], then [C, sl. 3].'
    expect(parseCitations(answer).map((c) => c.page)).toEqual([1, 2, 3])
  })
})

describe('formatCitation', () => {
  it('labels a deck by slide and links to the item at that page', () => {
    const c = formatCitation(ctx, { pageNumber: 14, sourceMethod: 'native' })
    expect(c.label).toBe('[Transformers, slide 14]')
    expect(c.href).toBe('/student/courses/sec1/modules/mod1?item=item-9&page=14')
    expect(c.trust).toBe('exact')
  })

  it('labels prose by page and appends a bbox highlight when present', () => {
    const c = formatCitation(
      { ...ctx, isSlides: false, title: 'Final Exam' },
      { pageNumber: 3, sourceMethod: 'vision', bbox: { x: 0.1, y: 0.2, width: 0.5, height: 0.25 } },
    )
    expect(c.label).toBe('[Final Exam, page 3]')
    expect(c.href).toBe('/student/courses/sec1/modules/mod1?item=item-9&page=3#bbox=0.1,0.2,0.5,0.25')
    expect(c.trust).toBe('ai-read') // VLM transcription is flagged
  })

  it('encodes the moduleItemId in the query', () => {
    const c = formatCitation({ ...ctx, moduleItemId: 'a/b c' }, { pageNumber: 1, sourceMethod: 'geometric' })
    expect(c.href).toContain('item=a%2Fb%20c')
  })
})

describe('parseCitations', () => {
  it('extracts unique [Title, page N] / [Title, slide N] citations in order', () => {
    const answer =
      'Attention sums to one [Transformers, page 14]. RNNs differ [RNN Basics, slide 3]. ' +
      'Again see [Transformers, page 14] and [Transformers, page 9].'
    const cites = parseCitations(answer)
    expect(cites).toHaveLength(3) // the duplicate [Transformers, page 14] is collapsed
    expect(cites[0]).toMatchObject({ title: 'Transformers', page: 14 })
    expect(cites[1]).toMatchObject({ title: 'RNN Basics', page: 3 })
    expect(cites[2]).toMatchObject({ title: 'Transformers', page: 9 })
  })

  it('returns nothing for prose without citations', () => {
    expect(parseCitations('No citations here, just text.')).toEqual([])
  })

  it('treats commas inside the title as part of the title', () => {
    expect(parseCitations('See [Lecture 3, Intro, page 5].')).toEqual([
      { raw: '[Lecture 3, Intro, page 5]', title: 'Lecture 3, Intro', page: 5 },
    ])
  })

  it('expands a multi-page citation into one entry per page', () => {
    // The model emits this for one passage spanning two pages; it used to fail
    // to match at all, leaving the raw bracket in the rendered prose.
    expect(parseCitations('Smoothing helps [Lecture 2: Language Modeling, page 44, 51].')).toEqual([
      { raw: '[Lecture 2: Language Modeling, page 44, 51]', title: 'Lecture 2: Language Modeling', page: 44 },
      { raw: '[Lecture 2: Language Modeling, page 44, 51]', title: 'Lecture 2: Language Modeling', page: 51 },
    ])
  })

  it('accepts plural "pages"/"slides" and dedupes across single and multi-page markers', () => {
    const cites = parseCitations('First [Deck, pages 3, 7]. Then [Deck, page 7] again, and [Deck, slides 1, 2].')
    expect(cites.map((c) => c.page)).toEqual([3, 7, 1, 2]) // the repeated page 7 is collapsed
    expect(cites.every((c) => c.title === 'Deck')).toBe(true)
  })

  it('keeps a title comma out of the page list when both are present', () => {
    // The one input where the lazy title group and the new page-list group can
    // fight: the title contains a comma AND the marker carries several pages.
    expect(parseCitations('See [Lecture 3, Intro, pages 5, 9].').map((c) => [c.title, c.page])).toEqual([
      ['Lecture 3, Intro', 5],
      ['Lecture 3, Intro', 9],
    ])
    // …and a title ending in a number must not have that number eaten as a page.
    expect(parseCitations('See [Week 5, Part 2, page 3].')).toEqual([
      { raw: '[Week 5, Part 2, page 3]', title: 'Week 5, Part 2', page: 3 },
    ])
  })

  it('numbers a repeated page consistently across markers', () => {
    // Numbering is keyed globally by title#page, so page 7 keeps number 2 when
    // it reappears in a later marker. Per-marker numbering would silently point
    // a chip at the wrong page — no visible symptom, so pin it.
    const cites = parseCitations('a [Deck, pages 3, 7]. b [Deck, page 7]. c [Deck, page 2].')
    expect(cites.map((c) => c.page)).toEqual([3, 7, 2])
  })
})

describe('citationPages', () => {
  it('parses a single page and a spaced list', () => {
    expect(citationPages('44')).toEqual([44])
    expect(citationPages('44, 51')).toEqual([44, 51])
    expect(citationPages('3,7 , 9')).toEqual([3, 7, 9])
  })

  it('dedupes so a repeated page cannot yield two chips with the same number', () => {
    expect(citationPages('44, 44')).toEqual([44])
  })
})

describe('matchCitationDoc', () => {
  const docs = [
    { id: 'a', title: 'Transformers' },
    { id: 'b', title: 'Transformers and Attention' },
    { id: 'c', title: 'RNN Basics' },
  ]
  it('prefers an exact (case/space-insensitive) match over a substring one', () => {
    expect(matchCitationDoc('  transformers ', docs)?.id).toBe('a')
  })
  it('falls back to a bidirectional substring match', () => {
    expect(matchCitationDoc('Attention', docs)?.id).toBe('b') // doc title contains the citation
    expect(matchCitationDoc('RNN Basics — full', docs)?.id).toBe('c') // citation contains the doc title
  })
  it('returns undefined when nothing matches (non-clickable source)', () => {
    expect(matchCitationDoc('Quantum Computing', docs)).toBeUndefined()
  })
})

describe('citationTrust', () => {
  it('flags only vision as ai-read', () => {
    for (const m of ['native', 'omml', 'geometric', 'ocr'] as const) expect(citationTrust(m)).toBe('exact')
    expect(citationTrust('vision')).toBe('ai-read')
  })
})

describe('normalizeBbox', () => {
  it('flips the y-axis for PDF (bottom-left origin) and normalizes to [0,1]', () => {
    // 612×792 page; a box at (61.2, 396) sized 306×198 in PDF points (bottom-left)
    const n = normalizeBbox({ x: 61.2, y: 396, width: 306, height: 198 }, 612, 792, true)
    expect(n.x).toBe(0.1)
    expect(n.width).toBe(0.5)
    expect(n.height).toBe(0.25)
    // top-left y = (792 - (396+198)) / 792 = 198/792 = 0.25
    expect(n.y).toBe(0.25)
  })

  it('keeps the y-axis for PPTX (top-left origin)', () => {
    const n = normalizeBbox({ x: 0, y: 198, width: 612, height: 198 }, 612, 792, false)
    expect(n.y).toBe(0.25)
  })

  it('clamps out-of-range values and guards a zero-size page', () => {
    const n = normalizeBbox({ x: -50, y: 0, width: 2000, height: 100 }, 612, 792, false)
    expect(n.x).toBe(0)
    expect(n.width).toBe(1)
    expect(normalizeBbox({ x: 0, y: 0, width: 1, height: 1 }, 0, 0, true)).toEqual({ x: 0, y: 0, width: 0, height: 0 })
  })
})
