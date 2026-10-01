/**
 * Entitlement read path — the guard every write that CREATES feature data
 * calls before the insert. The admin write path is set_institution_entitlements
 * (RPC); this module only reads.
 *
 * FAIL-OPEN, and this is the opposite of the AI kill switch that lives one key
 * over in the same jsonb column. The reasoning is not symmetry, it is blast
 * radius. Refusing on a failed read means one Postgres hiccup stops every
 * professor at every school from creating anything, an outage we inflicted on
 * paying customers. Granting on a failed read means someone briefly uses a
 * feature they have not bought, which is a billing conversation. Entitlement is
 * a commercial control, not a security boundary; row-level security still owns
 * tenancy either way.
 *
 * The thing that makes opposite failure directions safe is that this module
 * does its OWN read with its OWN catch. It never shares a fetch or an error
 * path with getEffectiveAiPolicy, so a transient error can never resolve one
 * control's default into the other's. That costs one extra primary-key lookup
 * on the same row, which is the right price.
 *
 * Design doc: docs/designs/entitlements/feature-entitlements.md
 */

import 'server-only'
import { notFound } from 'next/navigation'
import { logger } from '@/lib/logger'
import {
  parseEntitlementConfig,
  evaluateEntitlement,
  ENTITLEMENT_CONFIG_DEFAULT,
  type EntitlementConfig,
  type EntitledFeatureKey,
} from './entitled-features'

/*
 * ON NOT MEMOISING THESE READS
 *
 * A student course page asks up to three times per request: the layout for the
 * nav, verifyFeatureEnabled for the page gate, and surfaces like Grades that
 * filter their own tabs. Each is two lookups, so roughly four reads where one
 * would do, and React's cache() is the standard App Router answer.
 *
 * Tried and rejected, deliberately. cache() keys on every argument, and a fresh
 * admin client per call defeats the memo, so the cached reader has to make its
 * own — which turns `db` into a parameter that silently does nothing. That
 * broke the fail-open tests, and rightly: they inject a stub client to prove
 * the failure direction, and a signature that ignores what you pass it cannot
 * be tested and lies to the next reader.
 *
 * Measured before deciding: 0.073ms for the institutions read and 0.030ms for
 * the section lookup. Four of them is ~0.4ms on a page that already issues
 * dozens of queries. Not worth an untestable, dishonest signature.
 *
 * If this ever does matter, the honest fix is to drop `db` from these
 * signatures entirely and let tests mock @/lib/supabase/admin. That is a
 * ~20-call-site refactor and should be its own change, not a rider on this one.
 */

// Loosely-typed admin client, same convention as kill-switch.ts / section-access.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminDb = any

export type EntitlementGuardVerdict =
  | { allowed: true }
  | { allowed: false; reason: 'not-entitled' }

/**
 * Reads one institution's entitlement config. Throws on a database error so the
 * caller decides what to do, and the two callers decide differently on purpose:
 * checkEntitlement catches and fails open, while the two Plan editors catch it
 * and render "couldn't load". A permissive default is right when the question
 * is "may this professor act", and wrong when the question is "what does this
 * school own", because there the default states a falsehood as fact.
 */
export async function getEntitlementConfig(
  db: AdminDb,
  institutionId: string,
): Promise<EntitlementConfig> {
  const { data, error } = await db
    .from('institutions')
    .select('settings')
    .eq('id', institutionId)
    .single()
  if (error || !data) throw error ?? new Error('institution not found')
  return parseEntitlementConfig(data.settings)
}

/**
 * The guard. One call, one verdict; callers turn a refusal into their own
 * structured error ({ error } from actions, 403 JSON from routes) and never a
 * throw, matching checkAiFeature's contract.
 */
export async function checkEntitlement(
  db: AdminDb,
  institutionId: string,
  feature: EntitledFeatureKey,
  now: Date = new Date(),
): Promise<EntitlementGuardVerdict> {
  try {
    const config = await getEntitlementConfig(db, institutionId)
    const verdict = evaluateEntitlement(config, feature, now)
    return verdict.entitled ? { allowed: true } : { allowed: false, reason: 'not-entitled' }
  } catch (error) {
    logger.error(
      'Entitlements.checkEntitlement: config read failed — granting (fail-open)',
      error,
      { institutionId, feature },
    )
    return { allowed: true }
  }
}

/**
 * Section-scoped variant, for the many call sites that know their section but
 * not its institution. A missing section GRANTS, for the same reason the read
 * error does: this guard exists to enforce a contract, not to stop an attacker.
 * The ownership checks that ran before it are what keep a stranger out, and
 * they have already rejected an unknown section by this point.
 */
export async function checkEntitlementBySection(
  db: AdminDb,
  sectionId: string,
  feature: EntitledFeatureKey,
  now: Date = new Date(),
): Promise<EntitlementGuardVerdict> {
  try {
    const { data, error } = await db
      .from('course_sections')
      .select('institution_id')
      .eq('id', sectionId)
      .single()
    if (error || !data?.institution_id) throw error ?? new Error('section not found')
    return checkEntitlement(db, data.institution_id, feature, now)
  } catch (error) {
    logger.error(
      'Entitlements.checkEntitlementBySection: resolve failed — granting (fail-open)',
      error,
      { sectionId, feature },
    )
    return { allowed: true }
  }
}

/**
 * The whole config for one institution, for the surfaces that render every
 * feature at once (the two admin cards, the professor's course nav). Resolves
 * to "no overrides" on a read error, which grants everything, matching the
 * fail-open direction of checkEntitlement above.
 */
export async function resolveAllEntitlements(
  db: AdminDb,
  institutionId: string,
): Promise<EntitlementConfig> {
  try {
    return await getEntitlementConfig(db, institutionId)
  } catch (error) {
    logger.error('Entitlements.resolveAllEntitlements: read failed', error, { institutionId })
    return ENTITLEMENT_CONFIG_DEFAULT
  }
}

/**
 * Page-level guard: a route for a feature the institution has not bought is a
 * dead end, not a page with dead buttons. Mirrors `verifyFeatureEnabled` for
 * the per-section toggle, and follows the same rule in
 * `.claude/rules/dead-ends.md`: a URL that cannot resolve gets `notFound()`.
 *
 * Put this on the feature's TOP-LEVEL page, the one the nav links to and the
 * one that offers "Create". Detail pages for rows that already exist are
 * history, and §4.5 says history stays readable.
 *
 * Grants on a read error, same as every other check here.
 */
export async function verifyEntitled(
  db: AdminDb,
  sectionId: string,
  feature: EntitledFeatureKey,
): Promise<void> {
  const verdict = await checkEntitlementBySection(db, sectionId, feature)
  if (!verdict.allowed) {
    logger.warn('Entitlements.verifyEntitled: not entitled, dead-ending', { sectionId, feature })
    notFound()
  }
}

/** Section-scoped variant, for callers holding a section rather than a tenant. */
export async function resolveAllEntitlementsBySection(
  db: AdminDb,
  sectionId: string,
): Promise<EntitlementConfig> {
  try {
    const { data, error } = await db
      .from('course_sections')
      .select('institution_id')
      .eq('id', sectionId)
      .single()
    if (error || !data?.institution_id) throw error ?? new Error('section not found')
    return resolveAllEntitlements(db, data.institution_id)
  } catch (error) {
    logger.error('Entitlements.resolveAllEntitlementsBySection: resolve failed', error, {
      sectionId,
    })
    return ENTITLEMENT_CONFIG_DEFAULT
  }
}
