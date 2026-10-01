// The run card can only show "Looking things up…" if the browser has a stream to
// read WHILE the lookups are running. It used not to: retrieval happened before
// the response opened, so every pre-model row arrived already finished and the
// card painted fully ticked — the running state existed in the component and was
// never once seen.
//
// This pins the ordering, which is the only thing that makes it real. The lookup
// is a promise this test controls, so "the first chunk is a run marker and the
// search has not resolved" is a fact about sequencing, not a timing race.
import { describe, it, expect, vi } from 'vitest'
const SECTION = 'sec-1'
const STUDENT = 'stu-1'
let resolveSearch: (v: unknown) => void = () => {}
const searchMaterialPages = vi.fn(() => new Promise((r) => { resolveSearch = r }))
/* AI kill switch: these tests exercise the AI-ENABLED path — mock the guard
   open so their stubbed DB clients don't trip its fail-closed refusal. The
   disabled/locked paths are covered in ai-kill-switch.test.ts. */
vi.mock('@/lib/ai/kill-switch', () => ({
  checkAiFeature: vi.fn(async () => ({ allowed: true })),
  checkAiFeatureBySection: vi.fn(async () => ({ allowed: true })),
}))

vi.mock('@/lib/pinecone/search', () => ({ searchMaterialPages }))
vi.mock('@/lib/ai/usage', () => ({ recordAiUsage: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }))
vi.mock('@ai-sdk/google', () => ({ google: () => 'm' }))
vi.mock('ai', async (o) => ({ ...(await o<typeof import('ai')>()), streamText: () => ({
  textStream: (async function* () { yield 'answer' })(),
}) }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: STUDENT } }, error: null }) } }),
}))
const TABLES: Record<string, Record<string, unknown>[]> = {
  enrollments: [{ id: 'e', section_id: SECTION, student_id: STUDENT, status: 'enrolled' }],
  course_sections: [{ id: SECTION, institution_id: 'i', section_code: 'A', settings: { enabledFeatures: ['athena'] }, course: { code: 'C', title: 'T' } }],
  quiz_attempts: [], ai_conversations: [], ai_messages: [], skill_mastery: [],
}
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({
  from: (t: string) => { const rows = [...(TABLES[t] ?? [])]
    const res = (l = false) => ({ data: l ? rows : (rows[0] ?? null), error: null })
    const c: Record<string, unknown> = {}
    Object.assign(c, { select: () => c, order: () => c, limit: () => c, insert: () => c, update: () => c,
      eq: () => c, in: () => c, lt: () => c, single: async () => res(), maybeSingle: async () => res(),
      then: (r: (v: unknown) => unknown) => Promise.resolve(res(true)).then(r) })
    return c },
  // The route reserves a daily-cap slot before it streams (merged from main);
  // the ordering under test assumes the student has budget.
  rpc: async () => ({ data: [{ accepted: true }], error: null }),
}) }))
const { POST } = await import('@/app/api/chat/route')

describe('/api/chat — the run card streams while it works', () => {
  it('emits the first row before retrieval resolves', async () => {
    const res = await POST(new Request('http://t/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sectionId: SECTION, messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] }),
    }) as never)
    expect(res.status).toBe(200)
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    // First chunk must arrive while searchMaterialPages is still pending.
    const first = await reader.read()
    const text = new TextDecoder().decode(first.value)
    expect(text).toContain('[[athena:run:')
    expect(searchMaterialPages).toHaveBeenCalled()
    resolveSearch([])
    await reader.cancel()
  })
})
