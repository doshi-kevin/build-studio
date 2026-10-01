/**
 * Course Server Actions — mutations for course CRUD operations.
 *
 * Courses belong directly to a department and represent individual classes
 * (e.g. CS-556 NLP, CS-678 Deep Learning).
 *
 * Each action independently verifies the caller is a institution_admin before
 * executing any mutation (defense in depth).
 *
 * Uses two Supabase clients:
 * - Regular client (server.ts, anon key) — for auth verification (reads cookies)
 * - Admin client (admin.ts, service role key) — for mutations (bypasses RLS)
 *
 * Actions:
 * - createCourse: Insert a new course within a department
 * - updateCourse: Partial update of an existing course
 * - deleteCourse: Remove a course (cascades to sections → enrollments)
 * - getCourseCascadeCounts: Fetch counts of records affected by deletion
 *
 * All actions return { success, data } or { error: string }.
 */
'use server'

import { revalidatePath } from 'next/cache'
import { staleWriteError } from '@/lib/supabase/stale-write'
import { createAdminClient } from '@/lib/supabase/admin'
import { courseAdminQueries } from '@/lib/supabase/queries'
import { verifyInstitutionAdmin } from '@/lib/auth/admin-context'
import { assertTenantOwns } from '@/lib/auth/assert-tenant-owns'
import { createCourseSchema, updateCourseSchema, DEFAULT_COURSE_CREDITS } from '@/lib/validations/course'
import { logger } from '@/lib/logger'
import { logEvent } from '@/lib/supabase/event-logger'
import type { CreateCourseInput, UpdateCourseInput } from '@/lib/validations/course'

/**
 * Creates a new course within a department.
 * Validates input with zod, checks for duplicate code within the department, inserts into DB.
 */
export async function createCourse(input: CreateCourseInput) {
  try {
    const auth = await verifyInstitutionAdmin('course-actions')
    if ('error' in auth) return { error: auth.error }

    const parsed = createCourseSchema.safeParse(input)
    if (!parsed.success) {
      const fieldErrors = parsed.error.flatten().fieldErrors
      const firstError = Object.values(fieldErrors).flat()[0]
      logger.warn('createCourse: Validation failed', { errors: fieldErrors })
      return { error: firstError || 'Invalid input' }
    }

    /* Use admin client (bypasses RLS) for mutations */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    /* Tenant guard (prevents IDOR): only create a course under a department in
     * the caller's own institution — otherwise a tenant-A admin could inject a
     * course into another tenant's department. */
    const ownDept = await assertTenantOwns(adminDb, 'departments', parsed.data.department_id, auth.institutionId, { actionName: 'createCourse' })
    if (!ownDept.ok) return { error: ownDept.error }

    const existing = await courseAdminQueries.getByCode(adminDb, parsed.data.department_id, parsed.data.code)
    if (existing) {
      return { error: `Course code "${parsed.data.code}" already exists in this department` }
    }

    /* An empty Credits field means "the usual" — the placeholder says 3 — not
     * "unknown". Resolve it here so every create path agrees, including Athena
     * and any caller that omits the field entirely. */
    const course = await courseAdminQueries.create(adminDb, {
      ...parsed.data,
      credits: parsed.data.credits ?? DEFAULT_COURSE_CREDITS,
      institution_id: auth.institutionId,
    })
    if (!course) {
      return { error: 'Failed to create course' }
    }

    logger.info('createCourse: Success', { courseId: course.id, code: course.code, userId: auth.userId })
    logEvent({ userId: auth.userId, eventType: 'course.created', metadata: { code: course.code, title: parsed.data.title } })
    revalidatePath(`/admin/departments/${parsed.data.department_id}`)
    revalidatePath('/admin/departments')
    return { success: true, data: course }
  } catch (error) {
    logger.error('createCourse', error)
    return { error: 'Unexpected error' }
  }
}

/**
 * Updates an existing course.
 * Checks for duplicate code within the department if code is being changed.
 */
/**
 * `expectedUpdatedAt` is the row's `updated_at` as the caller's form was rendered
 * — the stale-write guard from #724. Optional for existing callers; pass it from
 * any edit form.
 */
export async function updateCourse(
  courseId: string,
  departmentId: string,
  input: UpdateCourseInput,
  expectedUpdatedAt?: string | null,
) {
  try {
    const auth = await verifyInstitutionAdmin('course-actions')
    if ('error' in auth) return { error: auth.error }

    const parsed = updateCourseSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input' }
    }

    /* Use admin client (bypasses RLS) for mutations */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    /* Tenant guard (prevents IDOR): the caller must own the course being
     * updated AND any department it is associated with / re-parented into —
     * otherwise a tenant-A admin could overwrite a tenant-B course or move a
     * course into another tenant's department via input.department_id. Runs
     * before the duplicate-code probe so cross-tenant IDs reveal nothing. */
    const ownCourse = await assertTenantOwns(adminDb, 'courses', courseId, auth.institutionId, { actionName: 'updateCourse' })
    if (!ownCourse.ok) return { error: ownCourse.error }

    if (departmentId) {
      const ownDept = await assertTenantOwns(adminDb, 'departments', departmentId, auth.institutionId, { actionName: 'updateCourse' })
      if (!ownDept.ok) return { error: ownDept.error }
    }

    if (parsed.data.department_id && parsed.data.department_id !== departmentId) {
      const ownNewDept = await assertTenantOwns(adminDb, 'departments', parsed.data.department_id, auth.institutionId, { actionName: 'updateCourse' })
      if (!ownNewDept.ok) return { error: ownNewDept.error }
    }

    if (parsed.data.code && departmentId) {
      const existing = await courseAdminQueries.getByCode(adminDb, departmentId, parsed.data.code)
      if (existing && existing.id !== courseId) {
        return { error: `Course code "${parsed.data.code}" already exists in this department` }
      }
    }

    const result = await courseAdminQueries.update(adminDb, courseId, parsed.data, expectedUpdatedAt)
    if (!result.ok) {
      if (result.reason === 'conflict') return staleWriteError()
      return { error: 'Failed to update course' }
    }
    const course = result.data

    logger.info('updateCourse: Success', { courseId, userId: auth.userId })
    logEvent({ userId: auth.userId, eventType: 'course.updated', metadata: { courseId } })
    revalidatePath(`/admin/departments/${departmentId}`)
    revalidatePath('/admin/departments')
    /* The course detail page renders the same row (code, title, credits,
     * description, status), so an edit has to invalidate it too. */
    revalidatePath(`/admin/courses/${courseId}`)
    return { success: true, data: course }
  } catch (error) {
    logger.error('updateCourse', error)
    return { error: 'Unexpected error' }
  }
}

/**
 * Deletes a course. Database CASCADE constraints handle course_sections → enrollments.
 */
export async function deleteCourse(courseId: string, departmentId: string) {
  try {
    const auth = await verifyInstitutionAdmin('course-actions')
    if ('error' in auth) return { error: auth.error }

    /* Use admin client (bypasses RLS) for mutations */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    /* Tenant guard (prevents IDOR): only delete a course in the caller's own
     * institution. Without this a tenant-A admin could destroy a tenant-B
     * course and CASCADE its sections + enrollments. */
    const own = await assertTenantOwns(adminDb, 'courses', courseId, auth.institutionId, { actionName: 'deleteCourse' })
    if (!own.ok) return { error: own.error }

    const success = await courseAdminQueries.remove(adminDb, courseId)
    if (!success) {
      return { error: 'Failed to delete course' }
    }

    logger.info('deleteCourse: Success', { courseId, userId: auth.userId })
    logEvent({ userId: auth.userId, eventType: 'course.deleted', metadata: { courseId } })
    revalidatePath(`/admin/departments/${departmentId}`)
    revalidatePath('/admin/departments')
    return { success: true }
  } catch (error) {
    logger.error('deleteCourse', error)
    return { error: 'Unexpected error' }
  }
}

/**
 * Fetches counts of records affected by deleting a course.
 * Used by the delete confirmation dialog to show the admin what will be lost.
 */
export async function getCourseCascadeCounts(courseId: string) {
  /* null on every failure path, not zeros — see getDepartmentCascadeCounts (#715). */
  try {
    /* Auth + tenant guard — previously this had no auth at all, so any caller
     * could enumerate any course's cascade counts across tenants. */
    const auth = await verifyInstitutionAdmin('course-actions')
    if ('error' in auth) return null

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    const own = await assertTenantOwns(adminDb, 'courses', courseId, auth.institutionId, { actionName: 'getCourseCascadeCounts' })
    if (!own.ok) return null

    return await courseAdminQueries.getCascadeCounts(adminDb, courseId)
  } catch (error) {
    logger.error('getCourseCascadeCounts', error)
    return null
  }
}
