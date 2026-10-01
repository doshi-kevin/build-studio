/**
 * Department Server Actions — mutations for department CRUD operations.
 *
 * Each action independently verifies the caller is a institution_admin before
 * executing any mutation (defense in depth — the admin layout also checks).
 *
 * Uses two Supabase clients:
 * - Regular client (server.ts, anon key) — for auth verification (reads cookies)
 * - Admin client (admin.ts, service role key) — for mutations (bypasses RLS)
 *
 * Actions:
 * - createDepartment: Insert a new department
 * - updateDepartment: Partial update of an existing department
 * - deleteDepartment: Remove a department (cascades to programs, courses, faculty)
 * - getDepartmentCascadeCounts: Fetch counts of records affected by deletion
 *
 * All actions return { success, data } or { error: string }.
 */
'use server'

import { revalidatePath } from 'next/cache'
import { staleWriteError } from '@/lib/supabase/stale-write'
import { createAdminClient } from '@/lib/supabase/admin'
import { departmentQueries } from '@/lib/supabase/queries'
import { verifyInstitutionAdmin } from '@/lib/auth/admin-context'
import { assertTenantOwns } from '@/lib/auth/assert-tenant-owns'
import { createDepartmentSchema, updateDepartmentSchema } from '@/lib/validations/department'
import { logger } from '@/lib/logger'
import { logEvent } from '@/lib/supabase/event-logger'
import type { CreateDepartmentInput, UpdateDepartmentInput } from '@/lib/validations/department'

/**
 * Creates a new department.
 * Validates input with zod, checks for duplicate code, inserts into DB.
 */
export async function createDepartment(input: CreateDepartmentInput) {
  try {
    const auth = await verifyInstitutionAdmin('departments')
    if ('error' in auth) return { error: auth.error }

    const parsed = createDepartmentSchema.safeParse(input)
    if (!parsed.success) {
      logger.warn('createDepartment: Validation failed', { errors: parsed.error.flatten() })
      return { error: 'Invalid input' }
    }

    /* Use admin client (bypasses RLS) for mutations — cast to match query type */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    /* Code uniqueness is now scoped per institution (UNIQUE(institution_id, code)),
     * so getByCode must filter by tenant too. Until that's done, an existing
     * Stevens "CS" department blocks UIUC from also creating "CS". */
    const existing = await departmentQueries.getByCode(adminDb, parsed.data.code, auth.institutionId)
    if (existing) {
      return { error: `Department code "${parsed.data.code}" already exists in your institution` }
    }

    const department = await departmentQueries.create(adminDb, { ...parsed.data, institution_id: auth.institutionId })
    if (!department) {
      return { error: 'Failed to create department' }
    }

    logger.info('createDepartment: Success', { departmentId: department.id, code: department.code, userId: auth.userId })
    logEvent({ userId: auth.userId, eventType: 'department.created', metadata: { name: parsed.data.name, code: parsed.data.code } })
    revalidatePath('/admin/departments')
    revalidatePath('/dashboard')
    return { success: true, data: department }
  } catch (error) {
    logger.error('createDepartment', error)
    return { error: 'Unexpected error' }
  }
}

/**
 * Updates an existing department.
 * Checks for duplicate code if code is being changed.
 */
/**
 * `expectedUpdatedAt` is the row's `updated_at` as the caller's form was rendered.
 * Optional so existing callers keep working, but omitting it opts out of the
 * stale-write guard (#724) — pass it from any edit form.
 */
export async function updateDepartment(
  departmentId: string,
  input: UpdateDepartmentInput,
  expectedUpdatedAt?: string | null,
) {
  try {
    const auth = await verifyInstitutionAdmin('departments')
    if ('error' in auth) return { error: auth.error }

    const parsed = updateDepartmentSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input' }
    }

    /* Use admin client (bypasses RLS) for mutations — cast to match query type */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    /* Tenant-ownership guard. */
    const own = await assertTenantOwns(adminDb, 'departments', departmentId, auth.institutionId, { actionName: 'updateDepartment' })
    if (!own.ok) return { error: own.error }

    if (parsed.data.code) {
      const existing = await departmentQueries.getByCode(adminDb, parsed.data.code, auth.institutionId)
      if (existing && existing.id !== departmentId) {
        return { error: `Department code "${parsed.data.code}" already exists in your institution` }
      }
    }

    const result = await departmentQueries.update(adminDb, departmentId, parsed.data, expectedUpdatedAt)
    if (!result.ok) {
      if (result.reason === 'conflict') return staleWriteError()
      return { error: 'Failed to update department' }
    }
    const department = result.data

    logger.info('updateDepartment: Success', { departmentId, userId: auth.userId })
    logEvent({ userId: auth.userId, eventType: 'department.updated', metadata: { name: parsed.data.name } })
    revalidatePath('/admin/departments')
    revalidatePath(`/admin/departments/${departmentId}`)
    revalidatePath('/dashboard')
    return { success: true, data: department }
  } catch (error) {
    logger.error('updateDepartment', error)
    return { error: 'Unexpected error' }
  }
}

/**
 * Deletes a department. Database CASCADE constraints handle related records.
 */
export async function deleteDepartment(departmentId: string) {
  try {
    const auth = await verifyInstitutionAdmin('departments')
    if ('error' in auth) return { error: auth.error }

    /* Use admin client (bypasses RLS) for mutations — cast to match query type */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    /* Tenant-ownership guard — without this, an admin in tenant A can
     * cascade-delete a tenant B department (and its programs/courses/faculty). */
    const own = await assertTenantOwns(adminDb, 'departments', departmentId, auth.institutionId, { actionName: 'deleteDepartment' })
    if (!own.ok) return { error: own.error }

    const success = await departmentQueries.remove(adminDb, departmentId)
    if (!success) {
      return { error: 'Failed to delete department' }
    }

    logger.info('deleteDepartment: Success', { departmentId, userId: auth.userId })
    logEvent({ userId: auth.userId, eventType: 'department.deleted', metadata: { departmentId } })
    revalidatePath('/admin/departments')
    revalidatePath('/dashboard')
    return { success: true }
  } catch (error) {
    logger.error('deleteDepartment', error)
    return { error: 'Unexpected error' }
  }
}

/**
 * Fetches counts of records affected by deleting a department.
 * Used by the delete confirmation dialog to show the admin what will be lost.
 */
export async function getDepartmentCascadeCounts(departmentId: string) {
  /* null on EVERY failure path, including the auth and tenant guards (#715). Returning
     zeros here was the same fail-open bug as in the query itself: the dialog reads zeros
     as "no associated programs, courses, or faculty will be affected" and lets the admin
     proceed. A denied read is not evidence of an empty department. */
  try {
    /* Auth + tenant guard — previously this had no auth at all, so any
     * caller could enumerate any department's cascade counts. */
    const auth = await verifyInstitutionAdmin('departments')
    if ('error' in auth) return null

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    const own = await assertTenantOwns(adminDb, 'departments', departmentId, auth.institutionId, { actionName: 'getDepartmentCascadeCounts' })
    if (!own.ok) return null

    return await departmentQueries.getCascadeCounts(adminDb, departmentId)
  } catch (error) {
    logger.error('getDepartmentCascadeCounts', error)
    return null
  }
}
