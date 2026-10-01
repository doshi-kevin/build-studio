// Server actions for institution_admin → institution_admin team management.
//
// Lets an existing institution_admin invite up to MAX_ADMINS_PER_INSTITUTION (5)
// other institution_admins into their tenant, resend a pending invite, or
// revoke a pending invite that hasn't been accepted yet.
//
// The cap counts BOTH pending + accepted admins so it can't be bypassed by
// flooding pending invites. Same temp-password plumbing as the super_admin
// invite path (auth.admin.createUser → upsert profile → sendInstitutionAdminWelcome).

'use server'

/* eslint-disable @typescript-eslint/no-explicit-any */

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { institutionQueries } from '@/lib/supabase/queries'
import { verifyInstitutionAdmin } from '@/lib/auth/admin-context'
import {
  inviteCoAdminSchema,
  MAX_ADMINS_PER_INSTITUTION,
  type InviteCoAdminInput,
} from '@/lib/validations/admin-invite'
import { sendInstitutionAdminWelcome } from '@/lib/email'
import { generateSecurePassword } from '@/lib/validations/student'
import { logger } from '@/lib/logger'
import { logEvent } from '@/lib/supabase/event-logger'

/** Count current institution_admins (pending + accepted) for the tenant. */
async function countAdmins(adminDb: any, institutionId: string): Promise<number> {
  const { count, error } = await adminDb
    .from('profiles')
    .select('id', { count: 'exact', head: true })
    .eq('institution_id', institutionId)
    .eq('role', 'institution_admin')
  if (error) {
    logger.error('countAdmins failed', error, { institutionId })
    /* Fail safe — refuse the invite rather than over-allocate. */
    return MAX_ADMINS_PER_INSTITUTION
  }
  return count || 0
}

/**
 * Invite another institution_admin into the caller's tenant. Enforces the
 * MAX_ADMINS_PER_INSTITUTION cap. The invitee gets a temp-password welcome
 * email and is forced through SetPasswordDialog on first login.
 */
export async function inviteInstitutionAdmin(input: InviteCoAdminInput) {
  try {
    const auth = await verifyInstitutionAdmin('inviteInstitutionAdmin')
    if ('error' in auth) return { error: auth.error }

    const parsed = inviteCoAdminSchema.safeParse(input)
    if (!parsed.success) {
      const firstError = Object.values(parsed.error.flatten().fieldErrors).flat()[0]
      return { error: firstError || 'Invalid input' }
    }

    const data = parsed.data
    const adminDb = createAdminClient() as any

    /* Cap check — counts pending + accepted to prevent flood bypass. */
    const current = await countAdmins(adminDb, auth.institutionId)
    if (current >= MAX_ADMINS_PER_INSTITUTION) {
      return {
        error: `Your institution already has the maximum of ${MAX_ADMINS_PER_INSTITUTION} admins. Remove or revoke a pending invite first.`,
      }
    }

    /* Reject if email is already in use within this tenant (info-leak safe —
     * cross-tenant collision is caught later by Supabase global auth uniqueness). */
    const { data: emailHit } = await adminDb
      .from('profiles')
      .select('id, email, role')
      .eq('email', data.email)
      .eq('institution_id', auth.institutionId)
      .maybeSingle()

    if (emailHit) {
      return { error: `A user with email "${data.email}" already exists in your institution` }
    }

    /* Load the institution name for the welcome email. */
    const institution = await institutionQueries.getById(adminDb, auth.institutionId)
    if (!institution) return { error: 'Your institution record is missing. Contact support.' }

    const tempPassword = generateSecurePassword()
    const { data: createUserData, error: createUserErr } = await adminDb.auth.admin.createUser({
      email: data.email,
      password: tempPassword,
      email_confirm: true,
      app_metadata: { requires_password_set: true },
      user_metadata: { name: data.name, role: 'institution_admin' },
    })

    if (createUserErr || !createUserData?.user?.id) {
      logger.error('inviteInstitutionAdmin: createUser failed', createUserErr, {
        email: data.email,
        institutionId: auth.institutionId,
      })
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
          institution_id: auth.institutionId,
          invite_status: 'pending',
          invited_at: new Date().toISOString(),
          invited_by: auth.userId,
          onboarding_completed: false,
        },
        { onConflict: 'id' },
      )

    if (profileErr) {
      logger.error('inviteInstitutionAdmin: profile upsert failed', profileErr, { newAdminId })
      /* Roll back orphan auth user so the email is reusable. */
      await adminDb.auth.admin.deleteUser(newAdminId).catch((e: unknown) => {
        logger.error('inviteInstitutionAdmin: orphan cleanup failed', e, { newAdminId })
      })
      return { error: 'Admin invite failed. Try again.' }
    }

    await sendInstitutionAdminWelcome(data.email, data.name, {
      institutionName: institution.name,
      tempPassword,
    })

    logger.info('inviteInstitutionAdmin: success', {
      institutionId: auth.institutionId,
      newAdminId,
      invitedBy: auth.userId,
    })
    logEvent({
      userId: auth.userId,
      eventType: 'institution.admin_invited',
      metadata: {
        institutionId: auth.institutionId,
        newAdminId,
        email: data.email,
        invitedByPeer: true,
      },
    })

    revalidatePath('/admin/admins')
    return { success: true as const, data: { newAdminId } }
  } catch (error) {
    logger.error('inviteInstitutionAdmin', error)
    return { error: 'Unexpected error' }
  }
}

/**
 * Re-issue the welcome email to a still-pending co-admin (rotates their temp
 * password so the original email becomes useless). Only works on profiles in
 * the caller's tenant whose invite_status is still 'pending'.
 */
export async function resendCoAdminInvite(adminUserId: string) {
  try {
    const auth = await verifyInstitutionAdmin('resendCoAdminInvite')
    if ('error' in auth) return { error: auth.error }

    const adminDb = createAdminClient() as any

    const { data: target, error: targetErr } = await adminDb
      .from('profiles')
      .select('id, email, name, role, invite_status, institution_id')
      .eq('id', adminUserId)
      .maybeSingle()

    if (targetErr || !target) return { error: 'Admin not found' }

    /* Tenant guard. */
    if (target.institution_id !== auth.institutionId) {
      logger.warn('resendCoAdminInvite: cross-tenant resend blocked', {
        adminUserId,
        targetInstitution: target.institution_id,
        callerInstitution: auth.institutionId,
      })
      return { error: 'Admin not found' }
    }

    if (target.role !== 'institution_admin') {
      return { error: 'Target is not an institution_admin' }
    }

    if (target.invite_status !== 'pending') {
      return { error: 'Invite has already been accepted — use password reset instead' }
    }

    const institution = await institutionQueries.getById(adminDb, auth.institutionId)
    if (!institution) return { error: 'Institution not found' }

    const tempPassword = generateSecurePassword()
    const { error: updateErr } = await adminDb.auth.admin.updateUserById(adminUserId, {
      password: tempPassword,
      app_metadata: { requires_password_set: true },
    })
    if (updateErr) {
      logger.error('resendCoAdminInvite: updateUserById failed', updateErr, { adminUserId })
      return { error: `Failed to rotate password: ${updateErr.message || 'unknown error'}` }
    }

    await adminDb
      .from('profiles')
      .update({ invited_at: new Date().toISOString() })
      .eq('id', adminUserId)

    await sendInstitutionAdminWelcome(target.email, target.name || 'Admin', {
      institutionName: institution.name,
      tempPassword,
    })

    logEvent({
      userId: auth.userId,
      eventType: 'institution.admin_invited',
      metadata: {
        institutionId: auth.institutionId,
        newAdminId: adminUserId,
        email: target.email,
        resend: true,
        invitedByPeer: true,
      },
    })

    revalidatePath('/admin/admins')
    return { success: true as const }
  } catch (error) {
    logger.error('resendCoAdminInvite', error)
    return { error: 'Unexpected error' }
  }
}

/**
 * Revoke a pending co-admin invite (deletes the auth.users + profile row so
 * the slot is freed under the cap). Refuses if the invite has already been
 * accepted — that's a removal action, not a revoke, and is out of scope here
 * to keep the v1 surface narrow.
 */
export async function revokeCoAdminInvite(adminUserId: string) {
  try {
    const auth = await verifyInstitutionAdmin('revokeCoAdminInvite')
    if ('error' in auth) return { error: auth.error }

    /* Self-revoke is a foot-gun: the only admin in the tenant could lock
     * themselves out. Also makes no sense — they're already accepted. */
    if (adminUserId === auth.userId) {
      return { error: 'You cannot revoke your own invite' }
    }

    const adminDb = createAdminClient() as any
    const { data: target, error: targetErr } = await adminDb
      .from('profiles')
      .select('id, email, role, invite_status, institution_id')
      .eq('id', adminUserId)
      .maybeSingle()

    if (targetErr || !target) return { error: 'Admin not found' }
    if (target.institution_id !== auth.institutionId) return { error: 'Admin not found' }
    if (target.role !== 'institution_admin') return { error: 'Target is not an institution_admin' }
    if (target.invite_status !== 'pending') {
      return { error: 'Invite has already been accepted — cannot revoke' }
    }

    /* Delete the auth user (which cascades to the profile via FK ON DELETE). */
    const { error: deleteErr } = await adminDb.auth.admin.deleteUser(adminUserId)
    if (deleteErr) {
      logger.error('revokeCoAdminInvite: deleteUser failed', deleteErr, { adminUserId })
      return { error: `Failed to revoke invite: ${deleteErr.message || 'unknown error'}` }
    }

    /* Belt-and-suspenders: ensure profile is gone even if auth.users → profiles
     * cascade isn't configured. */
    await adminDb.from('profiles').delete().eq('id', adminUserId)

    logEvent({
      userId: auth.userId,
      eventType: 'institution.admin_invite_revoked',
      metadata: {
        institutionId: auth.institutionId,
        revokedAdminId: adminUserId,
        email: target.email,
      },
    })

    revalidatePath('/admin/admins')
    return { success: true as const }
  } catch (error) {
    logger.error('revokeCoAdminInvite', error)
    return { error: 'Unexpected error' }
  }
}
