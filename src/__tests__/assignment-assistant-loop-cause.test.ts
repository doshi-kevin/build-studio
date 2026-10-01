/**
 * The CAUSE of the #651 loop, not its ceiling.
 *
 * Browser QA measured 115+ context-tool calls on one turn in the in-builder dock, about one
 * a second, model-independent. My first fix was a per-turn ceiling — a bound, not a cause. It
 * would have capped the waste at 12 calls and left the mechanism intact.
 *
 * The mechanism, confirmed by reading the SDK rather than inferring it:
 * `lastAssistantMessageIsCompleteWithToolCalls` filters only `providerExecuted` parts
 * (`ai/dist/index.mjs:13883`), which means tools the model PROVIDER ran, such as Google
 * search. Tools with our own `execute()` are app-run, so `providerExecuted` is falsy and the
 * predicate counts them as "complete". Every time the server ended a turn on server-run
 * context reads — exactly what happens when it spends its 6-step budget gathering and never
 * acts — the client auto-continued. The step cap was not bounding the loop, it was pacing it.
 *
 * Two cause-level fixes, one per side:
 *   1. Client: continue only when a CLIENT-RESOLVED tool was actually resolved, which is the
 *      one thing that continuation was ever for.
 *   2. Server: withhold a memoised zero-argument context read once its result is already in
 *      the turn's history, so a repeat call is impossible rather than discouraged. The tool
 *      description already said "CALL IT AT MOST ONCE PER CONVERSATION TURN" in capitals and
 *      the model did it 115 times, which is the evidence that asking is not a control.
 *
 * This file tests the shared contract and the predicate logic. The route's own withholding
 * helper is exercised through the tool-name list it keys off.
 */

import { describe, it, expect } from 'vitest'
import {
  CLIENT_RESOLVED_TOOL_TYPES,
  IDEMPOTENT_CONTEXT_TOOL_NAMES,
} from '@/lib/ai/assignment-assistant/tool-names'

/** The dock's gate, in the same shape the component applies it. */
function wouldAutoContinue(parts: Array<{ type: string; state?: string }>): boolean {
  return parts.some(
    (p) =>
      (CLIENT_RESOLVED_TOOL_TYPES as readonly string[]).includes(p.type) &&
      p.state === 'output-available',
  )
}

describe('#651 cause: the dock continues only for a client-resolved tool', () => {
  it('does NOT continue after server-run context reads', () => {
    /* The exact turn shape that looped: two app-executed context tools, both complete, no
       fill. The SDK's own predicate says "complete" here, which is why this needed its own
       gate. */
    expect(
      wouldAutoContinue([
        { type: 'tool-get_class_struggles', state: 'output-available' },
        { type: 'tool-list_section_assignments', state: 'output-available' },
      ]),
    ).toBe(false)
  })

  it('DOES continue after a fill was resolved in the browser', () => {
    /* The case the continuation exists for: the browser applied the edit, and the model
       should acknowledge it. Breaking this would silently remove the acknowledgement. */
    expect(
      wouldAutoContinue([
        { type: 'tool-get_class_struggles', state: 'output-available' },
        { type: 'tool-apply_edits', state: 'output-available' },
      ]),
    ).toBe(true)
  })

  it('does not continue on a fill that has been CALLED but not yet resolved', () => {
    /* Mid-flight. Continuing here would race the browser's own resolution. */
    expect(wouldAutoContinue([{ type: 'tool-apply_edits', state: 'input-available' }])).toBe(false)
  })

  it('covers the grading surface fill too, not just authoring', () => {
    expect(wouldAutoContinue([{ type: 'tool-fill_feedback', state: 'output-available' }])).toBe(true)
  })
})

describe('#651 cause: the memoised context reads are named for withholding', () => {
  it('names both zero-argument reads that appeared in the loop', () => {
    /* These two are what QA watched alternate 115 times. If either name drifts from the tool
       factory the withholding silently stops applying, and nothing else would notice. */
    expect(IDEMPOTENT_CONTEXT_TOOL_NAMES).toContain('get_class_struggles')
    expect(IDEMPOTENT_CONTEXT_TOOL_NAMES).toContain('list_section_assignments')
  })

  it('lists tool NAMES, while the client list uses part TYPES', () => {
    /* Two different shapes for two different consumers: the server keys a ToolSet by name,
       the client matches message parts prefixed with `tool-`. Mixing them up would make both
       fixes no-ops that still look present. */
    for (const name of IDEMPOTENT_CONTEXT_TOOL_NAMES) {
      expect(name.startsWith('tool-')).toBe(false)
    }
    for (const type of CLIENT_RESOLVED_TOOL_TYPES) {
      expect(type.startsWith('tool-')).toBe(true)
    }
  })

  it('keeps the two lists disjoint', () => {
    /* A context read must never be treated as a reason to continue, and a fill must never be
       withheld. Overlap would reintroduce the loop from the other direction. */
    const clientNames = CLIENT_RESOLVED_TOOL_TYPES.map((t) => t.slice('tool-'.length))
    for (const name of IDEMPOTENT_CONTEXT_TOOL_NAMES) {
      expect(clientNames).not.toContain(name)
    }
  })
})
