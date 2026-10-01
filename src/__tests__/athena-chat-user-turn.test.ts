// @vitest-environment node
//
// Which request writes the student's question down.
//
// The route used to decide this by reading `messages[length-1]` at the point of
// the write and pulling the text off THAT message: a request whose last message
// was the assistant's produced no text, so it wrote nothing, by accident. The
// refactor derives the retrieval query from the last USER message anywhere in the
// array (correct — that is what should be retrieved for), which quietly removed
// the accident. `isNewUserTurn` is what replaced it, and it is the only thing
// standing between a replayed turn and a duplicate row in the transcript.
//
// A duplicate here is silent and permanent: no error, no log, just the same
// question twice in a reopened thread — and, since the transcript is fed back to
// the model, in every later turn's context too.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockStreamText = vi.fn()
const mockGetUser = vi.fn()
const mockFrom = vi.fn()
const mockRpc = vi.fn()

vi.mock(import('ai'), async (importOriginal) => ({
  ...(await importOriginal()),
  streamText: ((...args: unknown[]) => mockStreamText(...args)) as never,
  convertToModelMessages: (async (m: unknown) => m) as never,
}))
vi.mock('@ai-sdk/google', () => ({ google: (model: string) => ({ model }) }))
vi.mock('@/lib/pinecone/search', () => ({ searchMaterialPages: vi.fn(async () => []) }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: mockGetUser } }),
}))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ from: mockFrom, rpc: mockRpc }),
}))
vi.mock('@/lib/ai/usage', () => ({ recordAiUsage: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

function chain(result: { data: unknown; error: unknown }) {
  const c: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'or', 'lt', 'lte', 'gt', 'gte', 'not', 'is', 'order', 'limit', 'update', 'insert']) {
    c[m] = vi.fn().mockReturnValue(c)
  }
  c.single = vi.fn().mockResolvedValue(result)
  c.maybeSingle = vi.fn().mockResolvedValue(result)
  c.then = (res: (v: unknown) => void) => Promise.resolve(result).then(res)
  return c
}

const SECTION = {
  id: 'sec-1',
  section_code: '01',
  institution_id: 'inst-1',
  settings: { enabledFeatures: ['athena'] },
  course: { code: 'CS-620', title: 'Advanced Machine Learning' },
}

let POST: (req: Request) => Promise<Response>

/** Every user turn this request wrote to the thread. */
const userAppends = () =>
  mockRpc.mock.calls.filter(([name, params]) => name === 'athena_append_message' && params?.p_role === 'user')

beforeEach(async () => {
  vi.resetModules()
  // No mock implementation below throws, so resetting here is safe (see the
  // vitest-4 caveat in CLAUDE.md).
  mockStreamText.mockReset()
  mockGetUser.mockReset()
  mockFrom.mockReset()
  mockRpc.mockReset()

  mockGetUser.mockResolvedValue({ data: { user: { id: 'student-1' } }, error: null })
  mockStreamText.mockImplementation(() => ({
    textStream: (async function* () {
      yield 'Attention weights sum to one.'
    })(),
  }))
  mockRpc.mockImplementation(async (name: string) => {
    // The daily-cap reserve; the append RPC returns the order_index it claimed.
    if (name === 'athena_increment_rate_limit') return { data: [{ accepted: true }], error: null }
    return { data: 2, error: null }
  })
  mockFrom.mockImplementation((table: string) =>
    chain(
      {
        enrollments: { data: { id: 'enr-1' }, error: null },
        course_sections: { data: SECTION, error: null },
        modules: { data: [], error: null },
        // The thread the client says it is writing into, owned by this student.
        athena_conversations: { data: { id: 'conv-1', section_id: 'sec-1' }, error: null },
      }[table] ?? { data: [], error: null },
    ),
  )

  const mod = await import('@/app/api/chat/route')
  POST = mod.POST
})

function request(messages: unknown[], body: Record<string, unknown> = {}): Request {
  return new Request('http://localhost/api/chat', {
    method: 'POST',
    body: JSON.stringify({ sectionId: 'sec-1', conversationId: 'conv-1', messages, ...body }),
  })
}

const user = (text: string) => ({ role: 'user', parts: [{ type: 'text', text }] })
const assistant = (text: string) => ({ role: 'assistant', parts: [{ type: 'text', text }] })

describe('POST /api/chat — the student turn is written once', () => {
  it('writes the question the student just sent', async () => {
    const res = await POST(request([user('what is a gradient?')]))
    await res.text() // the write happens inside the stream — drain it

    expect(userAppends()).toHaveLength(1)
    expect(userAppends()[0][1]).toMatchObject({
      p_conversation_id: 'conv-1',
      p_institution_id: 'inst-1',
      p_section_id: 'sec-1',
      p_user_id: 'student-1',
      p_parts: [{ type: 'text', text: 'what is a gradient?' }],
    })
  })

  it('writes nothing when the last message is the assistant\'s — that turn is already recorded', async () => {
    // A regenerate/replay: the client posts the answered exchange back. The
    // question text is still in the array and is still what retrieval runs on,
    // so nothing else in the route stops this from being written a second time.
    const res = await POST(request([user('what is a gradient?'), assistant('A gradient is…')]))
    const body = await res.text()

    expect(userAppends()).toHaveLength(0)
    // And it is a REFUSAL to duplicate, not a refusal to answer.
    expect(res.status).toBe(200)
    expect(body).toContain('Attention weights sum to one.')
    expect(mockStreamText).toHaveBeenCalledTimes(1)
  })

  it('answers an unpersisted chat without writing anything', async () => {
    const res = await POST(request([user('what is a gradient?')], { conversationId: undefined }))
    await res.text()

    // No thread open — a write here has no conversation to belong to.
    expect(mockRpc.mock.calls.some(([name]) => name === 'athena_append_message')).toBe(false)
    expect(mockStreamText).toHaveBeenCalledTimes(1)
  })

  it('writes nothing for a turn carrying neither text nor an attachment', async () => {
    // An empty row would show as a blank bubble on reopen, and as the first turn
    // it would name the thread 'New Chat' with nothing later to re-title it.
    const res = await POST(request([{ role: 'user', parts: [] }]))
    await res.text()

    expect(userAppends()).toHaveLength(0)
  })
})
