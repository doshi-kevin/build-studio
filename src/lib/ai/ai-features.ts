/**
 * AI Feature Registry — single source of truth for the AI kill switch.
 *
 * Every AI capability in the product belongs to exactly one of these groups.
 * The admin UIs (institution admin + super admin), the write-action validation,
 * and the server-side guard (kill-switch.ts) all derive from this list — adding
 * an AI feature group means appending here, nowhere else.
 *
 * Client-safe: no secrets, no server-only imports (the settings UIs render this).
 *
 * Policy storage (see the ai_kill_switch migration):
 *   platform_settings.settings.ai.global      — super admin, ALL institutions
 *   institutions.settings.ai.platform         — super admin, one institution
 *   institutions.settings.ai.institution      — institution admin, own institution
 * A feature is disabled iff ANY layer disables it (allDisabled sentinel or the
 * key listed). Layers never mutate each other, so an institution admin's own
 * choices survive a platform lock and resume when it lifts.
 */

export const AI_FEATURES = [
  {
    key: 'athena-professor',
    label: 'Athena for Professors',
    description: 'The AI assistant professors use to draft assignments, quizzes, and grading help',
  },
  {
    key: 'athena-student',
    label: 'Athena for Students (AI Tutor)',
    description: 'The AI tutor students chat with about course material',
  },
  {
    key: 'quiz-ai',
    label: 'Quiz AI',
    description: 'AI quiz generation, question quality checks, and adaptive-quiz AI grading',
  },
  {
    key: 'assignment-ai',
    label: 'Assignment AI',
    description: 'AI rubric generation, grade suggestions, and verbal-assessment audio',
  },
  {
    key: 'live-classroom-ai',
    label: 'Live Classroom AI',
    description: 'Live transcription, post-class insights, study packs, session reports, and instant quizzes',
  },
  {
    key: 'preclass-ai',
    label: 'Pre-Class Primers',
    description: 'AI-narrated audio previews of upcoming lectures',
  },
  {
    key: 'roadmap-skills-ai',
    label: 'Roadmap & Skills AI',
    description: 'AI class insights, student insight summaries, knowledge checks, and skill tagging',
  },
  {
    key: 'content-ai',
    label: 'Course Material AI',
    description: 'AI document processing — formula extraction and AI search indexing',
  },
  {
    key: 'projects-ai',
    label: 'Project AI',
    description: 'AI-generated project phase plans for student teams',
  },
  {
    // Its own group (rule 6.2): switching it off sends every purpose check to a person.
    key: 'studio-validator',
    label: 'Studio Tool Checks',
    description: 'AI help deciding whether a Studio tool is for teaching, before students can see it',
  },
] as const

export type AiFeatureKey = (typeof AI_FEATURES)[number]['key']

export const AI_FEATURE_KEYS = AI_FEATURES.map((f) => f.key) as AiFeatureKey[]
const KEY_SET: ReadonlySet<string> = new Set(AI_FEATURE_KEYS)

export function isAiFeatureKey(key: string): key is AiFeatureKey {
  return KEY_SET.has(key)
}

/**
 * One layer of the kill-switch policy. `allDisabled` is a sentinel — when true,
 * EVERY AI feature (including ones added after the admin saved) is off, and the
 * individual switches are inert but preserved. `version` is the optimistic-
 * concurrency guard checked by the set_institution_ai_policy RPC.
 */
export interface AiPolicyLayer {
  allDisabled: boolean
  disabledFeatures: string[]
  version: number
}

const asBool = (v: unknown): boolean => v === true

/** The enabled default — what a missing or malformed layer resolves to. */
export const AI_POLICY_LAYER_DEFAULT: AiPolicyLayer = {
  allDisabled: false,
  disabledFeatures: [],
  version: 1,
}

/**
 * Parses one policy layer from raw JSONB. Never throws, and salvages PER FIELD:
 * a MISSING/garbage blob resolves to the ENABLED default (the OFF state must
 * come from an explicitly stored flag, never from a parse bug — the inverse of
 * selfUnenroll's direction, deliberately), but a stored `allDisabled: true`
 * survives corruption in its SIBLING fields — a bad `version` must never
 * silently undo a compliance kill. Unknown feature keys are dropped, so junk
 * written by a hand-crafted RPC call is inert.
 */
export function parseAiPolicyLayer(raw: unknown): AiPolicyLayer {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return AI_POLICY_LAYER_DEFAULT
  const obj = raw as Record<string, unknown>
  return {
    allDisabled: asBool(obj.allDisabled),
    disabledFeatures: Array.isArray(obj.disabledFeatures)
      ? obj.disabledFeatures.filter((v): v is string => typeof v === 'string').filter(isAiFeatureKey).slice(0, 32)
      : [],
    version:
      typeof obj.version === 'number' && Number.isInteger(obj.version) && obj.version >= 1 ? obj.version : 1,
  }
}

export interface InstitutionAiPolicy {
  /** Super admin, this institution (institutions.settings.ai.platform). */
  platform: AiPolicyLayer
  /** Institution admin, own institution (institutions.settings.ai.institution). */
  institution: AiPolicyLayer
}

/** Parses institutions.settings → the two per-institution layers. Never throws. */
export function parseInstitutionAiPolicy(settings: unknown): InstitutionAiPolicy {
  const ai =
    settings && typeof settings === 'object'
      ? (settings as Record<string, unknown>).ai
      : undefined
  const layers = ai && typeof ai === 'object' ? (ai as Record<string, unknown>) : {}
  return {
    platform: parseAiPolicyLayer(layers.platform),
    institution: parseAiPolicyLayer(layers.institution),
  }
}

function layerDisables(layer: AiPolicyLayer, feature: AiFeatureKey): boolean {
  return layer.allDisabled || layer.disabledFeatures.includes(feature)
}

export type AiFeatureVerdict =
  | { allowed: true }
  /**
   * lockedBy provenance drives copy: 'global'/'platform' → "by Scholera",
   * 'institution' → "by your institution's administration".
   */
  | { allowed: false; lockedBy: 'global' | 'platform' | 'institution' }

/** Pure union-of-layers rule. Global (platform-wide) layer is passed separately. */
export function evaluateAiFeature(
  global: AiPolicyLayer,
  policy: InstitutionAiPolicy,
  feature: AiFeatureKey,
): AiFeatureVerdict {
  if (layerDisables(global, feature)) return { allowed: false, lockedBy: 'global' }
  if (layerDisables(policy.platform, feature)) return { allowed: false, lockedBy: 'platform' }
  if (layerDisables(policy.institution, feature)) return { allowed: false, lockedBy: 'institution' }
  return { allowed: true }
}

/** The refusal end users see when a feature is administratively disabled. */
export function aiDisabledMessage(lockedBy: 'global' | 'platform' | 'institution'): string {
  return lockedBy === 'institution'
    ? "AI features are currently disabled by your institution's administration."
    : 'AI features are currently disabled for your institution.'
}

/** The refusal used when the guard cannot READ the policy (fail-closed path). */
export const AI_UNAVAILABLE_MESSAGE =
  'AI features are temporarily unavailable. Please try again shortly.'

/** Verdict → user-facing refusal, covering the fail-closed 'error' case. */
export function aiRefusalMessage(
  lockedBy: 'global' | 'platform' | 'institution' | 'error',
): string {
  return lockedBy === 'error' ? AI_UNAVAILABLE_MESSAGE : aiDisabledMessage(lockedBy)
}
