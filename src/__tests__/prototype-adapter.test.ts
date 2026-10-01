// Tests for prototype-adapter — the pure AutoRoadmapData → RoadmapPrototype
// transform. Everything is exercised through the two exported functions
// (toPrototypeCourse, tierResolver); itemToResource/sessionToTile/formatDuration
// are private, so their branches are asserted via the module cards they produce.

import { describe, it, expect } from 'vitest'
import { toPrototypeCourse, tierResolver, type Tier, withMyBaking } from '@/lib/roadmap/prototype-adapter'
import { masteryTier } from '@/lib/skills/mastery'
import type {
  AutoRoadmapData,
  RoadmapItemNode,
  RoadmapWeekNode,
  RoadmapResourceNode,
  RoadmapEdge,
  RoadmapLinkEndpointType,
} from '@/lib/validations/auto-roadmap'
import type { ModuleItemType } from '@/lib/validations/module'
import type { CoverageResult, ModuleCoverage } from '@/lib/roadmap/coverage'

// ── Fixture builders ─────────────────────────────────────────────
const NONE = (): Tier => 'none'

function item(o: Partial<RoadmapItemNode> & { id: string; itemType: ModuleItemType }): RoadmapItemNode {
  return {
    title: o.id,
    description: '',
    position: 0,
    status: 'not_started',
    href: null,
    file: null,
    ...o,
  } as RoadmapItemNode
}

function week(o: Partial<RoadmapWeekNode> & { id: string; title: string }): RoadmapWeekNode {
  return {
    description: '',
    weekNumber: null,
    position: 0,
    status: 'not_started',
    items: [],
    ...o,
  } as RoadmapWeekNode
}

function resource(
  o: Partial<RoadmapResourceNode> & { id: string; kind: RoadmapResourceNode['kind'] },
): RoadmapResourceNode {
  return {
    title: o.id,
    status: 'not_started',
    stateLabel: 'Draft',
    href: '',
    ...o,
  } as RoadmapResourceNode
}

function data(o: Partial<AutoRoadmapData>): AutoRoadmapData {
  return {
    sectionId: 'sec-1',
    weeks: [],
    resources: [],
    edges: [],
    ...o,
  }
}

// module→resource placement edge (from=module)
const place = (moduleId: string, resId: string, resType: RoadmapLinkEndpointType): RoadmapEdge => ({
  id: `e-${moduleId}-${resId}`,
  fromType: 'module',
  fromId: moduleId,
  toType: resType,
  toId: resId,
})

const run = (d: Partial<AutoRoadmapData>, tierOf: (t: string) => Tier = NONE) =>
  toPrototypeCourse(data(d), { tierOf })

// ── Module phase + pct ───────────────────────────────────────────
describe('toPrototypeCourse — phase & pct', () => {
  it("phase 'done' + pct 100 when every covered node is complete", () => {
    const { course } = run({
      weeks: [week({ id: 'M1', title: 'W1', items: [item({ id: 'L1', itemType: 'lecture', status: 'complete' })] })],
      resources: [resource({ id: 'Q1', kind: 'quiz', status: 'complete' })],
      edges: [place('M1', 'Q1', 'quiz')],
    })
    expect(course[0].phase).toBe('done')
    expect(course[0].pct).toBe(100)
  })

  it("phase 'todo' + pct 0 when nothing has started", () => {
    const { course } = run({
      weeks: [week({ id: 'M1', title: 'W1', items: [item({ id: 'L1', itemType: 'lecture', status: 'not_started' })] })],
    })
    expect(course[0].phase).toBe('todo')
    expect(course[0].pct).toBe(0)
  })

  it("phase 'prog' with rounded pct for a partially-complete module", () => {
    const { course } = run({
      weeks: [
        week({
          id: 'M1',
          title: 'W1',
          items: [
            item({ id: 'L1', itemType: 'lecture', status: 'complete' }),
            item({ id: 'L2', itemType: 'lecture', status: 'not_started' }),
            item({ id: 'L3', itemType: 'lecture', status: 'not_started' }),
          ],
        }),
      ],
    })
    // 1 of 3 complete → round(33.33) = 33
    expect(course[0].phase).toBe('prog')
    expect(course[0].pct).toBe(33)
  })

  it("phase 'prog' but pct 0 when work is in_progress with nothing complete", () => {
    const { course } = run({
      weeks: [week({ id: 'M1', title: 'W1', items: [item({ id: 'L1', itemType: 'lecture', status: 'in_progress' })] })],
    })
    expect(course[0].phase).toBe('prog')
    expect(course[0].pct).toBe(0)
  })

  it("empty module → pct 0, phase 'todo', no materials", () => {
    const { course } = run({ weeks: [week({ id: 'M1', title: 'Empty' })] })
    expect(course[0]).toMatchObject({ pct: 0, phase: 'todo', materials: [] })
  })

  it('notes are shown as cards but excluded from pct/phase', () => {
    const { course } = run({
      weeks: [
        week({
          id: 'M1',
          title: 'W1',
          items: [
            item({ id: 'N1', itemType: 'note', status: 'not_started' }),
            item({ id: 'L1', itemType: 'lecture', status: 'complete' }),
          ],
        }),
      ],
    })
    // Both render as cards…
    expect(course[0].materials).toHaveLength(2)
    // …but the not_started note must not drag pct down or block 'done'.
    expect(course[0].pct).toBe(100)
    expect(course[0].phase).toBe('done')
  })

  it('placed quizzes/assignments count toward the module pct', () => {
    const { course } = run({
      weeks: [week({ id: 'M1', title: 'W1', items: [item({ id: 'L1', itemType: 'lecture', status: 'complete' })] })],
      resources: [
        resource({ id: 'Q1', kind: 'quiz', status: 'complete' }),
        resource({ id: 'A1', kind: 'assignment', status: 'not_started' }),
      ],
      edges: [place('M1', 'Q1', 'quiz'), place('M1', 'A1', 'assignment')],
    })
    // lecture done + quiz done + assignment not_started → 2 of 3
    expect(course[0].pct).toBe(67)
    expect(course[0].phase).toBe('prog')
  })

  it('drops legacy assignment-type items and section dividers from materials & pct', () => {
    const { course } = run({
      weeks: [
        week({
          id: 'M1',
          title: 'W1',
          items: [
            item({ id: 'AS', itemType: 'assignment', status: 'not_started' }),
            item({ id: 'DV', itemType: 'section_divider', status: 'not_started' }),
            item({ id: 'L1', itemType: 'lecture', status: 'complete' }),
          ],
        }),
      ],
    })
    expect(course[0].materials.map((m) => m.k)).toEqual(['lecture'])
    // only the lecture counts → all covered complete
    expect(course[0].phase).toBe('done')
  })
})

// ── Off-map bench: upload buckets ────────────────────────────────
describe('toPrototypeCourse — upload buckets (off-map bench)', () => {
  it('routes "Quiz Uploads" / "Classroom Uploads" module items to the bench, off the canvas', () => {
    const { course, quizUploads, classroomUploads } = run({
      weeks: [
        week({ id: 'QU', title: 'Quiz Uploads', items: [item({ id: 'F1', itemType: 'lecture' })] }),
        week({ id: 'CU', title: 'classroom uploads', items: [item({ id: 'F2', itemType: 'lecture' })] }),
        week({ id: 'M1', title: 'Week 1', items: [item({ id: 'L1', itemType: 'lecture' })] }),
      ],
    })
    // Hidden container modules never become canvas cards.
    expect(course.map((c) => c.title)).toEqual(['Week 1'])
    expect(quizUploads).toHaveLength(1)
    expect(classroomUploads).toHaveLength(1)
  })

  /* `systemKind` (modules.system_kind) is the container's real identity now — the
     title match survives only as a fallback for rows predating the column and for
     the demo fixtures. Routing by title alone meant a professor who RENAMED the
     container pulled its uploads onto the canvas, and a professor who happened to
     name their own week "Quiz Uploads" had that week's material swept off it. */
  it('routes by systemKind, so a renamed container still goes to the bench', () => {
    const { course, quizUploads, classroomUploads } = run({
      weeks: [
        week({ id: 'QU', title: 'AI quiz source files', systemKind: 'quiz_uploads', items: [item({ id: 'F1', itemType: 'lecture' })] }),
        week({ id: 'CU', title: 'Slides I projected', systemKind: 'classroom_uploads', items: [item({ id: 'F2', itemType: 'lecture' })] }),
        week({ id: 'M1', title: 'Week 1', items: [item({ id: 'L1', itemType: 'lecture' })] }),
      ],
    })
    expect(course.map((c) => c.title)).toEqual(['Week 1'])
    expect(quizUploads).toHaveLength(1)
    expect(classroomUploads).toHaveLength(1)
  })
})

// ── Professor-only card state ────────────────────────────────────
// Two flags the adapter must attach for a professor and withhold from a student:
// one is a visibility fact about the row, the other a class aggregate (§8).
describe('toPrototypeCourse — professor-only card flags', () => {
  it('marks material students cannot see, so an unshared upload never looks published', () => {
    const { course } = run({
      weeks: [week({
        id: 'M1',
        title: 'W1',
        items: [
          item({ id: 'L1', itemType: 'lecture', title: 'Shared deck' }),
          item({ id: 'L2', itemType: 'lecture', title: 'Today’s upload', hiddenFromStudents: true }),
        ],
      })],
    })
    const byTitle = new Map(course[0].materials.map((r) => [r.t, r]))
    expect(byTitle.get('Today’s upload')!.hidden).toBe(true)
    // Absent, not `false` — the card class list keys off truthiness.
    expect(byTitle.get('Shared deck')!.hidden).toBeUndefined()
  })

  it('gives openUntouched to a professor and never to a student (§8 class aggregate)', () => {
    const d = {
      weeks: [week({ id: 'M1', title: 'W1' })],
      resources: [resource({ id: 'q1', kind: 'quiz', title: 'Quiz 1', stateLabel: 'Published' })],
      edges: [place('M1', 'q1', 'quiz')],
    }
    const coverage: CoverageResult = {
      items: new Map(), modules: new Map(), studentDone: new Set(),
      resources: new Map([['q1', { status: 'not_started' as const, openUntouched: true }]]),
    }

    const prof = toPrototypeCourse(data(d), { tierOf: NONE, coverage, audience: 'prof' })
    expect(prof.course[0].quizzes[0].openUntouched).toBe(true)

    /* "Not one student has begun this" is a fact about the CLASS. On a student's
       card it would hand them their classmates' behaviour, so it must not reach
       the client at all — withheld here, not hidden in the renderer. */
    const stu = toPrototypeCourse(data(d), { tierOf: NONE, coverage, audience: 'stu' })
    expect(stu.course[0].quizzes[0].openUntouched).toBeUndefined()
    // The lifecycle word both audiences share is untouched by the flag.
    expect(stu.course[0].quizzes[0].s).toBe('Published')
  })
})

// ── Locked weeks (not open yet) ──────────────────────────────────
describe('toPrototypeCourse — locked weeks', () => {
  it('keeps a locked week on the canvas with its open date, unlike a draft', () => {
    const OPENS = '2026-08-12T00:00:00.000Z'
    const { course } = run({
      weeks: [
        week({ id: 'M1', title: 'Week 7', weekNumber: 7 }),
        week({ id: 'M2', title: 'Week 8', weekNumber: 8, locked: true, unlockDate: OPENS }),
      ],
    })
    // Both render — the locked one is the student's "there's more ahead" cue, so
    // it must NOT be dropped the way an unpublished (draft) module is.
    expect(course.map((m) => m.title)).toEqual(['Week 7', 'Week 8'])
    expect(course[0].locked).toBeUndefined()
    expect(course[1]).toMatchObject({ locked: true, opensAt: OPENS })
  })

  it('carries no contents for a locked week (the loader already stripped them)', () => {
    const { course } = run({ weeks: [week({ id: 'M2', title: 'Week 8', locked: true, unlockDate: null })] })
    expect(course[0].materials).toEqual([])
    expect(course[0].quizzes).toEqual([])
    expect(course[0].assignments).toEqual([])
    expect(course[0].opensAt).toBeNull()
  })
})

// ── Placement + unplaced bench ───────────────────────────────────
describe('toPrototypeCourse — placement & unplaced', () => {
  it('places a resource onto its module regardless of edge direction', () => {
    const reversed: RoadmapEdge = {
      id: 'rev',
      fromType: 'quiz',
      fromId: 'Q1',
      toType: 'module',
      toId: 'M1',
    }
    const { course } = run({
      weeks: [week({ id: 'M1', title: 'W1' })],
      resources: [resource({ id: 'Q1', kind: 'quiz', title: 'Midterm', stateLabel: 'Published', status: 'in_progress' })],
      edges: [reversed],
    })
    expect(course[0].quizzes).toEqual([
      { k: 'quiz', t: 'Midterm', s: 'Published', st: 'prog', skills: undefined, key: 'quiz:Q1' },
    ])
  })

  it('sends unplaced quizzes/assignments to the bench; live sessions never land there', () => {
    const { unplaced } = run({
      weeks: [week({ id: 'M1', title: 'W1' })],
      resources: [
        resource({ id: 'Q1', kind: 'quiz', title: 'Loose quiz' }),
        resource({ id: 'S1', kind: 'live_session', title: 'Loose session' }),
      ],
      // no edges → nothing placed
    })
    expect(unplaced.map((r) => r.t)).toEqual(['Loose quiz'])
  })
})

// ── itemToResource branches (via materials) ──────────────────────
describe('toPrototypeCourse — material card mapping', () => {
  const materialsOf = (it: RoadmapItemNode, tierOf: (t: string) => Tier = NONE) =>
    run({ weeks: [week({ id: 'M1', title: 'W1', items: [it] })] }, tierOf).course[0].materials

  it('lecture: format from fileType + page-count subtitle + slides flag + pages field', () => {
    const [card] = materialsOf(
      item({ id: 'L1', itemType: 'lecture', title: 'Intro', fileType: 'pdf', pageCount: 12, useAsSlides: true }),
    )
    expect(card).toMatchObject({ k: 'lecture', t: 'Intro', s: 'PDF · 12 pages', fmt: 'PDF', slides: true, pages: 12 })
  })

  it('every card carries its node key — materials, quizzes and assignments alike', () => {
    // Two consumers, both silent on failure. The class-lens overlay joins
    // material cards to getStudentJourneys by `module_item:{id}` — a missing key
    // reads as "not yet covered". The node modal parses a quiz card's key to
    // fetch that quiz's real questions — a missing key leaves the questions
    // (and the skill → question rail) permanently empty.
    const kinds: [string, ModuleItemType][] = [
      ['L1', 'lecture'], ['V1', 'video'], ['N1', 'note'], ['K1', 'link'], ['IM', 'image'],
    ]
    for (const [id, itemType] of kinds) {
      const [card] = materialsOf(item({ id, itemType, href: itemType === 'video' ? 'https://youtu.be/x' : null }))
      expect(card.key).toBe(`module_item:${id}`)
    }
    const { course } = run({
      weeks: [week({ id: 'M1', title: 'W1' })],
      resources: [resource({ id: 'Q1', kind: 'quiz' }), resource({ id: 'A1', kind: 'assignment' })],
      edges: [place('M1', 'Q1', 'quiz'), place('M1', 'A1', 'assignment')],
    })
    expect(course[0].quizzes[0].key).toBe('quiz:Q1')
    expect(course[0].assignments[0].key).toBe('assignment:A1')
  })

  it('lecture: carries the file payload, page citations and summary the detail modal renders', () => {
    // The node modal renders the real document inline and jumps it to the pages
    // that cite a skill — both come straight off the item, so a dropped field
    // here silently degrades the modal back to a stand-in preview.
    const [card] = materialsOf(
      item({
        id: 'L3',
        itemType: 'lecture',
        fileType: 'pdf',
        pageCount: 40,
        file: { url: 'https://f/deck.pdf', name: 'deck.pdf', size: 900 },
        pageRef: { pageNumber: 7 },
        topics: ['Attention'],
        topicPageHits: { Attention: [11, 12] },
        summary: 'How attention works.',
      }),
    )
    expect(card).toMatchObject({
      file: { url: 'https://f/deck.pdf', name: 'deck.pdf', size: 900, id: 'L3', page: 7 },
      topicPages: { Attention: [11, 12] },
      sum: 'How attention works.',
      pages: 40,
    })
  })

  it('video: an embed carries no inline file; an upload does', () => {
    // The embed fixture keeps a `file` on purpose: an item can have BOTH a
    // thumbnail/attachment row and an embed URL, and the modal must still send
    // the viewer to the embed rather than rendering the attachment inline.
    const [embed] = materialsOf(
      item({ id: 'V3', itemType: 'video', href: 'https://youtu.be/abc', file: { url: 'https://f/thumb.mp4', name: 'thumb.mp4' } }),
    )
    expect(embed.file).toBeUndefined()
    expect(embed.href).toBe('https://youtu.be/abc')
    const [upload] = materialsOf(
      item({ id: 'V4', itemType: 'video', file: { url: 'https://f/clip.mp4', name: 'clip.mp4' } }),
    )
    expect(upload.file).toMatchObject({ url: 'https://f/clip.mp4', id: 'V4' })
  })

  it('lecture: page count lands in the format-agnostic `pages` field for a PPT deck', () => {
    // Drives the deck cover "1 / N" badge without string-parsing the subtitle.
    const [card] = materialsOf(
      item({ id: 'L2', itemType: 'lecture', title: 'Slides', fileType: 'ppt', pageCount: 30, useAsSlides: true }),
    )
    expect(card).toMatchObject({ k: 'lecture', fmt: 'PPT', slides: true, pages: 30 })
  })

  it('image: format + pixel-size subtitle + file url as img', () => {
    const [card] = materialsOf(
      item({
        id: 'IM',
        itemType: 'image',
        fileType: 'image',
        imageDimensions: '800×600',
        file: { url: 'https://f/x.png', name: 'x.png' },
      }),
    )
    expect(card).toMatchObject({ k: 'image', s: 'PNG · 800×600', fmt: 'PNG', img: 'https://f/x.png' })
  })

  it('video (youtube): provider detected, no format ribbon, href passthrough, formatted duration', () => {
    const [card] = materialsOf(
      item({ id: 'V1', itemType: 'video', href: 'https://youtu.be/abc', videoDurationMin: 48 }),
    )
    expect(card).toMatchObject({ k: 'video', src: 'youtube', href: 'https://youtu.be/abc', dur: '48 min' })
    expect(card.fmt).toBeUndefined()
  })

  it('video (vimeo): provider detected', () => {
    const [card] = materialsOf(item({ id: 'V2', itemType: 'video', href: 'https://vimeo.com/123' }))
    expect(card.src).toBe('vimeo')
  })

  it('video (upload): no provider, format from file extension, href falls back to file url', () => {
    const [card] = materialsOf(
      item({ id: 'V3', itemType: 'video', href: null, file: { url: 'https://f/clip.mov', name: 'clip.mov' } }),
    )
    expect(card.src).toBeUndefined()
    expect(card.fmt).toBe('MOV')
    expect(card.href).toBe('https://f/clip.mov')
  })

  it('formats video duration: hours+minutes and whole hours', () => {
    expect(materialsOf(item({ id: 'V', itemType: 'video', videoDurationMin: 126 }))[0].dur).toBe('2h 6m')
    expect(materialsOf(item({ id: 'V', itemType: 'video', videoDurationMin: 120 }))[0].dur).toBe('2h')
    expect(materialsOf(item({ id: 'V', itemType: 'video', videoDurationMin: 0 }))[0].dur).toBeUndefined()
  })

  it('reference/link: subtitle is the bare hostname (www stripped)', () => {
    const [ref] = materialsOf(item({ id: 'R', itemType: 'reference', href: 'https://www.arxiv.org/abs/1' }))
    expect(ref).toMatchObject({ k: 'reference', s: 'arxiv.org', href: 'https://www.arxiv.org/abs/1' })
    const [link] = materialsOf(item({ id: 'K', itemType: 'link', href: 'https://docs.google.com/x' }))
    expect(link).toMatchObject({ k: 'link', s: 'docs.google.com' })
  })

  it('reference node kind is chosen from the URL, not the stored referenceType', () => {
    // Papers / known reading sites keep the rich reference card…
    expect(materialsOf(item({ id: 'P', itemType: 'reference', href: 'https://arxiv.org/abs/1706.03762' }))[0].k).toBe('reference')
    expect(materialsOf(item({ id: 'B', itemType: 'reference', href: 'https://distill.pub/2016/misread-tsne/' }))[0].k).toBe('reference')
    // …a plain link (title + generic URL) falls back to the lightweight link node.
    const [plain] = materialsOf(item({ id: 'L', itemType: 'reference', href: 'https://edstem.org', topics: ['X'] }))
    expect(plain).toMatchObject({ k: 'link', s: 'edstem.org', href: 'https://edstem.org' })
    // link nodes carry no skill pill (the node has no room for it).
    expect(plain.skills).toBeUndefined()
  })

  it('reference subtitle is the venue name for the node chip (no id)', () => {
    // arXiv → "arXiv" (NodeReference renders it as the red badge); id omitted.
    expect(materialsOf(item({ id: 'X', itemType: 'reference', href: 'https://arxiv.org/abs/1706.03762' }))[0].s).toBe('arXiv')
    // Another named venue → its name.
    expect(materialsOf(item({ id: 'J', itemType: 'reference', href: 'https://www.jmlr.org/papers/v3/bengio03a.html' }))[0].s).toBe('JMLR')
    // A reading reference with no recognised venue → bare hostname.
    expect(materialsOf(item({ id: 'G', itemType: 'reference', href: 'https://jalammar.github.io/illustrated-transformer/' }))[0].s).toBe('jalammar.github.io')
  })

  it('note card has the plain "Note" subtitle', () => {
    expect(materialsOf(item({ id: 'N', itemType: 'note' }))[0]).toMatchObject({ k: 'note', s: 'Note' })
  })

  it('colours skill chips via tierOf', () => {
    const tierOf = (t: string): Tier => (t === 'Gradients' ? 'strong' : 'none')
    const [card] = materialsOf(
      item({ id: 'L', itemType: 'lecture', topics: ['Gradients', 'Bias'] }),
      tierOf,
    )
    expect(card.skills).toEqual([
      ['Gradients', 'strong'],
      ['Bias', 'none'],
    ])
  })
})

// ── sessionToTile (via placed live_session) ──────────────────────
describe('toPrototypeCourse — session tiles', () => {
  const tileFor = (r: RoadmapResourceNode) =>
    run({
      weeks: [week({ id: 'M1', title: 'W1' })],
      resources: [r],
      edges: [place('M1', r.id, 'live_session')],
    }).course[0].sessions![0]

  it('every session tile carries its node key — calendar variant included', () => {
    // The modal parses `live_session:{id}` to fetch what actually ran in the
    // room. A tile without a key never resolves a room id, so the panel sits on
    // "loading what ran in this room…" forever — no error, just a permanent
    // spinner. The calendar branch returns its own object, so it is asserted
    // separately rather than trusted to keep spreading `base`.
    expect(tileFor(resource({ id: 'S0', kind: 'live_session', status: 'complete' })).key).toBe('live_session:S0')
    expect(
      tileFor(resource({ id: 'S0b', kind: 'live_session', status: 'not_started', scheduledAt: '2026-08-01T15:00:00Z' })).key,
    ).toBe('live_session:S0b')
  })

  it('scheduled (not-yet-held) room with a date → calendar-tile variant', () => {
    const tile = tileFor(
      resource({ id: 'S1', kind: 'live_session', status: 'not_started', scheduledAt: '2026-08-01T15:00:00Z' }),
    )
    expect(tile.sched).toBe(true)
    expect(tile.mon).toMatch(/^[A-Z]{3}$/)
    expect(typeof tile.day).toBe('number')
  })

  it('held session (or one without a date) is not a calendar tile', () => {
    expect(tileFor(resource({ id: 'S2', kind: 'live_session', status: 'complete', scheduledAt: '2026-08-01T15:00:00Z' })).sched).toBeUndefined()
    expect(tileFor(resource({ id: 'S3', kind: 'live_session', status: 'not_started' })).sched).toBeUndefined()
  })

  it('an unparseable scheduledAt does not produce a calendar tile', () => {
    expect(tileFor(resource({ id: 'S4', kind: 'live_session', status: 'not_started', scheduledAt: 'not-a-date' })).sched).toBeUndefined()
  })

  it('summarises poll and live-quiz children as interaction chips (with pluralisation)', () => {
    const tile = tileFor(
      resource({
        id: 'S5',
        kind: 'live_session',
        status: 'complete',
        children: [
          { id: 'p1', kind: 'live_poll', title: 'p', status: 'complete' },
          { id: 'q1', kind: 'live_quiz', title: 'q', status: 'complete' },
          { id: 'q2', kind: 'live_quiz', title: 'q', status: 'complete' },
        ],
      }),
    )
    expect(tile.ints).toEqual([
      ['poll', '1 poll'],
      ['lquiz', '2 live quizzes'],
    ])
  })

  it('maps the attendee roster to a facepile: ≤4 initials + full head-count', () => {
    const tile = tileFor(
      resource({
        id: 'S6',
        kind: 'live_session',
        status: 'complete',
        attendees: ['Marcus Johnson', 'Priya Patel', 'Alex Rodriguez', 'Jordan Kim', 'Sam Nguyen', 'Emily Chen'],
      }),
    )
    expect(tile.attendees).toEqual({ initials: ['MJ', 'PP', 'AR', 'JK'], total: 6 })
  })

  it('derives initials from single- and multi-word names; omits the facepile when there is no roster', () => {
    expect(tileFor(resource({ id: 'S7', kind: 'live_session', status: 'complete', attendees: ['Cher'] })).attendees)
      .toEqual({ initials: ['CH'], total: 1 })
    // 3+ words → first + LAST initial (not the middle name)
    expect(tileFor(resource({ id: 'S7b', kind: 'live_session', status: 'complete', attendees: ['Mary Jane Watson'] })).attendees)
      .toEqual({ initials: ['MW'], total: 1 })
    // no attendees → no facepile (never a fabricated crowd)
    expect(tileFor(resource({ id: 'S8', kind: 'live_session', status: 'complete' })).attendees).toBeUndefined()
  })

  it('a live (in_progress) room becomes the module liveRoom, not a session tile', () => {
    const { course } = run({
      weeks: [week({ id: 'M1', title: 'W1' })],
      resources: [
        resource({ id: 'LIVE', kind: 'live_session', title: 'Lecture 9 — Live', status: 'in_progress', stateLabel: 'Live', href: '/r/LIVE' }),
        resource({ id: 'ENDED', kind: 'live_session', title: 'Lecture 8', status: 'complete', href: '/r/ENDED' }),
      ],
      edges: [place('M1', 'LIVE', 'live_session'), place('M1', 'ENDED', 'live_session')],
    })
    const m = course[0]
    expect(m.live).toBe(true)
    expect(m.liveRoom).toMatchObject({ t: 'Lecture 9 — Live', href: '/r/LIVE', sched: false })
    /* `live` as well as `sched: false`. Every "how many of these are finished"
       tally reads `!sched`, which for a running class is true — so without this
       flag the card counts a class that has merely STARTED as delivered, while the
       coverage engine counts it as in-progress. The ended tile carries no flag, so
       the two can be told apart. */
    expect(m.liveRoom?.live).toBe(true)
    expect(m.sessions?.[0].live).toBeUndefined()
    // the live room is NOT also rendered as a session tile; the ended one still is
    expect(m.sessions?.map((s) => s.t)).toEqual(['Lecture 8'])
  })

  it('no live room → module.live is false and liveRoom undefined', () => {
    const { course } = run({
      weeks: [week({ id: 'M1', title: 'W1' })],
      resources: [resource({ id: 'S', kind: 'live_session', status: 'complete', href: '/r/S' })],
      edges: [place('M1', 'S', 'live_session')],
    })
    expect(course[0].live).toBe(false)
    expect(course[0].liveRoom).toBeUndefined()
  })

  it('the live room carries its own attendee facepile', () => {
    const { course } = run({
      weeks: [week({ id: 'M1', title: 'W1' })],
      resources: [
        resource({ id: 'LIVE', kind: 'live_session', status: 'in_progress', href: '/r/LIVE', attendees: ['Emily Chen', 'Marcus Johnson'] }),
      ],
      edges: [place('M1', 'LIVE', 'live_session')],
    })
    expect(course[0].liveRoom?.attendees).toEqual({ initials: ['EC', 'MJ'], total: 2 })
  })
})

// ── Ongoing frontier: the module before the next scheduled live class ────
describe('toPrototypeCourse — ongoing frontier', () => {
  const FUTURE = '2999-01-01T00:00:00Z'
  const w3 = () => [week({ id: 'M1', title: 'W1' }), week({ id: 'M2', title: 'W2' }), week({ id: 'M3', title: 'W3' })]

  it('marks the module BEFORE the next scheduled live class as ongoing', () => {
    const { course } = run({
      weeks: w3(),
      resources: [resource({ id: 'S', kind: 'live_session', status: 'not_started', scheduledAt: FUTURE })],
      edges: [place('M3', 'S', 'live_session')],
    })
    // scheduled class sits in M3 → M2 (the one before it) is the ongoing frontier
    expect(course.map((c) => !!c.ongoing)).toEqual([false, true, false])
  })

  it('picks the EARLIEST upcoming scheduled class across modules', () => {
    const { course } = run({
      weeks: w3(),
      resources: [
        resource({ id: 'S3', kind: 'live_session', status: 'not_started', scheduledAt: '2999-06-01T00:00:00Z' }),
        resource({ id: 'S2', kind: 'live_session', status: 'not_started', scheduledAt: FUTURE }),
      ],
      edges: [place('M3', 'S3', 'live_session'), place('M2', 'S2', 'live_session')],
    })
    // earliest is S2 in M2 → M1 is ongoing (the later S3 in M3 is ignored)
    expect(course.map((c) => !!c.ongoing)).toEqual([true, false, false])
  })

  it('ignores past-dated rooms, and highlights nothing when the next class is the first module', () => {
    const past = run({
      weeks: w3(),
      resources: [resource({ id: 'S', kind: 'live_session', status: 'not_started', scheduledAt: '2000-01-01T00:00:00Z' })],
      edges: [place('M3', 'S', 'live_session')],
    })
    expect(past.course.some((c) => c.ongoing)).toBe(false)

    const first = run({
      weeks: w3(),
      resources: [resource({ id: 'S', kind: 'live_session', status: 'not_started', scheduledAt: FUTURE })],
      edges: [place('M1', 'S', 'live_session')],
    })
    // next class is in the very first module → no module before it to highlight
    expect(first.course.some((c) => c.ongoing)).toBe(false)
  })

  it('no scheduled classes → no ongoing highlight', () => {
    const { course } = run({ weeks: w3() })
    expect(course.some((c) => c.ongoing)).toBe(false)
  })

  it('keeps the ongoing index aligned when a hidden upload bucket precedes the modules', () => {
    // Buckets are `continue`-skipped from BOTH course[] and the parallel
    // schedule array, so `course[nextIdx - 1]` must still resolve to the right
    // rendered module even when an off-canvas bucket sits ahead of them.
    const { course } = run({
      weeks: [week({ id: 'QU', title: 'Quiz Uploads' }), ...w3()],
      resources: [resource({ id: 'S', kind: 'live_session', status: 'not_started', scheduledAt: FUTURE })],
      edges: [place('M3', 'S', 'live_session')],
    })
    expect(course.map((c) => c.title)).toEqual(['W1', 'W2', 'W3']) // bucket stays off-canvas
    expect(course.map((c) => !!c.ongoing)).toEqual([false, true, false]) // M2, not M1
  })
})

// ── with derived coverage (Part II slice 1) ──────────────────────
//
// Every test above runs the no-coverage fallback — the degraded path taken only
// when `loadRoadmapCoverage` returns null (unreadable section / load error). It
// still reads real resource state, but module and item status is always
// 'not_started' there now that assembleRoadmapData never stores one, so those
// fixtures describe the shape, not what a user sees. These cover the path real
// users hit once coverage is derived — where stateless material loses its status
// dot and the module percentage comes from the engine rather than from counting
// every card.

describe('toPrototypeCourse — with coverage', () => {
  const cov = (o: Partial<CoverageResult> = {}): CoverageResult => ({
    items: new Map(), resources: new Map(), modules: new Map(), studentDone: new Set(), ...o,
  })
  const mod = (o: Partial<ModuleCoverage> = {}): ModuleCoverage => ({
    status: 'complete', pct: 100, excluded: false, skipped: false, ...o,
  })
  const runCov = (d: Partial<AutoRoadmapData>, coverage: CoverageResult) =>
    toPrototypeCourse(data(d), { tierOf: NONE, coverage })

  const mixedWeek = () => week({
    id: 'm1',
    title: 'Week 1',
    items: [
      item({ id: 'lec', itemType: 'lecture', title: 'Lecture' }),
      item({ id: 'vid', itemType: 'video', title: 'Video' }),
      item({ id: 'ref', itemType: 'reference', title: 'Paper' }),
    ],
  })

  const delivered = () =>
    cov({
      items: new Map([['lec', { status: 'complete' as const }]]),
      modules: new Map([['m1', mod()]]),
    })

  it('gives supplementary material no status, and the lecture its derived one', () => {
    const { course } = runCov({ weeks: [mixedWeek()] }, delivered())
    const byTitle = new Map(course[0].materials.map((r) => [r.t, r]))
    expect(byTitle.get('Lecture')!.st).toBe('done')
    // '' — not 'todo'. A paper was never something the professor delivers.
    expect(byTitle.get('Video')!.st).toBe('')
    expect(byTitle.get('Paper')!.st).toBe('')
  })

  it('takes pct and phase from the engine, not from counting every card', () => {
    const { course } = runCov({ weeks: [mixedWeek()] }, delivered())
    // Counting all three cards would read 33%; only the lecture is deliverable.
    expect(course[0].pct).toBe(100)
    expect(course[0].phase).toBe('done')
  })

  it('marks an excluded module so the card can suppress its percentage', () => {
    const { course } = runCov(
      { weeks: [mixedWeek()] },
      cov({
        items: new Map([['lec', { status: 'complete' as const }]]),
        modules: new Map([['m1', mod({ status: 'not_started', pct: 0, excluded: true, skipped: true })]]),
      }),
    )
    expect(course[0]).toMatchObject({ excluded: true, skipped: true, phase: 'todo' })
  })

  it('ships deck coverage as a number, not as prose in the subtitle', () => {
    // The subtitle is regex-parsed in several places, so the fraction rides on
    // its own field and the card renders it in the cover badge.
    const { course } = runCov(
      { weeks: [week({ id: 'm1', title: 'Week 1', items: [item({ id: 'd', itemType: 'lecture', useAsSlides: true, pageCount: 30 })] })] },
      cov({
        items: new Map([['d', { status: 'in_progress' as const, coverage: { covered: 18, total: 30 } }]]),
        modules: new Map([['m1', mod({ status: 'in_progress', pct: 0 })]]),
      }),
    )
    expect(course[0].materials[0]).toMatchObject({ covered: 18, pages: 30, s: 'PDF · 30 pages' })
  })

  it('keeps the fraction once the deck is fully covered — "30 / 30", not "1 / 30"', () => {
    const { course } = runCov(
      { weeks: [week({ id: 'm1', title: 'Week 1', items: [item({ id: 'd', itemType: 'lecture', useAsSlides: true, pageCount: 30 })] })] },
      cov({
        items: new Map([['d', { status: 'complete' as const, coverage: { covered: 30, total: 30 } }]]),
        modules: new Map([['m1', mod()]]),
      }),
    )
    /* Dropping it once the deck completed left the badge on its `?? 1` fallback,
       so a finished deck read "1 / 30" under a module header saying 100% — the
       engine had the real number and the adapter threw it away. */
    expect(course[0].materials[0]).toMatchObject({ covered: 30, pages: 30 })
  })

  it('uses the derived status for a placed quiz', () => {
    const { course } = runCov(
      {
        weeks: [week({ id: 'm1', title: 'Week 1' })],
        resources: [resource({ id: 'q1', kind: 'quiz', status: 'in_progress' })],
        edges: [place('m1', 'q1', 'quiz')],
      },
      cov({ resources: new Map([['q1', { status: 'complete' as const }]]) }),
    )
    expect(course[0].quizzes[0].st).toBe('done')
  })

  it('falls back to the legacy roll-up for a module the engine did not resolve', () => {
    const { course } = runCov({ weeks: [mixedWeek()] }, cov())
    expect(course[0].pct).toBe(0)
    expect(course[0].excluded).toBeUndefined()
  })

  // ── the student view (slice 2a) ────────────────────────────────
  // A student layer is signalled by ANY module carrying studentPct, which is
  // what flips extras from "not the professor's to deliver" to "mine to do".
  describe('student view', () => {
    const stu = (o: Partial<ModuleCoverage>, done: string[] = []) =>
      cov({
        items: new Map([['lec', { status: 'complete' as const }]]),
        modules: new Map([['m1', mod({ studentPct: 0, ...o })]]),
        studentDone: new Set(done),
      })

    it('gives a ticked extra a status and leaves an untouched one blank', () => {
      const { course } = runCov({ weeks: [mixedWeek()] }, stu({ studentPct: 67 }, ['vid']))
      const byTitle = new Map(course[0].materials.map((r) => [r.t, r]))
      expect(byTitle.get('Video')!.st).toBe('done')
      expect(byTitle.get('Paper')!.st).toBe('')
      // Both stay tickable, so neither can drop out of the student's denominator.
      expect(byTitle.get('Video')!.tickable).toBe(true)
      expect(byTitle.get('Paper')!.tickable).toBe(true)
      // The lecture is delivered, never the student's to tick.
      expect(byTitle.get('Lecture')!.tickable).toBeUndefined()
    })

    it('marks only the nodes the panel reported, keyed by the bare item id', () => {
      /* THE fan-out guard, in data form. `module_items.node_check_state` is
         course-level — the first student to open a node flips it for the whole
         section — so the DTO deliberately doesn't carry it and this function is
         what decides who sees the state. Drop the `mine` lookup and every
         classmate's map lights up for a click they never made; match on the raw
         `key` instead of the parsed id and nothing ever lights up at all, which
         looks exactly like the feature being broken. */
      const { course } = runCov(
        {
          weeks: [
            week({
              id: 'm1',
              title: 'Week 1',
              items: [
                item({ id: 'vid', itemType: 'video', title: 'Video' }),
                item({ id: 'ref', itemType: 'reference', title: 'Paper' }),
              ],
            }),
          ],
        },
        stu({ studentPct: 0 }),
      )
      // Keyed by the BARE id, as the check panel reports it — while the card's own
      // key is `module_item:vid`. That bridge is the whole contract.
      const marked = withMyBaking(course, { vid: true })
      const byTitle = new Map(marked[0].materials.map((r) => [r.t, r]))
      expect(byTitle.get('Video')!.baking).toBe(true)
      expect(byTitle.get('Paper')!.baking).toBeUndefined()
      // Nothing reported ⇒ the same array back, so no node can light up on its own.
      expect(withMyBaking(course, {})).toBe(course)
      // A prefixed key must NOT match — that would be the raw-key bug.
      expect(
        withMyBaking(course, { 'module_item:vid': true })[0].materials.every((r) => !r.baking),
      ).toBe(true)
    })

    it('shows the student their own percentage, not delivery', () => {
      const { course } = runCov({ weeks: [mixedWeek()] }, stu({ pct: 100, studentPct: 67 }, ['vid']))
      expect(course[0].pct).toBe(67)
    })

    it('keeps a started module blue even before the student finishes anything', () => {
      // Delivery is under way, so grey would wrongly read "the class hasn't begun".
      const { course } = runCov(
        { weeks: [mixedWeek()] },
        stu({ status: 'in_progress', pct: 0, studentPct: 0 }),
      )
      expect(course[0].phase).toBe('prog')
    })

    it('an extras-only week is a real number for the student, not "—"', () => {
      const done = runCov(
        { weeks: [mixedWeek()] },
        stu({ status: 'not_started', pct: 0, excluded: true, studentPct: 100 }, ['vid', 'ref']),
      )
      expect(done.course[0]).toMatchObject({ pct: 100, phase: 'done' })
      expect(done.course[0].excluded).toBeUndefined()

      const untouched = runCov(
        { weeks: [mixedWeek()] },
        stu({ status: 'not_started', pct: 0, excluded: true, studentPct: 0 }),
      )
      expect(untouched.course[0]).toMatchObject({ pct: 0, phase: 'todo' })
      expect(untouched.course[0].excluded).toBeUndefined()
    })

    it('a skipped week stays excluded even for a student', () => {
      const { course } = runCov(
        { weeks: [mixedWeek()] },
        cov({ modules: new Map([['m1', mod({ skipped: true, excluded: true, studentPct: 100 })]]) }),
      )
      expect(course[0]).toMatchObject({ excluded: true, phase: 'todo' })
    })
  })
})

// ── Dividers ─────────────────────────────────────────────────────
// The index is what the layout stacks on, so the mapping (item order → column
// slot / module order → band gap) is the whole contract.
describe('toPrototypeCourse — dividers', () => {
  it('maps an in-module divider to the number of MATERIAL cards above it', () => {
    const { course } = run({
      weeks: [week({
        id: 'M1',
        title: 'W1',
        items: [
          item({ id: 'L1', itemType: 'lecture' }),
          item({ id: 'N1', itemType: 'note' }), // spine, not the materials lane
          item({ id: 'L2', itemType: 'lecture' }),
        ],
        dividers: [
          { id: 'D0', title: 'Intro', afterItemId: null },
          { id: 'D1', title: 'Exam prep', afterItemId: 'N1' },
        ],
      })],
    })
    // D0 above everything; D1 follows a note, so it lands under the one material
    // card that precedes it — never pushed past L2.
    expect(course[0].dividers).toEqual([
      { index: 0, title: 'Intro' },
      { index: 1, title: 'Exam prep' },
    ])
  })

  it('places a module-level divider by how many module bands sit above it', () => {
    const { moduleDividers } = run({
      weeks: [
        week({ id: 'M1', title: 'W1', position: 0 }),
        week({ id: 'M2', title: 'W2', position: 2 }),
      ],
      moduleDividers: [
        { id: 'MD1', title: 'Midterm', position: 1 },
        { id: 'MD2', title: 'Finals', position: 9 },
      ],
    })
    expect(moduleDividers).toEqual([
      { index: 1, title: 'Midterm' }, // between the two modules
      { index: 2, title: 'Finals' },  // below the last one
    ])
  })

  it('ignores the off-map upload buckets when counting bands', () => {
    const { moduleDividers } = run({
      weeks: [
        week({ id: 'M0', title: 'Quiz Uploads', position: 0 }),
        week({ id: 'M1', title: 'W1', position: 1 }),
      ],
      moduleDividers: [{ id: 'MD1', title: 'Midterm', position: 2 }],
    })
    expect(moduleDividers).toEqual([{ index: 1, title: 'Midterm' }])
  })

  // The Modules page renders a MODULE before a divider on a position tie, and the
  // tie is reachable: createModule takes max(modules.position)+1, which collides
  // with a divider already parked there until the next drag rewrites both onto
  // 0..n-1. The adapter's `p <= d.position` has to agree, or the roadmap draws the
  // break on the wrong side of the module the professor sees it below.
  it('puts a tied module ABOVE the divider, matching the Modules page order', () => {
    const { moduleDividers } = run({
      weeks: [
        week({ id: 'M1', title: 'W1', position: 0 }),
        week({ id: 'M2', title: 'W2', position: 1 }), // tied with the divider
        week({ id: 'M3', title: 'W3', position: 2 }),
      ],
      moduleDividers: [{ id: 'MD1', title: 'Midterm', position: 1 }],
    })
    // 2 = below W2, not above it.
    expect(moduleDividers).toEqual([{ index: 2, title: 'Midterm' }])
  })

  it('collapses every divider onto slot 0 when a module has no materials lane', () => {
    const { course } = run({
      weeks: [week({
        id: 'M1',
        title: 'W1',
        items: [item({ id: 'N1', itemType: 'note' }), item({ id: 'N2', itemType: 'note' })],
        dividers: [
          { id: 'D1', title: 'Before', afterItemId: 'N1' },
          { id: 'D2', title: 'After', afterItemId: 'N2' },
        ],
      })],
    })
    // Notes hang on the spine, so the lane is empty and there is no slot to sit
    // between — both land at its head (the layout then stacks them at its foot)
    // rather than being indexed by notes they never crossed.
    expect(course[0].dividers).toEqual([
      { index: 0, title: 'Before' },
      { index: 0, title: 'After' },
    ])
  })

  it('indexes within the materials lane whatever the item mix', () => {
    const { course } = run({
      weeks: [week({
        id: 'M1',
        title: 'W1',
        items: [
          item({ id: 'A1', itemType: 'assignment' }), // legacy: yields no card at all
          item({ id: 'L1', itemType: 'lecture' }),
          item({ id: 'N1', itemType: 'note' }), // spine, not the lane
        ],
        dividers: [{ id: 'D1', title: 'Break', afterItemId: 'N1' }],
      })],
    })
    // computeLayout's lane is exactly `materials` minus notes — the index has to be
    // a slot in THAT list. Deriving it here binds the two: if itemToResource ever
    // stops emitting a card that inRightColumn still counts, this fails.
    const lane = course[0].materials.filter((r) => r.k !== 'note')
    expect(lane.map((r) => r.t)).toEqual(['L1'])
    expect(course[0].dividers).toEqual([{ index: 1, title: 'Break' }])
    expect(course[0].dividers![0].index).toBeLessThanOrEqual(lane.length)
  })
})

// ── tierResolver ─────────────────────────────────────────────────
describe('tierResolver', () => {
  it('maps a topic score through masteryTier, normalising the topic name', () => {
    const scores = new Map<string, number | null>([
      ['gradients', 85],
      ['bias', 40],
    ])
    const tierOf = tierResolver(scores, masteryTier)
    // trims + lowercases before lookup
    expect(tierOf('  Gradients ')).toBe('strong')
    expect(tierOf('BIAS')).toBe('weak')
  })

  it('returns "none" for a topic with no recorded score', () => {
    const tierOf = tierResolver(new Map(), masteryTier)
    expect(tierOf('Anything')).toBe('none')
  })
})
