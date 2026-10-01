/**
 * The entitlement guard's FAILURE direction.
 *
 * entitlements-evaluate.test.ts covers the rule and the parser — both pure, both
 * total, neither able to fail. This file covers the part that can: what the
 * guard answers when the database does not.
 *
 * It exists because the direction is counter-intuitive and load-bearing.
 * `check.ts` grants on a read error; `kill-switch.ts`, reading the SAME
 * institutions row one jsonb key over, refuses. A reviewer meeting
 * `return { allowed: true }` inside a catch block will read it as a bug and
 * flip it. Flipping it turns one Postgres hiccup into every professor at every
 * school being unable to create anything — the outage the module header says it
 * exists to prevent. Before this file, nothing failed when it was flipped:
 * checkAiFeature's fail-CLOSED direction was pinned by a test and
 * checkEntitlement's fail-OPEN direction was not.
 *
 * The last describe block is the seam itself. The design's claim is that the
 * two controls can fail in opposite directions safely BECAUSE each does its own
 * read with its own catch. That claim is about behaviour under failure, so it
 * can only be checked by failing a read and watching both answer at once.
 */

import { describe, it, expect, vi } from 'vitest'

const NOT_FOUND = 'NEXT_NOT_FOUND'
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error(NOT_FOUND)
  },
}))

import {
  checkEntitlement,
  checkEntitlementBySection,
  resolveAllEntitlements,
  resolveAllEntitlementsBySection,
  verifyEntitled,
  getEntitlementConfig,
} from '@/lib/entitlements/check'
import { evaluateEntitlement, ENTITLEMENT_CONFIG_DEFAULT } from '@/lib/entitlements/entitled-features'
import { checkAiFeature } from '@/lib/ai/kill-switch'

/** Minimal fake supabase client; only the shapes the guards touch. */
function dbReturning(rows: {
  institutions?: { data: unknown; error: unknown }
  course_sections?: { data: unknown; error: unknown }
  platform_settings?: { data: unknown; error: unknown }
}) {
  return {
    from(table: string) {
      const result = rows[table as keyof typeof rows] ?? {
        data: null,
        error: new Error(`no stub for ${table}`),
      }
      const chain = {
        select: () => chain,
        eq: () => chain,
        single: async () => result,
        maybeSingle: async () => result,
      }
      return chain
    },
  }
}

const revokedRow = (keys: string[]) => ({
  data: { settings: { entitlements: { granted: [], revoked: keys, pendingRevocation: {}, version: 2 } } },
  error: null,
})

describe('checkEntitlement — fail-OPEN, the opposite of the kill switch', () => {
  it('a read error GRANTS, so one Postgres hiccup cannot stop every school working', async () => {
    const db = dbReturning({ institutions: { data: null, error: new Error('boom') } })
    expect(await checkEntitlement(db, 'inst-1', 'quizzes')).toEqual({ allowed: true })
  })

  it('a missing institution row GRANTS rather than refusing', async () => {
    // Entitlement is a commercial control, not a security boundary. Ownership
    // checks ran before this point and are what keep a stranger out.
    const db = dbReturning({ institutions: { data: null, error: null } })
    expect(await checkEntitlement(db, 'inst-gone', 'quizzes')).toEqual({ allowed: true })
  })

  it('a HEALTHY read still refuses a revoked product', async () => {
    // Without this, "always grants" would satisfy every other test in the file.
    const db = dbReturning({ institutions: revokedRow(['quizzes']) })
    expect(await checkEntitlement(db, 'inst-1', 'quizzes')).toEqual({
      allowed: false,
      reason: 'not-entitled',
    })
  })

  it('refuses only the revoked product, not its neighbours', async () => {
    const db = dbReturning({ institutions: revokedRow(['quizzes']) })
    expect(await checkEntitlement(db, 'inst-1', 'assignments')).toEqual({ allowed: true })
  })

  it('honours a pending revocation whose date has passed, via the injected clock', async () => {
    const db = dbReturning({
      institutions: {
        data: {
          settings: {
            entitlements: {
              granted: [],
              revoked: [],
              pendingRevocation: { quizzes: '2026-10-01T00:00:00Z' },
              version: 1,
            },
          },
        },
        error: null,
      },
    })
    expect(await checkEntitlement(db, 'i', 'quizzes', new Date('2026-09-09T00:00:00Z'))).toEqual({
      allowed: true,
    })
    expect(await checkEntitlement(db, 'i', 'quizzes', new Date('2026-11-01T00:00:00Z'))).toEqual({
      allowed: false,
      reason: 'not-entitled',
    })
  })
})

describe('getEntitlementConfig — throws, so callers choose their own direction', () => {
  it('propagates a read error instead of swallowing it', async () => {
    // The admin editors rely on this: they must render "could not load" rather
    // than a screen of defaults that looks like a real plan.
    const db = dbReturning({ institutions: { data: null, error: new Error('boom') } })
    await expect(getEntitlementConfig(db, 'inst-1')).rejects.toThrow()
  })
})

describe('checkEntitlementBySection — an unresolvable section grants', () => {
  it('grants when the section cannot be resolved', async () => {
    // checkAiFeatureBySection REFUSES in exactly this case. The divergence is
    // deliberate and is the thing most likely to be "fixed" by mistake.
    const db = dbReturning({ course_sections: { data: null, error: new Error('nope') } })
    expect(await checkEntitlementBySection(db, 'sec-1', 'quizzes')).toEqual({ allowed: true })
  })

  it('resolves the section institution and applies its plan', async () => {
    const db = dbReturning({
      course_sections: { data: { institution_id: 'inst-9' }, error: null },
      institutions: revokedRow(['live-classroom']),
    })
    expect(await checkEntitlementBySection(db, 'sec-1', 'live-classroom')).toEqual({
      allowed: false,
      reason: 'not-entitled',
    })
    expect(await checkEntitlementBySection(db, 'sec-1', 'quizzes')).toEqual({ allowed: true })
  })
})

describe('verifyEntitled — the page-level dead end', () => {
  it('dead-ends on a revoked feature', async () => {
    const db = dbReturning({
      course_sections: { data: { institution_id: 'inst-9' }, error: null },
      institutions: revokedRow(['projects']),
    })
    await expect(verifyEntitled(db, 'sec-1', 'projects')).rejects.toThrow(NOT_FOUND)
  })

  it('does NOT dead-end when the plan could not be read', async () => {
    // A 404 asserts the thing does not exist. A failed read means we do not
    // know, and .claude/rules/dead-ends.md forbids confusing the two.
    const db = dbReturning({ course_sections: { data: null, error: new Error('boom') } })
    await expect(verifyEntitled(db, 'sec-1', 'projects')).resolves.toBeUndefined()
  })

  it('lets an entitled feature through', async () => {
    const db = dbReturning({
      course_sections: { data: { institution_id: 'inst-9' }, error: null },
      institutions: revokedRow(['projects']),
    })
    await expect(verifyEntitled(db, 'sec-1', 'quizzes')).resolves.toBeUndefined()
  })
})

describe('resolveAllEntitlements — the nav/admin read path', () => {
  it('a read error resolves to no overrides, which shows every feature', async () => {
    // Same direction as the guard: a broken read must not empty a professor's
    // sidebar. The sidebars filter on this result.
    const db = dbReturning({ institutions: { data: null, error: new Error('boom') } })
    const config = await resolveAllEntitlements(db, 'inst-1')
    expect(config).toEqual(ENTITLEMENT_CONFIG_DEFAULT)
    expect(evaluateEntitlement(config, 'quizzes', new Date()).entitled).toBe(true)
  })

  it('an unresolvable section resolves to no overrides too', async () => {
    const db = dbReturning({ course_sections: { data: null, error: new Error('nope') } })
    expect(await resolveAllEntitlementsBySection(db, 'sec-1')).toEqual(ENTITLEMENT_CONFIG_DEFAULT)
  })

  it('returns the real stored config when the read works', async () => {
    const db = dbReturning({
      course_sections: { data: { institution_id: 'inst-9' }, error: null },
      institutions: revokedRow(['discussions', 'challenges']),
    })
    const config = await resolveAllEntitlementsBySection(db, 'sec-1')
    expect(config.revoked).toEqual(['discussions', 'challenges'])
  })
})

describe('the seam: one broken read, two controls, opposite answers', () => {
  it('the SAME failing institutions read grants entitlement and refuses AI', async () => {
    /* This is the assertion the whole fail-open design rests on, and it cannot
       be made by reading either module alone. Both controls read
       institutions.settings; if they ever shared a fetch or an error path, one
       control's failure default would resolve into the other's. Here one db
       fails the same read for both, and they must disagree. */
    const db = dbReturning({
      platform_settings: { data: { settings: {} }, error: null },
      institutions: { data: null, error: new Error('boom') },
    })
    const entitlement = await checkEntitlement(db, 'inst-1', 'quizzes')
    const ai = await checkAiFeature(db, 'inst-1', 'quiz-ai')

    expect(entitlement).toEqual({ allowed: true })
    expect(ai.allowed).toBe(false)
    // Stated as the invariant rather than two independent facts: the two
    // controls must never agree about a failed read.
    expect(entitlement.allowed).not.toBe(ai.allowed)
  })

  it('a healthy read lets both answer on their own merits', async () => {
    const db = dbReturning({
      platform_settings: { data: { settings: {} }, error: null },
      institutions: {
        data: {
          settings: {
            entitlements: { granted: [], revoked: ['quizzes'], pendingRevocation: {}, version: 1 },
            ai: { allDisabled: false, disabledFeatures: [], version: 1 },
          },
        },
        error: null,
      },
    })
    // Quizzes unentitled, but quiz AI is not "locked" — the entitlement gate is
    // what stops the quiz being created; the kill switch is not asked to do it.
    expect(await checkEntitlement(db, 'inst-1', 'quizzes')).toEqual({
      allowed: false,
      reason: 'not-entitled',
    })
    expect((await checkAiFeature(db, 'inst-1', 'quiz-ai')).allowed).toBe(true)
  })
})
