/**
 * Tool-name constants shared by the server tool factory and the client dock.
 *
 * Its own module, with NO imports, deliberately. These names have to be known on both
 * sides, and `tools.ts` reaches for `supabase/queries` and the context loaders, so importing
 * that from a `'use client'` tree would pull server code into the browser bundle.
 */

/**
 * The tools with NO `execute`: the browser resolves these, not the server.
 *
 * The client needs to recognise them precisely, because the AI SDK cannot. Its
 * `lastAssistantMessageIsCompleteWithToolCalls` filters only `providerExecuted` parts
 * (`ai/dist/index.mjs:13883`), which means tools the model PROVIDER ran, such as Google
 * search. Our `execute()` tools are app-run, so that predicate reports them as "complete"
 * too, and the dock's auto-continue then continued turns that needed no continuation. That
 * is the #651 loop. One list, shared, so the two sides cannot disagree about which is which.
 */
export const CLIENT_RESOLVED_TOOL_TYPES = ['tool-apply_edits', 'tool-fill_feedback'] as const

/**
 * Zero-argument context reads whose result is memoised per request.
 *
 * A repeat call returns byte-identical data, so it can only ever waste a step. The server
 * withholds these once their result is already in the history, which is a stronger guarantee
 * than asking the model not to: the tool description already says "CALL IT AT MOST ONCE PER
 * CONVERSATION TURN" in capitals and the model did it 115 times anyway.
 */
export const IDEMPOTENT_CONTEXT_TOOL_NAMES = ['get_class_struggles', 'list_section_assignments'] as const
