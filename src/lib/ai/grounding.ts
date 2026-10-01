/**
 * countGroundingQueries — how many billable Google Search grounding queries a
 * finished streamText turn executed. Google bills these per QUERY (not per
 * grounded prompt), separately from tokens — see google:search_grounding in
 * src/lib/costs/external-rates.ts.
 *
 * Two shapes exist and we have to read BOTH. Classic grounding reports the
 * queries in response-level providerMetadata.groundingMetadata; the
 * provider-executed server tool ('server:GOOGLE_SEARCH_WEB' — the shape a
 * search-and-build turn actually takes) reports NO groundingMetadata at all,
 * so reading only the metadata logs 0 for real billable searches. QA caught
 * this on the assignment route: 1-3 queries ran, the ledger said none.
 *
 * MAX, not sum: the two shapes are alternatives, so summing would double-count
 * a turn that somehow reported both. Max never under-reports a real search and
 * never invents one.
 */

interface GroundingToolCall {
  toolName: string
  input?: unknown
}

interface GroundingStep {
  toolCalls: ReadonlyArray<GroundingToolCall | null | undefined>
}

export function countGroundingQueries(
  providerMetadata: unknown,
  steps: ReadonlyArray<GroundingStep> | undefined,
): number {
  const google = (
    providerMetadata as
      | { google?: { groundingMetadata?: { webSearchQueries?: unknown } } }
      | undefined
  )?.google
  const webSearchQueries = google?.groundingMetadata?.webSearchQueries
  const metadataQueries = Array.isArray(webSearchQueries) ? webSearchQueries.length : 0

  let toolCallQueries = 0
  for (const step of steps ?? []) {
    for (const call of step.toolCalls) {
      if (!call) continue
      if (!/google.?search|google_search_web/i.test(call.toolName)) continue
      const queries = (call.input as { queries?: unknown } | null | undefined)?.queries
      // A call with no queries array still cost at least one search.
      toolCallQueries += Array.isArray(queries) ? queries.length : 1
    }
  }
  return Math.max(metadataQueries, toolCallQueries)
}
