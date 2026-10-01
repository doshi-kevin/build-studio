// Student Athena moved off `ai_conversations`/`ai_messages` onto the shared
// Athena chat tables with a `surface` discriminator. What is worth a test here
// is the set of properties that fail SILENTLY — no error, no log, just a thread
// that misbehaves:
//
//   1. the surface filter, on both the read and the WRITE. Without it on the
//      read, a professor enrolled in a colleague's section finds their own
//      console threads listed in the student dock; without it on the insert the
//      column DEFAULTs to 'professor' and the student's own thread disappears.
//   2. the parts↔text mapping. The table stores `parts`; this surface renders
//      `content`. A mismatch shows as blank message bubbles on a reopened
//      thread, with nothing in any log.
//   3. the ownership filters these helpers carry in place of their own authz —
//      every caller reaches a thread by a client-supplied id.
//   4. the `title_locked` guard, which is the only thing standing between an
//      auto-title arriving late and a name the student chose.
import { describe, it, expect, vi } from 'vitest'
import {
  appendStudentMessage,
  createStudentConversation,
  deleteStudentConversation,
  findStudentConversation,
  listStudentConversations,
  listStudentMessages,
  recordUserTurn,
  setStudentConversationTitle,
} from '@/lib/ai/athena-core/persistence'

vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }))

type Row = Record<string, unknown>

/**
 * A query stub that records the filters applied and the payloads written, and
 * replays the seeded rows back. `filters` is flat, so one stub serves one call.
 */
function stubDb(rows: Row[], opts: { orderIndex?: number; rpcThrows?: boolean } = {}) {
  const filters: Record<string, unknown> = {}
  const writes: Row[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {
    select: () => chain,
    order: () => chain,
    limit: () => chain,
    delete: () => chain,
    insert: (payload: Row) => {
      writes.push(payload)
      return chain
    },
    update: (payload: Row) => {
      writes.push(payload)
      return chain
    },
    eq: (col: string, val: unknown) => {
      filters[col] = val
      return chain
    },
    single: async () => ({ data: rows[0] ?? null, error: null }),
    maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: rows, error: null }).then(resolve),
  }
  const rpcCalls: Array<{ name: string; params: Row }> = []
  return {
    filters,
    writes,
    rpcCalls,
    from: () => chain,
    rpc: async (name: string, params: Row) => {
      rpcCalls.push({ name, params })
      // A rejecting client, not `{ error }` — appendStudentMessage already
      // handles the error shape, so only a THROW reaches recordUserTurn's guard.
      if (opts.rpcThrows) throw new Error('connection reset')
      return { data: opts.orderIndex ?? 3, error: null }
    },
  }
}

describe('athena-core persistence', () => {
  it('lists only this student, this section, this surface', async () => {
    const db = stubDb([])
    await listStudentConversations(db, { sectionId: 'sec-1', userId: 'stu-1' })

    expect(db.filters).toMatchObject({
      user_id: 'stu-1',
      section_id: 'sec-1',
      surface: 'student',
      is_archived: false,
    })
  })

  it('reads a turn back out of parts, oldest first', async () => {
    const db = stubDb([
      { id: 'm2', conversation_id: 'c1', role: 'assistant', parts: [{ type: 'text', text: 'Because.' }], metadata: { run: [] }, created_at: 't2' },
      { id: 'm1', conversation_id: 'c1', role: 'user', parts: [{ type: 'text', text: 'Why?' }], metadata: null, created_at: 't1' },
    ])

    const { messages, hasMore } = await listStudentMessages(db, { conversationId: 'c1' })

    // The query reads newest-first; the transcript is rendered oldest-first.
    expect(messages.map((m) => m.content)).toEqual(['Why?', 'Because.'])
    // A row written with no metadata must not blow up messageAttachments/messageRun.
    expect(messages[0].metadata).toEqual({})
    expect(hasMore).toBe(false)
  })

  it('reports hasMore without leaking the extra row into the transcript', async () => {
    const rows = Array.from({ length: 4 }, (_, i) => ({
      id: `m${i}`, conversation_id: 'c1', role: 'user' as const,
      parts: [{ type: 'text', text: `turn ${i}` }], metadata: {}, created_at: `t${i}`,
    }))
    const db = stubDb(rows)

    const { messages, hasMore } = await listStudentMessages(db, { conversationId: 'c1', limit: 3 })

    expect(hasMore).toBe(true)
    expect(messages).toHaveLength(3)
  })

  it('appends through the RPC with the tenant from the caller, not the message', async () => {
    const db = stubDb([])
    const result = await appendStudentMessage(db, {
      conversationId: 'c1',
      institutionId: 'inst-1',
      sectionId: 'sec-1',
      userId: 'stu-1',
      role: 'assistant',
      content: 'The answer.',
      metadata: { run: [{ phase: 'done', id: 'materials', name: 'Course materials' }] },
    })

    expect(db.rpcCalls[0].name).toBe('athena_append_message')
    expect(db.rpcCalls[0].params).toMatchObject({
      p_conversation_id: 'c1',
      p_institution_id: 'inst-1',
      p_section_id: 'sec-1',
      p_user_id: 'stu-1',
      p_role: 'assistant',
      p_parts: [{ type: 'text', text: 'The answer.' }],
    })
    // The claimed order_index is what tells the route "this was the first turn,
    // name the thread" — a lost return value silently stops auto-titling.
    expect(result?.orderIndex).toBe(3)
  })

  it('stamps the surface and the tenant on a thread it creates', async () => {
    const db = stubDb([{ id: 'c1', section_id: 'sec-1', title: 'New Chat' }])
    await createStudentConversation(db, {
      institutionId: 'inst-1',
      sectionId: 'sec-1',
      userId: 'stu-1',
    })

    // `surface` DEFAULTs to 'professor' on the table, so dropping it here writes
    // a row that inserts cleanly, errors nowhere, and is then invisible forever
    // — listStudentConversations only ever asks for surface = 'student'.
    // institution_id comes from the section the enrollment check passed, and is
    // what scopes the row to a tenant.
    expect(db.writes[0]).toMatchObject({
      surface: 'student',
      institution_id: 'inst-1',
      section_id: 'sec-1',
      user_id: 'stu-1',
      title: 'New Chat',
    })
  })

  it('scopes a thread lookup to its owner, and to the section when one is given', async () => {
    const db = stubDb([{ id: 'c1' }])
    await findStudentConversation(db, {
      conversationId: 'c1',
      userId: 'stu-1',
      sectionId: 'sec-1',
    })

    // user_id is the IDOR guard for every caller of this helper — getMessages,
    // deleteConversation, generateConversationTitle and the chat route all reach
    // a thread by an id the client supplied. Without it, a forged id reads (and
    // deletes) another student's thread, and nothing anywhere errors.
    // section_id keeps a thread from the student's OTHER course off this
    // section's turn, since it is persisted on athena_artifacts.conversation_id.
    expect(db.filters).toMatchObject({
      id: 'c1',
      user_id: 'stu-1',
      surface: 'student',
      section_id: 'sec-1',
    })
  })

  it('omits the section filter entirely when the caller has no section', async () => {
    const db = stubDb([{ id: 'c1' }])
    const found = await findStudentConversation(db, { conversationId: 'c1', userId: 'stu-1' })

    // Filtering on an undefined sectionId would send `section_id=eq.undefined`,
    // which matches nothing — every reopened thread would report "Conversation
    // not found" while the ownership check still looked correct.
    expect('section_id' in db.filters).toBe(false)
    expect(found).not.toBeNull()
  })

  it('never clobbers a title the student set themselves', async () => {
    const db = stubDb([])
    const ok = await setStudentConversationTitle(db, {
      conversationId: 'c1',
      userId: 'stu-1',
      title: 'Why attention?',
    })

    expect(ok).toBe(true)
    expect(db.writes[0]).toEqual({ title: 'Why attention?' })
    // The guard is in the WHERE clause, not a prior read: a manual rename that
    // races an auto-title already in flight wins without a round trip.
    expect(db.filters).toMatchObject({ id: 'c1', title_locked: false })
  })

  it('deletes only a thread the caller owns', async () => {
    const db = stubDb([])
    await deleteStudentConversation(db, { conversationId: 'c1', userId: 'stu-1' })

    // Every caller has already run findStudentConversation, so this filter looks
    // redundant and reads like something a tidy-up would delete. It is the
    // backstop for the one caller that forgets: without it a single wrong id
    // cascades away every message in another student's thread, silently and
    // unrecoverably.
    expect(db.filters).toMatchObject({ id: 'c1', user_id: 'stu-1' })
  })
})

// recordUserTurn is the route's three-step user-turn write, moved down here so a
// second surface can't reassemble it wrong. The steps are only interesting
// together: append, re-sort, and name the thread IF this was its first message —
// where "first" is answered by the order_index the append RPC just claimed, not
// by a follow-up COUNT a concurrent second send could race.
describe('recordUserTurn', () => {
  const turn = {
    conversationId: 'c1',
    institutionId: 'inst-1',
    sectionId: 'sec-1',
    userId: 'stu-1',
  }

  it('names the thread from the first turn and re-sorts it', async () => {
    const db = stubDb([], { orderIndex: 1 })

    await recordUserTurn(db, { ...turn, content: '  Why does   attention work?  ' })

    expect(db.rpcCalls[0].params).toMatchObject({ p_role: 'user', p_parts: [{ type: 'text', text: '  Why does   attention work?  ' }] })
    // Both writes, in order: the bump that floats the thread to the top of the
    // picker, then the title. truncateTitle normalises the whitespace.
    expect(db.writes.map((w) => Object.keys(w)[0])).toEqual(['updated_at', 'title'])
    expect(db.writes[1]).toEqual({ title: 'Why does attention work?' })
  })

  it('leaves the title alone on every turn after the first', async () => {
    const db = stubDb([], { orderIndex: 4 })

    await recordUserTurn(db, { ...turn, content: 'And what about beam search?' })

    // Titling on any turn but the first renames a thread mid-conversation, one
    // question at a time — no error, no log, just a name that keeps changing.
    expect(db.writes.map((w) => Object.keys(w)[0])).toEqual(['updated_at'])
  })

  it('names a file-only first turn after the file', async () => {
    const db = stubDb([], { orderIndex: 1 })

    // A dropped PDF with no question is a real turn ("what's wrong with this?").
    await recordUserTurn(db, { ...turn, content: '', fallbackTitle: 'problem-set-3.pdf' })

    // Without the fallback, truncateTitle('') returns 'New Chat' and the thread
    // stays called that forever — nothing later ever re-titles it.
    expect(db.writes[1]).toEqual({ title: 'problem-set-3.pdf' })
  })

  it('swallows a failed write, because the answer still has to stream', async () => {
    const db = stubDb([], { rpcThrows: true })

    // This runs inside the response stream's prepare(): a throw here does not
    // lose a message, it errors the whole body and the student gets no answer to
    // a question that was asked perfectly well.
    await expect(recordUserTurn(db, { ...turn, content: 'Why?' })).resolves.toBeUndefined()
  })
})
