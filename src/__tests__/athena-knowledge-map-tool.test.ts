// `map_knowledge_path` is Athena's second WRITE, and the first whose CONTENT is
// a set of pointers at real rows. The resolver's matching rules have their own
// suite (knowledge-path.test.ts); what this file pins is everything the pure
// half cannot see:
//
//   1. the candidate nodes come from THIS section's published, already-open
//      modules — a model-proposed title must not be able to reach a node in
//      another course, or a locked week the roadmap won't even draw;
//   2. a path too thin to draw is a refusal — no row, and no directive telling
//      the student the app just lit something that does not exist;
//   3. the stored row's tenancy/ownership columns come from ctx, and every
//      stored nodeKey is one the server resolved, never one the model wrote;
//   4. the drive lands on the roadmap route carrying the artifact id the insert
//      returned.
//
// Row-aware Supabase double (same shape as athena-study-artifact-tool.test.ts):
// the filters really filter, so deleting `.eq('section_id', …)` changes the
// answer rather than passing vacuously.

import { describe, it, expect, vi } from 'vitest'
import { buildStudentTools, type AthenaStudentCtx } from '@/lib/ai/student-tutor/contract'

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

const SECTION = 'sec-1'
const STUDENT = 'student-1'
const INSTITUTION = 'inst-1'
const CONVERSATION = 'convo-1'
const NEW_ID = '9f1c0d2e-2222-4222-8222-bbbbbbbbbbbb'

// The curated-mastery aggregation has its own suite; here it only has to honour
// the per-student narrowing, so a dropped `.get(userId)` would show one student
// another's standing on the stops. The factory runs lazily — the tools module is
// imported inside `harness()` — so the constants above are initialised by then.
const SCORES = new Map([
  [STUDENT, new Map([['tokenization', 30], ['embeddings', 75]])],
  // Mirror image: a classmate who is strong exactly where this student is weak.
  ['student-2', new Map([['tokenization', 99], ['embeddings', 99]])],
])
vi.mock('@/lib/skills/roadmap-mastery', () => ({
  buildStudentMastery: async (_db: unknown, _sectionId: string, studentId?: string) => ({
    scoresByStudent: new Map([...SCORES].filter(([sid]) => !studentId || sid === studentId)),
    overallByStudent: new Map(),
  }),
}))

type Row = Record<string, unknown>

const MODULES: Row[] = [
  { id: 'm-1', section_id: SECTION, is_published: true },
  { id: 'm-2', section_id: SECTION, is_published: true },
  // Rows a proposed title must not be able to reach:
  { id: 'm-draft', section_id: SECTION, is_published: false },
  { id: 'm-other', section_id: 'sec-2', is_published: true },
]

const item = (id: string, moduleId: string, title: string, topics: string[]): Row => ({
  id,
  module_id: moduleId,
  title,
  item_type: 'lecture',
  is_visible: true,
  content: { topics },
})

const ITEMS: Row[] = [
  item('i-1', 'm-1', 'Tokenization', ['tokenization']),
  item('i-2', 'm-1', 'Word Embeddings', ['embeddings']),
  item('i-3', 'm-2', 'Attention', ['attention']),
  // Only reachable if the module filters are dropped.
  item('i-draft', 'm-draft', 'Ethics of NLP', ['ethics']),
  item('i-other', 'm-other', 'Decoding Strategies', ['decoding']),
]

/** Row-aware double with insert capture. `select(_, {head:true})` returns the
 *  count the cap check reads; everything else resolves to the filtered rows. */
function stubDb(tables: Record<string, Row[]>) {
  const inserted: Row[] = []
  const from = (table: string) => {
    let rows = [...(tables[table] ?? [])]
    let head = false
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: (_cols?: string, opts?: { count?: string; head?: boolean }) => {
        head = !!opts?.head
        return chain
      },
      eq: (col: string, val: unknown) => {
        rows = rows.filter((r) => r[col] === val)
        return chain
      },
      in: (col: string, vals: unknown[]) => {
        rows = rows.filter((r) => vals.includes(r[col]))
        return chain
      },
      is: (col: string, val: unknown) => {
        rows = rows.filter((r) => (r[col] ?? null) === val)
        return chain
      },
      // The unlock gate (openModuleFilter). Fixtures carry no unlock_date, so
      // every published module reads as open — pass-through keeps the rows.
      or: () => chain,
      order: () => chain,
      limit: (n: number) => {
        rows = rows.slice(0, n)
        return chain
      },
      insert: (payload: Row) => {
        inserted.push(payload)
        rows = [{ id: NEW_ID }]
        return chain
      },
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      single: async () => ({ data: rows[0] ?? null, error: rows[0] ? null : { message: 'no rows' } }),
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: head ? null : rows, error: null, count: rows.length }).then(resolve),
    }
    return chain
  }
  return { from, inserted }
}

type Directive = { type: string; route?: string; label?: string; said?: string }
type Result = {
  mapped: boolean
  reason?: string
  candidates?: string[]
  focus?: string
  stops?: { material: string; masteryPercent: number | null }[]
}

const edge = (from: string, to: string): Row => ({
  section_id: SECTION,
  edge_type: 'prerequisite',
  from_node_type: 'module_item',
  from_node_id: from,
  to_node_type: 'module_item',
  to_node_id: to,
})

async function harness(opts: { artifacts?: Row[]; edges?: Row[]; items?: Row[]; progress?: Row[] } = {}) {
  const db = stubDb({
    modules: MODULES,
    module_items: opts.items ?? ITEMS,
    roadmap_progress: opts.progress ?? [],
    roadmap_edges: opts.edges ?? [],
    athena_artifacts: opts.artifacts ?? [],
  })
  const directives: Directive[] = []
  const { studentToolsFor } = await import('@/lib/ai/student-tutor/tools')
  const tools = buildStudentTools(
    {
      adminDb: db as unknown as AthenaStudentCtx['adminDb'],
      sectionId: SECTION,
      userId: STUDENT,
      institutionId: INSTITUTION,
      conversationId: CONVERSATION,
      emit: (d) => directives.push(d as Directive),
    },
    studentToolsFor('copilot'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ) as any
  return {
    db,
    directives,
    map: (input: Record<string, unknown>) =>
      tools.map_knowledge_path.execute(input, {}) as Promise<Result>,
  }
}

const concept = (title: string) => ({ title, why: `why ${title}` })

describe('map_knowledge_path — the path is made of real nodes', () => {
  it('stores resolved node keys and a mastery snapshot, with every id from ctx', async () => {
    const { db, map } = await harness()

    const result = await map({
      question: 'what do I need to understand attention?',
      concepts: [concept('Tokenization'), concept('Word Embeddings')],
    })

    expect(result).toMatchObject({ mapped: true, focus: 'Attention' })
    // The mastery figures are THIS student's, taken from the narrowed read.
    expect(result.stops).toEqual([
      { material: 'Tokenization', why: 'why Tokenization', masteryPercent: 30 },
      { material: 'Word Embeddings', why: 'why Word Embeddings', masteryPercent: 75 },
    ])

    expect(db.inserted).toHaveLength(1)
    expect(db.inserted[0]).toMatchObject({
      institution_id: INSTITUTION,
      section_id: SECTION,
      student_id: STUDENT,
      conversation_id: CONVERSATION,
      kind: 'knowledge_map',
      title: 'Path to Attention',
      // Anchored to the focus node's OWN module, not the first one in the list.
      module_id: 'm-2',
    })
    const payload = db.inserted[0].payload as {
      question: string
      stops: { nodeKey: string }[]
      focus: { nodeKey: string; title: string }
    }
    // Every key is one the server resolved from this section's own rows.
    expect(payload.stops.map((s) => s.nodeKey)).toEqual(['module_item:i-1', 'module_item:i-2'])
    expect(payload.focus).toEqual({ nodeKey: 'module_item:i-3', title: 'Attention' })
    expect(payload.question).toBe('what do I need to understand attention?')
  })

  it('drives to the roadmap on the id the insert returned, not on anything the model wrote', async () => {
    const { directives, map } = await harness()

    await map({
      question: 'what leads up to attention?',
      concepts: [concept('Tokenization'), concept('Word Embeddings')],
    })

    expect(directives).toHaveLength(1)
    expect(directives[0]).toMatchObject({
      type: 'goto_page',
      route: `/student/courses/${SECTION}/roadmap?path=${NEW_ID}`,
    })
    expect(directives[0].said).toMatch(/✕/)
  })

  it('keeps a stop the student already finished — a prerequisite does not stop being one', async () => {
    // The whole reason the node loader was split out of `buildStudyFocus`: the
    // ranker takes only the unmastered TAIL, the map needs EVERY node. A stop
    // the student checked off reads as `mastered`, so a map built on the
    // ranker's slice would silently drop the foundation the rest stands on —
    // and, at two stops, drop the path itself under MIN_STOPS.
    const { db, map } = await harness({
      progress: [{
        section_id: SECTION,
        student_id: STUDENT,
        progress: { nodeProgress: { 'i-1': { checkedOff: true } } },
      }],
    })

    const result = await map({
      question: 'what do I need to understand attention?',
      concepts: [concept('Tokenization'), concept('Word Embeddings')],
    })

    expect(result.mapped).toBe(true)
    expect(result.stops?.map((s) => s.material)).toEqual(['Tokenization', 'Word Embeddings'])
    const payload = db.inserted[0].payload as { stops: { nodeKey: string }[] }
    expect(payload.stops.map((s) => s.nodeKey)).toEqual(['module_item:i-1', 'module_item:i-2'])
  })

  it('cannot reach a node in another section, or in an unpublished module', async () => {
    // Both titles exist in `module_items` — only the modules query's own filters
    // keep them out of reach. Drop either and this maps them as real stops.
    const { db, directives, map } = await harness()

    const result = await map({
      question: 'what do I need to understand attention?',
      concepts: [concept('Decoding Strategies'), concept('Ethics of NLP')],
    })

    expect(result.mapped).toBe(false)
    expect(result.reason).toMatch(/Decoding Strategies/)
    expect(result.reason).toMatch(/Ethics of NLP/)
    expect(db.inserted).toHaveLength(0)
    expect(directives).toEqual([])
  })
})

describe('map_knowledge_path — honest failure, never improvisation', () => {
  it('refuses when the question names nothing on this roadmap', async () => {
    const { db, directives, map } = await harness()

    const result = await map({
      question: 'what do I need to understand renaissance fresco technique?',
      concepts: [concept('Tokenization'), concept('Word Embeddings')],
    })

    // Two stops DID match — the refusal is about the missing destination, and
    // saving a path with no focus would draw a lens pointing nowhere.
    expect(result.mapped).toBe(false)
    expect(result.reason).toMatch(/no destination|nothing on this student's roadmap/i)
    expect(db.inserted).toHaveLength(0)
    // Emitting here would navigate the student to a map that was never made.
    expect(directives).toEqual([])
  })

  it('refuses a path down to one stop and says which concepts missed', async () => {
    const { db, directives, map } = await harness()

    const result = await map({
      question: 'what do I need to understand attention?',
      concepts: [concept('Tokenization'), concept('Latent Diffusion')],
    })

    expect(result.mapped).toBe(false)
    expect(result.reason).toMatch(/Latent Diffusion/)
    expect(db.inserted).toHaveLength(0)
    expect(directives).toEqual([])
  })

  // The live failure this whole branch exists for: the model proposed textbook
  // concept names against a course whose nodes are titled "Lecture 3: …". Nothing
  // matched, and the refusal told it nothing it could act on. A correction that
  // hands back the course's own vocabulary turns a dead end into one retry.
  it('hands back the course vocabulary so the model can retry with names that exist', async () => {
    const items = [
      item('i-1', 'm-1', 'Lecture 3: Word Vectors', []),
      item('i-2', 'm-1', 'Lecture 4: RNNs and Beyond', []),
      item('i-3', 'm-2', 'Lecture 5: Seq2Seq and Attention', []),
    ]
    const { db, map } = await harness({ items })

    const result = await map({
      question: 'What do I need to understand attention?',
      concepts: [
        { title: 'Word Embeddings', why: 'a' },
        { title: 'Encoder-Decoder Architecture (Seq2Seq)', why: 'b' },
      ],
    })

    expect(result.mapped).toBe(false)
    // The focus still resolves (Lecture 5 names attention) — it is the STOPS
    // that missed, which is exactly what the author saw.
    expect(result.reason).toMatch(/Word Embeddings/)
    expect(result.candidates).toEqual([
      'Lecture 3: Word Vectors',
      'Lecture 4: RNNs and Beyond',
      'Lecture 5: Seq2Seq and Attention',
    ])
    expect(db.inserted).toHaveLength(0)
  })

  it('includes the vocabulary when it is the DESTINATION that missed', async () => {
    const { map } = await harness()

    const result = await map({
      question: 'what do I need to understand renaissance fresco technique?',
      concepts: [concept('Tokenization'), concept('Word Embeddings')],
    })

    expect(result.mapped).toBe(false)
    expect(result.candidates).toContain('Attention')
  })

  it('refuses when the course has no open material at all', async () => {
    const { db, map } = await harness({ items: [] })

    const result = await map({
      question: 'what do I need to understand attention?',
      concepts: [concept('Tokenization'), concept('Word Embeddings')],
    })

    expect(result.mapped).toBe(false)
    expect(db.inserted).toHaveLength(0)
  })
})

describe('map_knowledge_path — the professor edges order the path', () => {
  it('reorders the stops when a prerequisite edge contradicts the model', async () => {
    const { db, map } = await harness({ edges: [edge('i-1', 'i-2')] })

    // Model proposes embeddings first; the roadmap says tokenization comes first.
    const result = await map({
      question: 'what do I need to understand attention?',
      concepts: [concept('Word Embeddings'), concept('Tokenization')],
    })

    expect(result.stops?.map((s) => s.material)).toEqual(['Tokenization', 'Word Embeddings'])
    const payload = db.inserted[0].payload as { stops: { nodeKey: string }[] }
    expect(payload.stops.map((s) => s.nodeKey)).toEqual(['module_item:i-1', 'module_item:i-2'])
  })

  it('ignores a "related" edge — only prerequisites claim an order', async () => {
    const related = { ...edge('i-1', 'i-2'), edge_type: 'related' }
    const { map } = await harness({ edges: [related] })

    const result = await map({
      question: 'what do I need to understand attention?',
      concepts: [concept('Word Embeddings'), concept('Tokenization')],
    })

    // The query filters on edge_type; without that filter the model's order here
    // would be overridden by a link that only means "see also".
    expect(result.stops?.map((s) => s.material)).toEqual(['Word Embeddings', 'Tokenization'])
  })
})

describe('map_knowledge_path — the shared per-section cap', () => {
  it('stops at the cap without writing, and without claiming the app moved', async () => {
    const full = Array.from({ length: 30 }, (_, i) => ({
      id: `a-${i}`,
      section_id: SECTION,
      student_id: STUDENT,
    }))
    const { db, directives, map } = await harness({ artifacts: full })

    const result = await map({
      question: 'what do I need to understand attention?',
      concepts: [concept('Tokenization'), concept('Word Embeddings')],
    })

    expect(result.mapped).toBe(false)
    expect(result.reason).toMatch(/maximum/i)
    expect(db.inserted).toHaveLength(0)
    expect(directives).toEqual([])
  })
})
