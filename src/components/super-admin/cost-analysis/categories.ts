/**
 * Category → label / chart-token maps for the Cost Analysis pages. Kept in a
 * plain module (NO 'use client') because both the server-rendered pages (card
 * mini-bars) and the client chart components need them — a server component
 * cannot call functions exported from a 'use client' module.
 */

/** category key → chart token. Extend when a new provider category appears. */
const CATEGORY_CHART_VARS: Record<string, string> = {
  ai: 'var(--chart-1)',
  elevenlabs: 'var(--chart-2)',
  resend: 'var(--chart-3)',
  pinecone: 'var(--chart-4)',
  google: 'var(--chart-5)',
}
// The chart palette (chart-1..5) is now fully assigned. An unmapped category
// renders neutral ON PURPOSE — reusing a chart hue would impersonate a real
// category (and the fallback index differs per surface, so the same provider
// could render two colors on one page). Extend CATEGORY_CHART_VARS when a new
// provider appears.
const FALLBACK_VAR = 'var(--muted-foreground)'

export const CATEGORY_LABELS: Record<string, string> = {
  ai: 'AI / LLM',
  elevenlabs: 'ElevenLabs (audio)',
  resend: 'Email',
  pinecone: 'Pinecone (vector search)',
  // Search grounding rides the GCP invoice, but is metered as its own
  // category so grounded-search volume stays visible per institution.
  google: 'Google (search grounding)',
}

export function categoryColor(key: string): string {
  return CATEGORY_CHART_VARS[key] ?? FALLBACK_VAR
}
