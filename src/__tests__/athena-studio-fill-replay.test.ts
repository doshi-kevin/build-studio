// The fill-tool REPLAY guard — the one defect in resumable Studio chats that
// destroys work rather than merely annoying.
//
// Why this can happen at all: the Studio fill tools (apply_edits, set_rubric,
// set_design_notes, …) have NO server-side `execute` — see
// src/lib/ai/assignment-assistant/tools.ts:4. The browser applies them and posts the
// result back with `addToolResult`. So the assistant message the route persists in
// `onFinish` is the SERVER's view, which never saw a result, and those parts land in
// the database as `input-available`.
//
// AssignmentAthenaPanel's auto-apply effect fires on exactly that state:
//     if (part.state !== 'input-available') continue
// So handing a saved transcript straight back would re-run every edit it contains
// over whatever is on the canvas NOW, silently overwriting the professor's work.
//
// Two further breakages share the same root cause, which is why the fix is settling
// the state rather than filtering the parts out:
//   - the chip renders "Applying…" forever (the panel's `fills` map is empty after a
//     remount, and only a TERMINAL state escapes that branch);
//   - a tool call carrying no result is invalid to the provider API, so the very next
//     turn in a resumed thread is rejected outright.
//
// NOTE: docs/designs/athena/studio-chat-history.md §4 claims this is "already
// solved". That is true only of the dock's in-memory Map, where the client had
// already applied the fill. It was never true of the database path.
import { describe, it, expect, vi } from 'vitest'
import { loadStudioConversation } from '@/lib/ai/assignment-assistant/persistence'

vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }))
vi.mock('@/lib/ai/athena-attachments-server', () => ({ signAthenaAttachments: vi.fn(async () => new Map()) }))

type Row = Record<string, unknown>

/** Same shape as assignment-assistant-persistence.test.ts's stub: one seeded row set
 *  answers both the conversation lookup and the messages query. */
function stubDb(rows: Row[]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {
    select: () => chain,
    order: () => chain,
    limit: () => chain,
    eq: () => chain,
    is: () => chain,
    maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve),
  }
  return { from: () => chain }
}

const load = (parts: unknown[]) =>
  loadStudioConversation(stubDb([{ id: 'conv-1', mode: 'standard', role: 'assistant', parts }]), {
    conversationId: 'conv-1',
    userId: 'prof-1',
    sectionId: 'sec-1',
    institutionId: 'inst-1',
  })

/** The panel's auto-apply predicate, quoted so the test fails if the guard ever
 *  stops holding for restored messages. */
const wouldAutoApply = (part: { type?: unknown; state?: unknown }) =>
  typeof part.type === 'string' && part.type.startsWith('tool-') && part.state === 'input-available'

describe('loadStudioConversation — restored fill parts cannot replay', () => {
  it('settles an input-available fill so the auto-apply effect skips it', async () => {
    const { messages } = await load([
      { type: 'tool-apply_edits', toolCallId: 'call-1', state: 'input-available', input: { ops: [] } },
    ])

    const part = (messages[0].parts as Array<Record<string, unknown>>)[0]
    expect(part.state).toBe('output-available')
    expect(part.output).toBeTruthy()
    // The real assertion: the panel's guard no longer matches.
    expect(wouldAutoApply(part)).toBe(false)
  })

  it('settles a fill left mid-stream (input-streaming), not only input-available', async () => {
    const { messages } = await load([
      { type: 'tool-set_rubric', toolCallId: 'call-2', state: 'input-streaming', input: {} },
    ])
    expect((messages[0].parts as Array<Record<string, unknown>>)[0].state).toBe('output-available')
  })

  it('leaves an already-settled fill exactly as stored, output and all', async () => {
    const stored = {
      type: 'tool-set_design_notes',
      toolCallId: 'call-3',
      state: 'output-available',
      output: { applied: true, summary: 'Design notes saved.' },
    }
    const { messages } = await load([stored])
    expect((messages[0].parts as Array<Record<string, unknown>>)[0]).toEqual(stored)
  })

  it('does not touch a server-executed tool, whose result is genuine', async () => {
    // get_class_struggles HAS an execute, so its stored state is already real.
    // Rewriting it would fabricate a result the model never received.
    const stored = { type: 'tool-get_class_struggles', toolCallId: 'call-4', state: 'input-available', input: {} }
    const { messages } = await load([stored])
    expect((messages[0].parts as Array<Record<string, unknown>>)[0]).toEqual(stored)
  })

  it('leaves no fill part in the whole thread that the panel would auto-apply', async () => {
    const { messages } = await load([
      { type: 'text', text: 'Here are the edits.' },
      { type: 'tool-apply_edits', toolCallId: 'a', state: 'input-available', input: {} },
      { type: 'tool-set_rubric', toolCallId: 'b', state: 'input-streaming', input: {} },
      { type: 'tool-fill_feedback', toolCallId: 'c', state: 'input-available', input: {} },
    ])

    const fills = (messages[0].parts as Array<Record<string, unknown>>).filter(
      (p) => typeof p.type === 'string' && (p.type as string).startsWith('tool-'),
    )
    expect(fills).toHaveLength(3)
    expect(fills.some(wouldAutoApply)).toBe(false)
  })
})
