// The synthetic world Topic Mastery is audited against: seeded randomness, the
// hidden ability distribution, and the per-archetype observation samplers.
//
// Spec: goals/mastery-algorithm-audit/simulation.md §§1-4 (frozen).
//
// Shared by the pure harness (src/__tests__/mastery-stress.test.ts) and the real
// local-Supabase run (scripts/audit/mastery-e2e.ts) so both describe the SAME
// students. That is what makes the seeded section's accuracy directly comparable
// to the in-memory cohort's instead of merely similar.

import { NODE_CHECK_MASTERY_WEIGHT } from '@/lib/skills/scoring'
import type { ActivityType } from '@/lib/validations/skill'

// ── 1. Seeded randomness ────────────────────────────────────────
// Same xmur3 + mulberry32 pair used by src/lib/live-classroom/shuffle.ts. Copied
// rather than imported because they are module-private there, and widening a
// production module's surface for a test is the wrong trade.

export function xmur3(str: string): () => number {
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

export function mulberry32(seed: number): () => number {
  return () => {
    let t = (seed += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export type Rng = () => number
export const rngFor = (label: string, seed: number): Rng => mulberry32(xmur3(`${label}:${seed}`)())

/** Box-Muller, one draw per call (the spare is discarded; we are not perf-bound). */
export function normal(rng: Rng, mean: number, sd: number): number {
  const u = Math.max(rng(), 1e-12)
  const v = rng()
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

export const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n))
export const shuffled = <T>(arr: readonly T[], rng: Rng): T[] => {
  const out = [...arr]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

// ── 2. The world ────────────────────────────────────────────────

/** simulation.md §2 — 15% weak (30), 60% middle (68), 25% strong (88), sd 8. */
export function abilityBand(rng: Rng): number {
  const r = rng()
  if (r < 0.15) return 30
  if (r < 0.75) return 68
  return 88
}

export type Archetype = 'mcq-quiz' | 'stem-problem-set' | 'coding-autograder' | 'ml-rubric' | 'exam' | 'node-check' | 'challenge'

export interface Observation {
  /** 0–100 achievement, or null when the archetype emits nothing (a failed node check). */
  pct: number | null
  type: ActivityType
  points: number
  /** Overridden for node checks, which do not go through evidenceWeight. */
  fixedWeight?: number
}

/**
 * simulation.md §3. Every archetype is unbiased: E[pct] = ability. Only the
 * shape and variance differ, so a failure is the estimator's fault and never the
 * world's. Point totals vary because evidenceWeight multiplies by them, and
 * whether that is sensible is one of the things under audit.
 */
export const ASSIGNMENT_POINTS = [5, 20, 50, 100]

export function observe(arch: Archetype, ability: number, rng: Rng): Observation {
  switch (arch) {
    case 'mcq-quiz': {
      const k = 10
      let correct = 0
      for (let i = 0; i < k; i++) if (rng() < ability / 100) correct++
      return { pct: (correct / k) * 100, type: 'quiz', points: k }
    }
    case 'stem-problem-set': {
      const points = ASSIGNMENT_POINTS[Math.floor(rng() * ASSIGNMENT_POINTS.length)]
      return { pct: clamp(normal(rng, ability, 10)), type: 'assignment', points }
    }
    case 'coding-autograder': {
      // All tests pass, or none. The least informative signal per event.
      const points = ASSIGNMENT_POINTS[Math.floor(rng() * ASSIGNMENT_POINTS.length)]
      return { pct: rng() < ability / 100 ? 100 : 0, type: 'assignment', points }
    }
    case 'ml-rubric': {
      // Squeezed 40% toward 75, then re-centred: 0.6x + 0.4a keeps E = ability
      // while shrinking the spread, which is what a human rubric does to noise.
      const points = ASSIGNMENT_POINTS[Math.floor(rng() * ASSIGNMENT_POINTS.length)]
      const x = normal(rng, ability, 7)
      return { pct: clamp(0.6 * x + 0.4 * ability), type: 'assignment', points }
    }
    case 'exam':
      return { pct: clamp(normal(rng, ability, 6)), type: 'exam', points: 100 }
    case 'node-check':
      // Positive-only: a pass emits, a fail emits nothing. Mirrors production,
      // where node_check_attempts.passed never regresses.
      return rng() < ability / 100
        ? { pct: 100, type: 'quiz', points: 1, fixedWeight: NODE_CHECK_MASTERY_WEIGHT }
        : { pct: null, type: 'quiz', points: 1 }
    case 'challenge':
      return rng() < ability / 100
        ? { pct: 100, type: 'challenge', points: 1 }
        : { pct: null, type: 'challenge', points: 1 }
  }
}

/** simulation.md §4 — chosen so a plain mean of the observations clears the bar. */
export const TERM: Record<Archetype, number> = {
  'mcq-quiz': 12,
  'stem-problem-set': 12,
  'coding-autograder': 18,
  'ml-rubric': 12,
  exam: 3,
  'node-check': 4,
  challenge: 3,
}

/** The realistic default mix: 14 attempted events in section-like proportions. */
export const MIXED: Archetype[] = [
  ...Array<Archetype>(4).fill('mcq-quiz'),
  ...Array<Archetype>(3).fill('stem-problem-set'),
  ...Array<Archetype>(2).fill('ml-rubric'),
  ...Array<Archetype>(2).fill('exam'),
  ...Array<Archetype>(2).fill('node-check'),
  ...Array<Archetype>(1).fill('challenge'),
]
