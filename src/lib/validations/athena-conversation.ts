// Athena chat title rules. Shared because the same trim-and-truncate was written
// out three times — renameConversation, the auto-title in persistence.ts, and the
// console's optimistic rail update — and the client copy drifted: it stored the raw
// input, so a 100-character rename showed in full until a refresh revealed the
// 80-character value the server had actually saved (#650).
//
// Deliberately a plain module, not the 'use server' actions file: every export there
// becomes a callable server action, and this has to be importable from the client.

/** Longest stored chat title. Anything beyond this is truncated, not rejected. */
export const ATHENA_TITLE_MAX = 80

/**
 * The canonical title as it will be STORED. Callers rendering an optimistic update
 * must pass their input through this, or the UI shows something the database does
 * not hold.
 */
export function normalizeAthenaTitle(title: string): string {
  // Guarded because renameConversation has no Zod schema and no try/catch: a
  // non-string arriving from a client would otherwise throw out of the server action
  // instead of returning { error }, and this helper now has multiple call sites.
  if (typeof title !== 'string') return ''
  return title.trim().slice(0, ATHENA_TITLE_MAX)
}
