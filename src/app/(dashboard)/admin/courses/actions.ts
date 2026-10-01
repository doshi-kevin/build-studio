/**
 * Course Assignment Server Actions — mutations for assigning professors to courses.
 *
 * "Assigning a professor to a course" creates a course_section row in the DB.
 * The UI simplifies this: admin picks course + professor + semester/year.
 *
 * Each action independently verifies the caller is a institution_admin before
 * executing any mutation (defense in depth).
 *
 * Actions:
 * - assignCourse: Create a new course section (assign professor to course)
 * - updateAssignment: Update an existing course section
 * - removeAssignment: Delete a course section
 *
 * All actions return { success, data } or { error: string }.
 */
'use server'

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { courseAssignmentQueries, courseAdminQueries } from '@/lib/supabase/queries'
import { verifyInstitutionAdmin } from '@/lib/auth/admin-context'
import { assertTenantOwns } from '@/lib/auth/assert-tenant-owns'
import { createCourseAssignmentSchema, updateCourseAssignmentSchema } from '@/lib/validations/course-assignment'
import { createCourseSchema } from '@/lib/validations/course'
import { logger } from '@/lib/logger'
import { logEvent } from '@/lib/supabase/event-logger'
import type { CreateCourseAssignmentInput, UpdateCourseAssignmentInput } from '@/lib/validations/course-assignment'
import type { CreateCourseInput } from '@/lib/validations/course'

/**
 * Create a new course in the master catalogue.
 */
/**
 * A section's professor must actually BE a professor.
 *
 * assertTenantOwns proves the id belongs to this institution; it says nothing about role.
 * That matters more here than it looks: `course_sections.professor_id` is the subject of a
 * large number of RLS policies and of verifySectionAccess, so naming a student grants them
 * professor-level reach into that section — the gradebook, every submission, the roster.
 *
 * Raised in security review of #716. The gap existed on assignCourse (create) already, so
 * the new update path added no capability — which is why it was rated minor — but both are
 * closed here rather than leaving one open as the documented way to do it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function assertIsProfessor(adminDb: any, professorId: string): Promise<boolean> {
  const { data } = await adminDb
    .from('profiles')
    .select('role')
    .eq('id', professorId)
    .maybeSingle()
  return data?.role === 'professor'
}

export async function createCourse(input: CreateCourseInput) {
  try {
    const auth = await verifyInstitutionAdmin('courses')
    if ('error' in auth) return { error: auth.error }

    const parsed = createCourseSchema.safeParse(input)
    if (!parsed.success) {
      const firstError = Object.values(parsed.error.flatten().fieldErrors).flat()[0]
      return { error: firstError || 'Invalid input' }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    const course = await courseAdminQueries.create(adminDb, { ...parsed.data, institution_id: auth.institutionId })
    if (!course) return { error: 'Failed to create course' }

    logger.info('createCourse: Success', { courseId: course.id, code: course.code, userId: auth.userId })
    logEvent({ userId: auth.userId, eventType: 'course.created', metadata: { courseId: course.id, code: course.code } })
    revalidatePath('/admin/courses')
    return { success: true, data: course }
  } catch (error) {
    logger.error('createCourse', error)
    return { error: 'Unexpected error' }
  }
}

/**
 * Assign a professor to a course by creating a course section.
 * Auto-generates section_code if not provided.
 */
export async function assignCourse(input: CreateCourseAssignmentInput) {
  try {
    const auth = await verifyInstitutionAdmin('courses')
    if ('error' in auth) return { error: auth.error }

    const parsed = createCourseAssignmentSchema.safeParse(input)
    if (!parsed.success) {
      const fieldErrors = parsed.error.flatten().fieldErrors
      const firstError = Object.values(fieldErrors).flat()[0]
      logger.warn('assignCourse: Validation failed', { errors: fieldErrors })
      return { error: firstError || 'Invalid input' }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    const data = parsed.data

    /* Tenant guard on the parent course AND professor — both must belong
     * to the caller's institution. Prevents wiring a tenant-A course to a
     * tenant-B professor (or vice versa) into a new section row. */
    const ownCourse = await assertTenantOwns(adminDb, 'courses', data.course_id, auth.institutionId, { actionName: 'assignCourse.course' })
    if (!ownCourse.ok) return { error: ownCourse.error }
    const ownProf = await assertTenantOwns(adminDb, 'profiles', data.professor_id, auth.institutionId, { actionName: 'assignCourse.professor' })
    if (!ownProf.ok) return { error: ownProf.error }
    if (!(await assertIsProfessor(adminDb, data.professor_id))) {
      return { error: 'That person is not a professor in your institution.' }
    }

    const { data: section, error: dbError } = await courseAssignmentQueries.create(adminDb, {
      course_id: data.course_id,
      professor_id: data.professor_id,
      semester: data.semester,
      year: data.year,
      section_code: data.section_code || 'A',
      institution_id: auth.institutionId,
      max_students: data.max_students ?? null,
      location: data.location || null,
      modality: data.modality || null,
    })

    if (dbError || !section) {
      logger.error('assignCourse: DB insert failed', null, { dbError, courseId: data.course_id, professorId: data.professor_id })
      if (dbError?.includes('duplicate') || dbError?.includes('unique')) {
        return { error: 'A section with this letter already exists for this course/semester/year.' }
      }
      if (dbError?.includes('violates foreign key')) {
        return { error: 'Invalid course or professor selected. Please refresh and try again.' }
      }
      return { error: `Failed to create course assignment: ${dbError || 'Unknown error'}` }
    }

    logger.info('assignCourse: Success', { sectionId: section.id, courseId: data.course_id, professorId: data.professor_id, userId: auth.userId })
    logEvent({ userId: auth.userId, eventType: 'section.created', metadata: { sectionId: section.id, courseId: data.course_id, sectionCode: data.section_code } })
    revalidatePath('/admin/courses')
    revalidatePath('/admin/professors')
    revalidatePath('/admin/departments')
    return { success: true, data: section }
  } catch (error) {
    logger.error('assignCourse', error)
    return { error: 'Unexpected error' }
  }
}

/**
 * Update an existing course section.
 */
export async function updateAssignment(sectionId: string, input: UpdateCourseAssignmentInput) {
  try {
    const auth = await verifyInstitutionAdmin('courses')
    if ('error' in auth) return { error: auth.error }

    const parsed = updateCourseAssignmentSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input' }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    /* Tenant ownership guard. */
    const own = await assertTenantOwns(adminDb, 'course_sections', sectionId, auth.institutionId, { actionName: 'updateAssignment' })
    if (!own.ok) return { error: own.error }

    /* professor_id is newly accepted here (#716), so it needs the same guard assignCourse
       already applies on create — otherwise reassigning a section becomes a way to attach
       a professor from another institution, and the read-back joins straight through it. */
    if (parsed.data.professor_id) {
      const ownProf = await assertTenantOwns(adminDb, 'profiles', parsed.data.professor_id, auth.institutionId, { actionName: 'updateAssignment.professor' })
      if (!ownProf.ok) return { error: ownProf.error }
      if (!(await assertIsProfessor(adminDb, parsed.data.professor_id))) {
        return { error: 'That person is not a professor in your institution.' }
      }
    }

    const section = await courseAssignmentQueries.update(adminDb, sectionId, parsed.data)
    if (!section) {
      return { error: 'Failed to update assignment' }
    }

    logger.info('updateAssignment: Success', { sectionId, userId: auth.userId })
    logEvent({ userId: auth.userId, eventType: 'section.updated', metadata: { sectionId } })
    revalidatePath('/admin/courses')
    revalidatePath('/admin/professors')
    return { success: true, data: section }
  } catch (error) {
    logger.error('updateAssignment', error)
    return { error: 'Unexpected error' }
  }
}

/**
 * Toggle a course section's status. Supports: draft, active, inactive, archived, cancelled.
 * When archiving: sets archived_at. When restoring from archived: clears archived_at.
 */
export async function toggleSectionStatus(sectionId: string, newStatus: string) {
  try {
    const auth = await verifyInstitutionAdmin('courses')
    if ('error' in auth) return { error: auth.error }

    const validStatuses = ['draft', 'active', 'inactive', 'archived', 'cancelled']
    if (!validStatuses.includes(newStatus)) {
      return { error: `Invalid status: "${newStatus}"` }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    /* Tenant ownership guard. */
    const own = await assertTenantOwns(adminDb, 'course_sections', sectionId, auth.institutionId, { actionName: 'toggleSectionStatus' })
    if (!own.ok) return { error: own.error }

    // First read current status to diagnose constraint issues
    const { data: current } = await adminDb
      .from('course_sections')
      .select('id, status')
      .eq('id', sectionId)
      .single()

    logger.info('toggleSectionStatus: Current state', { sectionId, currentStatus: current?.status, newStatus })

    const updatePayload: Record<string, unknown> = { status: newStatus }
    if (newStatus === 'archived') {
      updatePayload.archived_at = new Date().toISOString()
    } else if (current?.status === 'archived') {
      updatePayload.archived_at = null
    }

    const { data, error: updateError } = await adminDb
      .from('course_sections')
      .update(updatePayload)
      .eq('id', sectionId)
      .select('id, status')
      .single()

    if (updateError) {
      logger.error('toggleSectionStatus: Update failed', updateError, {
        sectionId, newStatus, currentStatus: current?.status,
      })
      return { error: `Failed: constraint rejects "${newStatus}". Current status is "${current?.status}". DB error: ${updateError.message}` }
    }

    if (!data) {
      return { error: 'Section not found' }
    }

    logger.info('toggleSectionStatus: Success', { sectionId, newStatus, userId: auth.userId })
    logEvent({ userId: auth.userId, eventType: 'section.status_changed', metadata: { sectionId, status: newStatus } })
    revalidatePath('/admin/courses')
    revalidatePath('/professor/courses')
    return { success: true }
  } catch (error) {
    logger.error('toggleSectionStatus', error)
    return { error: 'Unexpected error' }
  }
}

/**
 * Remove a course section (unassign professor from course).
 */
export async function removeAssignment(sectionId: string) {
  try {
    const auth = await verifyInstitutionAdmin('courses')
    if ('error' in auth) return { error: auth.error }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    /* Tenant ownership guard. */
    const own = await assertTenantOwns(adminDb, 'course_sections', sectionId, auth.institutionId, { actionName: 'removeAssignment' })
    if (!own.ok) return { error: own.error }

    const success = await courseAssignmentQueries.remove(adminDb, sectionId)
    if (!success) {
      return { error: 'Failed to remove assignment' }
    }

    logger.info('removeAssignment: Success', { sectionId, userId: auth.userId })
    logEvent({ userId: auth.userId, eventType: 'section.deleted', metadata: { sectionId } })
    revalidatePath('/admin/courses')
    revalidatePath('/admin/professors')
    revalidatePath('/admin/departments')
    return { success: true }
  } catch (error) {
    logger.error('removeAssignment', error)
    return { error: 'Unexpected error' }
  }
}

/**
 * Counts of the student work a section deletion would destroy.
 *
 * `course_sections` is the root of 57 ON DELETE CASCADE relationships, so removing one
 * takes every enrollment, submission, quiz attempt and grade in it with no recovery path
 * short of a database restore. The confirmation dialog shows these numbers so the admin
 * is told what they are about to lose rather than being asked an abstract "are you sure".
 *
 * Counts the tables an admin would actually recognise as lost work; the remaining
 * cascades are derived or structural. Read-only, but still behind the same auth + tenant
 * guard as every other action here — otherwise it enumerates other tenants' section sizes.
 */
export async function getSectionCascadeCounts(sectionId: string) {
  /* null, NOT zeros, on every failure path. Zeros are an affirmative claim — the dialog
     renders them as "this section has no enrollments or student work" — so returning them
     when we simply could not look means a blip, a timeout or a denied read reassures the
     admin that a full semester is empty, immediately before an unrecoverable 57-table
     cascade. Typing the section code guards against deleting the WRONG row; it does
     nothing about not knowing what is IN the row. Fail toward "I don't know". */
  try {
    const auth = await verifyInstitutionAdmin('courses')
    if ('error' in auth) return null

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    const own = await assertTenantOwns(adminDb, 'course_sections', sectionId, auth.institutionId, {
      actionName: 'getSectionCascadeCounts',
    })
    if (!own.ok) return null

    /* THROWS on a failed read rather than returning 0. `count` is null on error, so a bare
       `count ?? 0` would report "0 submissions" for a section full of work — an under-count
       is indistinguishable from an empty section, and this feeds a confirmation for an
       unrecoverable 57-table delete. The catch below turns any throw into null, which the
       dialog renders as "couldn't check" instead of as reassurance. */
    const countOf = async (table: string, column = 'section_id') => {
      const { count, error } = await adminDb
        .from(table)
        .select('id', { count: 'exact', head: true })
        .eq(column, sectionId)
      if (error) throw new Error(`count failed for ${table}: ${error.message}`)
      return count ?? 0
    }

    /* Submissions and attempts hang off assignments/quizzes rather than the section, so
       they need the ids first. Independent reads run together. */
    const [students, assignmentRows, quizRows, modules] = await Promise.all([
      countOf('enrollments'),
      adminDb.from('assignments').select('id').eq('section_id', sectionId),
      adminDb.from('quizzes').select('id').eq('section_id', sectionId),
      countOf('modules'),
    ])

    // Same reasoning: an errored id lookup would silently zero BOTH its own count and the
    // submissions/attempts derived from it.
    if (assignmentRows.error) throw new Error(`assignments lookup failed: ${assignmentRows.error.message}`)
    if (quizRows.error) throw new Error(`quizzes lookup failed: ${quizRows.error.message}`)

    const assignmentIds = (assignmentRows.data ?? []).map((r: { id: string }) => r.id)
    const quizIds = (quizRows.data ?? []).map((r: { id: string }) => r.id)

    const [submissions, quizAttempts] = await Promise.all([
      assignmentIds.length
        ? adminDb
            .from('assignment_submissions')
            .select('id', { count: 'exact', head: true })
            .in('assignment_id', assignmentIds)
            .then((r: { count: number | null; error: { message: string } | null }) => {
              if (r.error) throw new Error(`submission count failed: ${r.error.message}`)
              return r.count ?? 0
            })
        : Promise.resolve(0),
      quizIds.length
        ? adminDb
            .from('quiz_attempts')
            .select('id', { count: 'exact', head: true })
            .in('quiz_id', quizIds)
            .then((r: { count: number | null; error: { message: string } | null }) => {
              if (r.error) throw new Error(`attempt count failed: ${r.error.message}`)
              return r.count ?? 0
            })
        : Promise.resolve(0),
    ])

    return {
      students,
      assignments: assignmentIds.length,
      quizzes: quizIds.length,
      submissions,
      quizAttempts,
      modules,
    }
  } catch (error) {
    logger.error('getSectionCascadeCounts', error, { sectionId })
    return null
  }
}
