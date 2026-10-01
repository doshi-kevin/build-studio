/**
 * AI Kill Switch — policy semantics + guard behavior.
 *
 * The load-bearing assertions:
 *  - a missing/malformed blob parses to ENABLED (a parse bug must never brick AI),
 *  - the union rule: any layer disabling a feature disables it, with provenance,
 *  - allDisabled is a sentinel covering features that don't exist yet,
 *  - layers never bleed into each other (an institution's own choices survive a lock),
 *  - the guard FAILS CLOSED on a DB error — and reports it as 'error', not policy.
 */

import { describe, it, expect } from 'vitest'
import {
  AI_FEATURE_KEYS,
  AI_POLICY_LAYER_DEFAULT,
  parseAiPolicyLayer,
  parseInstitutionAiPolicy,
  evaluateAiFeature,
  aiRefusalMessage,
  type AiPolicyLayer,
} from '@/lib/ai/ai-features'
import { checkAiFeature, checkAiFeatureBySection } from '@/lib/ai/kill-switch'
import { describeAiPolicyChange } from '@/lib/notifications/ai-policy'

const layer = (over: Partial<AiPolicyLayer>): AiPolicyLayer => ({
  ...AI_POLICY_LAYER_DEFAULT,
  ...over,
})
const ENABLED = AI_POLICY_LAYER_DEFAULT
const NO_INSTITUTION_LAYERS = { platform: ENABLED, institution: ENABLED }

describe('parseAiPolicyLayer', () => {
  it('resolves missing/malformed input to the ENABLED default', () => {
    for (const raw of [undefined, null, 'x', 42, [], {}, { allDisabled: 'yes' }]) {
      expect(parseAiPolicyLayer(raw)).toEqual(AI_POLICY_LAYER_DEFAULT)
    }
  })

  it('parses a valid stored layer', () => {
    expect(
      parseAiPolicyLayer({ allDisabled: true, disabledFeatures: ['quiz-ai'], version: 3 }),
    ).toEqual({ allDisabled: true, disabledFeatures: ['quiz-ai'], version: 3 })
  })

  it('drops unknown feature keys (junk from a hand-crafted RPC call is inert)', () => {
    const parsed = parseAiPolicyLayer({
      allDisabled: false,
      disabledFeatures: ['quiz-ai', 'not-a-feature', 'drop-table'],
      version: 2,
    })
    expect(parsed.disabledFeatures).toEqual(['quiz-ai'])
  })

  it('caps an oversized disabledFeatures array instead of discarding the layer', () => {
    const raw = { allDisabled: false, disabledFeatures: Array(50).fill('quiz-ai'), version: 2 }
    expect(parseAiPolicyLayer(raw).disabledFeatures.length).toBeLessThanOrEqual(32)
    expect(parseAiPolicyLayer(raw).version).toBe(2)
  })

  it('a stored kill SURVIVES corruption in sibling fields (per-field salvage)', () => {
    // A bad version (0, float, string) must never silently undo allDisabled:true —
    // that would let data corruption re-enable AI an admin explicitly killed.
    for (const version of [0, -1, 1.5, 'x', null, undefined]) {
      const parsed = parseAiPolicyLayer({ allDisabled: true, disabledFeatures: [], version })
      expect(parsed.allDisabled).toBe(true)
      expect(parsed.version).toBe(1)
    }
    // ...and a garbage disabledFeatures shape doesn't undo it either.
    expect(parseAiPolicyLayer({ allDisabled: true, disabledFeatures: 'nope', version: 3 })).toEqual({
      allDisabled: true,
      disabledFeatures: [],
      version: 3,
    })
  })
})

describe('parseInstitutionAiPolicy', () => {
  it('empty settings → both layers enabled', () => {
    expect(parseInstitutionAiPolicy({})).toEqual(NO_INSTITUTION_LAYERS)
    expect(parseInstitutionAiPolicy(null)).toEqual(NO_INSTITUTION_LAYERS)
  })

  it('one stored layer does not affect the other', () => {
    const parsed = parseInstitutionAiPolicy({
      selfUnenroll: { enabled: true, days: 14 }, // sibling key must be ignored, not break parsing
      ai: { platform: { allDisabled: true, disabledFeatures: [], version: 2 } },
    })
    expect(parsed.platform.allDisabled).toBe(true)
    expect(parsed.institution).toEqual(ENABLED)
  })
})

describe('evaluateAiFeature — union of three layers with provenance', () => {
  it('all layers enabled → allowed', () => {
    expect(evaluateAiFeature(ENABLED, NO_INSTITUTION_LAYERS, 'quiz-ai')).toEqual({ allowed: true })
  })

  it.each([
    ['global', { global: layer({ disabledFeatures: ['quiz-ai'] }), platform: ENABLED, institution: ENABLED }],
    ['platform', { global: ENABLED, platform: layer({ disabledFeatures: ['quiz-ai'] }), institution: ENABLED }],
    ['institution', { global: ENABLED, platform: ENABLED, institution: layer({ disabledFeatures: ['quiz-ai'] }) }],
  ] as const)('a %s-layer listing disables with that provenance', (lockedBy, layers) => {
    expect(
      evaluateAiFeature(layers.global, { platform: layers.platform, institution: layers.institution }, 'quiz-ai'),
    ).toEqual({ allowed: false, lockedBy })
    // ...and only that feature: others stay allowed.
    expect(
      evaluateAiFeature(layers.global, { platform: layers.platform, institution: layers.institution }, 'projects-ai'),
    ).toEqual({ allowed: true })
  })

  it('provenance tie-break: global beats platform beats institution', () => {
    // lockedBy is the sole input to "by Scholera" vs "by your institution's
    // administration" — an inverted order would misattribute a lock.
    const kill = layer({ disabledFeatures: ['quiz-ai'] })
    expect(evaluateAiFeature(kill, { platform: kill, institution: kill }, 'quiz-ai')).toEqual({
      allowed: false,
      lockedBy: 'global',
    })
    expect(evaluateAiFeature(ENABLED, { platform: kill, institution: kill }, 'quiz-ai')).toEqual({
      allowed: false,
      lockedBy: 'platform',
    })
  })

  it('allDisabled sentinel covers EVERY registered feature', () => {
    const globalKill = layer({ allDisabled: true })
    for (const key of AI_FEATURE_KEYS) {
      expect(evaluateAiFeature(globalKill, NO_INSTITUTION_LAYERS, key)).toEqual({
        allowed: false,
        lockedBy: 'global',
      })
    }
  })

  it('platform lock does not depend on (or alter) the institution layer', () => {
    // Institution admin had quiz-ai disabled, then super admin locked everything.
    const institutionChoice = layer({ disabledFeatures: ['quiz-ai'], version: 4 })
    const locked = evaluateAiFeature(
      ENABLED,
      { platform: layer({ allDisabled: true }), institution: institutionChoice },
      'projects-ai',
    )
    expect(locked).toEqual({ allowed: false, lockedBy: 'platform' })
    // Lock lifted → the institution's own choice is still there and still applies.
    const after = evaluateAiFeature(ENABLED, { platform: ENABLED, institution: institutionChoice }, 'quiz-ai')
    expect(after).toEqual({ allowed: false, lockedBy: 'institution' })
  })
})

describe('aiRefusalMessage', () => {
  it('policy locks name the right authority; infra errors never impersonate policy', () => {
    expect(aiRefusalMessage('institution')).toMatch(/your institution's administration/)
    expect(aiRefusalMessage('platform')).toMatch(/disabled for your institution/)
    expect(aiRefusalMessage('global')).toMatch(/disabled for your institution/)
    expect(aiRefusalMessage('error')).toMatch(/temporarily unavailable/)
    expect(aiRefusalMessage('error')).not.toMatch(/disabled/)
  })
})

// ── Guard: fail-closed ────────────────────────────────────────────
// Minimal fake supabase clients; only the shapes the guard touches.

function dbReturning(rows: {
  platform_settings?: { data: unknown; error: unknown }
  institutions?: { data: unknown; error: unknown }
  course_sections?: { data: unknown; error: unknown }
}) {
  return {
    from(table: string) {
      const result =
        rows[table as keyof typeof rows] ?? { data: null, error: new Error(`no stub for ${table}`) }
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => result,
        single: async () => result,
      }
      return chain
    },
  }
}

describe('checkAiFeature — fail-closed', () => {
  it('DB error reading policy → refused as lockedBy error, never allowed', async () => {
    const db = dbReturning({
      platform_settings: { data: null, error: new Error('boom') },
      institutions: { data: { settings: {} }, error: null },
    })
    expect(await checkAiFeature(db, 'inst-1', 'quiz-ai')).toEqual({
      allowed: false,
      lockedBy: 'error',
    })
  })

  it('institution row missing (no error, no data) → refused as error', async () => {
    const db = dbReturning({
      platform_settings: { data: { settings: {} }, error: null },
      institutions: { data: null, error: null },
    })
    expect(await checkAiFeature(db, 'inst-gone', 'quiz-ai')).toEqual({
      allowed: false,
      lockedBy: 'error',
    })
  })

  it('healthy read with empty settings → allowed (default state)', async () => {
    const db = dbReturning({
      platform_settings: { data: { settings: {} }, error: null },
      institutions: { data: { settings: {} }, error: null },
    })
    expect(await checkAiFeature(db, 'inst-1', 'quiz-ai')).toEqual({ allowed: true })
  })

  it('missing platform_settings singleton row → allowed (absence is not a kill)', async () => {
    const db = dbReturning({
      platform_settings: { data: null, error: null },
      institutions: { data: { settings: {} }, error: null },
    })
    expect(await checkAiFeature(db, 'inst-1', 'quiz-ai')).toEqual({ allowed: true })
  })

  it('stored institution-layer disable is enforced end-to-end', async () => {
    const db = dbReturning({
      platform_settings: { data: { settings: {} }, error: null },
      institutions: {
        data: { settings: { ai: { institution: { allDisabled: false, disabledFeatures: ['preclass-ai'], version: 2 } } } },
        error: null,
      },
    })
    expect(await checkAiFeature(db, 'inst-1', 'preclass-ai')).toEqual({
      allowed: false,
      lockedBy: 'institution',
    })
  })
})

describe('describeAiPolicyChange — the bell-notification diff', () => {
  it('no effective change → null (no notification spam)', () => {
    expect(describeAiPolicyChange(ENABLED, { ...ENABLED, version: 5 })).toBeNull()
    // Feature-list churn UNDER an active master is invisible: 'all' was and is the state.
    expect(
      describeAiPolicyChange(layer({ allDisabled: true }), layer({ allDisabled: true, disabledFeatures: ['quiz-ai'] })),
    ).toBeNull()
  })

  it('diffs EFFECTIVE feature sets — the master kill never claims features were re-enabled', () => {
    // QA finding F3: with quiz-ai already off, flipping the master ON used to
    // notify "Re-enabled: Quiz AI" because raw sentinels were diffed.
    const change = describeAiPolicyChange(layer({ disabledFeatures: ['quiz-ai'] }), layer({ allDisabled: true }))
    expect(change?.title).toBe('All AI features were disabled')
    expect(change?.body).toBe('Disabled: All AI features.')
    expect(change?.body).not.toContain('Re-enabled')

    const reEnable = describeAiPolicyChange(layer({ disabledFeatures: ['preclass-ai'] }), ENABLED)
    expect(reEnable?.title).toBe('AI features were re-enabled')
    expect(reEnable?.body).toBe('Re-enabled: Pre-Class Primers.')

    // Master lifted but one feature still individually off: only the truly
    // re-enabled features are announced.
    const lift = describeAiPolicyChange(layer({ allDisabled: true }), layer({ disabledFeatures: ['quiz-ai'] }))
    expect(lift?.title).toBe('AI features were re-enabled')
    expect(lift?.body).not.toContain('Quiz AI')
  })
})

describe('checkAiFeatureBySection', () => {
  it('unresolvable section → refused (an unattributable AI call must not run)', async () => {
    const db = dbReturning({
      course_sections: { data: null, error: new Error('nope') },
    })
    expect(await checkAiFeatureBySection(db, 'sec-1', 'quiz-ai')).toEqual({
      allowed: false,
      lockedBy: 'error',
    })
  })

  it('resolves the section institution and applies its policy', async () => {
    const db = dbReturning({
      course_sections: { data: { institution_id: 'inst-9' }, error: null },
      platform_settings: { data: { settings: { ai: { allDisabled: true, disabledFeatures: [], version: 5 } } }, error: null },
      institutions: { data: { settings: {} }, error: null },
    })
    expect(await checkAiFeatureBySection(db, 'sec-1', 'quiz-ai')).toEqual({
      allowed: false,
      lockedBy: 'global',
    })
  })
})
