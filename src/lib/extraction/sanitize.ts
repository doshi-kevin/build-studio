/**
 * Recursively strip NUL (U+0000) bytes from every string in a value. Postgres
 * rejects NULs in jsonb ("null character not permitted"), so a single NUL in
 * extracted PDF text makes the whole `content` UPDATE throw — which, unchecked,
 * left the item stuck at 'processing' forever. Pure and dependency-free so tests
 * (and any caller) can import it without pulling in the extraction worker.
 */
export function stripNul<T>(value: T): T {
  if (typeof value === 'string') {
    return (value.includes('\u0000') ? value.replace(/\u0000/g, '') : value) as T
  }
  if (Array.isArray(value)) return value.map((v) => stripNul(v)) as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = stripNul(v)
    return out as T
  }
  return value
}
