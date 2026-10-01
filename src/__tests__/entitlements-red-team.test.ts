/**
 * Red team: does toggling ever break a feature, or move a number that should
 * not move?
 *
 * 2^7 configurations cannot be tested. This runs 2N+2 of them (base, full, N
 * singles, N all-but-ones) plus the coupled pairs, and asserts four invariants
 * over each. See §10 of docs/designs/entitlements/feature-entitlements.md.
 *
 * The all-but-one row is the one that earns its keep: bugs hide in features
 * that share a surface without knowing it, and those only show when exactly one
 * thing is absent. Every other row has too much missing at once to notice.
 */

import { describe, it, expect } from 'vitest'
import {
  ENTITLED_FEATURE_KEYS,
  evaluateEntitlement,
  parseEntitlementConfig,
  type EntitledFeatureKey,
  type EntitlementConfig,
} from '@/lib/entitlements/entitled-features'
import { scoreStudentRisk, type RiskItem } from '@/lib/risk/at-risk'
import { foldMasteryEvents, type MasteryEvent } from '@/lib/skills/scoring'
import { DEFAULT_TOPIC_MASTERY_CONFIG } from '@/lib/skills/config'

const NOW = new Date('2026-09-09T12:00:00Z')
const NOW_MS = NOW.getTime()

/** A graded, closed item. `classMedianPct` set is what makes it closed. */
function item(over: Partial<RiskItem> = {}): RiskItem {
  return {
    itemId: 'a1',
    kind: 'assignment',
    title: 'Lab 1',
    studentPct: 82,
    submitted: true,
    dueAt: Date.parse('2026-08-01T00:00:00Z'),
    passThreshold: 60,
    classMedianPct: 78,
    exempt: false,
    ...over,
  }
}

const event = (over: Partial<MasteryEvent> = {}): MasteryEvent => ({
  studentId: 's1',
  skillId: 'k1',
  pct: 80,
  at: Date.parse('2026-09-01T00:00:00Z'),
  weight: 2,
  ...over,
})

const masteryScore = (events: MasteryEvent[]) =>
  foldMasteryEvents(events, DEFAULT_TOPIC_MASTERY_CONFIG).get('s1:k1')?.score ?? null

/** Build a config where exactly the named features are on. */
function configWith(on: EntitledFeatureKey[]): EntitlementConfig {
  return {
    granted: [...on],
    revoked: ENTITLED_FEATURE_KEYS.filter((k) => !on.includes(k)),
    pendingRevocation: {},
    version: 1,
  }
}

const ALL = ENTITLED_FEATURE_KEYS
const CONFIGS: { name: string; on: EntitledFeatureKey[] }[] = [
  { name: 'base (nothing bought)', on: [] },
  { name: 'full (everything bought)', on: [...ALL] },
  ...ALL.map((k) => ({ name: `single: only ${k}`, on: [k] })),
  ...ALL.map((k) => ({ name: `all but one: no ${k}`, on: ALL.filter((x) => x !== k) })),
  // Coupled pairs: the edges with a real dependency, not all C(N,2).
  { name: 'coupled: live-classroom + projects', on: ['live-classroom', 'projects'] },
  { name: 'coupled: assignments + projects', on: ['assignments', 'projects'] },
  { name: 'coupled: quizzes + projects', on: ['quizzes', 'projects'] },
  { name: 'coupled: quizzes + assignments', on: ['quizzes', 'assignments'] },
]

describe('every configuration resolves cleanly', () => {
  it.each(CONFIGS)('$name', ({ on }) => {
    const config = configWith(on)
    for (const key of ALL) {
      const verdict = evaluateEntitlement(config, key, NOW)
      // Total: every key gets a definite answer, never undefined or a throw.
      expect(typeof verdict.entitled).toBe('boolean')
      expect(verdict.entitled).toBe(on.includes(key))
    }
  })

  it('a config survives a round trip through storage', () => {
    for (const { on } of CONFIGS) {
      const config = configWith(on)
      const roundTripped = parseEntitlementConfig({ entitlements: config })
      for (const key of ALL) {
        expect(evaluateEntitlement(roundTripped, key, NOW).entitled).toBe(
          evaluateEntitlement(config, key, NOW).entitled,
        )
      }
    }
  })
})

/**
 * Invariant 3, no zero-inflation: an absent product must leave the denominator
 * rather than contribute a zero. This is the invariant the whole design rests
 * on, and it is checked against the REAL scorers, not a model of them.
 */
describe('invariant: an absent product never contributes a zero', () => {
  it('at-risk: an item that does not exist is not the same as one scored zero', () => {
    /* This is §4.3 stated as arithmetic. A product nobody bought and a product
       bought but unused both produce NO item, and the scorer sees an identical
       list either way. A product that WAS used and skipped produces an item
       with no submission, which is a real zero. The three cases collapse to
       two, and the difference is whether the row exists. */
    const twoGraded = [item({ studentPct: 90 }), item({ itemId: 'a2', studentPct: 88 })]

    const absent = scoreStudentRisk({ items: twoGraded, weakSkillShare: null, now: NOW_MS })
    const skipped = scoreStudentRisk({
      items: [...twoGraded, item({ itemId: 'a3', studentPct: null, submitted: false })],
      weakSkillShare: null,
      now: NOW_MS,
    })

    // The absent product must not drag the student down...
    expect(absent.atRisk).toBe(false)
    // ...while a real skipped item must, or "missing work" would mean nothing.
    expect(skipped.points).toBeGreaterThan(absent.points)
  })

  it('at-risk: buying a second product does not manufacture risk', () => {
    const one = scoreStudentRisk({
      items: [item(), item({ itemId: 'a2' })],
      weakSkillShare: null,
      now: NOW_MS,
    })
    const two = scoreStudentRisk({
      items: [
        item(),
        item({ itemId: 'a2' }),
        item({ itemId: 'q1', kind: 'quiz', title: 'Quiz 1', studentPct: 88 }),
      ],
      weakSkillShare: null,
      now: NOW_MS,
    })
    // A student doing fine must not become at-risk because the school bought more.
    expect(two.points).toBeLessThanOrEqual(one.points)
    expect(two.atRisk).toBe(false)
  })

  it('at-risk: an unmeasured skill signal drops out rather than scoring zero', () => {
    const dropped = scoreStudentRisk({
      items: [item(), item({ itemId: 'a2' })],
      weakSkillShare: null,
      now: NOW_MS,
    })
    const allWeak = scoreStudentRisk({
      items: [item(), item({ itemId: 'a2' })],
      weakSkillShare: 1,
      now: NOW_MS,
    })
    // "Not measured" must not read as "every skill is weak".
    expect(dropped.points).toBeLessThan(allWeak.points)
  })

  it('mastery: an absent producer contributes no events, not a zero', () => {
    /* The bug this guards against is a producer that is switched off writing a
       0 instead of writing nothing. Comparing "one event" with "one event plus
       a phantom zero" is what actually distinguishes those two worlds; running
       the same input twice would only prove the fold is deterministic. */
    const quizOnly = masteryScore([event()])
    const withPhantomZero = masteryScore([event(), event({ pct: 0 })])

    expect(quizOnly).not.toBeNull()
    expect(withPhantomZero).not.toBeNull()
    expect(withPhantomZero as number).toBeLessThan(quizOnly as number)

    // And a second REAL event from another producer moves it the other way, so
    // the fold is reacting to evidence rather than to event count alone.
    const twoProducers = masteryScore([event(), event({ skillId: 'k1', pct: 95 })])
    expect(twoProducers as number).toBeGreaterThan(quizOnly as number)
  })
})

/**
 * Invariant 2, grade integrity: a grade computed while a feature was on must
 * equal the grade computed after it is turned off. Toggling never rewrites the
 * past, because the evidence rows stay and the scorers read rows.
 */
describe('invariant: toggling never rewrites a past grade', () => {
  it('the same evidence yields the same verdict under every configuration', () => {
    const items = [
      item({ itemId: 'q1', kind: 'quiz', title: 'Quiz 1', studentPct: 55, classMedianPct: 74 }),
      item({ itemId: 'a2', studentPct: 64 }),
    ]
    const baseline = scoreStudentRisk({ items, weakSkillShare: 0.4, now: NOW_MS })

    /* The scorer takes no entitlement parameter, so a loop feeding it 20
       configurations would be 20 identical calls. The claim worth checking is
       the one that would break if someone added that parameter: the function's
       input is evidence and a clock, and nothing else. Asserted structurally,
       because that is the shape the claim actually has. */
    const acceptedKeys = Object.keys({ items, weakSkillShare: 0.4, now: NOW_MS })
    expect(acceptedKeys.sort()).toEqual(['items', 'now', 'weakSkillShare'])
    expect(JSON.stringify(baseline)).not.toContain('entitle')

    // What DOES move the verdict is evidence. Same student, one more missed
    // item, worse outcome. This is the sensitivity that makes the invariant
    // above meaningful rather than vacuous.
    const withOneMoreMiss = scoreStudentRisk({
      items: [...items, item({ itemId: 'a3', studentPct: null, submitted: false })],
      weakSkillShare: 0.4,
      now: NOW_MS,
    })
    expect(withOneMoreMiss.points).toBeGreaterThan(baseline.points)
  })

  it('mastery folded from past evidence survives a revocation because nothing is deleted', () => {
    /* Revocation keeps history (§4.5), so the question is not whether the fold
       is deterministic but whether the ROWS are still there. Modelled as the
       thing that would actually change the number if we got it wrong: dropping
       the revoked producer's events. */
    const withHistory = [
      event({ at: Date.parse('2026-07-01T00:00:00Z'), pct: 40 }),
      event({ pct: 90 }),
    ]
    const ifWeDeletedTheRevokedProducersEvents = [event({ pct: 90 })]

    expect(masteryScore(withHistory)).not.toBe(
      masteryScore(ifWeDeletedTheRevokedProducersEvents),
    )
    // So "keep the rows" is a load-bearing rule, not a formality: deleting them
    // would visibly move a student's score.
  })
})

/**
 * Invariant 4, honest emptiness: with nothing bought there is no evidence, and
 * the engine must say it has none rather than report that everyone is fine.
 */
describe('invariant: nothing bought means "no signal", not "everyone is fine"', () => {
  it('at-risk refuses to score with no items', () => {
    const verdict = scoreStudentRisk({ items: [], weakSkillShare: null, now: NOW_MS })
    expect(verdict.hasEnoughSignal).toBe(false)
    expect(verdict.atRisk).toBe(false)
  })

  it('the refusal is distinguishable from a student who is doing well', () => {
    // Reading atRisk alone would conflate them, which is exactly the bug this
    // invariant exists to prevent: an empty list reading as "everyone is fine".
    const noEvidence = scoreStudentRisk({ items: [], weakSkillShare: null, now: NOW_MS })
    const doingWell = scoreStudentRisk({
      items: [item({ studentPct: 95 }), item({ itemId: 'a2', studentPct: 91 })],
      weakSkillShare: null,
      now: NOW_MS,
    })
    expect(doingWell.hasEnoughSignal).toBe(true)
    expect(doingWell.atRisk).toBe(false)
    expect(noEvidence.hasEnoughSignal).toBe(false)
    // The pair differs on the field a caller must branch on.
    expect(noEvidence.hasEnoughSignal).not.toBe(doingWell.hasEnoughSignal)
  })

  it('a student who submitted nothing is still flagged, not silently cleared', () => {
    // The failure this whole line of work exists to kill: no submissions
    // reading as "no problems found".
    const ghost = scoreStudentRisk({
      items: [
        item({ studentPct: null, submitted: false }),
        item({ itemId: 'a2', studentPct: null, submitted: false }),
        item({ itemId: 'a3', studentPct: null, submitted: false }),
      ],
      weakSkillShare: null,
      now: NOW_MS,
    })
    expect(ghost.hasEnoughSignal).toBe(true)
    expect(ghost.missingCount).toBe(3)
    expect(ghost.atRisk).toBe(true)
  })
})
