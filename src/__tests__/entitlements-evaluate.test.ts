/**
 * The entitlement rule, and its coexistence with the AI kill switch.
 *
 * Both controls live in institutions.settings and fail in OPPOSITE directions
 * (entitlement grants on a read error, the kill switch refuses). The second
 * half of this file is about that seam, because it is the part that cannot be
 * checked by reading either module on its own.
 */

import { describe, it, expect } from 'vitest'
import {
  parseEntitlementConfig,
  evaluateEntitlement,
  ENTITLEMENT_CONFIG_DEFAULT,
  ENTITLED_FEATURE_KEYS,
  isSchedulableRevocationDate,
  type EntitlementConfig,
} from '@/lib/entitlements/entitled-features'
import { parseInstitutionAiPolicy, evaluateAiFeature, parseAiPolicyLayer } from '@/lib/ai/ai-features'

const NOW = new Date('2026-09-09T12:00:00Z')

const config = (over: Partial<EntitlementConfig> = {}): EntitlementConfig => ({
  ...ENTITLEMENT_CONFIG_DEFAULT,
  ...over,
})

describe('evaluateEntitlement', () => {
  it('grants every product by default, which is what makes "all toggles on" need no migration', () => {
    for (const key of ENTITLED_FEATURE_KEYS) {
      expect(evaluateEntitlement(config(), key, NOW)).toEqual({
        entitled: true,
        pendingRevocationAt: null,
      })
    }
  })

  it('an explicit revoke beats the registry default', () => {
    expect(evaluateEntitlement(config({ revoked: ['quizzes'] }), 'quizzes', NOW)).toEqual({
      entitled: false,
    })
  })

  it('revoking one product leaves the others alone', () => {
    const c = config({ revoked: ['quizzes'] })
    expect(evaluateEntitlement(c, 'assignments', NOW).entitled).toBe(true)
    expect(evaluateEntitlement(c, 'live-classroom', NOW).entitled).toBe(true)
  })

  it('a pending revocation still grants before its effective date, and reports the date', () => {
    const c = config({ pendingRevocation: { quizzes: '2026-12-20T00:00:00Z' } })
    expect(evaluateEntitlement(c, 'quizzes', NOW)).toEqual({
      entitled: true,
      pendingRevocationAt: '2026-12-20T00:00:00Z',
    })
  })

  it('a pending revocation whose date has passed reads as revoked with no job having run', () => {
    const c = config({ pendingRevocation: { quizzes: '2026-08-01T00:00:00Z' } })
    expect(evaluateEntitlement(c, 'quizzes', NOW)).toEqual({ entitled: false })
  })
})

describe('parseEntitlementConfig', () => {
  it('garbage resolves to no overrides, so a parse bug cannot revoke a paid feature', () => {
    for (const junk of [null, undefined, 'nope', 42, [], { entitlements: 'nope' }, { entitlements: [] }]) {
      const parsed = parseEntitlementConfig(junk)
      expect(evaluateEntitlement(parsed, 'quizzes', NOW).entitled).toBe(true)
    }
  })

  it('drops keys that are not in the registry, so a hand-crafted RPC call is inert', () => {
    const parsed = parseEntitlementConfig({
      entitlements: { revoked: ['quizzes', 'not-a-feature', 'grades'] },
    })
    expect(parsed.revoked).toEqual(['quizzes'])
  })

  it('drops an unparseable pending date rather than treating it as now', () => {
    const parsed = parseEntitlementConfig({
      entitlements: { pendingRevocation: { quizzes: 'sometime next year' } },
    })
    expect(parsed.pendingRevocation).toEqual({})
    expect(evaluateEntitlement(parsed, 'quizzes', NOW).entitled).toBe(true)
  })

  it('reads a real stored config end to end', () => {
    const parsed = parseEntitlementConfig({
      selfUnenroll: { enabled: true },
      ai: { platform: { allDisabled: true, disabledFeatures: [], version: 4 } },
      entitlements: {
        granted: ['projects'],
        revoked: ['live-classroom'],
        pendingRevocation: { quizzes: '2026-12-20T00:00:00Z' },
        version: 3,
      },
    })
    expect(parsed).toEqual({
      granted: ['projects'],
      revoked: ['live-classroom'],
      pendingRevocation: { quizzes: '2026-12-20T00:00:00Z' },
      version: 3,
    })
  })
})

describe('entitlements and the AI kill switch share a column without colliding', () => {
  // The exact shape a real institutions.settings row has once both controls
  // have been written to it.
  const settings = {
    selfUnenroll: { enabled: true },
    ai: {
      platform: { allDisabled: false, disabledFeatures: ['quiz-ai'], version: 2 },
      institution: { allDisabled: false, disabledFeatures: [], version: 5 },
    },
    entitlements: { granted: [], revoked: ['live-classroom'], pendingRevocation: {}, version: 3 },
  }
  const globalLayer = parseAiPolicyLayer({ allDisabled: false, disabledFeatures: [], version: 1 })

  it('each parser reads only its own key and ignores the other', () => {
    const ent = parseEntitlementConfig(settings)
    const ai = parseInstitutionAiPolicy(settings)
    expect(ent.revoked).toEqual(['live-classroom'])
    expect(ent.version).toBe(3)
    expect(ai.platform.disabledFeatures).toEqual(['quiz-ai'])
    expect(ai.platform.version).toBe(2)
    expect(ai.institution.version).toBe(5)
  })

  it('AI off does not revoke the feature: quizzes stay entitled when quiz-ai is killed', () => {
    // The professor can still write quizzes by hand. Only AI generation stops.
    expect(evaluateEntitlement(parseEntitlementConfig(settings), 'quizzes', NOW).entitled).toBe(true)
    expect(
      evaluateAiFeature(globalLayer, parseInstitutionAiPolicy(settings), 'quiz-ai'),
    ).toEqual({ allowed: false, lockedBy: 'platform' })
  })

  it('a feature being unentitled does not disable AI for the features that remain', () => {
    // live-classroom is revoked, but live-classroom-ai's own verdict is
    // untouched. The entitlement gate is what stops the room being created;
    // the kill switch must not be asked to do that job.
    expect(
      evaluateEntitlement(parseEntitlementConfig(settings), 'live-classroom', NOW).entitled,
    ).toBe(false)
    expect(
      evaluateAiFeature(globalLayer, parseInstitutionAiPolicy(settings), 'live-classroom-ai'),
    ).toEqual({ allowed: true })
  })

  it('the global AI kill leaves every entitlement standing', () => {
    const killed = parseAiPolicyLayer({ allDisabled: true, disabledFeatures: [], version: 9 })
    const ai = parseInstitutionAiPolicy(settings)
    for (const key of ENTITLED_FEATURE_KEYS) {
      const entitled = evaluateEntitlement(parseEntitlementConfig(settings), key, NOW).entitled
      expect(entitled).toBe(key !== 'live-classroom')
    }
    expect(evaluateAiFeature(killed, ai, 'quiz-ai').allowed).toBe(false)
    expect(evaluateAiFeature(killed, ai, 'assignment-ai').allowed).toBe(false)
  })

  it('corrupting one key does not disturb the other', () => {
    const halfBroken = { ...settings, entitlements: 'wat' }
    const ai = parseInstitutionAiPolicy(halfBroken)
    expect(ai.platform.disabledFeatures).toEqual(['quiz-ai'])
    // Entitlements fall back to defaults (everything on), AI keeps its kill.
    expect(evaluateEntitlement(parseEntitlementConfig(halfBroken), 'live-classroom', NOW).entitled).toBe(
      true,
    )

    const otherHalf = { ...settings, ai: 'wat' }
    expect(parseEntitlementConfig(otherHalf).revoked).toEqual(['live-classroom'])
    // A corrupt AI blob resolves to the ENABLED default, per that module's
    // documented direction. Asserted here so a change to it is visible from
    // this seam too.
    expect(
      evaluateAiFeature(globalLayer, parseInstitutionAiPolicy(otherHalf), 'quiz-ai').allowed,
    ).toBe(true)
  })
})

describe('a scheduled revocation date must be sane, not merely parseable', () => {
  /**
   * Exercises the SHIPPED rule, not a copy of it. An earlier version of this
   * block reimplemented the bound locally and claimed in a comment to mirror
   * the server action. The two happened to agree, but nothing checked that, so
   * the claim would have rotted silently. One exported function now serves the
   * card, the action and this test.
   */
  const TODAY = new Date('2026-09-09T12:00:00Z')
  const day = (d: string) => `${d}T00:00:00Z`

  it('accepts a real future cutoff', () => {
    expect(isSchedulableRevocationDate(day('2026-12-20'), TODAY)).toBe(true)
    expect(isSchedulableRevocationDate(day('2030-05-01'), TODAY)).toBe(true)
  })

  it('rejects a year that is parseable but absurd', () => {
    // The NaN guard alone lets this through, which is how browser QA saw a
    // confirm dialog reading "Dec 1, 6789".
    expect(isSchedulableRevocationDate(day('6789-12-01'), TODAY)).toBe(false)
  })

  it('rejects a past date, which would revoke on save instead of scheduling', () => {
    // The worst fat-finger case: year 0001 parses and is historical, so storing
    // it turns the feature off immediately. "Turn off now instead" is the
    // explicit control for that intent.
    expect(isSchedulableRevocationDate(day('0001-12-01'), TODAY)).toBe(false)
    expect(isSchedulableRevocationDate(day('2020-01-01'), TODAY)).toBe(false)
  })

  it('still rejects the unparseable half-typed value that crashed the card', () => {
    expect(isSchedulableRevocationDate(day('12252-12-01'), TODAY)).toBe(false)
  })

  it('carries enough slack for a user west of Greenwich to pick their own today', () => {
    /* A date input yields UTC midnight of the chosen day, so someone in Hawaii
       picking "today" hands the server an instant up to ~34 hours old. Writing
       this test is what surfaced that: the floor was one day, which rejected
       them. Anything genuinely historical is off by centuries, so the slack
       costs nothing. */
    const lateInTheHawaiianDay = new Date('2026-09-10T09:00:00Z')
    expect(isSchedulableRevocationDate(day('2026-09-09'), lateInTheHawaiianDay)).toBe(true)

    expect(isSchedulableRevocationDate(day('2026-09-09'), TODAY)).toBe(true)
    expect(isSchedulableRevocationDate(day('2026-09-08'), TODAY)).toBe(true)
    // Still firmly rejects a date that is actually in the past.
    expect(isSchedulableRevocationDate(day('2026-09-01'), TODAY)).toBe(false)
  })

  it('the input bound does not apply to evaluation, or a passed deadline would stop working', () => {
    /* Duplicates the earlier pending-date assertion on purpose, from the other
       direction: the bound added above rejects a past date at INPUT, and it
       would be an easy mistake to add the same bound to evaluateEntitlement.
       That would break the mechanism by which a deadline passes without a job. */
    const c = config({ pendingRevocation: { quizzes: '2026-08-01T00:00:00Z' } })
    expect(evaluateEntitlement(c, 'quizzes', NOW).entitled).toBe(false)
  })
})
