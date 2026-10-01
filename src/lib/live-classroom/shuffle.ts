// Deterministic seeded shuffle for poll/quiz choices.
//
// We want every student to see options in a DIFFERENT order from the prof's
// authored order — so neighbours can't just shout "the answer is C". But
// the order has to stay STABLE for a given (student, interaction) pair so
// that mid-answer, refresh, or "you already answered" rendering doesn't
// scramble what the student is looking at.
//
// Implementation: derive a 32-bit seed from `${userId}:${interactionId}`
// via a simple xmur3 hash, then run mulberry32 PRNG → Fisher-Yates shuffle.
// No external deps, ~10 lines, fast enough to call inline on render.

function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507)
    h = Math.imul(h ^ (h >>> 13), 3266489909)
    h ^= h >>> 16
    return h >>> 0
  }
}

function mulberry32(seed: number): () => number {
  return () => {
    let t = (seed += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Returns a NEW array with the same elements as `arr`, shuffled
 * deterministically based on the seed. Same seed → same order, every time.
 */
export function seededShuffle<T>(arr: readonly T[], seed: string): T[] {
  if (arr.length <= 1) return [...arr]
  const seedFn = xmur3(seed)
  const rng = mulberry32(seedFn())
  const out = [...arr]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}
