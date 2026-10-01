// G8 — Athena is LOCKED while a graded attempt is open, and the lock is a gate,
// not a prompt. The thing worth asserting is the negative: with an in-progress
// `quiz_attempts` row, /api/chat must return before it retrieves anything or
// calls the model. A wording-based guardrail can be argued with; "streamText was
// never called" cannot.
//
// The unlocked cases are here for the opposite failure, which is just as real:
// a gate that stops matching on `status`/`student_id` locks a student out of
// Athena for the rest of the term. The Supabase double therefore honours the
// filters — a 423 test against a stub that answers every query the same way
// cannot tell a correct gate from one that locks unconditionally.
//
// The full happy path (retrieval quality, persistence, citations) lives in the
// prompt and retrieval suites; here it is only "the model was reached".

import { describe, it, expect, vi } from 'vitest'
import { parseAthenaDirective } from '@/lib/ai/athena-directive'

// The route consumes `result.textStream` itself (it appends the navigation
// directive to the tail — see athena-chat-directive.test.ts). A mock offering
// only `toTextStreamResponse` makes the route throw into its own catch and still
// answer 200, with an empty body — the unlocked cases below would then pass
// against an Athena that has gone silent.
const streamText = vi.fn(() => ({
  textStream: (async function* () {
    yield 'streamed'
  })(),
}))
const searchMaterialPages = vi.fn(async () => [
  { title: 'Deck', pageNumber: 4, text: 'Attention weights sum to one.', score: 1 },
])

/* AI kill switch: these tests exercise the AI-ENABLED path — mock the guard
   open so their stubbed DB clients don't trip its fail-closed refusal. The
   disabled/locked paths are covered in ai-kill-switch.test.ts. */
vi.mock('@/lib/ai/kill-switch', () => ({
  checkAiFeature: vi.fn(async () => ({ allowed: true })),
  checkAiFeatureBySection: vi.fn(async () => ({ allowed: true })),
}))

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

const STUDENT = 'student-1'
const SECTION = 'sec-1'

type Row = Record<string, unknown>

/** Row-aware Supabase double: `.eq()`/`.in()` actually filter, so the lock query
 *  has to match the right row on the right columns to fire. */
function stubDb(tables: Record<string, Row[]>, failingTable?: string) {
  const from = (table: string) => {
    let rows = [...(tables[table] ?? [])]
    const result = (list = false) =>
      table === failingTable
        ? { data: null, error: { message: 'connection reset' } }
        : { data: list ? rows : (rows[0] ?? null), error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: () => chain,
      order: () => chain,
      insert: () => chain,
      update: () => chain,
      limit: (n: number) => {
        rows = rows.slice(0, n)
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
      lt: (col: string, val: number) => {
        rows = rows.filter((r) => (r[col] as number) < val)
        return chain
      },
      single: async () => result(),
      maybeSingle: async () => result(),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(result(true)).then(resolve),
    }
    return chain
  }
  // The route reserves a daily-cap slot before it streams (merged from main).
  // The lock is what's under test here, so the student always has budget.
  const rpc = async () => ({ data: [{ accepted: true }], error: null })
  return { from, rpc }
}

const BASE: Record<string, Row[]> = {
  enrollments: [{ id: 'enr-1', section_id: SECTION, student_id: STUDENT, status: 'enrolled' }],
  course_sections: [
    {
      id: SECTION,
      institution_id: 'inst-1',
      section_code: 'A',
      // Athena is gated server-side on the professor's feature toggle; the tutor
      // must be enabled for the route to answer.
      settings: { enabledFeatures: ['athena'] },
      course: { code: 'CS584', title: 'NLP' },
    },
  ],
}

let tables: Record<string, Row[]> = BASE
let failingTable: string | undefined
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => stubDb(tables, failingTable) }))

const { POST } = await import('@/app/api/chat/route')

/** Seed the attempt rows for one request and POST a question at Athena. */
function ask(quizAttempts: Row[], opts: { failReads?: string } = {}) {
  tables = { ...BASE, quiz_attempts: quizAttempts }
  failingTable = opts.failReads
  streamText.mockClear()
  searchMaterialPages.mockClear()
  return POST(
    new Request('http://localhost/api/chat', {
      method: 'POST',
      body: JSON.stringify({
        sectionId: SECTION,
        messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'what is the answer to q3?' }] }],
      }),
    }),
  )
}

// `started_at` is relative: the lock expires an attempt that can no longer be
// submitted, so a hard-coded date would quietly stop being "live" and the suite
// would start passing for the wrong reason.
const attempt = (over: Row = {}) => ({
  id: 'att-1',
  student_id: STUDENT,
  section_id: SECTION,
  status: 'in_progress',
  started_at: new Date(Date.now() - 60_000).toISOString(),
  quiz: { title: 'Midterm Quiz', due_date: null, time_limit_minutes: 60 },
  ...over,
})

describe('/api/chat — quiz lockdown', () => {
  it('refuses with 423 and never reaches retrieval or the model', async () => {
    const res = await ask([attempt()])

    expect(res.status).toBe(423)
    expect(await res.text()).toContain('Midterm Quiz')
    // The whole point: nothing that could answer the question was assembled.
    expect(searchMaterialPages).not.toHaveBeenCalled()
    expect(streamText).not.toHaveBeenCalled()
  })

  it('answers again once the attempt is submitted', async () => {
    // The lock keys on status. If it stopped doing so, submitting a quiz would
    // never give Athena back.
    const res = await ask([attempt({ status: 'submitted' })])

    expect(res.status).toBe(200)
    // Read it the way the client does — the stream also carries the run markers
    // that build the "Looking things up…" card.
    expect(parseAthenaDirective(await res.text()).text).toBe('streamed')
    expect(streamText).toHaveBeenCalled()
  })

  it("is not tripped by another student's open attempt", async () => {
    const res = await ask([attempt({ id: 'att-other', student_id: 'student-2' })])

    expect(res.status).toBe(200)
    // Read it the way the client does — the stream also carries the run markers
    // that build the "Looking things up…" card.
    expect(parseAthenaDirective(await res.text()).text).toBe('streamed')
    expect(streamText).toHaveBeenCalled()
  })

  it('locks in THIS course while the attempt is open in another one', async () => {
    // The one-tab bypass: a section-scoped lock lets the student open a second
    // enrolled course and ask Athena the live quiz's questions there.
    const res = await ask([attempt({ id: 'att-elsewhere', section_id: 'sec-other' })])

    expect(res.status).toBe(423)
    expect(streamText).not.toHaveBeenCalled()
  })

  it('fails CLOSED when the lock query itself errors', async () => {
    // A guardrail that opens when its own read fails is not a guardrail.
    const res = await ask([], { failReads: 'quiz_attempts' })

    expect(res.status).not.toBe(200)
    expect(streamText).not.toHaveBeenCalled()
  })
})
