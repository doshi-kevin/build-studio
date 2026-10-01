// Tests for assembleRoadmapData: professor-drawn link resolution, topic→page
// hits, item field coercion, and dividers.
//
// The manual Module → Lecture → Topic layer this file used to cover retired with
// the old roadmap canvas (§11 decision 4) — an edge to a manual box now falls out
// through the same orphan filter as any other endpoint that no longer resolves,
// which is what the first block below pins.

import { describe, it, expect } from 'vitest'
import { assembleRoadmapData } from '@/lib/roadmap/auto-roadmap-helpers'

const SECTION = 'sec-1'

const autoModules = [
  { id: 'M1', title: 'Week 1', description: '', week_number: 1, position: 0 },
]
const autoItems = [
  {
    id: 'I1',
    module_id: 'M1',
    item_type: 'lecture',
    title: 'Intro Lecture',
    description: '',
    position: 0,
    content: { fileUrl: 'https://files/lec.pdf', fileName: 'lec.pdf', fileSize: 100 },
  },
]

const quizResource = {
  id: 'Q1',
  kind: 'quiz' as const,
  title: 'Quiz 1',
  status: 'in_progress' as const,
  stateLabel: 'Published',
  href: '/professor/courses/sec-1/quizzes/Q1',
}

describe('assembleRoadmapData — professor-drawn links', () => {
  it('keeps a link between two live boxes and drops one whose endpoint is gone', () => {
    const edges = [
      // auto module M1 ↔ auto item I1 — both live, kept
      { id: 'ok', from_node_type: 'module', from_node_id: 'M1', to_node_type: 'module_item', to_node_id: 'I1' },
      // auto item I1 ↔ quiz Q1 — both live, kept
      { id: 'ok2', from_node_type: 'module_item', from_node_id: 'I1', to_node_type: 'quiz', to_node_id: 'Q1' },
      // endpoint missing → dropped. A retired manual box leaves exactly this shape
      // behind, which is why manual endpoints needed no cleanup of their own.
      { id: 'orphan', from_node_type: 'manual_module', from_node_id: 'GHOST', to_node_type: 'module', to_node_id: 'M1' },
    ]
    const data = assembleRoadmapData(SECTION, autoModules, autoItems, edges, [quizResource])
    expect(data.edges.map((e) => e.id).sort()).toEqual(['ok', 'ok2'])
    expect(data.edges.find((e) => e.id === 'ok')).toMatchObject({
      fromType: 'module',
      fromId: 'M1',
      toType: 'module_item',
      toId: 'I1',
    })
  })
})

describe('assembleRoadmapData — topicPageHits (reference-rail anchors)', () => {
  const item = (content: Record<string, unknown>) => [
    { id: 'I1', module_id: 'M1', item_type: 'lecture', title: 'Lec', description: '', position: 0, content },
  ]
  const hitsOf = (content: Record<string, unknown>) =>
    assembleRoadmapData(SECTION, autoModules, item(content)).weeks[0].items[0].topicPageHits

  it('prefers the anchors stored at index time over the substring fallback', () => {
    const hits = hitsOf({
      topics: ['Laplace smoothing'],
      // A completed extraction that WOULD produce a fallback — the semantic
      // anchors roadmap-rail-v1 wrote must win, because they are the ones that
      // catch a page saying "add-one" instead of the canonical topic name.
      extraction: { status: 'completed', pages: [{ pageNumber: 1, text: 'laplace smoothing', headings: [] }] },
      topicPages: { 'Laplace smoothing': [2, 5, 9] },
    })
    expect(hits).toEqual({ 'Laplace smoothing': [2, 5, 9] })
  })

  it('ignores a malformed stored map rather than sending the viewer to a bad page', () => {
    // The column is JSONB and predates this shape: items indexed by the retired
    // pgvector path (or the JS-cosine cache before it) can hold anything.
    const hits = hitsOf({
      topics: ['Backpropagation'],
      topicPages: { Backpropagation: ['page 4', 0, -2, null], Other: 'nope' },
      extraction: {
        status: 'completed',
        pages: [{ pageNumber: 4, text: 'we derive backpropagation here', headings: [] }],
      },
    })
    expect(hits).toEqual({ Backpropagation: [4] }) // fell through to the substring anchor
  })

  it('falls back to a single exact-substring page (wrapped as an array) when nothing was indexed', () => {
    const hits = hitsOf({
      topics: ['Backpropagation'],
      extraction: {
        status: 'completed',
        pages: [
          { pageNumber: 1, text: 'intro', headings: [] },
          { pageNumber: 4, text: 'we derive backpropagation here', headings: [] },
        ],
      },
    })
    expect(hits).toEqual({ Backpropagation: [4] }) // array shape, not a bare number
  })

  it('is undefined when there are neither anchors nor a completed extraction', () => {
    expect(hitsOf({ topics: ['Backpropagation'] })).toBeUndefined()
  })

  /* Issue #112. The substring fallback used to take the FIRST page naming the
     topic, which in a real deck is the "Learning Objectives" slide — it lists
     every concept in the lecture, so it won every one of them. These pin that a
     first-mention signpost page now LOSES to the page that teaches the concept. */
  describe('explanation page beats first mention', () => {
    const perplexityPages = [
      // p2 mentions it first, but only as an objective to be met later.
      { pageNumber: 2, text: 'Understand perplexity and evaluate language models', headings: ['Learning Objectives'] },
      // p20 defers it.
      { pageNumber: 20, text: 'We return to perplexity in the next section', headings: ['N-gram models'] },
      // p36 is where it is actually taught.
      {
        pageNumber: 36,
        text: 'Perplexity is the inverse probability of the test set, normalised by word count. Lower perplexity means a better model, so we report perplexity on held-out text.',
        headings: ['Perplexity'],
      },
    ]

    it('anchors to the page that explains the topic, not the objectives slide', () => {
      const hits = hitsOf({
        topics: ['Perplexity'],
        extraction: { status: 'completed', pages: perplexityPages },
      })
      expect(hits).toEqual({ Perplexity: [36] })
    })

    it('picks a definition page over an earlier signpost even with no matching heading', () => {
      const hits = hitsOf({
        topics: ['Smoothing'],
        extraction: {
          status: 'completed',
          pages: [
            { pageNumber: 1, text: 'Smoothing, backoff, interpolation', headings: ['Outline'] },
            { pageNumber: 14, text: 'Smoothing is a way to move probability mass to unseen events.', headings: [] },
          ],
        },
      })
      expect(hits).toEqual({ Smoothing: [14] })
    })

    it('still anchors somewhere when the objectives slide is the ONLY mention', () => {
      const hits = hitsOf({
        topics: ['Perplexity'],
        extraction: { status: 'completed', pages: [perplexityPages[0]] },
      })
      expect(hits).toEqual({ Perplexity: [2] })
    })

    it('keeps the earliest page when nothing distinguishes two mentions (old behaviour)', () => {
      const hits = hitsOf({
        topics: ['Tokenisation'],
        extraction: {
          status: 'completed',
          pages: [
            { pageNumber: 5, text: 'we apply tokenisation first', headings: [] },
            { pageNumber: 9, text: 'after tokenisation, we count', headings: [] },
          ],
        },
      })
      expect(hits).toEqual({ Tokenisation: [5] })
    })

    // A topic name is user data, so it reaches the matcher with whatever
    // characters the professor typed. A regex-based matcher would throw here.
    it('matches a topic containing regex metacharacters', () => {
      const hits = hitsOf({
        topics: ['O(n log n)'],
        extraction: {
          status: 'completed',
          pages: [{ pageNumber: 3, text: 'merge sort runs in O(n log n) time', headings: [] }],
        },
      })
      expect(hits).toEqual({ 'O(n log n)': [3] })
    })
  })
  // ── content.concepts[].pages — the extractor's own citations ──────────
  // The concept pass already records the pages it read a concept on, and
  // `topics` is literally concepts.slice(0,7).map(c => c.name). Those citations
  // outrank everything else: the model that named the concept had the page open.

  it('prefers the extractor-cited pages over semantic hits AND substring', () => {
    const hits = hitsOf({
      topics: ['Perplexity Comparison'],
      concepts: [{ name: 'Perplexity Comparison', pages: [2, 3], importance: 9, summary: 's' }],
      // Both weaker sources present and DISAGREEING, so precedence is what's pinned.
      // The semantic tier moved onto the item at #435 (was a caller-supplied map
      // backed by pgvector, now content.topicPages written against Pinecone at
      // index time). Same tier, same precedence — only the source changed.
      topicPages: { 'Perplexity Comparison': [7] },
      extraction: {
        status: 'completed',
        pages: [{ pageNumber: 1, text: 'perplexity comparison', headings: [] }],
      },
    })
    expect(hits).toEqual({ 'Perplexity Comparison': [2, 3] })
  })

  it('anchors a paraphrased concept the substring search cannot find', () => {
    // The regression this fixes: the extractor names a concept the way a professor
    // would, the slide says something else, and the verbatim search finds nothing.
    const hits = hitsOf({
      topics: ['Maximum Path Length'],
      concepts: [{ name: 'Maximum Path Length', pages: [4], importance: 7, summary: 's' }],
      extraction: {
        status: 'completed',
        pages: [{ pageNumber: 4, text: 'Layer type | Complexity | Max path', headings: [] }],
      },
    })
    expect(hits).toEqual({ 'Maximum Path Length': [4] })
  })

  it('resolves each topic independently instead of letting one source win the item', () => {
    // Mixed provenance in one item: a cited concept, a professor-added skill the
    // extractor never saw (semantic only), and one only the substring finds.
    const hits = hitsOf({
      topics: ['Cited Concept', 'Hand Added Skill', 'Legacy Only'],
      concepts: [{ name: 'Cited Concept', pages: [2], importance: 5, summary: 's' }],
      topicPages: { 'Hand Added Skill': [3, 4] },
      extraction: {
        status: 'completed',
        pages: [{ pageNumber: 6, text: 'a page mentioning legacy only', headings: [] }],
      },
    })
    expect(hits).toEqual({
      'Cited Concept': [2],
      'Hand Added Skill': [3, 4],
      'Legacy Only': [6],
    })
  })

  it('ignores malformed concept entries rather than shipping a bad page number', () => {
    // This is unvalidated JSONB from older writes; a junk page would reach the
    // viewer as somewhere to scroll to.
    const hits = hitsOf({
      topics: ['Bad Pages', 'Good Pages'],
      concepts: [
        { name: 'Bad Pages', pages: ['page 2', 0, -1, null], importance: 5, summary: 's' },
        { name: 'Good Pages', pages: [3], importance: 5, summary: 's' },
        { name: '', pages: [9] },
        'not an object',
      ],
    })
    expect(hits).toEqual({ 'Good Pages': [3] })
  })
})

describe('assembleRoadmapData — video duration & image dimension coercion', () => {
  const nodeOf = (item_type: string, content: Record<string, unknown>) =>
    assembleRoadmapData(
      SECTION,
      autoModules,
      [{ id: 'I1', module_id: 'M1', item_type, title: 'X', description: '', position: 0, content }],
    ).weeks[0].items[0]

  it('coerces a numeric-string video duration to positive minutes (legacy string data)', () => {
    expect(nodeOf('video', { duration: '48' }).videoDurationMin).toBe(48)
  })

  it('accepts a numeric video duration as-is', () => {
    expect(nodeOf('video', { duration: 90 }).videoDurationMin).toBe(90)
  })

  it('rejects zero, negative, and non-finite durations (→ undefined)', () => {
    expect(nodeOf('video', { duration: 0 }).videoDurationMin).toBeUndefined()
    expect(nodeOf('video', { duration: -5 }).videoDurationMin).toBeUndefined()
    expect(nodeOf('video', { duration: 'abc' }).videoDurationMin).toBeUndefined()
    expect(nodeOf('video', {}).videoDurationMin).toBeUndefined()
  })

  it('formats image dimensions as "W×H" only when both are positive numbers', () => {
    expect(nodeOf('image', { width: 800, height: 600 }).imageDimensions).toBe('800×600')
    expect(nodeOf('image', { width: 0, height: 600 }).imageDimensions).toBeUndefined()
    expect(nodeOf('image', { width: 800 }).imageDimensions).toBeUndefined()
    expect(nodeOf('image', {}).imageDimensions).toBeUndefined()
  })
})

describe('assembleRoadmapData — dividers', () => {
  const rawItem = (id: string, item_type: string, position: number, content: unknown = {}) =>
    ({ id, module_id: 'M1', item_type, title: id, description: '', position, content })

  it('lifts section_dividers out of items, tagged with the item they follow', () => {
    const data = assembleRoadmapData(SECTION, autoModules, [
      rawItem('I1', 'lecture', 0),
      rawItem('D1', 'section_divider', 1, { label: 'Exam prep' }),
      rawItem('I2', 'lecture', 2),
    ])

    // Never content: the divider stays out of the items (and so out of every
    // status/coverage tally derived from them).
    expect(data.weeks[0].items.map((i) => i.id)).toEqual(['I1', 'I2'])
    expect(data.weeks[0].dividers).toEqual([{ id: 'D1', title: 'Exam prep', afterItemId: 'I1' }])
  })

  it('marks a leading divider with afterItemId null and falls back to the item title', () => {
    const data = assembleRoadmapData(SECTION, autoModules, [
      rawItem('D1', 'section_divider', 0, {}),
      rawItem('I1', 'lecture', 1),
    ])
    expect(data.weeks[0].dividers).toEqual([{ id: 'D1', title: 'D1', afterItemId: null }])
  })

  // No divider may reach the canvas unlabelled — the roadmap draws its title INTO
  // the pen line, so an empty one is a bare stroke the professor can't identify.
  it('falls back to "Section" when neither the label nor the title has text', () => {
    const data = assembleRoadmapData(SECTION, autoModules, [
      { ...rawItem('D1', 'section_divider', 0, { label: '  ' }), title: '' },
    ])
    expect(data.weeks[0].dividers).toEqual([{ id: 'D1', title: 'Section', afterItemId: null }])
  })

  it('returns module-level dividers sorted by position', () => {
    const data = assembleRoadmapData(SECTION, autoModules, autoItems, [], [], [
      { id: 'MD2', title: 'Finals', position: 5 },
      { id: 'MD1', title: 'Midterm', position: 1 },
    ])
    expect(data.moduleDividers).toEqual([
      { id: 'MD1', title: 'Midterm', position: 1 },
      { id: 'MD2', title: 'Finals', position: 5 },
    ])
  })
})

// A week the class hasn't reached yet stays ON the student's map (so they can see
// there is more course ahead) but must leave the server as a shell. These pin the
// gate itself: the payload is where unreleased content is withheld, not the CSS.
describe('assembleRoadmapData — locked weeks (future unlock_date)', () => {
  const FUTURE = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString()
  const PAST = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()
  const twoWeeks = [
    { id: 'M1', title: 'Week 1', description: '', week_number: 1, position: 0, unlock_date: PAST },
    { id: 'M2', title: 'Week 8', description: '', week_number: 8, position: 1, unlock_date: FUTURE },
  ]
  const items = [
    { id: 'I1', module_id: 'M1', item_type: 'lecture', title: 'Intro Lecture', description: '', position: 0, content: {} },
    { id: 'I2', module_id: 'M2', item_type: 'lecture', title: 'Unreleased Lecture', description: '', position: 0, content: { fileUrl: 'https://files/secret.pdf' } },
  ]
  // The quiz is pinned under the locked week by a placement edge.
  const placed = { id: 'e-place', from_node_type: 'module', from_node_id: 'M2', to_node_type: 'quiz', to_node_id: 'Q1' }

  it('strips a locked week to its title and drops what is placed under it', () => {
    const data = assembleRoadmapData(SECTION, twoWeeks, items, [placed], [quizResource])
    const [open, locked] = data.weeks
    expect(open.title).toBe('Week 1')
    expect(open.locked).toBeUndefined()
    expect(open.items.map((i) => i.id)).toEqual(['I1'])
    // Title + open date survive; the contents do not.
    expect(locked).toMatchObject({ title: 'Week 8', locked: true, unlockDate: FUTURE })
    expect(locked.items).toEqual([])
    // Neither the unreleased lecture's file URL nor the quiz placed under the week
    // is anywhere in the payload — including its now-orphaned placement edge.
    expect(JSON.stringify(data)).not.toContain('secret.pdf')
    expect(data.resources).toEqual([])
    expect(data.edges).toEqual([])
  })

  /* Placement is direction-agnostic (placementByResource reads either endpoint), so
     the drop has to be too — a quiz stored quiz→module under a locked week is the
     same unreleased content as one stored module→quiz. */
  it('drops a resource placed under a locked week with the edge stored in reverse', () => {
    const reversed = { id: 'e-rev', from_node_type: 'quiz', from_node_id: 'Q1', to_node_type: 'module', to_node_id: 'M2' }
    const data = assembleRoadmapData(SECTION, twoWeeks, items, [reversed], [quizResource])
    expect(data.resources).toEqual([])
    expect(data.edges).toEqual([])
  })

  it('leaves a past unlock_date open, and treats an unparseable one as open', () => {
    const modules = [
      { id: 'M1', title: 'Week 1', description: '', week_number: 1, position: 0, unlock_date: PAST },
      { id: 'M2', title: 'Week 8', description: '', week_number: 8, position: 1, unlock_date: 'not-a-date' },
    ]
    const data = assembleRoadmapData(SECTION, modules, items)
    expect(data.weeks.map((w) => w.locked)).toEqual([undefined, undefined])
    expect(data.weeks[1].items.map((i) => i.id)).toEqual(['I2'])
  })

  // The professor loader never selects unlock_date, so their map cannot lock —
  // the same convention that keeps `draft` professor-only.
  it('never locks a week when the loader did not select unlock_date', () => {
    const data = assembleRoadmapData(SECTION, autoModules, autoItems, [placed], [quizResource])
    expect(data.weeks[0].locked).toBeUndefined()
    expect(data.weeks[0].items).toHaveLength(1)
  })
})
