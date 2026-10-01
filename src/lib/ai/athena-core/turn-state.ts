// Pure read of an Athena turn's outcome. Extracted from AssignmentAthenaPanel so the
// test exercises the SAME code the panel runs — a predicate re-implemented inside a
// test passes whatever the component actually does, which is no guard at all.
//
// Lives in athena-core because the failure is not specific to one surface. It started on
// the in-builder dock (#651), but the professor console and the student tutor run the same
// shape of loop against the same kind of step cap, and both could spend the whole budget
// on context tools and close the stream with nothing to show. Every surface that can end a
// turn empty needs to be able to say so.

/** Minimal structural shape of a UIMessage part; providers add fields we don't read. */
export interface TurnPart {
  type: string
  text?: unknown
  output?: unknown
  /** AI SDK tool-part lifecycle: input-streaming, input-available, output-available, output-error. */
  state?: unknown
}

export interface TurnMessage {
  role: string
  parts?: TurnPart[]
}

/**
 * True when the last assistant turn called tools, produced no text, and applied
 * nothing — the shape of the in-builder runaway loop (#651): the server's 6-step
 * budget is spent on context tools, `apply_edits` is never reached, and the stream
 * closes with nothing to render.
 *
 * Read from the transcript rather than a step count on purpose: one server step can
 * emit many tool calls in parallel, so ~100 chips fit inside 6 steps and counting
 * chips would not identify a stall.
 *
 * The FALSE POSITIVE is the dangerous direction — a turn that silently filled fields
 * via `apply_edits` is a success, and labelling it a stall would tell a professor
 * their change didn't happen when it did. Hence the explicit `applied === true` check.
 */
export interface StalledTurnOptions {
  /**
   * Tool part types whose OUTPUT is itself the reply, e.g. `tool-draft_announcement` on the
   * professor console, which renders an artifact card rather than trailing prose.
   *
   * Needed because "did this turn produce something?" is surface knowledge. Browser QA
   * caught the console showing "didn't get to an answer" directly BENEATH a complete
   * announcement draft, inviting another billed turn to redo work already on screen (#651).
   * A draft tool renders a card with no trailing text and no `applied`, which matched the
   * predicate exactly — the false-positive direction this file's own docstring calls the
   * dangerous one.
   *
   * The in-builder dock passes nothing: there, a fill is a reply only when it APPLIED, and
   * treating a context read as an answer is precisely the bug being detected.
   */
  replyToolTypes?: readonly string[]
}

export function isStalledWithoutReply(
  messages: TurnMessage[],
  options: StalledTurnOptions = {},
): boolean {
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'assistant') return false

  const parts = last.parts ?? []
  const calledTools = parts.some((p) => typeof p.type === 'string' && p.type.startsWith('tool-'))
  if (!calledTools) return false

  const hasText = parts.some(
    (p) => p.type === 'text' && typeof p.text === 'string' && p.text.trim().length > 0,
  )
  if (hasText) return false

  const applied = parts.some(
    (p) =>
      typeof p.type === 'string' &&
      p.type.startsWith('tool-') &&
      (p.output as { applied?: unknown } | null)?.applied === true,
  )
  if (applied) return false

  /* A surface-declared producing tool that RENDERED something IS the reply.
     Keyed on the part's state, not on its output, because the draft tools have no `execute`:
     a finished draft awaiting the professor's approval sits at `input-available` with output
     still null, and the console renders its full card from the input alone. Demanding an
     output printed "Athena didn't get to an answer" directly beneath a complete announcement
     draft, inviting a second billed turn to redo work already on screen (#651).

     Only the two SETTLED states count. `input-streaming` deliberately does not, and getting
     that wrong was a regression in the first version of this fix: the console already hides
     the notice while a turn is streaming (`!isLoading` at its render site), so the only case
     `input-streaming` reaches here is a stream that DIED mid-tool-call. That leaves a
     permanently spinning "Working" pill, no draft, and a billed turn, which is precisely what
     the notice exists to admit. Counting it as a reply bought nothing and lost that.

     `output-error` can never count, output or not, so a failed tool cannot pass as an answer
     on the strength of an error payload. */
  const produced = parts.some((p) => {
    if (typeof p.type !== 'string') return false
    if (!(options.replyToolTypes ?? []).includes(p.type)) return false
    const state = typeof p.state === 'string' ? p.state : null
    if (state === 'output-error') return false
    return state === 'input-available' || state === 'output-available' || p.output != null
  })
  return !produced
}
