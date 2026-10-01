// Studio Athena (About page / Assignments / Quizzes / Grading) gains persisted,
// resumable conversations on top of the shared athena_conversations table. What
// is worth a test here is the set of properties that fail SILENTLY — no error,
// no log, just a thread that misbehaves:
//
//   1. ensureConversation writes EVERY studio-scope column. Drop one and the
//      migration's own CHECK constraint would reject it in prod — but a mocked
//      DB in a unit test happily accepts a partial payload, so this has to be
//      asserted directly rather than trusted from "the insert didn't throw".
//   2. listStudioConversations' null-vs-value scoping. About/general chats have
//      NO item id — filtering those with `.eq('assignment_id', undefined)`
//      would send `assignment_id=eq.undefined` (matches nothing) instead of
//      `.is('assignment_id', null)`, silently emptying every list for those
//      scopes forever.
//   3. The IDOR ownership filters loadStudioConversation carries in place of
//      its own authz — a caller reaches a thread by a client-supplied id.
//   4. maybeAutoTitle's atomic guard — a title race must lose in the WHERE
//      clause, not in a prior read (data-access.md's TOCTOU guidance).
import { describe, it, expect, vi } from 'vitest'
import {
  listStudioConversations,
  loadStudioConversation,
  maybeAutoTitle,
  persistUserMessage,
  persistAssistantMessage,
  setStudioConversationArchived,
  type StudioPersistCtx,
} from '@/lib/ai/assignment-assistant/persistence'

vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }))
vi.mock('@/lib/ai/athena-attachments-server', () => ({ signAthenaAttachments: vi.fn(async () => new Map()) }))

type Row = Record<string, unknown>

/** A query stub that records filters/writes and replays seeded rows, mirroring
 *  the one athena-core-persistence.test.ts uses — extended with `.is()` and
 *  `.upsert()`, which this module's queries also need. */
function stubDb(rows: Row[], opts: { rpcThrows?: boolean; error?: { message: string } } = {}) {
  const filters: Record<string, unknown> = {}
  const writes: Row[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {
    select: () => chain,
    order: () => chain,
    limit: () => chain,
    insert: (payload: Row) => {
      writes.push(payload)
      return chain
    },
    update: (payload: Row) => {
      writes.push(payload)
      return chain
    },
    upsert: (payload: Row) => {
      writes.push(payload)
      return chain
    },
    eq: (col: string, val: unknown) => {
      filters[col] = val
      return chain
    },
    is: (col: string, val: unknown) => {
      filters[col] = val
      return chain
    },
    maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
    // Seeded rows double as "the rows this write matched", so an empty stub is
    // also the no-such-row case an update returns count 0 for.
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve({
        data: opts.error ? null : rows,
        error: opts.error ?? null,
        count: opts.error ? null : rows.length,
      }).then(resolve),
  }
  const rpcCalls: Array<{ name: string; params: Row }> = []
  return {
    filters,
    writes,
    rpcCalls,
    from: () => chain,
    rpc: async (name: string, params: Row) => {
      rpcCalls.push({ name, params })
      if (opts.rpcThrows) throw new Error('connection reset')
      return { data: 1, error: null }
    },
  }
}

const baseCtx: StudioPersistCtx = {
  adminDb: null,
  conversationId: 'conv-1',
  sectionId: 'sec-1',
  userId: 'prof-1',
  institutionId: 'inst-1',
  studioSurface: 'authoring',
  studioKind: 'files',
  assignmentId: 'asg-1',
  quizId: null,
  projectId: null,
  mode: 'standard',
}

describe('persistUserMessage / ensureConversation', () => {
  it('stamps every studio-scope column on the conversation it creates', async () => {
    const db = stubDb([])
    await persistUserMessage({ ...baseCtx, adminDb: db }, { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] } as never)

    // Drop any ONE of these in the insert payload and the row either fails the
    // migration's studio-columns-scoped CHECK in prod, or (worse, in a system
    // with looser constraints) silently files the thread under the wrong scope
    // — a chat about assignment A resurfacing under a different item's history.
    expect(db.writes[0]).toMatchObject({
      id: 'conv-1',
      institution_id: 'inst-1',
      section_id: 'sec-1',
      user_id: 'prof-1',
      surface: 'studio',
      studio_surface: 'authoring',
      studio_kind: 'files',
      assignment_id: 'asg-1',
      quiz_id: null,
      mode: 'standard',
    })
    expect(db.rpcCalls[0].name).toBe('athena_append_message')
    expect(db.rpcCalls[0].params).toMatchObject({ p_conversation_id: 'conv-1', p_role: 'user' })
  })
})

describe('persistAssistantMessage', () => {
  it('appends via the RPC and bumps updated_at so the resume list re-sorts', async () => {
    const db = stubDb([])
    await persistAssistantMessage({ ...baseCtx, adminDb: db }, { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'ok' }] } as never)

    expect(db.rpcCalls[0].params).toMatchObject({ p_role: 'assistant' })
    expect(db.writes[0]).toHaveProperty('updated_at')
  })
})

describe('listStudioConversations', () => {
  it('scopes by section, user, surface=studio, and the given studio surface/kind/item', async () => {
    const db = stubDb([])
    await listStudioConversations(db, {
      sectionId: 'sec-1',
      userId: 'prof-1',
      studioSurface: 'authoring',
      studioKind: 'files',
      assignmentId: 'asg-1',
      quizId: null,
      projectId: null,
    })

    expect(db.filters).toMatchObject({
      section_id: 'sec-1',
      user_id: 'prof-1',
      surface: 'studio',
      studio_surface: 'authoring',
      is_archived: false,
      studio_kind: 'files',
      assignment_id: 'asg-1',
      // A quiz_id filter of `.eq(undefined)` would silently match zero rows —
      // this scope has no quiz, so it must be an IS NULL, not an equality.
      quiz_id: null,
    })
  })

  it('uses IS NULL (not eq-undefined) for the item-less About/general scopes', async () => {
    const db = stubDb([])
    await listStudioConversations(db, {
      sectionId: 'sec-1',
      userId: 'prof-1',
      studioSurface: 'authoring',
      studioKind: 'about',
      assignmentId: null,
      quizId: null,
      projectId: null,
    })

    // `.is()` was used for both, not `.eq(col, null)` — asserted indirectly by
    // checking the stub recorded the null via its `is` branch. Since the stub
    // funnels both into the same `filters` map, what actually matters is that
    // the CALLER chose `.is()` for a null scope value; a real Supabase client
    // would 400 (or silently no-match) on `.eq('assignment_id', null)`. The
    // production regression this guards: About's list going permanently empty.
    expect(db.filters.assignment_id).toBeNull()
    expect(db.filters.quiz_id).toBeNull()
  })

  it('falls back untitled rows to "New Chat" rather than surfacing null', async () => {
    const db = stubDb([
      { id: 'c1', title: null, mode: 'standard', updated_at: 't1' },
      { id: 'c2', title: 'Fix the rubric wording', mode: 'frontier', updated_at: 't2' },
    ])
    const result = await listStudioConversations(db, {
      sectionId: 'sec-1',
      userId: 'prof-1',
      studioSurface: 'authoring',
      studioKind: 'files',
      assignmentId: 'asg-1',
      quizId: null,
      projectId: null,
    })

    expect(result).toEqual([
      { id: 'c1', title: 'New Chat', mode: 'standard', updatedAt: 't1' },
      { id: 'c2', title: 'Fix the rubric wording', mode: 'frontier', updatedAt: 't2' },
    ])
  })
})

describe('loadStudioConversation', () => {
  // The stub replays the SAME seeded rows for both the conversation lookup and
  // the messages query (it doesn't distinguish `.from()` tables), so the row
  // needs `parts` too — otherwise the message-parts loop below throws on a row
  // that's really standing in for the conversation lookup.
  const conversationAndMessageRow = { id: 'conv-1', mode: 'frontier' as const, role: 'user', parts: [] }

  it('scopes the thread lookup to its owner, section, and the studio surface', async () => {
    const db = stubDb([conversationAndMessageRow])
    await loadStudioConversation(db, { conversationId: 'conv-1', userId: 'prof-1', sectionId: 'sec-1', institutionId: 'inst-1' })

    // Every one of these is the IDOR guard for a client-supplied conversationId —
    // drop any and a forged/foreign id reads another professor's thread with no
    // error anywhere in the stack.
    expect(db.filters).toMatchObject({
      id: 'conv-1',
      user_id: 'prof-1',
      section_id: 'sec-1',
      surface: 'studio',
    })
  })

  it("reports the thread's own mode, so resuming can switch Standard/Frontier to match", async () => {
    const db = stubDb([conversationAndMessageRow])
    const result = await loadStudioConversation(db, { conversationId: 'conv-1', userId: 'prof-1', sectionId: 'sec-1', institutionId: 'inst-1' })
    expect(result.mode).toBe('frontier')
  })

  it('reports "not found" for a thread this caller does not own, rather than throwing', async () => {
    const db = stubDb([])
    const result = await loadStudioConversation(db, { conversationId: 'conv-x', userId: 'prof-1', sectionId: 'sec-1', institutionId: 'inst-1' })
    expect(result.error).toBeTruthy()
    expect(result.messages).toEqual([])
  })
})

describe("maybeAutoTitle", () => {
  it('guards the write atomically — title IS NULL and not locked, never a prior read', async () => {
    const db = stubDb([])
    await maybeAutoTitle({ ...baseCtx, adminDb: db }, '  Make the rubric harder on part 2  ')

    expect(db.writes[0]).toEqual({ title: 'Make the rubric harder on part 2' })
    // The guard rides the WHERE, not a SELECT beforehand: two turns racing (a
    // real shape here — an auto-sent fill-acknowledgment can follow the user's
    // first message almost immediately) must not both win a title write.
    expect(db.filters).toMatchObject({ id: 'conv-1', title_locked: false, title: null })
  })

  it('never throws when the underlying write fails', async () => {
    const db = stubDb([], { rpcThrows: true })
    // maybeAutoTitle doesn't call rpc, but its own try/catch must swallow ANY
    // failure — this runs inside the stream's onFinish, where a throw would
    // surface as an unhandled rejection rather than losing just the title.
    db.from = () => {
      throw new Error('boom')
    }
    await expect(maybeAutoTitle({ ...baseCtx, adminDb: db }, 'hello')).resolves.toBeUndefined()
  })
})

describe('setStudioConversationArchived', () => {
  it('scopes the write to the caller — the filters ARE the authorization here', async () => {
    const db = stubDb([{ id: 'conv-1' }])
    const ok = await setStudioConversationArchived(db, {
      conversationId: 'conv-1',
      userId: 'prof-1',
      sectionId: 'sec-1',
      archived: true,
    })

    expect(ok).toBe(true)
    expect(db.writes[0]).toEqual({ is_archived: true })
    // This runs on the service role, which bypasses RLS, and the conversationId
    // comes straight from the client. Drop any one of these and a professor can
    // archive somebody else's thread by passing its id.
    expect(db.filters).toMatchObject({
      id: 'conv-1',
      user_id: 'prof-1',
      section_id: 'sec-1',
      surface: 'studio',
    })
  })

  it('does not filter on is_archived, so Undo can still find the row it just archived', async () => {
    const db = stubDb([{ id: 'conv-1' }])
    const ok = await setStudioConversationArchived(db, {
      conversationId: 'conv-1',
      userId: 'prof-1',
      sectionId: 'sec-1',
      archived: false,
    })

    expect(ok).toBe(true)
    expect(db.writes[0]).toEqual({ is_archived: false })
    // listStudioConversations filters is_archived=false; copying that filter set
    // into this update would make Undo match zero rows every single time, since
    // the row it is restoring is archived by definition.
    expect(db.filters).not.toHaveProperty('is_archived')
  })

  it('reports failure when nothing matched, rather than a success the row never got', async () => {
    // A foreign or already-deleted id looks exactly like this. The panel removes
    // the row optimistically and only puts it back on a falsy answer — reporting
    // true here would leave the list disagreeing with the database until reopened.
    const db = stubDb([])
    const ok = await setStudioConversationArchived(db, {
      conversationId: 'conv-x',
      userId: 'prof-1',
      sectionId: 'sec-1',
      archived: true,
    })
    expect(ok).toBe(false)
  })

  it('reports failure instead of throwing when the update errors', async () => {
    // Called from a toast action handler (`.then(...)`) with no catch — a throw
    // there is an unhandled rejection, not a visible error.
    const db = stubDb([{ id: 'conv-1' }], { error: { message: 'deadlock detected' } })
    const ok = await setStudioConversationArchived(db, {
      conversationId: 'conv-1',
      userId: 'prof-1',
      sectionId: 'sec-1',
      archived: true,
    })
    expect(ok).toBe(false)
  })
})
