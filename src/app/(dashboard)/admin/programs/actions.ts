/**
 * Program Server Actions — mutations for program CRUD operations.
 *
 * Each action independently verifies the caller is a institution_admin before
 * executing any mutation (defense in depth — the admin layout also checks).
 *
 * Actions:
 * - createProgram: Insert a new academic program
 * - updateProgram: Partial update of an existing program
 * - deleteProgram: Remove a program (no cascading FKs)
 *
 * All actions return { success, data } or { error: string }.
 */
'use server'

import { revalidatePath } from 'next/cache'
import { staleWriteError } from '@/lib/supabase/stale-write'
import { createAdminClient } from '@/lib/supabase/admin'
import { programQueries } from '@/lib/supabase/queries'
import { verifyInstitutionAdmin } from '@/lib/auth/admin-context'
import { assertTenantOwns } from '@/lib/auth/assert-tenant-owns'
import { createProgramSchema, updateProgramSchema } from '@/lib/validations/program'
import { logger } from '@/lib/logger'
import { logEvent } from '@/lib/supabase/event-logger'
import type { CreateProgramInput, UpdateProgramInput } from '@/lib/validations/program'

/**
 * Creates a new academic program.
 * Validates input with Zod, checks for duplicate code, inserts into DB.
 */
export async function createProgram(input: CreateProgramInput) {
  try {
    const auth = await verifyInstitutionAdmin('programs')
    if ('error' in auth) return { error: auth.error }

    const parsed = createProgramSchema.safeParse(input)
    if (!parsed.success) {
      const firstError = parsed.error.issues[0]
      return { error: firstError?.message || 'Validation failed' }
    }

    const data = parsed.data
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    /* Tenant guard on the parent department — without this, an admin in
     * tenant A can create a program nested under tenant B's department. */
    if (data.department_id) {
      const own = await assertTenantOwns(adminDb, 'departments', data.department_id, auth.institutionId, { actionName: 'createProgram' })
      if (!own.ok) return { error: own.error }
    }

    /* Check code uniqueness within this institution. programs.code is now
     * UNIQUE(institution_id, department_id, code) transitively via department,
     * so per-tenant scope is required. */
    const existing = await programQueries.getByCode(adminDb, data.code, auth.institutionId)
    if (existing) {
      return { error: `Program code "${data.code}" is already in use in your institution` }
    }

    /* Same tenant guard as updateProgram.director — see the note there. A
       client-supplied director_id is otherwise written unchecked, and the
       admin-client read-back joins profiles(id, name, email) through it. */
    if (data.director_id) {
      const ownDirector = await assertTenantOwns(adminDb, 'profiles', data.director_id, auth.institutionId, { actionName: 'createProgram.director' })
      if (!ownDirector.ok) return { error: ownDirector.error }
    }

    /* Insert the program. institution_id is required (NOT NULL with no default). */
    const { data: program, error: insertError } = await adminDb
      .from('programs')
      .insert({
        name: data.name,
        code: data.code,
        institution_id: auth.institutionId,
        degree_type: data.degree_type,
        department_id: data.department_id,
        director_id: data.director_id || null,
        description: data.description || null,
        total_credits: data.total_credits || null,
        duration_semesters: data.duration_semesters || null,
        status: data.status,
      })
      .select('*')
      .single()

    if (insertError) {
      logger.error('createProgram: Insert failed', insertError)
      return { error: 'Failed to create program' }
    }

    logger.info('createProgram: Success', { programId: program.id, code: data.code })

    await logEvent({
      userId: auth.userId,
      eventType: 'program.created',
      metadata: { name: data.name, code: data.code },
    })

    revalidatePath('/admin/programs')
    revalidatePath('/admin')
    return { success: true, data: program }
  } catch (error) {
    logger.error('createProgram: Exception', error)
    return { error: 'An unexpected error occurred' }
  }
}

/**
 * Updates an existing program.
 * Validates input, checks code uniqueness if changed, updates in DB.
 */
/**
 * `expectedUpdatedAt` is the row's `updated_at` as the caller's form was rendered
 * — the stale-write guard from #724. Optional for existing callers; the edit
 * dialog passes it.
 */
export async function updateProgram(
  programId: string,
  input: UpdateProgramInput,
  expectedUpdatedAt?: string | null,
) {
  try {
    const auth = await verifyInstitutionAdmin('programs')
    if ('error' in auth) return { error: auth.error }

    const parsed = updateProgramSchema.safeParse(input)
    if (!parsed.success) {
      const firstError = parsed.error.issues[0]
      return { error: firstError?.message || 'Validation failed' }
    }

    const data = parsed.data
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    /* Tenant ownership guard. */
    const own = await assertTenantOwns(adminDb, 'programs', programId, auth.institutionId, { actionName: 'updateProgram' })
    if (!own.ok) return { error: own.error }

    /* If re-parenting to a different department, that department must
     * also belong to the caller's institution. */
    if (data.department_id) {
      const ownDept = await assertTenantOwns(adminDb, 'departments', data.department_id, auth.institutionId, { actionName: 'updateProgram.reparent' })
      if (!ownDept.ok) return { error: ownDept.error }
    }

    /* The director must belong to the caller's institution too. `department_id` is
       guarded above and also backstopped by trg_programs_tenant_match, but that
       trigger fires only on `institution_id, department_id` — a sibling FK like
       this one is outside its column list, so nothing else catches it.
       It matters because the read-back joins straight through:
       programs/page.tsx fetches with the RLS-bypassing admin client and
       getAllWithRelated selects `director:profiles(id, name, email)`. The
       institution filter scopes the PROGRAM rows; the join follows the FK
       wherever it points, so a foreign director's name and email would render in
       this admin's own console. The tenant-filtered dropdown was the only thing
       enforcing this, and a directly-invoked server action ignores it. */
    if (data.director_id) {
      const ownDirector = await assertTenantOwns(adminDb, 'profiles', data.director_id, auth.institutionId, { actionName: 'updateProgram.director' })
      if (!ownDirector.ok) return { error: ownDirector.error }
    }

    /* Check code uniqueness within the institution if changed */
    if (data.code) {
      const existing = await programQueries.getByCode(adminDb, data.code, auth.institutionId)
      if (existing && existing.id !== programId) {
        return { error: `Program code "${data.code}" is already in use in your institution` }
      }
    }

    /* Build update object — convert empty strings to null */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateData: Record<string, any> = { updated_at: new Date().toISOString() }
    if (data.name !== undefined) updateData.name = data.name
    if (data.code !== undefined) updateData.code = data.code
    if (data.degree_type !== undefined) updateData.degree_type = data.degree_type
    if (data.department_id !== undefined) updateData.department_id = data.department_id
    if (data.director_id !== undefined) updateData.director_id = data.director_id || null
    if (data.description !== undefined) updateData.description = data.description || null
    if (data.total_credits !== undefined) updateData.total_credits = data.total_credits || null
    if (data.duration_semesters !== undefined) updateData.duration_semesters = data.duration_semesters || null
    if (data.status !== undefined) updateData.status = data.status

    /* Optimistic concurrency (#724): the guard rides in the WHERE clause so a
       stale write matches zero rows rather than clobbering a newer one. maybeSingle
       because zero rows is the expected stale-write outcome, not an error — and
       past assertTenantOwns above, zero rows can only mean the guard fired. */
    let updateQuery = adminDb.from('programs').update(updateData).eq('id', programId)
    if (expectedUpdatedAt) {
      updateQuery = updateQuery.eq('updated_at', expectedUpdatedAt)
    } else {
      logger.warn('updateProgram: no expectedUpdatedAt — stale-write guard NOT applied', { programId })
    }

    const { data: program, error: updateError } = await updateQuery.select('*').maybeSingle()

    if (updateError) {
      logger.error('updateProgram: Update failed', updateError, { programId })
      return { error: 'Failed to update program' }
    }
    if (!program) {
      logger.warn('updateProgram: stale write rejected', { programId, expectedUpdatedAt })
      return staleWriteError()
    }

    logger.info('updateProgram: Success', { programId })

    await logEvent({
      userId: auth.userId,
      eventType: 'program.updated',
      metadata: { programId, name: program.name },
    })

    revalidatePath('/admin/programs')
    revalidatePath(`/admin/programs/${programId}`)
    return { success: true, data: program }
  } catch (error) {
    logger.error('updateProgram: Exception', error, { programId })
    return { error: 'An unexpected error occurred' }
  }
}

/**
 * Deletes a program. No cascading dependencies (nothing references programs.id).
 */
export async function deleteProgram(programId: string) {
  try {
    const auth = await verifyInstitutionAdmin('programs')
    if ('error' in auth) return { error: auth.error }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    /* Tenant ownership guard. */
    const own = await assertTenantOwns(adminDb, 'programs', programId, auth.institutionId, { actionName: 'deleteProgram' })
    if (!own.ok) return { error: own.error }

    const success = await programQueries.remove(adminDb, programId)

    if (!success) {
      return { error: 'Failed to delete program' }
    }

    logger.info('deleteProgram: Success', { programId })

    await logEvent({
      userId: auth.userId,
      eventType: 'program.deleted',
      metadata: { programId },
    })

    revalidatePath('/admin/programs')
    revalidatePath('/admin')
    return { success: true }
  } catch (error) {
    logger.error('deleteProgram: Exception', error, { programId })
    return { error: 'An unexpected error occurred' }
  }
}
