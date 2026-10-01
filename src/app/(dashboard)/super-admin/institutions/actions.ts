// Server actions for super-admin institution management.
// Phase 1: createInstitution (with optional primary admin invite).
// Future: suspend/unsuspend, reissue admin invite, etc.

'use server'

/* eslint-disable @typescript-eslint/no-explicit-any */

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { profileQueries, institutionQueries } from '@/lib/supabase/queries'
import { createInstitutionSchema, inviteAdminSchema, type CreateInstitutionInput, type InviteAdminInput } from '@/lib/validations/institution'
import { sendInstitutionAdminWelcome } from '@/lib/email'
import { generateSecurePassword } from '@/lib/validations/student'
import { logger } from '@/lib/logger'
import { logEvent } from '@/lib/supabase/event-logger'

/**
 * Verifies the caller is a super_admin. Returns userId if so, error if not.
 * Uses the regular (anon key) client to read auth cookies and check the
 * profile role. The 3-layer security pattern (middleware → layout → action)
 * means RLS isn't the primary control here; this gate is.
 */
async function verifySuperAdmin() {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return { error: 'Unauthorized — not signed in' }
  }
  const profile = await profileQueries.getProfileById(supabase, user.id)
  if (!profile || profile.role !== 'super_admin') {
    return { error: 'Unauthorized — super_admin access required' }
  }
  return { userId: user.id }
}

/**
 * Creates a new institution and (optionally) invites its primary admin.
 *
 * If `primaryAdminEmail` is provided:
 *   1. Generate a secure temp password.
 *   2. createUser via auth.admin with email_confirm:true and
 *      requires_password_set:true so middleware bounces them through
 *      SetPasswordDialog on first login.
 *   3. Upsert the profile with role='institution_admin' + new institution_id.
 *      The sync_institution_to_auth_metadata trigger pushes institution_id
 *      into auth.users.app_metadata for cheap JWT-based RLS later.
 *   4. Email the admin their login + temp password.
 *
 * If `primaryAdminEmail` is omitted:
 *   The institution exists with no admin — UI surfaces a warning, super_admin
 *   can invite an admin later.
 */
export async function createInstitution(input: CreateInstitutionInput) {
  try {
    const auth = await verifySuperAdmin()
    if ('error' in auth) return { error: auth.error }

    const parsed = createInstitutionSchema.safeParse(input)
    if (!parsed.success) {
      const fieldErrors = parsed.error.flatten().fieldErrors
      const firstError = Object.values(fieldErrors).flat()[0]
      logger.warn('createInstitution: Validation failed', { errors: fieldErrors })
      return { error: firstError || 'Invalid input' }
    }

    const data = parsed.data
    const adminDb = createAdminClient() as any

    /* Insert institution. We rely on the `slug UNIQUE` constraint rather than a
     * pre-check, which (a) is one round-trip instead of two and (b) closes the
     * race window between the check and the insert. Postgres error code 23505 =
     * unique_violation. */
    const { data: institutionRow, error: insertErr } = await adminDb
      .from('institutions')
      .insert({
        name: data.name,
        slug: data.slug,
        status: 'active',
        // Explicit AI kill-switch baseline (all enabled) — auditable, instead
        // of leaning on the parser's implicit default for a missing key.
        settings: {
          ai: {
            platform: { allDisabled: false, disabledFeatures: [], version: 1 },
            institution: { allDisabled: false, disabledFeatures: [], version: 1 },
          },
        },
      })
      .select('*')
      .single()

    if (insertErr || !institutionRow) {
      if (insertErr?.code === '23505') {
        return { error: `An institution with slug "${data.slug}" already exists` }
      }
      logger.error('createInstitution: Insert failed', insertErr, { slug: data.slug })
      return { error: `Failed to create institution: ${insertErr?.message || 'unknown error'}` }
    }

    const institutionId = institutionRow.id

    /* Optional: invite primary admin. */
    let primaryAdminId: string | null = null
    if (data.primaryAdminEmail && data.primaryAdminName) {
      /* Reject if email is already on a profile (would create a tenant-mixup). */
      const { data: emailHit } = await adminDb
        .from('profiles')
        .select('id, email, institution_id')
        .ilike('email', data.primaryAdminEmail)
        .maybeSingle()

      if (emailHit) {
        /* Roll back the institution insert. ON DELETE RESTRICT on FKs is
         * not yet a problem because no children exist; safe to delete. */
        await adminDb.from('institutions').delete().eq('id', institutionId)
        return { error: `A user with email "${data.primaryAdminEmail}" already exists` }
      }

      const tempPassword = generateSecurePassword()
      const { data: createUserData, error: createUserErr } = await adminDb.auth.admin.createUser({
        email: data.primaryAdminEmail,
        password: tempPassword,
        email_confirm: true,
        app_metadata: { requires_password_set: true },
        user_metadata: { name: data.primaryAdminName, role: 'institution_admin' },
      })

      if (createUserErr || !createUserData?.user?.id) {
        logger.error('createInstitution: createUser failed', createUserErr, { email: data.primaryAdminEmail })
        await adminDb.from('institutions').delete().eq('id', institutionId)
        return { error: `Failed to create admin account: ${createUserErr?.message || 'unknown error'}` }
      }

      primaryAdminId = createUserData.user.id

      const { error: profileErr } = await adminDb
        .from('profiles')
        .upsert(
          {
            id: primaryAdminId,
            email: data.primaryAdminEmail,
            name: data.primaryAdminName,
            role: 'institution_admin',
            institution_id: institutionId,
            invite_status: 'pending',
            invited_at: new Date().toISOString(),
            invited_by: auth.userId,
            onboarding_completed: false,
          },
          { onConflict: 'id' },
        )

      if (profileErr) {
        logger.error('createInstitution: Profile upsert failed', profileErr, { primaryAdminId })
        /* Roll back the orphan auth user so the email can be reused for a clean
         * retry. Leaving an orphan is worse than retrying — the email becomes
         * "taken" in auth.users with no profile row, so the admin can never log
         * in and a re-invite would hit the existing-email branch. */
        await adminDb.auth.admin.deleteUser(primaryAdminId).catch((e: unknown) => {
          logger.error('createInstitution: Failed to delete orphan auth user during rollback', e, { primaryAdminId })
        })
        primaryAdminId = null
        return { error: 'Institution created, but admin invite failed. Try inviting an admin from the list view.' }
      }

      await sendInstitutionAdminWelcome(data.primaryAdminEmail, data.primaryAdminName, {
        institutionName: data.name,
        tempPassword,
      })
    }

    logger.info('createInstitution: Success', {
      institutionId,
      slug: data.slug,
      primaryAdminId,
      hasAdmin: !!primaryAdminId,
      invitedBy: auth.userId,
    })
    logEvent({
      userId: auth.userId,
      eventType: 'institution.created',
      metadata: {
        institutionId,
        slug: data.slug,
        primaryAdminId,
        hasAdmin: !!primaryAdminId,
      },
    })

    revalidatePath('/super-admin')
    return {
      success: true as const,
      data: { institutionId, primaryAdminId },
    }
  } catch (error) {
    logger.error('createInstitution', error)
    return { error: 'Unexpected error' }
  }
}

/**
 * Invite an institution_admin into an existing institution. Used by the detail
 * page when an institution exists with admin_count = 0 (empty state). Reuses the
 * temp-password invite plumbing from createInstitution.
 */
export async function inviteAdminToInstitution(input: InviteAdminInput) {
  try {
    const auth = await verifySuperAdmin()
    if ('error' in auth) return { error: auth.error }

    const parsed = inviteAdminSchema.safeParse(input)
    if (!parsed.success) {
      const firstError = Object.values(parsed.error.flatten().fieldErrors).flat()[0]
      return { error: firstError || 'Invalid input' }
    }

    const data = parsed.data
    const adminDb = createAdminClient() as any

    /* Verify the institution exists and load its name (for the email). */
    const institution = await institutionQueries.getById(adminDb, data.institutionId)
    if (!institution) return { error: 'Institution not found' }

    /* Reject if email is already in use anywhere. */
    const { data: emailHit } = await adminDb
      .from('profiles')
      .select('id, email, institution_id')
      .ilike('email', data.email)
      .maybeSingle()
    if (emailHit) {
      return { error: `A user with email "${data.email}" already exists` }
    }

    const tempPassword = generateSecurePassword()
    const { data: createUserData, error: createUserErr } = await adminDb.auth.admin.createUser({
      email: data.email,
      password: tempPassword,
      email_confirm: true,
      app_metadata: { requires_password_set: true },
      user_metadata: { name: data.name, role: 'institution_admin' },
    })
    if (createUserErr || !createUserData?.user?.id) {
      logger.error('inviteAdminToInstitution: createUser failed', createUserErr, { email: data.email })
      return { error: `Failed to create admin account: ${createUserErr?.message || 'unknown error'}` }
    }

    const newAdminId = createUserData.user.id
    const { error: profileErr } = await adminDb
      .from('profiles')
      .upsert(
        {
          id: newAdminId,
          email: data.email,
          name: data.name,
          role: 'institution_admin',
          institution_id: data.institutionId,
          invite_status: 'pending',
          invited_at: new Date().toISOString(),
          invited_by: auth.userId,
          onboarding_completed: false,
        },
        { onConflict: 'id' },
      )

    if (profileErr) {
      logger.error('inviteAdminToInstitution: Profile upsert failed', profileErr, { newAdminId })
      await adminDb.auth.admin.deleteUser(newAdminId).catch((e: unknown) => {
        logger.error('inviteAdminToInstitution: Orphan auth user cleanup failed', e, { newAdminId })
      })
      return { error: 'Admin invite failed. Try again.' }
    }

    await sendInstitutionAdminWelcome(data.email, data.name, {
      institutionName: institution.name,
      tempPassword,
    })

    logger.info('inviteAdminToInstitution: Success', {
      institutionId: data.institutionId,
      newAdminId,
      invitedBy: auth.userId,
    })
    logEvent({
      userId: auth.userId,
      eventType: 'institution.admin_invited',
      metadata: { institutionId: data.institutionId, newAdminId, email: data.email },
    })

    revalidatePath('/super-admin')
    revalidatePath(`/super-admin/institutions/${data.institutionId}`)
    return { success: true as const, data: { newAdminId } }
  } catch (error) {
    logger.error('inviteAdminToInstitution', error)
    return { error: 'Unexpected error' }
  }
}

/**
 * Flip an institution's status between 'active' and 'suspended'.
 *
 * Suspension flow:
 *   1. UPDATE institutions.status — fires the sync_institution_status_to_members
 *      trigger, which pushes the new status into every member's auth.users
 *      app_metadata. Future JWTs will carry it.
 *   2. Force-revoke all live sessions for that tenant via auth.admin.signOut(_, 'global').
 *      Without step 2, an admin with a stale tab could keep firing server actions
 *      until their refresh token rotates. verifyInstitutionAdmin also DB-checks
 *      status as a belt-and-suspenders safeguard against any straggler tokens.
 *
 * Reactivation skips the signOut — users can sign back in normally and pick up
 * the new status on their next login.
 */
export async function setInstitutionStatus(institutionId: string, status: 'active' | 'suspended') {
  try {
    const auth = await verifySuperAdmin()
    if ('error' in auth) return { error: auth.error }

    if (status !== 'active' && status !== 'suspended') {
      return { error: 'Invalid status' }
    }

    const adminDb = createAdminClient() as any
    const { data, error } = await adminDb
      .from('institutions')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', institutionId)
      .select('*')
      .single()

    if (error || !data) {
      logger.error('setInstitutionStatus: Update failed', error, { institutionId, status })
      return { error: `Failed to update institution: ${error?.message || 'not found'}` }
    }

    /* On suspend: kick everyone in this tenant out of any live session. */
    let signedOutCount = 0
    if (status === 'suspended') {
      const { data: members, error: membersErr } = await adminDb
        .from('profiles')
        .select('id, role')
        .eq('institution_id', institutionId)

      if (membersErr) {
        logger.error('setInstitutionStatus: Failed to load members for signOut', membersErr, {
          institutionId,
        })
      } else if (members && members.length > 0) {
        /* signOut in parallel; failures are logged but don't block. The DB-level
         * suspension check in verifyInstitutionAdmin + DashboardLayout still
         * blocks any straggler. */
        await Promise.all(
          members.map(async (m: { id: string; role: string }) => {
            /* Don't sign out super_admins (they may not be in this institution
             * but we filter by institution_id anyway, so this is defense-in-depth). */
            if (m.role === 'super_admin') return
            const { error: signOutErr } = await adminDb.auth.admin.signOut(m.id, 'global')
            if (signOutErr) {
              logger.error('setInstitutionStatus: signOut failed', signOutErr, { userId: m.id })
            } else {
              signedOutCount += 1
            }
          }),
        )
      }
    }

    logger.info('setInstitutionStatus: Success', {
      institutionId,
      status,
      updatedBy: auth.userId,
      signedOutCount,
    })
    logEvent({
      userId: auth.userId,
      eventType: status === 'suspended' ? 'institution.suspended' : 'institution.reactivated',
      metadata: { institutionId, slug: data.slug, signedOutCount },
    })

    revalidatePath('/super-admin')
    revalidatePath(`/super-admin/institutions/${institutionId}`)
    return { success: true as const, data }
  } catch (error) {
    logger.error('setInstitutionStatus', error)
    return { error: 'Unexpected error' }
  }
}

/**
 * Re-send the welcome email to a pending institution_admin with a fresh temp
 * password. Used when the original invite email was missed/lost. Only works
 * on profiles whose invite_status is still 'pending' — accepted admins should
 * use the standard password reset flow instead.
 */
export async function resendInstitutionAdminInvite(adminUserId: string) {
  try {
    const auth = await verifySuperAdmin()
    if ('error' in auth) return { error: auth.error }

    const adminDb = createAdminClient() as any

    /* Load profile + institution for the welcome email. */
    const { data: profile, error: profileErr } = await adminDb
      .from('profiles')
      .select('id, email, name, role, invite_status, institution_id')
      .eq('id', adminUserId)
      .maybeSingle()

    if (profileErr || !profile) {
      logger.error('resendInstitutionAdminInvite: profile lookup failed', profileErr, { adminUserId })
      return { error: 'Admin not found' }
    }

    if (profile.role !== 'institution_admin') {
      return { error: 'Only institution_admin invites can be resent here' }
    }

    if (profile.invite_status !== 'pending') {
      return { error: 'Invite has already been accepted — use password reset instead' }
    }

    const institution = await institutionQueries.getById(adminDb, profile.institution_id)
    if (!institution) return { error: 'Institution not found' }

    /* Rotate the temp password so the old email becomes useless. */
    const tempPassword = generateSecurePassword()
    const { error: updateErr } = await adminDb.auth.admin.updateUserById(adminUserId, {
      password: tempPassword,
      app_metadata: { requires_password_set: true },
    })
    if (updateErr) {
      logger.error('resendInstitutionAdminInvite: updateUserById failed', updateErr, { adminUserId })
      return { error: `Failed to rotate password: ${updateErr.message || 'unknown error'}` }
    }

    /* Bump invited_at so the audit trail reflects the resend. */
    await adminDb
      .from('profiles')
      .update({ invited_at: new Date().toISOString() })
      .eq('id', adminUserId)

    await sendInstitutionAdminWelcome(profile.email, profile.name || 'Admin', {
      institutionName: institution.name,
      tempPassword,
    })

    logger.info('resendInstitutionAdminInvite: Success', {
      adminUserId,
      institutionId: profile.institution_id,
      resentBy: auth.userId,
    })
    logEvent({
      userId: auth.userId,
      eventType: 'institution.admin_invited',
      metadata: {
        institutionId: profile.institution_id,
        newAdminId: adminUserId,
        email: profile.email,
        resend: true,
      },
    })

    revalidatePath(`/super-admin/institutions/${profile.institution_id}`)
    return { success: true as const }
  } catch (error) {
    logger.error('resendInstitutionAdminInvite', error)
    return { error: 'Unexpected error' }
  }
}
