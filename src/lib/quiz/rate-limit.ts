// Coarse, per-instance in-memory rate limiter for the LLM-calling quiz actions.
//
// It bounds how often a single user can trigger a Gemini call from ONE server
// instance. It is intentionally coarse: the window state lives in process memory,
// so it is NOT shared across Cloud Run instances — it's a cheap backstop, not a
// global guarantee. The per-question turn cap (server-persisted transcript) is the
// primary protection against looping a single walkthrough. A global, multi-instance
// limit (DB/Redis-backed) is tracked as a follow-up.

type Window = { count: number; resetAt: number }

const buckets = new Map<string, Window>()

/**
 * Fixed-window limiter. Returns true if the call is allowed, false if the caller
 * has exceeded `limit` calls within `windowMs` for this `key`.
 */
export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now()

  // Opportunistic prune so the map can't grow without bound.
  if (buckets.size > 5000) {
    for (const [k, w] of buckets) if (now >= w.resetAt) buckets.delete(k)
  }

  const w = buckets.get(key)
  if (!w || now >= w.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs })
    return true
  }
  if (w.count >= limit) return false
  w.count += 1
  return true
}
