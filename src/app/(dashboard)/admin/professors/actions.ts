/**
 * Professor Server Actions — mutations for professor CRUD operations.
 *
 * Each action independently verifies the caller is a institution_admin before
 * executing any mutation (defense in depth — the admin layout also checks).
 *
 * Uses two Supabase clients:
 * - Regular client (server.ts, anon key) — for auth verification (reads cookies)
 * - Admin client (admin.ts, service role key) — for mutations (bypasses RLS)
 *   and for auth.admin.createUser/updateUserById (requires service role key)
 *
 * Actions:
 * - createProfessor: Invite a new professor (auth user + profile + department_faculty)
 * - updateProfessor: Update a professor's profile fields
 * - updateDepartmentFaculty: Update department-specific faculty fields
 * - deleteProfessor: Remove a professor (blocked if assigned to course sections)
 * - getProfessorCascadeCounts: Counts of records affected by deletion
 * - addProfessorToDepartment: Add existing professor to another department
 * - removeProfessorFromDepartment: Remove professor from a department
 *
 * All actions return { success, data } or { error: string }.
 */
'use server'

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { professorQueries } from '@/lib/supabase/queries'
import { verifyInstitutionAdmin } from '@/lib/auth/admin-context'
import { assertTenantOwns, assertTenantOwnsVia } from '@/lib/auth/assert-tenant-owns'
import { inviteProfessorSchema, updateProfessorProfileSchema, updateDepartmentFacultySchema } from '@/lib/validations/professor'
import { sendProfessorWelcome } from '@/lib/email'
import { generateSecurePassword } from '@/lib/validations/student'
import { logger } from '@/lib/logger'
import { logEvent } from '@/lib/supabase/event-logger'
import type { InviteProfessorInput, UpdateProfessorProfileInput, UpdateDepartmentFacultyInput } from '@/lib/validations/professor'

/**
 * Invites a new professor via temp-password flow:
 * 1. Generate a secure random password.
 * 2. admin.createUser() with password + email_confirm:true + requires_password_set flag.
 * 3. Email the professor their login email + temp password.
 * 4. On first login, middleware forces them through SetPasswordDialog.
 *
 * We stopped using Supabase's magic-link invite flow because email clients
 * (Gmail Safe-Browsing, Outlook ATP, Resend click-tracking) silently redeem
 * single-use action_links during pre-fetch scans, breaking the first click
 * for the invitee. Temp passwords sidestep that entirely — nothing to consume.
 */
export async function createProfessor(input: InviteProfessorInput) {
  try {
    const auth = await verifyInstitutionAdmin('professors')
    if ('error' in auth) return { error: auth.error }

    const parsed = inviteProfessorSchema.safeParse(input)
    if (!parsed.success) {
      const fieldErrors = parsed.error.flatten().fieldErrors
      const firstError = Object.values(fieldErrors).flat()[0]
      logger.warn('createProfessor: Validation failed', { errors: fieldErrors })
      return { error: firstError || 'Invalid input' }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    const data = parsed.data

    /* Tenant guard on the parent department — prevents inviting a professor
     * into a tenant-B department from a tenant-A admin session. */
    const ownDept = await assertTenantOwns(adminDb, 'departments', data.department_id, auth.institutionId, { actionName: 'createProfessor' })
    if (!ownDept.ok) return { error: ownDept.error }

    /* Check if email already exists in this tenant. Scoped to institutionId so
     * we don't leak the existence of users at other institutions. Cross-tenant
     * collisions are caught later by Supabase's global auth.users uniqueness. */
    const existing = await professorQueries.getByEmail(adminDb, data.email, auth.institutionId)
    if (existing) {
      return { error: `A user with email "${data.email}" already exists` }
    }

    const fullName = `${data.first_name} ${data.last_name}`
    const tempPassword = generateSecurePassword()

    /* Create auth user with known temp password. email_confirm:true lets them
     * log in immediately; requires_password_set:true makes middleware force
     * SetPasswordDialog on first navigation until completeOnboarding() clears it. */
    const { data: createData, error: createError } = await adminDb.auth.admin.createUser({
      email: data.email,
      password: tempPassword,
      email_confirm: true,
      app_metadata: { requires_password_set: true },
      user_metadata: { name: fullName, role: 'professor' },
    })

    if (createError || !createData?.user?.id) {
      logger.error('createProfessor: createUser failed', createError, { email: data.email })
      return { error: `Failed to create professor account: ${createError?.message || 'unknown error'}` }
    }

    const userId = createData.user.id

    /* Upsert profile with invite tracking fields */
    const profile = await professorQueries.upsertProfile(adminDb, {
      id: userId,
      email: data.email,
      name: fullName,
      first_name: data.first_name,
      last_name: data.last_name,
      institution_id: auth.institutionId,
      invite_status: 'pending',
      invited_at: new Date().toISOString(),
      invited_by: auth.userId,
      onboarding_completed: false,
    })

    if (!profile) {
      logger.error('createProfessor: Profile upsert failed', null, { userId })
      return { error: 'Professor account created but profile update failed. Please try editing the professor.' }
    }

    /* Insert department_faculty row — minimal fields, professor fills rest during onboarding */
    const faculty = await professorQueries.createDepartmentFaculty(adminDb, {
      department_id: data.department_id,
      professor_id: userId,
      position: data.position,
      employment_type: data.employment_type,
      is_primary_department: true,
      status: 'active',
    })

    if (!faculty) {
      logger.error('createProfessor: Department faculty insert failed', null, { userId, departmentId: data.department_id })
      return { error: 'Professor account created but department assignment failed. Please add them to the department manually.' }
    }

    logger.info('createProfessor: Success', { professorId: userId, email: data.email, departmentId: data.department_id, invitedBy: auth.userId })
    logEvent({ userId: auth.userId, eventType: 'professor.invited', metadata: { name: fullName, email: data.email } })

    /* Email the temp credentials. The entire onboarding hinges on this email
     * landing — without it the professor has no password and cannot log in. A
     * send failure must surface to the admin, not be swallowed into a "success"
     * that leaves a stuck pending invite nobody knows is broken. */
    const emailed = await sendProfessorWelcome(data.email, fullName, { tempPassword })
    if (!emailed) {
      logger.error('createProfessor: welcome email failed to send', null, { professorId: userId, email: data.email })
    }

    revalidatePath('/admin/professors')
    revalidatePath('/admin/departments')
    revalidatePath('/dashboard')
    return {
      success: true,
      data: { professor: profile, faculty },
      emailWarning: emailed
        ? undefined
        : ('Professor account created, but the invite email could not be sent. Use "Resend invite" on their card to try again.' as const),
    }
  } catch (error) {
    logger.error('createProfessor', error)
    return { error: 'Unexpected error' }
  }
}

/**
 * Updates a professor's profile-level fields (name, phone).
 */
export async function updateProfessor(professorId: string, input: UpdateProfessorProfileInput) {
  try {
    const auth = await verifyInstitutionAdmin('professors')
    if ('error' in auth) return { error: auth.error }

    const parsed = updateProfessorProfileSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input' }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    /* Tenant ownership guard. */
    const own = await assertTenantOwns(adminDb, 'profiles', professorId, auth.institutionId, { actionName: 'updateProfessor' })
    if (!own.ok) return { error: own.error }

    const updateData: Record<string, unknown> = { ...parsed.data }
    if (parsed.data.first_name || parsed.data.last_name) {
      /* Rebuild full name if either part changed */
      const existing = await professorQueries.getById(adminDb, professorId)
      if (existing) {
        const firstName = parsed.data.first_name || existing.first_name || ''
        const lastName = parsed.data.last_name || existing.last_name || ''
        updateData.name = `${firstName} ${lastName}`
      }
    }

    const professor = await professorQueries.updateProfile(adminDb, professorId, updateData)
    if (!professor) {
      return { error: 'Failed to update professor' }
    }

    logger.info('updateProfessor: Success', { professorId, userId: auth.userId })
    logEvent({ userId: auth.userId, eventType: 'professor.updated', metadata: { professorId } })
    revalidatePath('/admin/professors')
    revalidatePath(`/admin/professors/${professorId}`)
    revalidatePath('/admin/departments')
    return { success: true, data: professor }
  } catch (error) {
    logger.error('updateProfessor', error)
    return { error: 'Unexpected error' }
  }
}

/**
 * Updates department-specific faculty fields (title, position, office, bio, etc.).
 */
export async function updateFacultyDetails(facultyId: string, input: UpdateDepartmentFacultyInput) {
  try {
    const auth = await verifyInstitutionAdmin('professors')
    if ('error' in auth) return { error: auth.error }

    const parsed = updateDepartmentFacultySchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input' }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    /* Tenant ownership guard via parent department. */
    const own = await assertTenantOwnsVia(adminDb, 'department_faculty', facultyId, 'department_id', 'departments', auth.institutionId, { actionName: 'updateFacultyDetails' })
    if (!own.ok) return { error: own.error }

    const faculty = await professorQueries.updateDepartmentFaculty(adminDb, facultyId, parsed.data)
    if (!faculty) {
      return { error: 'Failed to update faculty details' }
    }

    logger.info('updateFacultyDetails: Success', { facultyId, userId: auth.userId })
    revalidatePath('/admin/professors')
    revalidatePath('/admin/departments')
    return { success: true, data: faculty }
  } catch (error) {
    logger.error('updateFacultyDetails', error)
    return { error: 'Unexpected error' }
  }
}

/**
 * Deletes a professor. Blocked if they are assigned to any course sections
 * (course_sections.professor_id has ON DELETE RESTRICT).
 */
export async function deleteProfessor(professorId: string) {
  try {
    const auth = await verifyInstitutionAdmin('professors')
    if ('error' in auth) return { error: auth.error }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    /* Tenant ownership guard. */
    const own = await assertTenantOwns(adminDb, 'profiles', professorId, auth.institutionId, { actionName: 'deleteProfessor' })
    if (!own.ok) return { error: own.error }

    /* Check if professor has active course sections */
    const counts = await professorQueries.getCascadeCounts(adminDb, professorId)
    if (counts.sections > 0) {
      return { error: `Cannot delete: professor is assigned to ${counts.sections} course section(s). Remove course assignments first.` }
    }

    /* Also delete the auth user */
    const { error: authDeleteError } = await adminDb.auth.admin.deleteUser(professorId)
    if (authDeleteError) {
      logger.error('deleteProfessor: Auth user deletion failed', authDeleteError, { professorId })
      /* Continue with profile deletion — auth user orphan is less harmful */
    }

    const success = await professorQueries.remove(adminDb, professorId)
    if (!success) {
      return { error: 'Failed to delete professor' }
    }

    logger.info('deleteProfessor: Success', { professorId, userId: auth.userId })
    logEvent({ userId: auth.userId, eventType: 'professor.removed', metadata: { professorId } })
    revalidatePath('/admin/professors')
    revalidatePath('/admin/departments')
    revalidatePath('/dashboard')
    return { success: true }
  } catch (error) {
    logger.error('deleteProfessor', error)
    return { error: 'Unexpected error' }
  }
}

/**
 * Fetches counts of records affected by deleting a professor.
 */
export async function getProfessorCascadeCounts(professorId: string) {
  try {
    /* Auth + tenant guard — previously this had no auth at all, exposing
     * any tenant's professor cascade counts to any caller. */
    const auth = await verifyInstitutionAdmin('professors')
    if ('error' in auth) return { departments: 0, sections: 0 }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    const own = await assertTenantOwns(adminDb, 'profiles', professorId, auth.institutionId, { actionName: 'getProfessorCascadeCounts' })
    if (!own.ok) return { departments: 0, sections: 0 }

    return await professorQueries.getCascadeCounts(adminDb, professorId)
  } catch (error) {
    logger.error('getProfessorCascadeCounts', error)
    return { departments: 0, sections: 0 }
  }
}

/**
 * Add an existing professor to a department (creates department_faculty row).
 * Used by the department Faculty tab's "Add Faculty" dialog.
 */
export async function addProfessorToDepartment(input: {
  department_id: string
  professor_id: string
  title?: string
  position: string
  employment_type: string
  office_location?: string
  status?: string
}) {
  try {
    const auth = await verifyInstitutionAdmin('professors')
    if ('error' in auth) return { error: auth.error }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    /* Both the department AND the professor must belong to the caller's
     * institution — prevents cross-wiring tenant-A dept with tenant-B prof. */
    const ownDept = await assertTenantOwns(adminDb, 'departments', input.department_id, auth.institutionId, { actionName: 'addProfessorToDepartment.dept' })
    if (!ownDept.ok) return { error: ownDept.error }
    const ownProf = await assertTenantOwns(adminDb, 'profiles', input.professor_id, auth.institutionId, { actionName: 'addProfessorToDepartment.prof' })
    if (!ownProf.ok) return { error: ownProf.error }

    const faculty = await professorQueries.createDepartmentFaculty(adminDb, {
      department_id: input.department_id,
      professor_id: input.professor_id,
      title: input.title || null,
      position: input.position,
      employment_type: input.employment_type,
      office_location: input.office_location || null,
      is_primary_department: false,
      status: input.status || 'active',
    })

    if (!faculty) {
      return { error: 'Failed to add professor to department. They may already be assigned.' }
    }

    logger.info('addProfessorToDepartment: Success', { facultyId: faculty.id, userId: auth.userId })
    revalidatePath('/admin/departments')
    revalidatePath('/admin/professors')
    return { success: true, data: faculty }
  } catch (error) {
    logger.error('addProfessorToDepartment', error)
    return { error: 'Unexpected error' }
  }
}

/**
 * Remove a professor from a department (deletes department_faculty row).
 * Does NOT delete the professor's profile.
 */
export async function removeProfessorFromDepartment(facultyId: string) {
  try {
    const auth = await verifyInstitutionAdmin('professors')
    if ('error' in auth) return { error: auth.error }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    /* Tenant ownership guard via parent department. */
    const own = await assertTenantOwnsVia(adminDb, 'department_faculty', facultyId, 'department_id', 'departments', auth.institutionId, { actionName: 'removeProfessorFromDepartment' })
    if (!own.ok) return { error: own.error }

    const success = await professorQueries.removeDepartmentFaculty(adminDb, facultyId)
    if (!success) {
      return { error: 'Failed to remove professor from department' }
    }

    logger.info('removeProfessorFromDepartment: Success', { facultyId, userId: auth.userId })
    revalidatePath('/admin/departments')
    revalidatePath('/admin/professors')
    return { success: true }
  } catch (error) {
    logger.error('removeProfessorFromDepartment', error)
    return { error: 'Unexpected error' }
  }
}

/**
 * Revokes a pending professor invite by DELETING the auth user, which frees the
 * email for a re-invite and cascades the profile row away
 * (profiles_id_fkey → auth.users ON DELETE CASCADE).
 *
 * The revocation is therefore permanent and the person disappears from the
 * console — deliberately, because freeing the address is the point. The audit
 * trail is the `professor.invite_revoked` event, which records the email so the
 * action stays attributable after the row is gone.
 *
 * There used to be an `UPDATE profiles SET invite_status = 'revoked'` after the
 * delete. It could never do anything: the cascade had already removed the row,
 * so it matched zero rows, reported no error, and the action returned success
 * whether or not anything happened (#723). Mirrors revokeCoAdminInvite.
 */
export async function revokeProfessorInvite(professorId: string) {
  try {
    const auth = await verifyInstitutionAdmin('professors')
    if ('error' in auth) return { error: auth.error }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    /* Tenant ownership guard. */
    const own = await assertTenantOwns(adminDb, 'profiles', professorId, auth.institutionId, { actionName: 'revokeProfessorInvite' })
    /* Deliberately NOT distinguishing "already revoked" from "another tenant's id":
       telling them apart would confirm a foreign row exists. Same words for both,
       but actionable ones — the raw helper message was a bare "Not found", which
       left an admin whose colleague revoked first with nothing to do. */
    if (!own.ok) {
      return { error: 'This invite is no longer available. Reload to refresh the list.' }
    }

    /* Verify the professor has a pending invite */
    const professor = await professorQueries.getById(adminDb, professorId)
    if (!professor) {
      return { error: 'Professor not found' }
    }
    if (professor.invite_status !== 'pending') {
      return { error: 'Can only revoke pending invites' }
    }

    /* Delete the auth user to free up the email. This cascades the profile away,
       so it is the whole operation — and a failure here means nothing was
       revoked, which the caller has to hear about rather than see as success. */
    const { error: authDeleteError } = await adminDb.auth.admin.deleteUser(professorId)
    if (authDeleteError) {
      logger.error('revokeProfessorInvite: Auth user deletion failed', authDeleteError, { professorId })
      return { error: 'Failed to revoke invite' }
    }

    /* Belt-and-suspenders: ensure the profile is gone even if the auth.users →
       profiles cascade is ever reconfigured. Same guard revokeCoAdminInvite uses. */
    const { error: profileDeleteError } = await adminDb.from('profiles').delete().eq('id', professorId)
    /* Harmless under the current cascade (the row is already gone), but if that
       cascade were ever removed a failure here would strand a profile with no
       auth user — silently, since the revoke has already succeeded by now. */
    if (profileDeleteError) {
      logger.warn('revokeProfessorInvite: belt-and-suspenders profile delete failed', { professorId, error: profileDeleteError.message })
    }

    logger.info('revokeProfessorInvite: Success', { professorId, userId: auth.userId })
    /* Email is captured here on purpose: once the cascade runs, this event is the
       only remaining record of who was revoked. */
    logEvent({
      userId: auth.userId,
      eventType: 'professor.invite_revoked',
      metadata: { professorId, email: professor.email },
    })
    revalidatePath('/admin/professors')
    revalidatePath('/admin/departments')
    return { success: true }
  } catch (error) {
    logger.error('revokeProfessorInvite', error)
    return { error: 'Unexpected error' }
  }
}

/**
 * Resends a pending professor invite. Rotates the temp password, re-arms the
 * `requires_password_set` gate, and re-sends the welcome email. This is the
 * recovery path when the original invite never landed (bad address, provider
 * filtering, or a transient email-send failure) — without it, the only way to
 * re-deliver credentials was to revoke and re-create the professor.
 *
 * Mirrors resendStaffInvite. Only pending invites can be resent; an active
 * professor already has a password and would just use Forgot Password.
 */
export async function resendProfessorInvite(professorId: string) {
  try {
    const auth = await verifyInstitutionAdmin('professors')
    if ('error' in auth) return { error: auth.error }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    /* Tenant guard — without this an admin in tenant A could rotate the temp
     * password of a tenant-B professor and read the welcome email, a trivial
     * account takeover. */
    const own = await assertTenantOwns(adminDb, 'profiles', professorId, auth.institutionId, { actionName: 'resendProfessorInvite' })
    if (!own.ok) return { error: own.error }

    const professor = await professorQueries.getById(adminDb, professorId)
    if (!professor) {
      return { error: 'Professor not found' }
    }
    if (professor.invite_status !== 'pending') {
      return { error: `Invite is already ${professor.invite_status} — no resend needed` }
    }

    /* Rotate the temp password, keep email confirmed, and re-arm the
     * requires_password_set gate (preserving any other app_metadata) so the
     * professor is forced through SetPasswordDialog on first login. */
    const tempPassword = generateSecurePassword()
    const { data: stamped } = await adminDb.auth.admin.getUserById(professorId)
    const existingAppMeta = stamped?.user?.app_metadata || {}
    const { error: rotateError } = await adminDb.auth.admin.updateUserById(professorId, {
      password: tempPassword,
      email_confirm: true,
      app_metadata: { ...existingAppMeta, requires_password_set: true },
    })
    if (rotateError) {
      logger.error('resendProfessorInvite: Failed to rotate temp password', rotateError, { professorId })
      return { error: 'Could not reset the password. Please try again.' }
    }

    const emailed = await sendProfessorWelcome(professor.email, professor.name || professor.email, { tempPassword })

    /* Refresh invite tracking so the directory sorts this as freshly invited. */
    await adminDb
      .from('profiles')
      .update({ invited_at: new Date().toISOString(), invited_by: auth.userId })
      .eq('id', professorId)

    logger.info('resendProfessorInvite: Success', { professorId, userId: auth.userId, emailed })
    logEvent({ userId: auth.userId, eventType: 'professor.invite_resent', metadata: { professorId, emailed } })
    revalidatePath('/admin/professors')
    revalidatePath('/admin/departments')
    return {
      success: true,
      emailWarning: emailed
        ? undefined
        : ('Password reset, but the invite email could not be sent. Try again in a minute; if it still fails, check the address or contact support.' as const),
    }
  } catch (error) {
    logger.error('resendProfessorInvite', error)
    return { error: 'Unexpected error' }
  }
}
