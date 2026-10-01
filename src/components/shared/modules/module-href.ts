/**
 * Builds the one-page Modules URL that a retired `/modules/[moduleId]` link
 * should land on, preserving whatever the original link carried.
 *
 * `redirect()` drops any query string not present in the target, and the
 * citation links built by lib/extraction/citation.ts carry `?item=` and
 * `?page=` — without forwarding them the reader lands on the board with
 * nothing scrolled to and no idea which material was cited.
 */
export function buildModulesHref(
  base: string,
  moduleId: string,
  searchParams: Record<string, string | string[] | undefined>,
): string {
  const forwarded = new URLSearchParams()
  for (const [key, value] of Object.entries(searchParams)) {
    if (typeof value === 'string') forwarded.set(key, value)
    else if (Array.isArray(value) && value[0] !== undefined) forwarded.set(key, value[0])
  }
  // Tells the board which section to open.
  forwarded.set('section', moduleId)
  return `${base}?${forwarded.toString()}`
}
