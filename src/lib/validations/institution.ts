// Zod schema for super_admin institution operations.
// `primaryAdmin*` fields are optional — institutions can exist without an admin
// (the UI surfaces a warning). When email is provided, name becomes required.

import { z } from 'zod'

export const createInstitutionSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'Institution name is required')
      .max(200, 'Institution name must be 200 characters or fewer'),
    slug: z
      .string()
      .trim()
      .min(2, 'Slug must be at least 2 characters')
      .max(50, 'Slug must be 50 characters or fewer')
      .regex(/^[a-z0-9-]+$/, 'Slug may only contain lowercase letters, digits, and hyphens'),
    primaryAdminEmail: z
      .string()
      .trim()
      .email('Invalid email')
      .optional()
      .or(z.literal('').transform(() => undefined)),
    primaryAdminName: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .or(z.literal('').transform(() => undefined)),
  })
  .refine(
    /* Bidirectional check: either both admin fields are set, or both are absent.
     * Without this, a user typing only a name (no email) would submit silently
     * and the institution would be created without an admin — a UX trap. */
    (data) => !!data.primaryAdminEmail === !!data.primaryAdminName,
    {
      message: 'Both admin email and name are required, or leave both blank',
      path: ['primaryAdminEmail'],
    },
  )

export type CreateInstitutionInput = z.infer<typeof createInstitutionSchema>

/** Schema for inviting an admin to an existing institution (Phase 2 detail page).
 * Used when the empty-state warning prompts the super_admin to assign an admin. */
export const inviteAdminSchema = z.object({
  institutionId: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email(),
})

export type InviteAdminInput = z.infer<typeof inviteAdminSchema>

// ── Add/drop policy (issue #159) ────────────────────────────────────────────
// Institution-level policy for STUDENT self-drop only. Admin-initiated
// unenroll is a separate flow and is never gated by this.

/** Upper bound matches the institutions_add_drop_deadline_days_check constraint. */
export const MAX_ADD_DROP_DEADLINE_DAYS = 365

export const updateAddDropPolicySchema = z.object({
  allowStudentDrop: z.boolean(),
  /** null = no deadline; students may self-drop for the whole term. */
  addDropDeadlineDays: z
    .number()
    .int('Enter a whole number of days')
    .min(0, 'Days cannot be negative')
    .max(MAX_ADD_DROP_DEADLINE_DAYS, `Days must be ${MAX_ADD_DROP_DEADLINE_DAYS} or fewer`)
    .nullable(),
})

export type UpdateAddDropPolicyInput = z.infer<typeof updateAddDropPolicySchema>

export interface AddDropPolicy {
  allowStudentDrop: boolean
  addDropDeadlineDays: number | null
}

/**
 * Read the add/drop policy off an institution row. Both columns are new, so an
 * institution fetched before the migration (or a null row) parses to the
 * permissive default — self-drop allowed, no deadline — which is exactly the
 * behaviour that shipped before this policy existed.
 */
export function parseAddDropPolicy(institution: unknown): AddDropPolicy {
  const row = (institution ?? {}) as {
    allow_student_drop?: unknown
    add_drop_deadline_days?: unknown
  }
  const days = row.add_drop_deadline_days
  return {
    allowStudentDrop: row.allow_student_drop === false ? false : true,
    addDropDeadlineDays: typeof days === 'number' && Number.isFinite(days) ? days : null,
  }
}

/**
 * The last moment a student may self-drop, or null when no deadline applies
 * (policy has no deadline configured, or the section has no start_date to
 * anchor one to). Dates are parsed at server-local midnight to match how the
 * enrollment window is evaluated in enrollInSection().
 */
/**
 * Is self-unenroll still open for a section?
 *
 * The single predicate BOTH the student course layout (which decides whether to show the
 * button) and dropSection (which decides whether to honour it) call, so the two cannot
 * drift into showing an action the server refuses (#744). Keeping the clock read inside
 * here also matches canSelfUnenroll, the helper this replaces.
 *
 * PERMISSIVE when no deadline applies, which is what parseAddDropPolicy documents: a null
 * `addDropDeadlineDays` means self-drop stays open for the whole term, and that is the
 * behaviour that shipped before any policy existed. My first version returned false here on
 * the theory that missing configuration should fail closed. That inverted the design and
 * would have silently removed self-drop from every institution, since none has a day count
 * set. `allowStudentDrop` is the switch for turning it off; absence of a deadline is not.
 *
 * A section with no start_date is the one genuine unknown: there is nothing to anchor a
 * configured window to, so a configured window cannot be honoured. That stays closed.
 */
export function withinAddDropWindow(
  policy: AddDropPolicy,
  sectionStartDate: string | null | undefined,
): boolean {
  if (!policy.allowStudentDrop) return false
  // No configured deadline: open all term.
  if (policy.addDropDeadlineDays === null) return true
  const deadline = addDropDeadline(policy, sectionStartDate)
  if (!deadline) return false
  return Date.now() <= deadline.getTime()
}

export function addDropDeadline(
  policy: AddDropPolicy,
  sectionStartDate: string | null | undefined,
): Date | null {
  if (policy.addDropDeadlineDays === null || !sectionStartDate) return null
  const deadline = new Date(sectionStartDate + 'T00:00:00')
  if (Number.isNaN(deadline.getTime())) return null
  deadline.setDate(deadline.getDate() + policy.addDropDeadlineDays)
  deadline.setHours(23, 59, 59, 999)
  return deadline
}

/**
 * Why a student cannot self-drop this section, or null if they can. The string
 * is user-facing copy — the server action returns it as `{ error }` and the UI
 * renders it verbatim, so the reason exists in exactly one place.
 *
 * Permissive by default: an institution that has configured nothing keeps the
 * pre-#159 behaviour rather than trapping its students in their courses.
 */
export function selfDropBlockedReason(
  policy: AddDropPolicy,
  sectionStartDate: string | null | undefined,
  now: Date = new Date(),
): string | null {
  if (!policy.allowStudentDrop) {
    return 'Your institution handles course withdrawals directly — contact your registrar to drop this course.'
  }

  const deadline = addDropDeadline(policy, sectionStartDate)
  if (!deadline || now <= deadline) return null

  const formatted = deadline.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
  return `The add/drop period for this course ended on ${formatted} — contact your institution to withdraw.`
}
