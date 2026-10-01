/**
 * Maps a Supabase auth error onto something a reader can act on.
 *
 * Supabase surfaces a transport failure as AuthRetryableFetchError carrying the
 * browser's own text — literally "Failed to fetch" — and the auth pages used to
 * put that straight into their error panel (#727). It reaches users two ways: an
 * identifier the WAF blocks (the response comes back with no CORS header, so the
 * fetch throws) and a genuinely offline network. Neither is actionable as
 * written, and `.claude/rules/ui-design.md` says raw exception text must never
 * render.
 *
 * Matched on the error NAME first and the message only as a fallback: the name is
 * stable across supabase-js versions, while the browser's wording is not
 * ("Failed to fetch" in Chrome, "Load failed" in Safari).
 *
 * Every other auth error keeps its own message — those are already written for
 * people ("Invalid login credentials"), and rewriting them here would just hide
 * detail the reader needs.
 */
export function authErrorMessage(error: { name?: string; message: string }): string {
  const transportFailure =
    error.name === 'AuthRetryableFetchError' ||
    /failed to fetch|load failed|networkerror|network request failed/i.test(error.message)
  return transportFailure
    ? "Couldn't reach the server — check your connection and try again."
    : error.message
}
