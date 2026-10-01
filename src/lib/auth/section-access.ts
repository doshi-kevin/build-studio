// Centralized section-access check for professor + TA/grader routes.
// Callers use this to decide (a) whether the user can see the section at all,
// and (b) what role they're acting as, so write buttons and write server
// actions can be gated accordingly. Reuses the professor UI tree for staff
// instead of duplicating /staff views.

import { createAdminClient } from '@/lib/supabase/admin'

export type SectionRole = 'professor' | 'ta' | 'grader'

export interface SectionAccessOk {
  ok: true
  role: SectionRole
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminDb: any
}

export interface SectionAccessDenied {
  ok: false
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminDb: any
}

export type SectionAccess = SectionAccessOk | SectionAccessDenied

/**
 * Resolve the caller's role for a given section.
 * Returns { ok: true, role } if the caller is either the section's professor
 * or an active TA/grader; { ok: false } otherwise.
 *
 * Callers must already have an authenticated `userId` — this function does
 * NOT call `auth.getUser()` itself. Keep session resolution in the page/action.
 */
export async function verifySectionAccess(
  sectionId: string,
  userId: string,
): Promise<SectionAccess> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any

  const { data: section } = await adminDb
    .from('course_sections')
    .select('id, professor_id')
    .eq('id', sectionId)
    .maybeSingle()

  if (!section) return { ok: false, adminDb }

  if (section.professor_id === userId) {
    return { ok: true, role: 'professor', adminDb }
  }

  const { data: staff } = await adminDb
    .from('section_staff')
    .select('role')
    .eq('section_id', sectionId)
    .eq('staff_id', userId)
    .eq('status', 'active')
    .gt('ends_at', new Date().toISOString())
    .maybeSingle()

  if (staff?.role === 'ta') return { ok: true, role: 'ta', adminDb }
  if (staff?.role === 'grader') return { ok: true, role: 'grader', adminDb }

  return { ok: false, adminDb }
}

/*
 * THE CAPABILITY MODEL. Three predicates, and which one a call site picks is a
 * decision, not a coin flip — this comment is the specification, because there
 * isn't one anywhere else.
 *
 *   canWriteAsProfessor  professor              destructive + irreversible
 *   canWriteAsStaff      professor, ta          authoring: content, announcements
 *   canGrade             professor, ta, grader  score AND feedback writes on a submission
 *
 * Two things this pins down that used to be accidental:
 *
 * DESTRUCTIVE OPERATIONS ARE PROFESSOR-ONLY (#749). assignments/actions.ts reached
 * for canWriteAsStaff at all 45 of its call sites, deleteAssignment included, so a
 * TA could permanently delete any assignment in the section — while quizzes,
 * projects and live-classroom reserved the equivalent for the professor. The guards
 * were all present and holding; they simply disagreed with each other depending on
 * which predicate the author happened to use. A TA is often a graduate student and
 * assignment deletion is unrecoverable, so the safe reading wins.
 *
 * GRADERS CAN GRADE (#746). canWriteAsStaff was the gate for grading too, which made
 * a role named "grader" strictly less capable than a TA at the one thing its name
 * describes: the grading form rendered fully enabled and every save silently
 * no-opped. Score and submission-feedback writes now go through canGrade. This is
 * deliberately NARROW — graders grade, and nothing else. Announcements, content and
 * destructive actions stay where they were, and so does suggestGrades: it calls an LLM,
 * and admitting graders there would widen who can spend AI budget rather than who can
 * grade.
 *
 * A UI that offers an action this file will refuse is the other half of the bug. Both
 * issues were reported as "enabled control that does nothing", so gate the control on
 * the same predicate as the action; verifySectionAccess already returns the role.
 */

/**
 * What the reader sees when their role can't perform the write.
 *
 * Six actions returned the literal string 'FORBIDDEN', which the UI toasted
 * verbatim — so a course assistant clicking a control their role can't use got a
 * raw error code. ui-design.md is explicit that status codes must never reach the
 * screen, and #746 asks for a refusal that actually says something. Deliberately
 * does NOT name the role or the required permission: it is the same wording on
 * every surface, so it can't be used to probe what a role can do.
 */
export const ROLE_DENIED_MESSAGE =
  "You don't have permission to do that in this course. Ask the professor if you need access."

/** Destructive and irreversible operations. Professor only. */
export function canWriteAsProfessor(role: SectionRole): boolean {
  return role === 'professor'
}

/** Authoring writes — content, announcements, assignment setup. Not grading (see canGrade). */
export function canWriteAsStaff(role: SectionRole): boolean {
  return role === 'professor' || role === 'ta'
}

/** Score and feedback writes on a submission, plus final grades. Includes graders. */
export function canGrade(role: SectionRole): boolean {
  return role === 'professor' || role === 'ta' || role === 'grader'
}
