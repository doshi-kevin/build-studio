// Tests for the Skill Mastery scoring engine (pure). Covers the cited rules:
// weighted decaying average, cold-start, class metrics, bands.

import { describe, it, expect } from 'vitest'
import {
  recencyDecay,
  RECENCY_HALFLIFE_MS,
  nextMasteryTarget,
  subscoresBySkill,
  splitPointsAcrossSkills,
  nextMasteryScore,
  stakeMultiplier,
  evidenceWeight,
  meanScore,
  medianScore,
  percentProficient,
  percentAtRisk,
  classNumber,
  classBands,
  MAX_EVENT_DELTA,
} from '@/lib/skills/scoring'
import { DEFAULT_TOPIC_MASTERY_CONFIG as CFG } from '@/lib/skills/config'

describe('nextMasteryScore', () => {
  it('cold start blends the seed toward the first evidence (never a raw 0)', () => {
    // The seed is a guess, so it enters the pool at PRIOR_PSEUDO_WEIGHT (3)
    // against the evidence's own weight (2): (50·3 + 90·2) / 5.
    const v = nextMasteryScore(null, 90, 2, CFG, 50)
    expect(v).toBeCloseTo((50 * 3 + 90 * 2) / 5, 5) // 66
    // Still strictly between the seed and the evidence — one data point is not
    // a verdict, and it is never a raw 0.
    expect(v).toBeGreaterThan(50)
    expect(v).toBeLessThan(90)
  })

  it('moves an existing score toward new evidence, pooled against its weight', () => {
    // No priorWeight supplied, so the prior carries PRIOR_PSEUDO_WEIGHT (3)
    // against this event's weight (2): (40·3 + 80·2) / 5.
    const v = nextMasteryScore(40, 80, 2, CFG)
    expect(v).toBeCloseTo((40 * 3 + 80 * 2) / 5, 5) // 56
  })

  it('a heavier body of prior evidence resists a single new event', () => {
    // Same event, but the score already rests on a lot of evidence: it should
    // barely move. This is what stops one zero erasing a term of work.
    const thin = nextMasteryScore(90, 0, 10, CFG, 50, 5)
    const thick = nextMasteryScore(90, 0, 10, CFG, 50, 500)
    expect(90 - thick).toBeLessThan(90 - thin)
    expect(thick).toBeGreaterThan(88)
  })

  it('no single event moves a score with history by more than MAX_EVENT_DELTA', () => {
    for (const prior of [0, 25, 50, 75, 100]) {
      for (const ev of [0, 50, 100]) {
        const v = nextMasteryScore(prior, ev, 300, CFG, 50, 0)
        expect(Math.abs(v - prior)).toBeLessThanOrEqual(MAX_EVENT_DELTA + 1e-9)
      }
    }
  })

  it('heavier evidence pulls harder', () => {
    const light = nextMasteryScore(40, 80, 1, CFG)
    const heavy = nextMasteryScore(40, 80, 6, CFG)
    expect(heavy).toBeGreaterThan(light)
    expect(heavy).toBeLessThanOrEqual(80)
  })

  it('clamps output to 0–100', () => {
    expect(nextMasteryScore(95, 200, 10, CFG)).toBeLessThanOrEqual(100)
    expect(nextMasteryScore(5, -50, 10, CFG)).toBeGreaterThanOrEqual(0)
  })

  it('repeated identical evidence converges toward it', () => {
    let s: number | null = null
    for (let i = 0; i < 12; i++) s = nextMasteryScore(s, 72, 2, CFG, 50)
    expect(s).toBeCloseTo(72, 0)
  })
})

describe('stake weighting', () => {
  it('weights exam > assignment > quiz by default', () => {
    expect(stakeMultiplier(CFG, 'exam')).toBeGreaterThan(stakeMultiplier(CFG, 'assignment'))
    expect(stakeMultiplier(CFG, 'assignment')).toBeGreaterThan(stakeMultiplier(CFG, 'quiz'))
  })

  it('evidence weight grows with assessed points, but sub-linearly', () => {
    const q = CFG.stakeMultipliers.quiz
    expect(evidenceWeight(CFG, 'quiz', 2)).toBeCloseTo(q * 2, 5) // the W_REF anchor
    expect(evidenceWeight(CFG, 'quiz', 0)).toBeCloseTo(q * 1, 5) // min 1 point
    // A 100-point item is worth more than a 5-point one, but nowhere near 20x.
    // Linear scaling here is what used to drive α straight into its ceiling and
    // turn mastery into "the most recent grade wins".
    const small = evidenceWeight(CFG, 'quiz', 5)
    const large = evidenceWeight(CFG, 'quiz', 100)
    expect(large).toBeGreaterThan(small)
    expect(large / small).toBeLessThan(3)
  })
})

describe('class metrics', () => {
  const scores = [40, 60, 80, 100, null]

  it('mean ignores no-data', () => {
    expect(meanScore(scores)).toBe(70)
  })

  it('median is robust to a high outlier', () => {
    expect(medianScore([50, 55, 60, 99])).toBe((55 + 60) / 2)
  })

  it('% proficient / at-risk use the thresholds', () => {
    expect(percentProficient([70, 80, 50, 40], 70)).toBe(50)
    expect(percentAtRisk([70, 80, 49, 40], 50)).toBe(50)
  })

  it('all metrics return null when nobody has data', () => {
    expect(medianScore([null, null])).toBeNull()
    expect(classNumber([null], CFG)).toBeNull()
  })

  it('classNumber follows the configured metric', () => {
    expect(classNumber([40, 60, 80, 100], { ...CFG, classMetric: 'mean' })).toBe(70)
    expect(classNumber([40, 60, 80, 100], { ...CFG, classMetric: 'median' })).toBe(70)
    expect(classNumber([40, 100], { ...CFG, classMetric: 'percent_proficient', proficientThreshold: 70 })).toBe(50)
  })

  it('classBands buckets at 50/70/85', () => {
    expect(classBands([10, 55, 75, 90, null])).toEqual({
      atRisk: 1,
      developing: 1,
      proficient: 1,
      advanced: 1,
    })
  })
})

// ── Per-skill evidence from a multi-topic activity ──────────────

describe('subscoresBySkill', () => {
  it('scores each skill on its OWN questions, not the whole-quiz average', () => {
    // 5 questions on A all right, 5 on B all wrong: 50% overall. The old
    // behaviour recorded 50 against BOTH, which is the bug this exists to fix.
    const outcomes = [
      ...Array.from({ length: 5 }, () => ({ skillIds: ['A'], earned: 1, possible: 1 })),
      ...Array.from({ length: 5 }, () => ({ skillIds: ['B'], earned: 0, possible: 1 })),
    ]
    const subs = subscoresBySkill(outcomes)
    expect(subs).toEqual([
      { skillId: 'A', pct: 100, points: 5 },
      { skillId: 'B', pct: 0, points: 5 },
    ])
  })

  it('weights a skill by the points actually assessed for it', () => {
    const subs = subscoresBySkill([
      { skillIds: ['A'], earned: 3, possible: 4 },
      { skillIds: ['A'], earned: 1, possible: 6 },
    ])
    expect(subs).toEqual([{ skillId: 'A', pct: 40, points: 10 }])
  })

  it('counts a question tagged with two skills toward each of them in full', () => {
    const subs = subscoresBySkill([{ skillIds: ['A', 'B'], earned: 2, possible: 2 }])
    expect(subs).toEqual([
      { skillId: 'A', pct: 100, points: 2 },
      { skillId: 'B', pct: 100, points: 2 },
    ])
  })

  it('drops questions that resolve to no skill, and skills worth no points', () => {
    expect(subscoresBySkill([{ skillIds: [], earned: 1, possible: 1 }])).toEqual([])
    expect(subscoresBySkill([{ skillIds: ['A'], earned: 0, possible: 0 }])).toEqual([])
  })

  it('is order-independent, so a rebuild cannot fold the same quiz differently', () => {
    const a = [
      { skillIds: ['B'], earned: 1, possible: 2 },
      { skillIds: ['A'], earned: 2, possible: 2 },
    ]
    expect(subscoresBySkill(a)).toEqual(subscoresBySkill([...a].reverse()))
  })
})

describe('splitPointsAcrossSkills', () => {
  it('splits a holistic score so it cannot outvote precise per-skill evidence', () => {
    // 100-point assignment over 4 skills: 25 each, so its weight drops from
    // 15.29 to 11.29 while a 3-question quiz subscore weighs 2.58.
    expect(splitPointsAcrossSkills(100, 4)).toBe(25)
    expect(evidenceWeight(CFG, 'assignment', splitPointsAcrossSkills(100, 4))).toBeCloseTo(11.288, 2)
    expect(evidenceWeight(CFG, 'assignment', 100)).toBeCloseTo(15.288, 2)
  })

  it('a single-skill assignment is unchanged, and never splits below one point', () => {
    expect(splitPointsAcrossSkills(50, 1)).toBe(50)
    expect(splitPointsAcrossSkills(2, 8)).toBeCloseTo(0.25, 5)
    // evidenceWeight floors at 1 point, so an over-split cannot go negative.
    expect(evidenceWeight(CFG, 'assignment', splitPointsAcrossSkills(2, 8))).toBe(2)
  })
})

// ── recencyDecay ───────────────────────────────────────────────

describe('recencyDecay', () => {
  it('is 1 at zero age and exactly half a half-life later', () => {
    expect(recencyDecay(0)).toBe(1)
    expect(recencyDecay(RECENCY_HALFLIFE_MS)).toBeCloseTo(0.5, 10)
    expect(recencyDecay(2 * RECENCY_HALFLIFE_MS)).toBeCloseTo(0.25, 10)
  })

  it('treats a negative age as zero rather than amplifying old evidence', () => {
    // Reachable from the incremental hook, which ages from `now - lastAt`: a
    // backdated grade entered after a later one makes that difference negative.
    // Without the clamp it would return >1 and inflate the standing weight.
    expect(recencyDecay(-RECENCY_HALFLIFE_MS)).toBe(1)
  })
})

// ── the professor's responsiveness knob ────────────────────────

describe('baseAlpha as a responsiveness knob', () => {
  const evidence = 90
  const weight = 4

  it('moves further on the same evidence when raised, and less when lowered', () => {
    const base = nextMasteryTarget(50, evidence, weight, CFG)
    const eager = nextMasteryTarget(50, evidence, weight, { ...CFG, baseAlpha: 0.9 })
    const cautious = nextMasteryTarget(50, evidence, weight, { ...CFG, baseAlpha: 0.3 })
    expect(eager).toBeGreaterThan(base)
    expect(cautious).toBeLessThan(base)
    // Still bounded by the evidence itself — a knob, not an override.
    expect(eager).toBeLessThanOrEqual(evidence)
    expect(cautious).toBeGreaterThan(50)
  })

  it('at the default is exactly neutral, so the knob has no hidden bias', () => {
    // responsiveness = baseAlpha / DEFAULT_BASE_ALPHA, so the default must be 1.
    expect(nextMasteryTarget(50, evidence, weight, CFG))
      .toBeCloseTo(nextMasteryTarget(50, evidence, weight, { ...CFG, baseAlpha: 0.6 }), 10)
  })
})
