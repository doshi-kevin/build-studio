// Pure name-resolution for the get_student_performance tool. Kept out of the
// server-only context module so it can be unit-tested directly. Resolves a
// free-text name (as a professor typed it) to ONE enrolled student, or reports
// ambiguous / not-found — the input is model-supplied, so this is the guard
// against surfacing the wrong student's data.

export interface RosterMember {
  id: string
  name: string
}

export type ResolveResult =
  | { kind: 'found'; id: string; name: string }
  | { kind: 'ambiguous'; matches: string[] }
  | { kind: 'not_found'; suggestions: string[] }

/** Normalize a name for matching: lowercase, strip diacritics, collapse spaces. */
export function normName(s: string): string {
  return (s || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/** Tiny Levenshtein for ranking not-found suggestions (small classes, bounded). */
export function editDistance(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (!m) return n
  if (!n) return m
  let prev = Array.from({ length: n + 1 }, (_, i) => i)
  for (let i = 1; i <= m; i++) {
    const curr = [i]
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
    }
    prev = curr
  }
  return prev[n]
}

/**
 * Resolve a free-text name to ONE enrolled student.
 * Cascade: exact → token-prefix (word-boundary, avoids the "Li"→"Olivia" trap) →
 * else not-found with the closest few names. Multiple token-prefix hits → ambiguous.
 */
export function resolveStudent(query: string, roster: RosterMember[]): ResolveResult {
  const q = normName(query)
  const qTokens = q.split(' ').filter(Boolean)

  const exact = roster.filter((r) => normName(r.name) === q)
  if (exact.length === 1) return { kind: 'found', id: exact[0].id, name: exact[0].name }
  if (exact.length > 1) return { kind: 'ambiguous', matches: exact.map((r) => r.name) }

  // Token-prefix: every query token must prefix some name token (word boundary).
  const prefix =
    qTokens.length === 0
      ? []
      : roster.filter((r) => {
          const nameTokens = normName(r.name).split(' ').filter(Boolean)
          return qTokens.every((qt) => nameTokens.some((nt) => nt.startsWith(qt)))
        })
  if (prefix.length === 1) return { kind: 'found', id: prefix[0].id, name: prefix[0].name }
  if (prefix.length > 1) return { kind: 'ambiguous', matches: prefix.map((r) => r.name) }

  // No match → up to 5 closest names by edit distance to the closest name token.
  const suggestions = roster
    .map((r) => ({
      name: r.name,
      dist: Math.min(...normName(r.name).split(' ').filter(Boolean).map((nt) => editDistance(q, nt))),
    }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 5)
    .map((s) => s.name)
  return { kind: 'not_found', suggestions }
}
