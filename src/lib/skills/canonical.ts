// Canonical skill-name matching — the pure, client-safe de-dup primitives shared
// by the server-side reconciler (skill pool building / activity mapping) and the
// client-side roadmap node modal (skill chip → question anchoring). Both sides
// MUST use the same rule: a curated pool name ("Backpropagation") and a raw
// per-question tag ("back-propagation") have to resolve to the same concept.

/** Normalised de-dup key: lowercase, drop ALL separators/punctuation so
 *  "back-propagation" / "back propagation" / "Backpropagation" collapse to one. */
export function canonicalizeName(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '')
}

/**
 * Do two concept names mean the same thing? Exact canonical match first; then
 * the conservative substring rule (one contained in the other, both ≥4 chars)
 * to catch "backprop" ⊂ "backpropagation". The pairwise form of matchInPool.
 */
export function skillNamesMatch(a: string, b: string): boolean {
  const ca = canonicalizeName(a)
  const cb = canonicalizeName(b)
  if (!ca || !cb) return false
  if (ca === cb) return true
  return ca.length >= 4 && cb.length >= 4 && (ca.includes(cb) || cb.includes(ca))
}

/**
 * Resolve one candidate name against a pool of skills. Exact canonical match
 * first, then the conservative substring rule (both >= 4 chars). Returns the
 * first hit, so the CALLER decides precedence by how it orders the pool —
 * longest canonical first makes the most specific skill win, which is what
 * stops "Integrated rate laws" from also crediting "Rate laws".
 *
 * Lives here rather than in reconcile.ts because the scoring hot path resolves
 * every question tag through it, and reconcile pulls in the AI client.
 */
export function matchInPool(
  candidate: string,
  pool: Array<{ id: string; canonical: string }>,
): string | null {
  const c = canonicalizeName(candidate)
  if (!c) return null
  for (const t of pool) if (t.canonical === c) return t.id
  for (const t of pool) {
    if (c.length >= 4 && t.canonical.length >= 4 && (t.canonical.includes(c) || c.includes(t.canonical))) {
      return t.id
    }
  }
  return null
}
