// Server actions for super_admin team management at the platform tier.
//
// Lets a super_admin invite up to MAX_SUPER_ADMINS (5) other super_admins,
// resend a pending invite, revoke a pending invite, and (for the platform
// owner only) transfer ownership to another super_admin.
//
// The platform owner is enforced at the DB layer via a partial unique
// index on profiles(is_platform_owner) WHERE true (mig 50). Only one row
// can be the owner at a time. Transfer is two UPDATEs in sequence —
// demote self first (frees the index slot), then promote target. If the
// second update fails, the first is rolled back so the platform never
// ends up ownerless.
//
// The cap counts BOTH pending + accepted super_admins so it can't be
// bypassed by flooding pending invites.

'use server'

/* eslint-disable @typescript-eslint/no-explicit-any */

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { verifySuperAdmin } from '@/lib/auth/super-admin-context'
import {
  inviteSuperAdminSchema,
  MAX_SUPER_ADMINS,
  type InviteSuperAdminInput,
} from '@/lib/validations/super-admin-invite'
import { sendSuperAdminWelcome } from '@/lib/email'
import { generateSecurePassword } from '@/lib/validations/student'
import { logger } from '@/lib/logger'
import { logEvent } from '@/lib/supabase/event-logger'

/** Count current super_admins (pending + accepted) platform-wide. */
async function countSuperAdmins(adminDb: any): Promise<number> {
  const { count, error } = await adminDb
    .from('profiles')
    .select('id', { count: 'exact', head: true })
    .eq('role', 'super_admin')
  if (error) {
    logger.error('countSuperAdmins failed', error)
    /* Fail safe — refuse the invite rather than over-allocate. */
    return MAX_SUPER_ADMINS
  }
  return count || 0
}

/**
 * Invite another super_admin. Enforces MAX_SUPER_ADMINS. The invitee gets
 * a temp-password welcome email and is forced through SetPasswordDialog
 * on first login (same flow as institution_admin invites).
 */
export async function inviteSuperAdmin(input: InviteSuperAdminInput) {
  try {
    const auth = await verifySuperAdmin()
    if ('error' in auth) return { error: auth.error }

    const parsed = inviteSuperAdminSchema.safeParse(input)
    if (!parsed.success) {
      const firstError = Object.values(parsed.error.flatten().fieldErrors).flat()[0]
      return { error: firstError || 'Invalid input' }
    }

    const data = parsed.data
    const adminDb = createAdminClient() as any

    /* Cap check — counts pending + accepted to prevent flood bypass. */
    const current = await countSuperAdmins(adminDb)
    if (current >= MAX_SUPER_ADMINS) {
      return {
        error: `Scholera already has the maximum of ${MAX_SUPER_ADMINS} super_admins. Remove or revoke a pending invite first.`,
      }
    }

    /* Reject if email is already in use anywhere on the platform — super_admin
     * is platform-wide, so cross-tenant collision is the same collision. */
    const { data: emailHit } = await adminDb
      .from('profiles')
      .select('id, email, role')
      .eq('email', data.email)
      .maybeSingle()

    if (emailHit) {
      return { error: `A user with email "${data.email}" already exists on Scholera` }
    }

    const tempPassword = generateSecurePassword()
    const { data: createUserData, error: createUserErr } = await adminDb.auth.admin.createUser({
      email: data.email,
      password: tempPassword,
      email_confirm: true,
      app_metadata: { requires_password_set: true },
      user_metadata: { name: data.name, role: 'super_admin' },
    })

    if (createUserErr || !createUserData?.user?.id) {
      logger.error('inviteSuperAdmin: createUser failed', createUserErr, { email: data.email })
      return { error: `Failed to create super_admin account: ${createUserErr?.message || 'unknown error'}` }
    }

    const newAdminId = createUserData.user.id
    const { error: profileErr } = await adminDb
      .from('profiles')
      .upsert(
        {
          id: newAdminId,
          email: data.email,
          name: data.name,
          role: 'super_admin',
          /* Super_admins are platform-tier — institution_id is null. */
          institution_id: null,
          invite_status: 'pending',
          invited_at: new Date().toISOString(),
          invited_by: auth.userId,
          onboarding_completed: false,
          is_platform_owner: false,
        },
        { onConflict: 'id' },
      )

    if (profileErr) {
      logger.error('inviteSuperAdmin: profile upsert failed', profileErr, { newAdminId })
      /* Roll back orphan auth user so the email is reusable. */
      await adminDb.auth.admin.deleteUser(newAdminId).catch((e: unknown) => {
        logger.error('inviteSuperAdmin: orphan cleanup failed', e, { newAdminId })
      })
      return { error: 'Super_admin invite failed. Try again.' }
    }

    await sendSuperAdminWelcome(data.email, data.name, {
      tempPassword,
      isPlatformOwner: false,
    })

    logger.info('inviteSuperAdmin: success', { newAdminId, invitedBy: auth.userId })
    logEvent({
      userId: auth.userId,
      eventType: 'platform.super_admin_invited',
      metadata: { newAdminId, email: data.email },
    })

    revalidatePath('/super-admin/team')
    return { success: true as const, data: { newAdminId } }
  } catch (error) {
    logger.error('inviteSuperAdmin', error)
    return { error: 'Unexpected error' }
  }
}

/**
 * Re-issue the welcome email to a still-pending super_admin (rotates their
 * temp password so the original email becomes useless). Only works on
 * profiles whose invite_status is still 'pending'.
 */
export async function resendSuperAdminInvite(targetUserId: string) {
  try {
    const auth = await verifySuperAdmin()
    if ('error' in auth) return { error: auth.error }

    const adminDb = createAdminClient() as any

    const { data: target, error: targetErr } = await adminDb
      .from('profiles')
      .select('id, email, name, role, invite_status, is_platform_owner')
      .eq('id', targetUserId)
      .maybeSingle()

    if (targetErr || !target) return { error: 'Super_admin not found' }
    if (target.role !== 'super_admin') return { error: 'Target is not a super_admin' }
    if (target.invite_status !== 'pending') {
      return { error: 'Invite has already been accepted — use password reset instead' }
    }

    const tempPassword = generateSecurePassword()
    const { error: updateErr } = await adminDb.auth.admin.updateUserById(targetUserId, {
      password: tempPassword,
      app_metadata: { requires_password_set: true },
    })
    if (updateErr) {
      logger.error('resendSuperAdminInvite: updateUserById failed', updateErr, { targetUserId })
      return { error: `Failed to rotate password: ${updateErr.message || 'unknown error'}` }
    }

    await adminDb
      .from('profiles')
      .update({ invited_at: new Date().toISOString() })
      .eq('id', targetUserId)

    await sendSuperAdminWelcome(target.email, target.name || 'Super Admin', {
      tempPassword,
      isPlatformOwner: target.is_platform_owner === true,
    })

    logEvent({
      userId: auth.userId,
      eventType: 'platform.super_admin_invited',
      metadata: { newAdminId: targetUserId, email: target.email, resend: true },
    })

    revalidatePath('/super-admin/team')
    return { success: true as const }
  } catch (error) {
    logger.error('resendSuperAdminInvite', error)
    return { error: 'Unexpected error' }
  }
}

/**
 * Revoke a super_admin. Refuses if target is the platform owner — only
 * the owner can transfer ownership, after which the prior owner is a
 * regular super_admin and can then be revoked.
 *
 * Self-revoke is also refused: the platform must always have at least
 * one super_admin (and the owner can't revoke themselves regardless).
 */
export async function revokeSuperAdmin(targetUserId: string) {
  try {
    const auth = await verifySuperAdmin()
    if ('error' in auth) return { error: auth.error }

    if (targetUserId === auth.userId) {
      return { error: 'You cannot revoke your own super_admin access' }
    }

    const adminDb = createAdminClient() as any

    const { data: target, error: targetErr } = await adminDb
      .from('profiles')
      .select('id, email, role, is_platform_owner, invite_status')
      .eq('id', targetUserId)
      .maybeSingle()

    if (targetErr || !target) return { error: 'Super_admin not found' }
    if (target.role !== 'super_admin') return { error: 'Target is not a super_admin' }
    if (target.is_platform_owner === true) {
      return {
        error:
          'Cannot revoke the platform owner. Transfer ownership to another super_admin first.',
      }
    }

    /* Delete the auth user (which cascades to the profile via FK ON DELETE). */
    const { error: deleteErr } = await adminDb.auth.admin.deleteUser(targetUserId)
    if (deleteErr) {
      logger.error('revokeSuperAdmin: deleteUser failed', deleteErr, { targetUserId })
      return { error: `Failed to revoke: ${deleteErr.message || 'unknown error'}` }
    }

    /* Belt-and-suspenders: ensure profile is gone even if cascade isn't configured. */
    await adminDb.from('profiles').delete().eq('id', targetUserId)

    logEvent({
      userId: auth.userId,
      eventType: 'platform.super_admin_revoked',
      metadata: { revokedAdminId: targetUserId, email: target.email },
    })

    revalidatePath('/super-admin/team')
    return { success: true as const }
  } catch (error) {
    logger.error('revokeSuperAdmin', error)
    return { error: 'Unexpected error' }
  }
}

/**
 * Transfer platform ownership from the current owner (the caller) to
 * another super_admin. The caller is demoted to a regular super_admin
 * in the same operation.
 *
 * Sequence:
 *   1. Verify caller is the current platform owner.
 *   2. Verify target is an existing, accepted super_admin.
 *   3. Demote self (drops the unique-index slot).
 *   4. Promote target. If this fails, restore self as owner.
 *
 * Failure between steps 3 and 4 is the only risky window. The unique
 * index protects against an accidental double-owner, and the rollback
 * in step 4 restores the prior owner if the promotion fails.
 */
export async function transferPlatformOwnership(newOwnerId: string) {
  try {
    const auth = await verifySuperAdmin()
    if ('error' in auth) return { error: auth.error }

    if (!auth.isPlatformOwner) {
      return { error: 'Only the platform owner can transfer ownership' }
    }
    if (newOwnerId === auth.userId) {
      return { error: 'You are already the platform owner' }
    }

    const adminDb = createAdminClient() as any

    const { data: target, error: targetErr } = await adminDb
      .from('profiles')
      .select('id, email, role, invite_status, is_platform_owner')
      .eq('id', newOwnerId)
      .maybeSingle()

    if (targetErr || !target) return { error: 'Target super_admin not found' }
    if (target.role !== 'super_admin') return { error: 'Target must be a super_admin' }
    if (target.invite_status !== 'accepted') {
      return { error: 'Target must have accepted their invite before becoming owner' }
    }
    if (target.is_platform_owner === true) {
      return { error: 'Target is already the platform owner' }
    }

    /* Step 1: demote self. Frees the partial-unique-index slot so the
     * subsequent promote doesn't conflict. */
    const { error: demoteErr } = await adminDb
      .from('profiles')
      .update({ is_platform_owner: false })
      .eq('id', auth.userId)

    if (demoteErr) {
      logger.error('transferPlatformOwnership: demote failed', demoteErr, { callerId: auth.userId })
      return { error: 'Failed to demote current owner' }
    }

    /* Step 2: promote target. */
    const { error: promoteErr } = await adminDb
      .from('profiles')
      .update({ is_platform_owner: true })
      .eq('id', newOwnerId)

    if (promoteErr) {
      logger.error('transferPlatformOwnership: promote failed', promoteErr, { newOwnerId })
      /* Rollback — restore caller as owner so the platform isn't ownerless. */
      const { error: rollbackErr } = await adminDb
        .from('profiles')
        .update({ is_platform_owner: true })
        .eq('id', auth.userId)
      if (rollbackErr) {
        /* Loud — this leaves the platform with no owner. Recovery requires
         * direct SQL by another super_admin or DB operator. */
        logger.error(
          'transferPlatformOwnership: rollback also failed — platform is OWNERLESS',
          rollbackErr,
          { callerId: auth.userId, newOwnerId },
        )
        return { error: 'Ownership transfer failed and rollback failed. Contact support.' }
      }
      return { error: 'Ownership transfer failed; rolled back to current owner.' }
    }

    logger.info('transferPlatformOwnership: success', {
      previousOwner: auth.userId,
      newOwnerId,
    })
    logEvent({
      userId: auth.userId,
      eventType: 'platform.ownership_transferred',
      metadata: { previousOwner: auth.userId, newOwnerId, newOwnerEmail: target.email },
    })

    revalidatePath('/super-admin/team')
    return { success: true as const }
  } catch (error) {
    logger.error('transferPlatformOwnership', error)
    return { error: 'Unexpected error' }
  }
}
