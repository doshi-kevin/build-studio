/**
 * Student Course Actions — self-unenroll, gated by institution policy.
 *
 * Enrollment is admin-driven (see docs/designs/platform/admin-roster-import.md): students
 * cannot enroll themselves, and may unenroll ONLY while the institution's
 * self-unenroll policy allows it — the admin's toggle is on AND we're within
 * `days` days of this enrollment's enrolled_at. Outside the window, roster
 * changes go through the institution admin.
 *
 * The sidebar hides the button when the window is closed; this action re-checks
 * the policy regardless — the client is untrusted.
 */
'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { profileQueries } from '@/lib/supabase/queries'
import { logger } from '@/lib/logger'
import { logEvent } from '@/lib/supabase/event-logger'
import { parseInstitutionSettings } from '@/lib/validations/institution-settings'
import { addDropDeadline, withinAddDropWindow, parseAddDropPolicy } from '@/lib/validations/institution'

/** Helper: verify the caller is an authenticated student (with tenant). */
async function verifyStudent(): Promise<{ userId: string; institutionId: string } | { error: string }> {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return { error: 'Not authenticated' }
  }

  const profile = await profileQueries.getProfileById(supabase, user.id)
  if (!profile || profile.role !== 'student') {
    logger.warn('Student action: Unauthorized', { userId: user.id, role: profile?.role })
    return { error: 'Unauthorized — student access required' }
  }

  const institutionId = (profile as { institution_id?: string | null }).institution_id
  if (!institutionId) {
    logger.error('Student action: profile has no institution_id', null, { userId: user.id })
    return { error: 'Your account is missing tenant assignment. Contact support.' }
  }

  return { userId: user.id, institutionId }
}

/**
 * Unenroll from a course section (status → 'dropped'; the record is preserved).
 * Allowed only inside the institution's self-unenroll window.
 */
export async function dropSection(
  sectionId: string,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const auth = await verifyStudent()
    if ('error' in auth) return { error: auth.error }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    /* Find the active enrollment. The student_id filter is the tenant boundary —
     * a student can only have enrollments in their own institution, so a
     * cross-tenant section UUID would not match any of their rows. */
    const [{ data: enrollment, error: findError }, { data: institution }, { data: section }] =
      await Promise.all([
        adminDb
          .from('enrollments')
          .select('id, status, enrolled_at')
          .eq('section_id', sectionId)
          .eq('student_id', auth.userId)
          .eq('status', 'enrolled')
          .maybeSingle(),
        adminDb
          .from('institutions')
          .select('settings, add_drop_deadline_days')
          .eq('id', auth.institutionId)
          .maybeSingle(),
        adminDb.from('course_sections').select('start_date').eq('id', sectionId).maybeSingle(),
      ])

    if (findError || !enrollment) {
      return { error: 'No active enrollment found for this section' }
    }

    /* Master switch first: an institution can turn self-unenroll off entirely. Fails closed
       when settings are missing or malformed. */
    const { selfUnenroll } = parseInstitutionSettings(institution?.settings)
    if (!selfUnenroll.enabled) {
      return { error: 'Unenrolling yourself is not available for this course. Contact your administrator to be removed.' }
    }

    /* The deadline is anchored to the SECTION's start date, not to this student's own
       enrolled_at (#744). Anchoring per student gave two people who enrolled a week apart
       two different deadlines for the same course, which is not what an add/drop period is.
       Registrars — Canvas, Banner, PeopleSoft alike — treat it as one date off the term.
       This wires up addDropDeadline(), which was written correctly and had no caller. */
    const policy = parseAddDropPolicy(institution)
    if (!withinAddDropWindow(policy, section?.start_date)) {
      const deadline = addDropDeadline(policy, section?.start_date)
      /* Name the date when there is one. "Not available" on a course whose window simply
         closed reads as a bug rather than a policy. A null deadline never reaches here:
         withinAddDropWindow treats "no configured deadline" as open all term. */
      return {
        error: deadline
          ? `The add/drop period for this course ended on ${deadline.toLocaleDateString()}. Contact your administrator to be removed.`
          : 'Unenrolling yourself is not available for this course. Contact your administrator to be removed.',
      }
    }

    /* Status check in the WHERE so a concurrent drop/re-add can't be clobbered.
       dropped_at is set in the SAME statement, so the pair can never disagree — a second
       write could fail and leave a dropped row with no departure date, which the future
       retention sweep reads as "unknown" and skips forever. */
    const { data: updated, error: updateError } = await adminDb
      .from('enrollments')
      .update({ status: 'dropped', dropped_at: new Date().toISOString() })
      .eq('id', enrollment.id)
      .eq('status', 'enrolled')
      .select('id')

    if (updateError || !updated || updated.length === 0) {
      logger.error('dropSection: Update failed', updateError, { sectionId })
      return { error: 'Failed to unenroll. Please try again.' }
    }

    logger.info('dropSection: Success', { userId: auth.userId, sectionId })

    await logEvent({
      userId: auth.userId,
      sectionId,
      eventType: 'enrollment.self_drop',
      eventCategory: 'student',
      metadata: { sectionId, enrollmentId: enrollment.id },
    })

    revalidatePath('/student/courses')
    revalidatePath('/dashboard')

    return { success: true }
  } catch (error) {
    logger.error('dropSection: Exception', error)
    return { error: 'An unexpected error occurred' }
  }
}
