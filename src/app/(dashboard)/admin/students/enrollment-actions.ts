/**
 * Enrollment Server Actions — admin operations for managing student enrollments.
 *
 * Used from the student detail page to enroll/unenroll students,
 * change enrollment status, and update grades.
 *
 * Actions:
 * - enrollStudent: Enroll a student in a course section
 * - unenrollStudent: Remove a student from a course section
 * - updateEnrollmentStatus: Change enrollment status (enrolled/completed/dropped/withdrawn)
 * - updateEnrollmentGrade: Update final grade and score
 */
'use server'

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { enrollmentAdminQueries } from '@/lib/supabase/queries'
import { verifyInstitutionAdmin } from '@/lib/auth/admin-context'
import { assertTenantOwns, assertTenantOwnsVia } from '@/lib/auth/assert-tenant-owns'
import { enrollStudentSchema, updateEnrollmentStatusSchema, updateGradeSchema } from '@/lib/validations/enrollment'
import { logger } from '@/lib/logger'
import { logEvent } from '@/lib/supabase/event-logger'
import type { EnrollStudentInput, UpdateEnrollmentStatusInput, UpdateGradeInput } from '@/lib/validations/enrollment'

/**
 * Enroll a student in a course section.
 * The DB has a UNIQUE(section_id, student_id) constraint — handles duplicate gracefully.
 */
export async function enrollStudent(input: EnrollStudentInput) {
  try {
    const auth = await verifyInstitutionAdmin('enrollment')
    if ('error' in auth) return { error: auth.error }

    const parsed = enrollStudentSchema.safeParse(input)
    if (!parsed.success) {
      const firstError = parsed.error.issues[0]
      return { error: firstError?.message || 'Validation failed' }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    /* Both the student AND the section must belong to the caller's
     * institution — prevents enrolling a tenant-A student into a tenant-B
     * section (or splitting tenants either direction). */
    const ownStudent = await assertTenantOwns(adminDb, 'profiles', parsed.data.student_id, auth.institutionId, { actionName: 'enrollStudent.student' })
    if (!ownStudent.ok) return { error: ownStudent.error }
    const ownSection = await assertTenantOwns(adminDb, 'course_sections', parsed.data.section_id, auth.institutionId, { actionName: 'enrollStudent.section' })
    if (!ownSection.ok) return { error: ownSection.error }

    const enrollment = await enrollmentAdminQueries.create(adminDb, parsed.data)

    if (!enrollment) {
      return { error: 'Failed to enroll student. They may already be enrolled in this section.' }
    }

    logger.info('enrollStudent: Success', { enrollmentId: enrollment.id })

    await logEvent({
      userId: auth.userId,
      eventType: 'enrollment.created',
      eventCategory: 'admin',
      metadata: { studentId: parsed.data.student_id, sectionId: parsed.data.section_id },
    })

    revalidatePath(`/admin/students/${parsed.data.student_id}`)
    revalidatePath('/admin')
    return { success: true, data: enrollment }
  } catch (error) {
    logger.error('enrollStudent: Exception', error)
    return { error: 'An unexpected error occurred' }
  }
}

/** Unenroll a student from a course section. */
export async function unenrollStudent(enrollmentId: string, studentId: string) {
  try {
    const auth = await verifyInstitutionAdmin('enrollment')
    if ('error' in auth) return { error: auth.error }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    /* Tenant guard via the parent course_section. */
    const own = await assertTenantOwnsVia(adminDb, 'enrollments', enrollmentId, 'section_id', 'course_sections', auth.institutionId, { actionName: 'unenrollStudent' })
    if (!own.ok) return { error: own.error }

    const success = await enrollmentAdminQueries.remove(adminDb, enrollmentId)

    if (!success) {
      return { error: 'Failed to unenroll student' }
    }

    logger.info('unenrollStudent: Success', { enrollmentId })

    await logEvent({
      userId: auth.userId,
      eventType: 'enrollment.deleted',
      eventCategory: 'admin',
      metadata: { enrollmentId, studentId },
    })

    revalidatePath(`/admin/students/${studentId}`)
    revalidatePath('/admin')
    return { success: true }
  } catch (error) {
    logger.error('unenrollStudent: Exception', error)
    return { error: 'An unexpected error occurred' }
  }
}

/** Update enrollment status. */
export async function updateEnrollmentStatus(
  enrollmentId: string,
  studentId: string,
  input: UpdateEnrollmentStatusInput
) {
  try {
    const auth = await verifyInstitutionAdmin('enrollment')
    if ('error' in auth) return { error: auth.error }

    const parsed = updateEnrollmentStatusSchema.safeParse(input)
    if (!parsed.success) {
      return { error: parsed.error.issues[0]?.message || 'Validation failed' }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    /* Tenant guard via the parent course_section. */
    const own = await assertTenantOwnsVia(adminDb, 'enrollments', enrollmentId, 'section_id', 'course_sections', auth.institutionId, { actionName: 'updateEnrollmentStatus' })
    if (!own.ok) return { error: own.error }

    const enrollment = await enrollmentAdminQueries.updateStatus(adminDb, enrollmentId, parsed.data.status)

    if (!enrollment) {
      return { error: 'Failed to update enrollment status' }
    }

    logger.info('updateEnrollmentStatus: Success', { enrollmentId, status: parsed.data.status })

    revalidatePath(`/admin/students/${studentId}`)
    return { success: true, data: enrollment }
  } catch (error) {
    logger.error('updateEnrollmentStatus: Exception', error)
    return { error: 'An unexpected error occurred' }
  }
}

/** Update enrollment grade (final_grade and/or final_score). */
export async function updateEnrollmentGrade(
  enrollmentId: string,
  studentId: string,
  input: UpdateGradeInput
) {
  try {
    const auth = await verifyInstitutionAdmin('enrollment')
    if ('error' in auth) return { error: auth.error }

    const parsed = updateGradeSchema.safeParse(input)
    if (!parsed.success) {
      return { error: parsed.error.issues[0]?.message || 'Validation failed' }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    /* Tenant guard via the parent course_section. Without this an admin
     * in tenant A could overwrite final grades on tenant-B enrollments. */
    const own = await assertTenantOwnsVia(adminDb, 'enrollments', enrollmentId, 'section_id', 'course_sections', auth.institutionId, { actionName: 'updateEnrollmentGrade' })
    if (!own.ok) return { error: own.error }

    const enrollment = await enrollmentAdminQueries.updateGrade(adminDb, enrollmentId, {
      final_grade: parsed.data.final_grade || undefined,
      final_score: parsed.data.final_score,
    })

    if (!enrollment) {
      return { error: 'Failed to update grade' }
    }

    logger.info('updateEnrollmentGrade: Success', { enrollmentId })

    revalidatePath(`/admin/students/${studentId}`)
    return { success: true, data: enrollment }
  } catch (error) {
    logger.error('updateEnrollmentGrade: Exception', error)
    return { error: 'An unexpected error occurred' }
  }
}
