/**
 * Student Server Actions — mutations for student CRUD operations.
 *
 * Each action independently verifies the caller is a institution_admin before
 * executing any mutation (defense in depth — the admin layout also checks).
 *
 * Uses two Supabase clients:
 * - Regular client (server.ts, anon key) — for auth verification (reads cookies)
 * - Admin client (admin.ts, service role key) — for mutations (bypasses RLS)
 *   and for auth.admin.createUser() (requires service role key)
 *
 * Actions:
 * - createStudent: Create a new student (auth user + profile with CWID)
 * - updateStudent: Update a student's profile fields
 * - deleteStudent: Remove a student (profile + auth user)
 * - getStudentCascadeCounts: Counts of enrollments affected by deletion
 *
 * Student creation flow (mirrors the professor temp-password flow):
 * 1. Validate input (email, name, 8-digit CWID)
 * 2. Check email + CWID uniqueness
 * 3. Generate secure random password
 * 4. Create auth user via auth.admin.createUser() with email_confirm:true and
 *    app_metadata.requires_password_set:true so the middleware forces the
 *    SetPasswordDialog on first login.
 * 5. Upsert profile with role='student', CWID, invite_status='pending',
 *    onboarding_completed:false.
 * 6. Email the temp credentials. Once the student logs in and sets a real
 *    password, completeOnboarding() (login/actions.ts) clears the flag and
 *    advances invite_status pending → accepted.
 */
'use server'

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { studentQueries } from '@/lib/supabase/queries'
import { verifyInstitutionAdmin } from '@/lib/auth/admin-context'
import { assertTenantOwns } from '@/lib/auth/assert-tenant-owns'
import { createStudentSchema, updateStudentSchema } from '@/lib/validations/student'
import { provisionStudentAccount } from '@/lib/admin/provision-student'
import { sendStudentCredentials } from '@/lib/email'
import { logger } from '@/lib/logger'
import { logEvent } from '@/lib/supabase/event-logger'
import type { CreateStudentInput, UpdateStudentInput } from '@/lib/validations/student'

/**
 * Creates a new student: generates password, creates auth user, upserts profile with CWID.
 *
 * After creation, sends login credentials (CWID + password) to the student's email.
 * Returns { success, emailSent } — emailSent indicates if the credentials email was delivered.
 */
export async function createStudent(input: CreateStudentInput) {
  try {
    const auth = await verifyInstitutionAdmin('students')
    if ('error' in auth) return { error: auth.error }

    /* Validate input with Zod */
    const parsed = createStudentSchema.safeParse(input)
    if (!parsed.success) {
      const fieldErrors = parsed.error.flatten().fieldErrors
      const firstError = Object.values(fieldErrors).flat()[0]
      logger.warn('createStudent: Validation failed', { errors: fieldErrors })
      return { error: firstError || 'Invalid input' }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    const data = parsed.data

    /* Check if email already exists in this tenant. Scoped so we don't leak
     * users at other institutions; cross-tenant email collisions are caught
     * later by Supabase's global auth.users uniqueness. */
    const existingEmail = await studentQueries.getByEmail(adminDb, data.email, auth.institutionId)
    if (existingEmail) {
      return { error: `A user with email "${data.email}" already exists` }
    }

    /* Check if CWID is already in use. profiles.cwid is globally UNIQUE so this
     * is a cross-tenant collision check by definition — we don't pass institutionId. */
    const existingCwid = await studentQueries.getByCwid(adminDb, data.cwid)
    if (existingCwid) {
      return { error: `A student with CWID "${data.cwid}" already exists` }
    }

    /* Create the auth user (temp password, forced reset on first login) and
       upsert the profile — shared with the bulk roster import. */
    const fullName = `${data.first_name} ${data.last_name}`
    const provisioned = await provisionStudentAccount(adminDb, {
      email: data.email,
      firstName: data.first_name,
      lastName: data.last_name,
      cwid: data.cwid,
      phone: data.phone || null,
      institutionId: auth.institutionId,
      invitedBy: auth.userId,
    })

    if (!provisioned.ok) {
      return { error: provisioned.error === 'Account created but profile update failed'
        ? 'Student account created but profile update failed. Please try editing the student.'
        : provisioned.error }
    }

    const { userId, profile, password } = provisioned

    logger.info('createStudent: Success', {
      studentId: userId,
      email: data.email,
      cwid: data.cwid,
      userId: auth.userId,
    })
    logEvent({ userId: auth.userId, eventType: 'student.created', metadata: { name: fullName, email: data.email, cwid: data.cwid } })

    /* Send login credentials to the student's email */
    const emailSent = await sendStudentCredentials(data.email, fullName, data.cwid, password)
    if (!emailSent) {
      logger.warn('createStudent: Credentials email failed — student account still created', { email: data.email })
    }

    revalidatePath('/admin/students')
    revalidatePath('/dashboard')

    return {
      success: true,
      emailSent,
      data: { student: profile },
    }
  } catch (error) {
    logger.error('createStudent', error)
    return { error: 'Unexpected error' }
  }
}

/**
 * Updates a student's profile-level fields (name, phone, status).
 */
export async function updateStudent(studentId: string, input: UpdateStudentInput) {
  try {
    const auth = await verifyInstitutionAdmin('students')
    if ('error' in auth) return { error: auth.error }

    const parsed = updateStudentSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input' }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    /* Tenant ownership guard. */
    const own = await assertTenantOwns(adminDb, 'profiles', studentId, auth.institutionId, { actionName: 'updateStudent' })
    if (!own.ok) return { error: own.error }

    /* If reassigning department, that department must belong to the
     * caller's institution too. */
    if (parsed.data.department_id) {
      const ownDept = await assertTenantOwns(adminDb, 'departments', parsed.data.department_id, auth.institutionId, { actionName: 'updateStudent.department' })
      if (!ownDept.ok) return { error: ownDept.error }
    }

    const updateData: Record<string, unknown> = { ...parsed.data }

    /* Rebuild full name if either part changed */
    if (parsed.data.first_name || parsed.data.last_name) {
      const existing = await studentQueries.getById(adminDb, studentId)
      if (existing) {
        const firstName = parsed.data.first_name || existing.first_name || ''
        const lastName = parsed.data.last_name || existing.last_name || ''
        updateData.name = `${firstName} ${lastName}`
      }
    }

    /* Convert empty department_id to null */
    if (updateData.department_id === '') {
      updateData.department_id = null
    }

    const student = await studentQueries.updateProfile(adminDb, studentId, updateData)
    if (!student) {
      return { error: 'Failed to update student' }
    }

    logger.info('updateStudent: Success', { studentId, userId: auth.userId })
    logEvent({ userId: auth.userId, eventType: 'student.updated', metadata: { studentId } })
    revalidatePath('/admin/students')
    revalidatePath(`/admin/students/${studentId}`)
    return { success: true, data: student }
  } catch (error) {
    logger.error('updateStudent', error)
    return { error: 'Unexpected error' }
  }
}

/**
 * Deletes a student: removes profile (cascades to enrollments) + auth user.
 */
export async function deleteStudent(studentId: string) {
  try {
    const auth = await verifyInstitutionAdmin('students')
    if ('error' in auth) return { error: auth.error }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    /* Tenant ownership guard. */
    const own = await assertTenantOwns(adminDb, 'profiles', studentId, auth.institutionId, { actionName: 'deleteStudent' })
    if (!own.ok) return { error: own.error }

    /* Delete auth user first */
    const { error: authDeleteError } = await adminDb.auth.admin.deleteUser(studentId)
    if (authDeleteError) {
      logger.error('deleteStudent: Auth user deletion failed', authDeleteError, { studentId })
      /* Continue with profile deletion — auth user orphan is less harmful */
    }

    /* Delete profile — cascades to enrollments via FK */
    const success = await studentQueries.remove(adminDb, studentId)
    if (!success) {
      return { error: 'Failed to delete student' }
    }

    logger.info('deleteStudent: Success', { studentId, userId: auth.userId })
    logEvent({ userId: auth.userId, eventType: 'student.removed', metadata: { studentId } })
    revalidatePath('/admin/students')
    revalidatePath('/dashboard')
    return { success: true }
  } catch (error) {
    logger.error('deleteStudent', error)
    return { error: 'Unexpected error' }
  }
}

/**
 * Revokes a pending student invite by DELETING the auth user, which frees the
 * email for a re-invite and cascades the profile row away
 * (profiles_id_fkey → auth.users ON DELETE CASCADE).
 *
 * The revocation is therefore permanent and the person disappears from the
 * console — deliberately, because freeing the address is the point. The audit
 * trail is the `student.invite_revoked` event, which records the email so the
 * action is still attributable after the row is gone.
 *
 * There used to be an `UPDATE profiles SET invite_status = 'revoked'` after the
 * delete. It could never do anything: the cascade had already removed the row,
 * so it matched zero rows, reported no error, and the action returned success
 * whether or not anything happened (#723). Mirrors revokeCoAdminInvite, which
 * had this right.
 */
export async function revokeStudentInvite(studentId: string) {
  try {
    const auth = await verifyInstitutionAdmin('students')
    if ('error' in auth) return { error: auth.error }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    /* Tenant ownership guard. */
    const own = await assertTenantOwns(adminDb, 'profiles', studentId, auth.institutionId, { actionName: 'revokeStudentInvite' })
    /* Deliberately NOT distinguishing "already revoked" from "another tenant's id":
       telling them apart would confirm a foreign row exists. Same words for both,
       but actionable ones — the raw helper message was a bare "Not found", which
       left an admin whose colleague revoked first with nothing to do. */
    if (!own.ok) {
      return { error: 'This invite is no longer available. Reload to refresh the list.' }
    }

    /* Verify the student has a pending invite */
    const student = await studentQueries.getById(adminDb, studentId)
    if (!student) {
      return { error: 'Student not found' }
    }
    if (student.invite_status !== 'pending') {
      return { error: 'Can only revoke pending invites' }
    }

    /* Delete the auth user to free up the email. This cascades the profile away,
       so it is the whole operation — and a failure here means nothing was
       revoked, which the caller has to hear about rather than see as success. */
    const { error: authDeleteError } = await adminDb.auth.admin.deleteUser(studentId)
    if (authDeleteError) {
      logger.error('revokeStudentInvite: Auth user deletion failed', authDeleteError, { studentId })
      return { error: 'Failed to revoke invite' }
    }

    /* Belt-and-suspenders: ensure the profile is gone even if the auth.users →
       profiles cascade is ever reconfigured. Same guard revokeCoAdminInvite uses. */
    const { error: profileDeleteError } = await adminDb.from('profiles').delete().eq('id', studentId)
    /* Harmless under the current cascade (the row is already gone), but if that
       cascade were ever removed a failure here would strand a profile with no
       auth user — silently, since the revoke has already succeeded by now. */
    if (profileDeleteError) {
      logger.warn('revokeStudentInvite: belt-and-suspenders profile delete failed', { studentId, error: profileDeleteError.message })
    }

    logger.info('revokeStudentInvite: Success', { studentId, userId: auth.userId })
    /* Email is captured here on purpose: once the cascade runs, this event is the
       only remaining record of who was revoked. */
    logEvent({
      userId: auth.userId,
      eventType: 'student.invite_revoked',
      metadata: { studentId, email: student.email },
    })
    revalidatePath('/admin/students')
    return { success: true }
  } catch (error) {
    logger.error('revokeStudentInvite', error)
    return { error: 'Unexpected error' }
  }
}

/**
 * Fetches counts of records affected by deleting a student.
 * Used by the delete confirmation dialog to warn the admin.
 */
export async function getStudentCascadeCounts(studentId: string) {
  try {
    /* Auth + tenant guard — previously this had no auth at all. */
    const auth = await verifyInstitutionAdmin('students')
    if ('error' in auth) return { enrollments: 0 }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    const own = await assertTenantOwns(adminDb, 'profiles', studentId, auth.institutionId, { actionName: 'getStudentCascadeCounts' })
    if (!own.ok) return { enrollments: 0 }

    return await studentQueries.getCascadeCounts(adminDb, studentId)
  } catch (error) {
    logger.error('getStudentCascadeCounts', error)
    return { enrollments: 0 }
  }
}
