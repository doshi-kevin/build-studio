// Tenant-ownership assertion helper for admin server actions.
//
// Pattern: every admin server action that takes an entity ID from the
// caller (e.g. departmentId, studentId, sectionId) must verify the
// entity belongs to the caller's institution BEFORE performing any
// mutation. Without this check, an institution_admin in tenant A who
// guesses or harvests a tenant-B UUID can mutate / delete tenant B's
// data via the admin client (which bypasses RLS).
//
// Usage:
//   const auth = await verifyInstitutionAdmin('updateDepartment')
//   if ('error' in auth) return { error: auth.error }
//   const own = await assertTenantOwns(adminDb, 'departments', departmentId, auth.institutionId)
//   if (!own.ok) return { error: own.error }
//
// For tables that don't carry institution_id directly (e.g. enrollments,
// section_staff_requests), use the variant that resolves through a
// parent table.

import { logger } from '@/lib/logger'

interface AssertResult {
  ok: boolean
  /** Human-readable error message safe to return to the client. Always
   *  generic ("not found") to avoid revealing which UUIDs exist in
   *  other tenants. */
  error?: string
}

/**
 * Confirms a row in `table` with id=`id` has institution_id=`institutionId`.
 * Returns ok=false (with a generic "not found") if the row is missing or
 * belongs to a different tenant. Logs cross-tenant attempts loudly.
 */
export async function assertTenantOwns(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminDb: any,
  table: string,
  id: string,
  institutionId: string,
  opts: { actionName?: string } = {},
): Promise<AssertResult> {
  if (!id) return { ok: false, error: 'Missing identifier' }
  const { data, error } = await adminDb
    .from(table)
    .select('institution_id')
    .eq('id', id)
    .maybeSingle()

  if (error || !data) {
    return { ok: false, error: 'Not found' }
  }
  if (data.institution_id !== institutionId) {
    logger.warn('assertTenantOwns: cross-tenant attempt blocked', {
      action: opts.actionName,
      table,
      id,
      callerInstitution: institutionId,
      targetInstitution: data.institution_id,
    })
    return { ok: false, error: 'Not found' }
  }
  return { ok: true }
}

/**
 * Variant for transitive tables that resolve their tenant through a
 * parent FK. Loads the row's `parentColumn` (e.g. section_id), then
 * confirms the parent's institution_id matches.
 *
 * Example:
 *   assertTenantOwnsVia(adminDb, 'enrollments', enrollmentId,
 *     'section_id', 'course_sections', auth.institutionId)
 */
export async function assertTenantOwnsVia(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminDb: any,
  table: string,
  id: string,
  parentColumn: string,
  parentTable: string,
  institutionId: string,
  opts: { actionName?: string } = {},
): Promise<AssertResult> {
  if (!id) return { ok: false, error: 'Missing identifier' }
  const { data: row, error: rowErr } = await adminDb
    .from(table)
    .select(parentColumn)
    .eq('id', id)
    .maybeSingle()

  if (rowErr || !row) return { ok: false, error: 'Not found' }
  const parentId = (row as Record<string, unknown>)[parentColumn]
  if (typeof parentId !== 'string' || !parentId) return { ok: false, error: 'Not found' }

  return assertTenantOwns(adminDb, parentTable, parentId, institutionId, opts)
}
