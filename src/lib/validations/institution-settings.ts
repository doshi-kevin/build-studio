/**
 * Institution Settings — institution-level policy stored in institutions.settings JSONB.
 *
 * Today one key: selfUnenroll — whether students may unenroll themselves, and for
 * how many days after being enrolled. Outside that window (or with the toggle off)
 * only the institution admin can remove a student.
 *
 * parseInstitutionSettings FAILS CLOSED: missing, malformed, or partial settings
 * resolve to { enabled: false } — a broken JSONB must never grant students an
 * ability the admin didn't switch on.
 */

import { z } from 'zod'

export const SELF_UNENROLL_MAX_DAYS = 365
export const SELF_UNENROLL_DEFAULT_DAYS = 14

export const selfUnenrollPolicySchema = z.object({
  enabled: z.boolean(),
  days: z.number().int().min(1).max(SELF_UNENROLL_MAX_DAYS),
})

export type SelfUnenrollPolicy = z.infer<typeof selfUnenrollPolicySchema>

export interface InstitutionSettings {
  selfUnenroll: SelfUnenrollPolicy
}

const DISABLED: SelfUnenrollPolicy = { enabled: false, days: SELF_UNENROLL_DEFAULT_DAYS }

/** Parses institutions.settings. Never throws; anything invalid → self-unenroll disabled. */
export function parseInstitutionSettings(raw: unknown): InstitutionSettings {
  if (!raw || typeof raw !== 'object') return { selfUnenroll: DISABLED }
  const parsed = selfUnenrollPolicySchema.safeParse((raw as Record<string, unknown>).selfUnenroll)
  return { selfUnenroll: parsed.success ? parsed.data : DISABLED }
}

/**
 * The self-unenroll window check, shared by the student course UI (show/hide the
 * button) and the dropSection action (the actual gate). UTC on both sides —
 * enrolled_at is a timestamptz and Date math here never touches local time.
 */
export function canSelfUnenroll(policy: SelfUnenrollPolicy, enrolledAt: string | null): boolean {
  if (!policy.enabled) return false
  if (!enrolledAt) return false
  const enrolledMs = Date.parse(enrolledAt)
  if (Number.isNaN(enrolledMs)) return false
  return Date.now() <= enrolledMs + policy.days * 24 * 60 * 60 * 1000
}
