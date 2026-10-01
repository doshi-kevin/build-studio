/**
 * #651 — the in-builder dock's runaway loop. Athena spends the server's whole 6-step
 * budget on get_class_struggles / list_section_assignments, never reaches apply_edits,
 * and the stream closes with no text: the professor gets a wall of tool chips, no
 * fields filled, no error, and no cap notice.
 *
 * The documented "Athena paused after several automatic steps" message could never
 * appear for this, because it is wired to the CLIENT's auto-send chain — a different
 * cap. And counting chips would not have caught it either: one server step can emit
 * many tool calls in parallel, so ~100 chips fit inside 6 steps.
 *
 * This exercises the panel's ACTUAL predicate (extracted to lib/ai/assignment-assistant/
 * turn-state.ts for exactly that reason — a re-implementation inside the test would
 * pass whatever the component really does). The dangerous direction is the FALSE POSITIVE: a turn
 * that silently filled fields via apply_edits is a success, and calling it a stall would
 * tell a professor their work didn't happen when it did. Both directions are asserted.
 *
 * The loop's root cause (tool definitions / system prompt) is NOT addressed here and is
 * not claimed fixed — this is the safety net that makes it visible.
 */

import { describe, it, expect } from 'vitest'

import { isStalledWithoutReply, type TurnMessage } from '@/lib/ai/athena-core/turn-state'

type Part = { type: string; text?: string; output?: unknown }

/** The REAL predicate the panel renders from — not a copy of it. */
const stalled = (messages: Array<{ role: string; parts: Part[] }>) =>
  isStalledWithoutReply(messages as TurnMessage[])

const toolCall = (name: string, output?: unknown): Part => ({ type: `tool-${name}`, output })

describe('#651 — detecting a turn that gathered context and returned nothing', () => {
  it('flags the runaway loop: many context tools, no text, nothing applied', () => {
    const parts = [
      ...Array.from({ length: 40 }, () => toolCall('get_class_struggles', { items: [] })),
      ...Array.from({ length: 40 }, () => toolCall('list_section_assignments', { items: [] })),
    ]
    expect(stalled([{ role: 'assistant', parts }])).toBe(true)
  })

  it('does NOT flag a silent turn that actually filled fields', () => {
    // The false positive that matters: apply_edits succeeded and produced no prose.
    // Calling this a stall tells the professor their change didn't happen when it did.
    const parts = [toolCall('get_class_struggles', { items: [] }), toolCall('apply_edits', { applied: true })]
    expect(stalled([{ role: 'assistant', parts }])).toBe(false)
  })

  it('does NOT flag a turn that answered in prose', () => {
    const parts = [toolCall('list_section_assignments', { items: [] }), { type: 'text', text: 'You have 3 assignments due.' }]
    expect(stalled([{ role: 'assistant', parts }])).toBe(false)
  })

  it('treats whitespace-only text as no reply', () => {
    const parts = [toolCall('get_class_struggles', {}), { type: 'text', text: '   \n ' }]
    expect(stalled([{ role: 'assistant', parts }])).toBe(true)
  })

  it('ignores turns that called no tools at all', () => {
    // A plain empty assistant message is a different failure; this notice would misdescribe it.
    expect(stalled([{ role: 'assistant', parts: [] }])).toBe(false)
  })

  it('ignores a trailing user message', () => {
    expect(stalled([{ role: 'assistant', parts: [toolCall('x')] }, { role: 'user', parts: [] }])).toBe(false)
  })

  it('flags a refused apply (applied === false) — the professor still got nothing', () => {
    const parts = [toolCall('apply_edits', { applied: false })]
    expect(stalled([{ role: 'assistant', parts }])).toBe(true)
  })
})

/**
 * The false-positive direction, which this predicate's own docstring calls the dangerous one.
 *
 * Browser QA caught the professor console rendering "Athena looked things up but didn't get
 * to an answer" DIRECTLY BENEATH a finished announcement draft, inviting the professor to
 * spend another billed turn redoing work already on screen. A draft tool renders an artifact
 * card with no trailing text part and no `applied`, which matched the stall shape exactly.
 *
 * "Did this turn produce something?" is surface knowledge: on the console a draft IS the
 * reply, while on the in-builder dock a context read is exactly the thing being detected. So
 * the surface declares which tool types count.
 */
describe('#651 — a declared producing tool counts as a reply', () => {
  const draftTurn: TurnMessage[] = [
    {
      role: 'assistant',
      parts: [
        { type: 'tool-ask_course_insights', output: { rows: 3 } },
        { type: 'tool-draft_announcement', output: { title: 'Homework due Friday', body: '…' } },
      ],
    },
  ]

  it('is a stall when the surface declares nothing (the in-builder dock)', () => {
    /* Unchanged behaviour for the dock: tools ran, nothing applied, no text. */
    expect(isStalledWithoutReply(draftTurn)).toBe(true)
  })

  it('is NOT a stall once the surface declares the draft tool as a reply', () => {
    expect(
      isStalledWithoutReply(draftTurn, { replyToolTypes: ['tool-draft_announcement'] }),
    ).toBe(false)
  })

  it('still reports a stall when only NON-producing tools ran', () => {
    /* The console must keep detecting a genuine dead end: declaring draft tools must not
       blanket-suppress the notice. */
    const contextOnly: TurnMessage[] = [
      { role: 'assistant', parts: [{ type: 'tool-ask_course_insights', output: { rows: 3 } }] },
    ]
    expect(
      isStalledWithoutReply(contextOnly, { replyToolTypes: ['tool-draft_announcement'] }),
    ).toBe(true)
  })

  it('is NOT a stall while a draft awaits the professor, output still null', () => {
    /* The false positive browser QA caught. The draft tools have no `execute`, so a FINISHED
       draft sits at `input-available` with no output for as long as the professor takes to
       review it. The console renders its whole card from the input. The old predicate asked
       for an output and so printed "didn't get to an answer" underneath a complete
       announcement, inviting a second billed turn to redo visible work. */
    const awaitingReview: TurnMessage[] = [
      {
        role: 'assistant',
        parts: [
          { type: 'tool-ask_course_insights', output: { rows: 3 } },
          { type: 'tool-draft_announcement', state: 'input-available' },
        ],
      },
    ]
    expect(
      isStalledWithoutReply(awaitingReview, { replyToolTypes: ['tool-draft_announcement'] }),
    ).toBe(false)
  })

  it('IS a stall when a draft died mid-stream', () => {
    /* The console already hides the notice while a turn is streaming, so the ONLY way a part
       reaches this predicate at `input-streaming` is a stream that died mid-tool-call. The
       professor is left with a spinning "Working" pill, no draft, and a billed turn. The first
       version of this fix counted that as a reply and silenced the notice on exactly the case
       it exists for. */
    const aborted: TurnMessage[] = [
      {
        role: 'assistant',
        parts: [{ type: 'tool-draft_announcement', state: 'input-streaming' }],
      },
    ]
    expect(
      isStalledWithoutReply(aborted, { replyToolTypes: ['tool-draft_announcement'] }),
    ).toBe(true)
  })

  it('is NOT a stall once the draft tool has resolved', () => {
    const resolved: TurnMessage[] = [
      {
        role: 'assistant',
        parts: [{ type: 'tool-draft_announcement', state: 'output-available' }],
      },
    ]
    expect(
      isStalledWithoutReply(resolved, { replyToolTypes: ['tool-draft_announcement'] }),
    ).toBe(false)
  })

  it('IS a stall when the declared tool errored even if it carries an output', () => {
    /* An error part must never pass as an answer on the strength of an error payload. */
    const erroredWithPayload: TurnMessage[] = [
      {
        role: 'assistant',
        parts: [
          { type: 'tool-draft_announcement', state: 'output-error', output: { partial: true } },
        ],
      },
    ]
    expect(
      isStalledWithoutReply(erroredWithPayload, { replyToolTypes: ['tool-draft_announcement'] }),
    ).toBe(true)
  })

  it('IS a stall when the declared tool errored', () => {
    /* The other direction, and the one that keeps the notice worth having: an errored draft
       produced no answer, so suppressing the notice here would leave a dead transcript. */
    const errored: TurnMessage[] = [
      {
        role: 'assistant',
        parts: [{ type: 'tool-draft_announcement', state: 'output-error' }],
      },
    ]
    expect(
      isStalledWithoutReply(errored, { replyToolTypes: ['tool-draft_announcement'] }),
    ).toBe(true)
  })

  it('does not count a declared tool that returned nothing', () => {
    /* A card that never rendered is not an answer. */
    const empty: TurnMessage[] = [
      { role: 'assistant', parts: [{ type: 'tool-draft_announcement', output: null }] },
    ]
    expect(
      isStalledWithoutReply(empty, { replyToolTypes: ['tool-draft_announcement'] }),
    ).toBe(true)
  })
})
