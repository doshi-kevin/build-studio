/**
 * The validator's ruleset: every check it runs, in one place. A verdict is reproducible
 * from the artifact hash, VALIDATOR_VERSION, the ruleset and the runtime version, all of
 * which each run records.
 *
 * Severity says WHY a check exists, so no static check is mistaken for a security
 * boundary (docs/reference/studio-plugin-validator.md, "Checks"):
 *   security     the runtime only detects it, or a check stops substitution of what runs
 *   reliability  the runtime already blocks it, so the plugin would break for students
 *   policy       a Studio rule the runtime can't enforce (kit, purpose, manifest)
 *   quality      measured in a browser: layout, accessibility, required states
 *
 * Bump STUDIO_VALIDATOR_RULESET whenever a check is added, removed or tightened. Raise
 * the minimum accepted ruleset (studio_validator_settings) only when old verdicts must
 * stop counting for new publication.
 */

/** The validator's own code version, recorded on every run. */
export const VALIDATOR_VERSION = '1.0.0'
/** The ruleset every new run uses. */
export const STUDIO_VALIDATOR_RULESET = 1
/** The runtime and bridge version the validator exercises. */
export const VALIDATOR_RUNTIME_VERSION = 'v1'

export type CheckStage = 'static' | 'runtime'
export type CheckSeverity = 'security' | 'reliability' | 'policy' | 'quality'

export interface CheckDefinition {
  id: string
  /** Studio rule numbers it enforces (studio-plugin-rules.md). */
  rules: readonly string[]
  stage: CheckStage
  severity: CheckSeverity
  /** A required check must pass for the version to pass. Non-required checks only warn. */
  required: boolean
  /** Its uncertain findings go to a Scholera reviewer (needs_review) instead of failing. */
  reviewable: boolean
  /** Manifest versions it applies to. A required check that needs v2 fails on v1. */
  manifestVersions: readonly (1 | 2)[]
  sinceRuleset: number
  /** One line for documentation and the professor. */
  summary: string
}

const BOTH = [1, 2] as const
const V2 = [2] as const

export const CHECKS = [
  // ── Stage 1: the artifact itself ──
  { id: 'artifact.hash', rules: ['8.4'], stage: 'static', severity: 'security', required: true, reviewable: false, manifestVersions: BOTH, sinceRuleset: 1, summary: 'The stored artifact is exactly the one being judged' },
  { id: 'artifact.size', rules: ['10.1'], stage: 'static', severity: 'reliability', required: true, reviewable: false, manifestVersions: BOTH, sinceRuleset: 1, summary: 'Source and bundles are within the size and file limits' },
  { id: 'artifact.entries', rules: ['9.4'], stage: 'static', severity: 'reliability', required: true, reviewable: false, manifestVersions: BOTH, sinceRuleset: 1, summary: 'Both views have their source entry and a non-empty bundle' },
  { id: 'artifact.vendor_free', rules: ['7.1', '8.7'], stage: 'static', severity: 'policy', required: true, reviewable: false, manifestVersions: BOTH, sinceRuleset: 1, summary: 'Bundles hold plugin code only; React and the kit come from the runtime' },
  { id: 'artifact.syntax', rules: ['8.7'], stage: 'static', severity: 'reliability', required: true, reviewable: false, manifestVersions: BOTH, sinceRuleset: 1, summary: 'Bundles are plain scripts the runtime can run, within parse limits' },
  { id: 'source.imports', rules: ['1.2', '7.1'], stage: 'static', severity: 'reliability', required: true, reviewable: false, manifestVersions: BOTH, sinceRuleset: 1, summary: 'Source imports only React, the plugin kit and its own files' },
  { id: 'manifest.valid', rules: ['1.5', '4.5', '8.7'], stage: 'static', severity: 'policy', required: true, reviewable: false, manifestVersions: BOTH, sinceRuleset: 1, summary: 'The manifest parses under its declared version' },
  // ── Stage 1: plugin code ──
  { id: 'code.navigation', rules: ['1.2', '2.5'], stage: 'static', severity: 'security', required: true, reviewable: false, manifestVersions: BOTH, sinceRuleset: 1, summary: 'No code that navigates the frame (the one channel the runtime only detects)' },
  { id: 'code.global_indirection', rules: ['1.2'], stage: 'static', severity: 'security', required: true, reviewable: false, manifestVersions: BOTH, sinceRuleset: 1, summary: 'No hidden access to browser globals that would slip past the other checks' },
  { id: 'code.html_injection', rules: ['6.5', '1.2'], stage: 'static', severity: 'security', required: true, reviewable: false, manifestVersions: BOTH, sinceRuleset: 1, summary: 'No raw HTML injection, which can build links that navigate' },
  { id: 'code.dynamic_code', rules: ['1.1'], stage: 'static', severity: 'reliability', required: true, reviewable: false, manifestVersions: BOTH, sinceRuleset: 1, summary: 'No eval, new Function, string timers or dynamic import (the policy blocks them)' },
  { id: 'code.network', rules: ['1.2'], stage: 'static', severity: 'reliability', required: true, reviewable: false, manifestVersions: BOTH, sinceRuleset: 1, summary: 'No fetch, XHR, WebSocket, EventSource or beacons (the policy blocks them)' },
  { id: 'code.storage', rules: ['3.1'], stage: 'static', severity: 'reliability', required: true, reviewable: false, manifestVersions: BOTH, sinceRuleset: 1, summary: 'No cookies, localStorage, sessionStorage, IndexedDB or caches (the sandbox blocks them)' },
  { id: 'code.workers', rules: ['1.2'], stage: 'static', severity: 'reliability', required: true, reviewable: false, manifestVersions: BOTH, sinceRuleset: 1, summary: 'No workers or service workers (the policy blocks them)' },
  { id: 'code.device_apis', rules: ['1.4'], stage: 'static', severity: 'reliability', required: true, reviewable: false, manifestVersions: BOTH, sinceRuleset: 1, summary: 'No camera, microphone, location, clipboard, notifications or WebRTC (blocked; power goes through capabilities)' },
  { id: 'code.bridge_usage', rules: ['1.5', '4.5'], stage: 'static', severity: 'reliability', required: true, reviewable: false, manifestVersions: BOTH, sinceRuleset: 1, summary: 'Bridge calls name methods this view declares; no bypass of the Bridge' },
  { id: 'code.external_urls', rules: ['1.2'], stage: 'static', severity: 'reliability', required: false, reviewable: false, manifestVersions: BOTH, sinceRuleset: 1, summary: 'External URLs in plugin code (a warning: text may mention a link)' },
  // ── Stage 1: plugin kit ──
  { id: 'kit.components_only', rules: ['7.1', '7.6'], stage: 'static', severity: 'policy', required: true, reviewable: false, manifestVersions: BOTH, sinceRuleset: 1, summary: 'Screens are built from kit components, not raw HTML elements or DOM calls' },
  { id: 'kit.no_hardcoded_style', rules: ['7.1', '7.2'], stage: 'static', severity: 'policy', required: true, reviewable: false, manifestVersions: BOTH, sinceRuleset: 1, summary: 'No styles or hard-coded colors; only kit tokens' },
  { id: 'kit.required_states', rules: ['7.5'], stage: 'static', severity: 'policy', required: true, reviewable: false, manifestVersions: BOTH, sinceRuleset: 1, summary: 'Each view uses the kit’s loading, empty and error states' },
  // ── Stage 1: data and edtech ──
  { id: 'data.answer_key', rules: ['5.2'], stage: 'static', severity: 'policy', required: true, reviewable: true, manifestVersions: BOTH, sinceRuleset: 1, summary: 'No likely answer key in the student view (a heuristic; review if found)' },
  { id: 'edtech.purpose', rules: ['9.6'], stage: 'static', severity: 'policy', required: true, reviewable: true, manifestVersions: V2, sinceRuleset: 1, summary: 'The tool is for teaching, learning or running the course' },
  { id: 'edtech.signals', rules: ['3.4'], stage: 'static', severity: 'policy', required: true, reviewable: false, manifestVersions: V2, sinceRuleset: 1, summary: 'Tracking uses only the shared signal list' },
  { id: 'edtech.skill_slots', rules: ['4.3', '2.4'], stage: 'static', severity: 'policy', required: true, reviewable: false, manifestVersions: V2, sinceRuleset: 1, summary: 'Skill slots name concepts, never a section’s skills' },
  { id: 'edtech.ai_fallback', rules: ['6.2'], stage: 'static', severity: 'policy', required: true, reviewable: false, manifestVersions: V2, sinceRuleset: 1, summary: 'The manifest says what happens when AI is switched off' },
  // ── Stage 2: the plugin running in the Step 4 sandbox ──
  { id: 'runtime.boot', rules: ['8.7', '7.5'], stage: 'runtime', severity: 'reliability', required: true, reviewable: false, manifestVersions: BOTH, sinceRuleset: 1, summary: 'Each view completes the handshake and renders without crashing' },
  { id: 'runtime.isolation', rules: ['1.2', '2.5'], stage: 'runtime', severity: 'security', required: true, reviewable: false, manifestVersions: BOTH, sinceRuleset: 1, summary: 'No request leaves the sandbox, and the frame never navigates' },
  { id: 'runtime.mobile_layout', rules: ['7.3'], stage: 'runtime', severity: 'quality', required: true, reviewable: false, manifestVersions: BOTH, sinceRuleset: 1, summary: 'Nothing scrolls sideways at phone width' },
  { id: 'runtime.touch_targets', rules: ['7.3'], stage: 'runtime', severity: 'quality', required: true, reviewable: false, manifestVersions: BOTH, sinceRuleset: 1, summary: 'Every control is at least 44 by 44 pixels' },
  { id: 'runtime.accessibility', rules: ['7.4'], stage: 'runtime', severity: 'quality', required: true, reviewable: false, manifestVersions: BOTH, sinceRuleset: 1, summary: 'An automated WCAG A and AA scan (axe-core) finds no violations' },
  { id: 'runtime.states', rules: ['7.5'], stage: 'runtime', severity: 'quality', required: true, reviewable: false, manifestVersions: BOTH, sinceRuleset: 1, summary: 'Loading, empty and error states appear, with no raw error text' },
] as const satisfies readonly CheckDefinition[]

export type CheckId = (typeof CHECKS)[number]['id']
export type StaticCheckId = Extract<(typeof CHECKS)[number], { stage: 'static' }>['id']
export type RuntimeCheckId = Extract<(typeof CHECKS)[number], { stage: 'runtime' }>['id']

export function checksFor(stage: CheckStage, ruleset = STUDIO_VALIDATOR_RULESET): readonly CheckDefinition[] {
  return CHECKS.filter((c) => c.stage === stage && c.sinceRuleset <= ruleset)
}

export const RUNTIME_CHECK_IDS = checksFor('runtime').map((c) => c.id) as RuntimeCheckId[]

export function checkDefinition(id: string): CheckDefinition | undefined {
  return CHECKS.find((c) => c.id === id)
}
