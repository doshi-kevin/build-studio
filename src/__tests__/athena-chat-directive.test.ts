// /api/chat hand-rolls its response stream now, and that stream carries two
// things the student experiences directly:
//
//   1. the answer itself. The route stopped returning `toTextStreamResponse()`
//      and pipes `result.textStream` through a ReadableStream whose catch block
//      SWALLOWS failures — a break there is a silent 200 with an empty body, an
//      Athena that has stopped talking. Nothing else asserts the body.
//   2. the navigation directive, appended after the answer when a tool picked a
//      node. It must appear only then, and must never reach `athena_messages` —
//      persisted, it would re-drive the student's browser every time they
//      scrolled back to an old answer.
//   3. the run channel — one marker per lookup start and finish, which is what
//      the dock's "Looking things up…" card is built from. It has to name the
//      lookups that ACTUALLY ran (the whole point of replacing the hardcoded
//      pair the client used to draw) and stay out of `athena_messages` too.
//
// The tool is called for real here (only the ranking underneath it is stubbed),
// so the seam being tested is the actual one: tool → onFocusNode → stream tail →
// parseAthenaDirective on the client.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseAthenaDirective } from '@/lib/ai/athena-directive'

const STUDENT = 'student-1'
const SECTION = 'sec-1'
const CONVO = 'convo-1'
const ANSWER = "I've opened Attention — start with the scaled dot-product section."

const TOP_NODE = {
  key: 'module_item:9f2b1c44-0000-4a11-9c3d-77e2b6a51234',
  title: 'Attention',
  state: 'review_next' as const,
  pct: 20,
  topics: ['Attention'],
}
const SECOND_NODE = {
  key: 'module_item:3a7d0e91-1111-4c22-8b44-55c1a9d33210',
  title: 'Tokenization',
  state: 'in_progress' as const,
  pct: 60,
  topics: ['Tokenization'],
}

// The ranking has its own suite (study-focus.test.ts); here it only has to
// produce a node so the directive path has something to carry.
// `overall` is widened so the mastered-course case below can hand back null.
const buildStudyFocus = vi.fn(async () => ({
  nodes: [TOP_NODE, SECOND_NODE],
  overall: 54 as number | null,
}))
/* AI kill switch: these tests exercise the AI-ENABLED path — mock the guard
   open so their stubbed DB clients don't trip its fail-closed refusal. The
   disabled/locked paths are covered in ai-kill-switch.test.ts. */
vi.mock('@/lib/ai/kill-switch', () => ({
  checkAiFeature: vi.fn(async () => ({ allowed: true })),
  checkAiFeatureBySection: vi.fn(async () => ({ allowed: true })),
}))

vi.mock('@/lib/roadmap/study-focus', () => ({ buildStudyFocus: (...a: unknown[]) => buildStudyFocus(...(a as [])) }))

/** Whether the model "decides" to call the study-focus tool on this turn. */
let callsTool = false
/** What the model passes for `openTopNode` when it does call it (#663). Default true =
 *  "take me there", which is the behaviour the navigation tests below exercise. */
let callsToolWithIntent = true

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const streamText = vi.fn((config: any) => ({
  textStream: (async function* () {
    // Real order of events: the tool runs mid-turn, then the answer streams.
    /* openTopNode: true = "the student asked to be taken there". The tool only
       navigates on intent now (#663) — calling it with {} answers in words and leaves
       the student where they are, which is the whole point of the fix. */
    if (callsTool) await config.tools.get_my_study_focus.execute({ openTopNode: callsToolWithIntent }, {})
    for (const chunk of [ANSWER.slice(0, 12), ANSWER.slice(12)]) yield chunk
    await config.onFinish?.({ text: ANSWER, usage: { inputTokens: 10, outputTokens: 20 } })
  })(),
}))

const searchMaterialPages = vi.fn(async () => [
  { title: 'Deck', pageNumber: 4, text: 'Attention weights sum to one.', score: 1 },
])

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  streamText,
}))
vi.mock('@ai-sdk/google', () => ({ google: () => 'mock-model' }))
vi.mock('@/lib/pinecone/search', () => ({ searchMaterialPages }))
vi.mock('@/lib/ai/usage', () => ({ recordAiUsage: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: STUDENT } }, error: null }) },
  }),
}))

type Row = Record<string, unknown>
const inserts: Array<{ table: string; payload: Row }> = []
const updates: Array<{ table: string; payload: Row }> = []
/** Turns are appended through the athena_append_message RPC, not an insert. */
const rpcCalls: Array<{ name: string; params: Row }> = []
/** What order_index the append RPC claims — 1 means "this was the first turn". */
let appendOrderIndex = 1

/** The titles this turn wrote (a turn also bumps updated_at on the same table). */
const titleWrites = () =>
  updates
    .filter((u) => u.table === 'athena_conversations' && 'title' in u.payload)
    .map((u) => u.payload.title)

/** The message rows this turn appended, in the shape the assertions read. */
function appended(role: 'user' | 'assistant') {
  return rpcCalls
    .filter((c) => c.name === 'athena_append_message' && c.params.p_role === role)
    .map((c) => {
      const parts = c.params.p_parts as Array<{ type: string; text?: string }>
      return { text: parts.map((p) => p.text ?? '').join(''), metadata: c.params.p_metadata as Row }
    })
}

function stubDb(tables: Record<string, Row[]>) {
  const from = (table: string) => {
    let rows = [...(tables[table] ?? [])]
    const result = (list = false) => ({ data: list ? rows : (rows[0] ?? null), error: null })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: () => chain,
      order: () => chain,
      update: (payload: Row) => {
        updates.push({ table, payload })
        return chain
      },
      insert: (payload: Row) => {
        inserts.push({ table, payload })
        return chain
      },
      limit: (n: number) => { rows = rows.slice(0, n); return chain },
      eq: (col: string, val: unknown) => { rows = rows.filter((r) => r[col] === val); return chain },
      in: (col: string, vals: unknown[]) => { rows = rows.filter((r) => vals.includes(r[col])); return chain },
      lt: (col: string, val: number) => { rows = rows.filter((r) => (r[col] as number) < val); return chain },
      single: async () => result(),
      maybeSingle: async () => result(),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(result(true)).then(resolve),
    }
    return chain
  }
  const rpc = async (name: string, params: Row) => {
    rpcCalls.push({ name, params })
    // The turn is appended with an atomic order_index; 1 = first message.
    if (name === 'athena_append_message') return { data: appendOrderIndex, error: null }
    // The route reserves a daily-cap slot before it streams. These tests are
    // about the answer, so the student always has budget.
    return { data: [{ accepted: true }], error: null }
  }
  return { from, rpc }
}

const TABLES: Record<string, Row[]> = {
  enrollments: [{ id: 'enr-1', section_id: SECTION, student_id: STUDENT, status: 'enrolled' }],
  course_sections: [
    { id: SECTION, institution_id: 'inst-1', section_code: 'A', settings: { enabledFeatures: ['athena'] }, course: { code: 'CS584', title: 'NLP' } },
  ],
  quiz_attempts: [],
  // section_id matters: the ownership check is scoped to the section too, since
  // this id is persisted on rows the turn creates (athena_artifacts). `surface`
  // is what keeps a professor's own console threads out of the student dock.
  athena_conversations: [
    { id: CONVO, user_id: STUDENT, section_id: SECTION, surface: 'student' },
  ],
  athena_messages: [],
}
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => stubDb(TABLES) }))

const { POST } = await import('@/app/api/chat/route')

async function ask(opts: { tool: boolean; conversationId?: string; intent?: boolean }) {
  callsTool = opts.tool
  callsToolWithIntent = opts.intent ?? true
  const res = await POST(
    new Request('http://localhost/api/chat', {
      method: 'POST',
      body: JSON.stringify({
        sectionId: SECTION,
        conversationId: opts.conversationId,
        messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'what should I study?' }] }],
      }),
    }),
  )
  return { res, body: await res.text() }
}

beforeEach(() => {
  inserts.length = 0
  updates.length = 0
  rpcCalls.length = 0
  appendOrderIndex = 1
  streamText.mockClear()
  buildStudyFocus.mockClear()
})

describe('/api/chat — naming the thread', () => {
  it('names a thread from its first turn', async () => {
    await ask({ tool: false, conversationId: CONVO })

    expect(titleWrites()).toEqual(['what should I study?'])
  })

  it('leaves the name alone on every turn after the first', async () => {
    appendOrderIndex = 3

    await ask({ tool: false, conversationId: CONVO })

    // Retitling here would rename the student's thread after every message they
    // send. "Is this the first turn?" used to be a COUNT issued after the insert,
    // which a concurrent second send could race; it is now the index the append
    // statement itself claimed. Nothing else in the route reads that return
    // value, so dropping the check breaks no other assertion.
    expect(titleWrites()).toEqual([])
  })
})

describe('/api/chat — the answer stream', () => {
  it('delivers the model text the student is waiting on', async () => {
    // The rewrite to a hand-rolled ReadableStream buries any failure in a catch
    // block, so "200 OK" alone proves nothing about whether Athena said anything.
    const { res, body } = await ask({ tool: false })

    expect(res.status).toBe(200)
    // Read it the way the client does: the stream also carries run markers, and
    // the student must never see one.
    expect(parseAthenaDirective(body).text).toBe(ANSWER)
  })

  it('adds nothing to a turn where no tool picked a place to go', async () => {
    const { body } = await ask({ tool: false })

    expect(parseAthenaDirective(body).gotoNode).toBeNull()
    expect(body).not.toContain('[[athena:node')
  })
})

describe('/api/chat — the run channel', () => {
  it('reports the lookups it really performed, with real durations', async () => {
    const { body } = await ask({ tool: false })
    const { run } = parseAthenaDirective(body)

    // Retrieval and the always-on memory lane both run on every turn, and each
    // reports a start and a finish.
    const done = run.filter((e) => e.phase === 'done')
    expect(done.map((e) => e.name).sort()).toEqual(['Course materials', 'What I know about you'])
    // The detail is derived from the result, not a fixed string: one page came
    // back from the stubbed search and it clears the score floor.
    expect(done.find((e) => e.name === 'Course materials')?.detail).toBe('1 of 1 pages matched')
    for (const event of done) expect(typeof event.ms).toBe('number')
    for (const event of run.filter((e) => e.phase === 'start')) expect(event.ms).toBeUndefined()
  })

  it('reports a tool the model chose to call, and no tool it did not', async () => {
    const withTool = parseAthenaDirective((await ask({ tool: true })).body).run
    expect(withTool.some((e) => e.name === 'What to study next')).toBe(true)
    // Named from the ranking's own result — two nodes were stubbed.
    expect(withTool.find((e) => e.name === 'What to study next' && e.phase === 'done')?.detail).toBe(
      '2 ranked, weakest first',
    )

    const withoutTool = parseAthenaDirective((await ask({ tool: false })).body).run
    expect(withoutTool.some((e) => e.name === 'What to study next')).toBe(false)
  })

  it('is not persisted either — an old answer has no run to replay', async () => {
    await ask({ tool: true, conversationId: CONVO })

    const saved = appended('assistant')
    expect(saved[0].text).not.toContain('athena:run')
  })
})

describe('/api/chat — the navigation directive', () => {
  it('appends the ranking\'s top node, after the answer', async () => {
    const { body } = await ask({ tool: true })

    const parsed = parseAthenaDirective(body)
    // The client's parser and the route's writer have to agree, or the student
    // reads the marker as text and the roadmap never opens.
    expect(parsed.gotoNode).toBe(TOP_NODE.key)
    expect(parsed.text).toBe(ANSWER)
    // Exactly one NODE directive, and it comes after the answer (the run markers
    // are interleaved, which is why this counts the node family specifically).
    expect(body.match(/\[\[athena:node:/g)).toHaveLength(1)
    expect(body.indexOf('[[athena:node:')).toBeGreaterThan(body.indexOf(ANSWER.slice(-20)))
  })

  it('does NOT navigate when the student only asked about their standing (#663)', async () => {
    /* The reported bug: Co-pilot moved the student to the roadmap whenever an answer
       happened to name a weak topic — reproduced on "What am I weak in?" and even on
       "what should I ask in class?" with no live class. Being taken off the page you are
       working on is something you asked for, or it is an interruption.

       The tool RUNS here (tool: true) — same as the navigating case — but with
       openTopNode false, which is how the model should invoke it for a status question.
       Driving it through the stream is what makes this a real assertion: an
       `execute()` call made after the response was built cannot affect the body. */
    const { body } = await ask({ tool: true, intent: false })

    expect(parseAthenaDirective(body).gotoNode).toBeNull()
    expect(body).not.toContain('[[athena:node:')
    // The answer itself is unaffected — the student is informed, just not moved.
    expect(parseAthenaDirective(body).text).toBe(ANSWER)
  })

  it('stays silent when the ranking has nowhere to send them', async () => {
    // A mastered, fully checked-off course: the tool still answers, but driving
    // the student to a node that does not exist is worse than not moving.
    buildStudyFocus.mockResolvedValueOnce({ nodes: [], overall: null })

    const { body } = await ask({ tool: true })

    expect(parseAthenaDirective(body).text).toBe(ANSWER)
    expect(parseAthenaDirective(body).gotoNode).toBeNull()
  })

  it('never hands the model a node key to write itself', async () => {
    // The directive is trustworthy only because the model cannot produce one:
    // it is appended by the route from the ranking. If `key` appeared in the
    // tool result the model could argue itself into any navigation.
    await ask({ tool: true })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const config = streamText.mock.calls[0][0] as any
    const toolResult = await config.tools.get_my_study_focus.execute({}, {})

    expect(JSON.stringify(toolResult)).not.toContain(TOP_NODE.key)
    expect(JSON.stringify(toolResult)).not.toContain('9f2b1c44')
    expect(toolResult.nodes[0].material).toBe('Attention')
  })

  // The reason `buildStudyFocus` grew a return object at all: the student's
  // course-wide standing rides out on the ranking's read so "how am I doing?"
  // costs no second whole-section query. The ranking has its own suite — what is
  // only testable here is that the tool actually FORWARDS the number, on both
  // branches. Dropped, the model answers that question with nothing.
  it('hands the model the course-wide standing, on both branches', async () => {
    // `tool: false` so the stub stream doesn't run the tool itself — this test
    // drives it directly, which keeps `mockResolvedValueOnce` below aimed at the
    // call being asserted.
    await ask({ tool: false })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ranked = streamText.mock.calls[0][0] as any
    expect((await ranked.tools.get_my_study_focus.execute({}, {})).overallMasteryPercent).toBe(54)

    // Nothing assessed yet. Null must survive as null: the tool description
    // tells the model to say so plainly, and a 0 here would have it tell a
    // student they have learned nothing.
    await ask({ tool: false })
    buildStudyFocus.mockResolvedValueOnce({ nodes: [], overall: null })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const empty = streamText.mock.calls.at(-1)![0] as any
    const result = await empty.tools.get_my_study_focus.execute({}, {})

    expect(result.count).toBe(0)
    expect(result.overallMasteryPercent).toBeNull()
  })

  it('is not persisted, so reopening the thread does not re-navigate', async () => {
    const { body } = await ask({ tool: true, conversationId: CONVO })

    expect(body).toContain('[[athena:node:')
    const saved = appended('assistant')
    expect(saved).toHaveLength(1)
    expect(saved[0].text).toBe(ANSWER)
    expect(saved[0].text).not.toContain('athena:node')
  })
})
