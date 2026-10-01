/**
 * athena-core — the model registry for the STUDENT Athena surface.
 *
 * Why this file exists rather than an import from `professor-assistant/models`:
 * the design (docs/designs/athena-students.md §2) makes the student surface a
 * standalone core so the two LIVE professor surfaces are never refactored to
 * serve it. The duplication is deliberate and temporary — convergence is Part 7,
 * conditional on this surface proving out. Nothing here may import from
 * `professor-assistant/*` or `assignment-assistant/*`.
 *
 * The one thing that is NOT duplicated is the enforcement plumbing underneath:
 * the `athena_rate_limits` table and the `athena_increment_rate_limit` RPC are
 * shared infrastructure (the RPC takes the cap as a PARAMETER), so students get
 * their own counter rows at their own caps without a second table or a second
 * RPC. See rate-limit.ts.
 *
 * Client-safe: pure data + types, no provider SDK import, no `server-only`.
 */

import { AI_TUTOR_MODEL } from '@/lib/ai/config'

export type StudentModelId = 'gemini-flash'

export interface StudentModelDef {
  /** Stable id; the only id the student surface may route to. */
  id: StudentModelId
  /** Display name, for a usage UI or a future picker. */
  label: string
  /** Underlying provider model string. */
  model: string
  /** Which provider client the server builds. Widen the union per new provider. */
  provider: 'google'
  /**
   * Max accepted user messages per student per rolling window for THIS model —
   * §10's per-student cap. Lower than the professor's 150 on purpose: a student
   * body is orders of magnitude larger than a faculty, so this number is what
   * bounds the per-institution tail. Tune here; nothing else hardcodes it.
   */
  dailyCap: number
  /**
   * Gemini thinking level. Pinned to the model's floor so time-to-first-token
   * stays low — reasoning tokens are the dominant latency cost on this surface.
   */
  thinkingLevel: 'minimal' | 'low' | 'medium' | 'high'
}

/**
 * The rolling window over which a student's accepted-request count accumulates.
 * No cron: the window resets implicitly on first use after it lapses (see the
 * athena_increment_rate_limit RPC).
 */
export const STUDENT_RATE_LIMIT_WINDOW_HOURS = 24

/**
 * The pool the student surface draws from. Every Athena surface has its own
 * independent pool at its own caps, so a professor draining the console never
 * touches a student's budget and vice versa.
 *
 * MUST stay in sync with the athena_rate_limits_scope_check CHECK constraint,
 * which 20260805150929_ai_tutor_rate_limit_scope.sql widened to include
 * 'tutor' — so this surface needs no migration of its own. That migration is
 * load-bearing, not cosmetic: reserveStudentSlot fails OPEN, so a deploy that
 * ran ahead of it would log the constraint violation and stop capping anyone.
 */
export const STUDENT_LIMIT_SCOPE = 'tutor'

/**
 * One model, because the student surface exposes no picker. §10 reserves a Pro
 * tier at 10/day for when one lands; adding it is one entry here plus failover
 * handling in reserveStudentSlot — deliberately not written until a picker can
 * actually select it.
 */
export const STUDENT_MODELS: StudentModelDef[] = [
  {
    id: 'gemini-flash',
    label: 'Gemini Flash',
    model: AI_TUTOR_MODEL,
    provider: 'google',
    dailyCap: 100,
    thinkingLevel: 'minimal',
  },
]

export const DEFAULT_STUDENT_MODEL_ID: StudentModelId = 'gemini-flash'

/** The model def the student route runs on. */
export function studentModelDef(id: StudentModelId = DEFAULT_STUDENT_MODEL_ID): StudentModelDef {
  return STUDENT_MODELS.find((m) => m.id === id) ?? STUDENT_MODELS[0]
}
