/**
 * Feature entitlements — what an institution has BOUGHT, as opposed to what a
 * professor has switched on for one section (course_sections.settings.
 * enabledFeatures, see src/lib/validations/features.ts). Entitlement is the
 * ceiling; the per-section toggle can only subtract from it.
 *
 * Client-safe: no server-only imports, because the admin editors render this
 * registry. The read path lives in ./check.ts.
 *
 * Design doc: docs/designs/entitlements/feature-entitlements.md
 */

/**
 * Products are the sellable features. Everything else in COURSE_FEATURES is
 * either Platform (structurally required to run a course) or a Lens (a view
 * over evidence other features produced), and neither is ever entitled.
 *
 * `defaultEntitled` is what an institution gets when its stored config says
 * nothing about this key. Every product today ships `true`, which is how
 * "all toggles on" costs no migration. A future paid add-on ships `false` and
 * is off everywhere until explicitly granted — see §7 of the design doc for
 * why this beats both a pure deny-list and a pure allow-list.
 */
export const ENTITLED_FEATURES = [
  {
    key: 'quizzes',
    label: 'Quizzes',
    description: 'Quiz authoring, delivery, proctoring and adaptive practice',
    defaultEntitled: true,
  },
  {
    key: 'assignments',
    label: 'Assignments',
    description: 'Assignment authoring, submissions, rubrics and grading',
    defaultEntitled: true,
  },
  {
    key: 'live-classroom',
    label: 'Live Classroom',
    description: 'Live sessions, polls, attendance, transcription and recording',
    defaultEntitled: true,
  },
  {
    key: 'projects',
    label: 'Projects',
    description: 'Team projects with phased rubrics',
    defaultEntitled: true,
  },
  {
    key: 'discussions',
    label: 'Discussions',
    description: 'Threaded course discussion boards',
    defaultEntitled: true,
  },
  {
    key: 'challenges',
    label: 'Challenges',
    description: 'Practice challenges and leaderboards',
    defaultEntitled: true,
  },
  {
    key: 'athena',
    label: 'Athena',
    description: 'The AI assistant for professors and students',
    defaultEntitled: true,
  },
] as const

export type EntitledFeatureKey = (typeof ENTITLED_FEATURES)[number]['key']

export const ENTITLED_FEATURE_KEYS = ENTITLED_FEATURES.map((f) => f.key) as EntitledFeatureKey[]

const KEY_SET: ReadonlySet<string> = new Set(ENTITLED_FEATURE_KEYS)

export function isEntitledFeatureKey(key: string): key is EntitledFeatureKey {
  return KEY_SET.has(key)
}

const DEFAULTS: ReadonlyMap<string, boolean> = new Map(
  ENTITLED_FEATURES.map((f) => [f.key, f.defaultEntitled]),
)

/**
 * One institution's stored entitlement config. `granted` and `revoked` are
 * explicit overrides; a key in neither falls back to the registry default.
 * `pendingRevocation` maps a feature key to the ISO timestamp at which its
 * revocation takes effect — see §4.4 for why an off-switch is deferred and an
 * on-switch is not.
 *
 * `version` is the optimistic-concurrency guard the RPC checks, same shape as
 * the AI policy layers.
 */
export interface EntitlementConfig {
  granted: string[]
  revoked: string[]
  pendingRevocation: Record<string, string>
  version: number
}

export const ENTITLEMENT_CONFIG_DEFAULT: EntitlementConfig = {
  granted: [],
  revoked: [],
  pendingRevocation: {},
  version: 1,
}

function parseKeyList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((v): v is string => typeof v === 'string')
    .filter(isEntitledFeatureKey)
    .slice(0, 32)
}

function parsePending(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isEntitledFeatureKey(key)) continue
    if (typeof value !== 'string') continue
    // Unparseable dates are dropped rather than treated as "now". A corrupt
    // timestamp must not revoke a feature the customer is paying for.
    if (Number.isNaN(Date.parse(value))) continue
    out[key] = value
  }
  return out
}

/**
 * Parses institutions.settings.entitlements from raw jsonb. Never throws.
 *
 * Direction of salvage is the opposite of the AI kill switch: garbage resolves
 * to "no overrides", which means every feature falls back to its registry
 * default. A parse bug must not silently revoke a feature. Unknown keys are
 * dropped, so junk written by a hand-crafted RPC call is inert.
 */
export function parseEntitlementConfig(settings: unknown): EntitlementConfig {
  const raw =
    settings && typeof settings === 'object' && !Array.isArray(settings)
      ? (settings as Record<string, unknown>).entitlements
      : undefined
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ENTITLEMENT_CONFIG_DEFAULT
  const obj = raw as Record<string, unknown>
  return {
    granted: parseKeyList(obj.granted),
    revoked: parseKeyList(obj.revoked),
    pendingRevocation: parsePending(obj.pendingRevocation),
    version:
      typeof obj.version === 'number' && Number.isInteger(obj.version) && obj.version >= 1
        ? obj.version
        : 1,
  }
}

/**
 * How far ahead a revocation may be scheduled. Ten years is not a policy, it is
 * a typo filter: past that, the input is a mis-keyed year rather than a plan.
 */
export const MAX_SCHEDULE_YEARS = 10

/**
 * Is this a date an admin may schedule a revocation for?
 *
 * Two hazards, both from `<input type="date">` reporting a value on every
 * keystroke. A half-typed year can be unparseable ("12252-12-01"), which throws
 * from `.toISOString()`. It can also PARSE and be absurd ("6789-12-01"), or
 * parse and be historical ("0001-12-01") — and the historical case is the
 * dangerous one, because a stored past date revokes on save rather than
 * scheduling. There is an explicit "turn off now" control for that intent.
 *
 * Deliberately NOT applied inside evaluateEntitlement: this bounds what an
 * admin may PICK. A date already stored in the past must keep evaluating as
 * revoked, since that is how a deadline passes with no job running.
 *
 * The floor carries two days of slack, and the size is not arbitrary. A date
 * input yields the chosen day at UTC midnight, so a user west of Greenwich
 * picking their own "today" produces an instant already in the past. In Hawaii
 * (UTC-10), late in their day, that gap reaches ~34 hours. One day of slack
 * rejected them; two covers every inhabited zone with room to spare. Widening
 * it costs nothing, because the only thing this floor exists to catch is a
 * mis-keyed year, which is off by centuries rather than hours.
 */
const SCHEDULE_FLOOR_SLACK_MS = 48 * 60 * 60 * 1000

export function isSchedulableRevocationDate(value: string, now: Date = new Date()): boolean {
  const at = Date.parse(value)
  if (Number.isNaN(at)) return false
  const floor = now.getTime() - SCHEDULE_FLOOR_SLACK_MS
  const ceiling = Date.UTC(now.getUTCFullYear() + MAX_SCHEDULE_YEARS, 11, 31)
  return at >= floor && at <= ceiling
}

export type EntitlementVerdict =
  | { entitled: true; pendingRevocationAt: string | null }
  | { entitled: false }

/**
 * The rule, pure and total. `now` is injected so callers (and tests) control
 * the clock rather than reading it here.
 *
 * A pending revocation whose effective date has passed reads as revoked even
 * though nothing has rewritten the stored config yet, so the deadline holds
 * without a scheduled job. Once it has passed, a super admin save moves the
 * key into `revoked` and clears the pending entry, but correctness does not
 * depend on that happening.
 */
export function evaluateEntitlement(
  config: EntitlementConfig,
  feature: EntitledFeatureKey,
  now: Date,
): EntitlementVerdict {
  if (config.revoked.includes(feature)) return { entitled: false }

  const pendingAt = config.pendingRevocation[feature]
  if (pendingAt) {
    const effective = Date.parse(pendingAt)
    if (!Number.isNaN(effective) && effective <= now.getTime()) return { entitled: false }
    // Still entitled, but the UI should say when that ends.
    return { entitled: true, pendingRevocationAt: pendingAt }
  }

  if (config.granted.includes(feature)) return { entitled: true, pendingRevocationAt: null }
  return DEFAULTS.get(feature)
    ? { entitled: true, pendingRevocationAt: null }
    : { entitled: false }
}

/** What a professor sees when they try to use a feature the school has not bought. */
export function entitlementRefusalMessage(feature: EntitledFeatureKey): string {
  const label = ENTITLED_FEATURES.find((f) => f.key === feature)?.label ?? feature
  return `${label} is not part of your institution's plan. Ask an administrator to request it.`
}

/**
 * The refusal when the config could not be READ. Deliberately distinct copy:
 * an infrastructure error must never impersonate a commercial decision, the
 * same rule aiRefusalMessage follows.
 */
export const ENTITLEMENT_UNAVAILABLE_MESSAGE =
  'We could not confirm your institution’s plan just now. Please try again shortly.'
