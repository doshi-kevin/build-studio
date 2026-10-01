/**
 * provisionStudentAccount — the one place a student account comes into existence.
 *
 * Extracted from admin/students/actions.ts createStudent so the bulk roster import
 * can create accounts per-row without calling the server action (which re-verifies
 * auth and revalidates paths on every call). Both callers share this exact sequence:
 *
 * 1. Generate a secure temp password.
 * 2. auth.admin.createUser with email_confirm:true + requires_password_set:true —
 *    the student can log in immediately and is forced through SetPasswordDialog.
 * 3. Upsert the profile (handles the handle_new_user() trigger race) with
 *    role='student', invite_status='pending', onboarding_completed:false.
 *
 * Does NOT check duplicates, send email, log events, or revalidate — callers own
 * those (they differ between the single-add form and the bulk import).
 *
 * Server-only: takes the service-role admin client. Callers MUST have verified
 * institution-admin auth first and MUST pass institutionId from the verified
 * session, never from client input.
 */

import { studentQueries } from '@/lib/supabase/queries'
import { generateSecurePassword } from '@/lib/validations/student'
import { logger } from '@/lib/logger'
import type { SupabaseClient } from '@supabase/supabase-js'

export interface ProvisionStudentInput {
  email: string
  firstName: string
  lastName: string
  /** null = no campus ID (bulk import) — the student logs in by email */
  cwid: string | null
  phone?: string | null
  institutionId: string
  invitedBy: string
}

export type ProvisionStudentResult =
  | { ok: true; profile: Record<string, unknown>; userId: string; password: string }
  | { ok: false; error: string }

export async function provisionStudentAccount(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminDb: any,
  input: ProvisionStudentInput
): Promise<ProvisionStudentResult> {
  const password = generateSecurePassword()
  const fullName = `${input.firstName} ${input.lastName}`.trim()

  const { data: authData, error: authError } = await adminDb.auth.admin.createUser({
    email: input.email,
    password,
    email_confirm: true,
    app_metadata: { requires_password_set: true },
    user_metadata: { name: fullName, role: 'student' },
  })

  if (authError) {
    /* Deliberately generic: auth.users is GLOBAL across tenants, so echoing
       Supabase's "already been registered" message would let an admin probe
       whether arbitrary emails have accounts at OTHER institutions (user
       enumeration). The real reason stays in the server log. */
    logger.error('provisionStudentAccount: Auth user creation failed', authError, { email: input.email })
    return { ok: false, error: 'Could not create an account for this email — it may already be in use' }
  }

  const userId = authData.user.id

  const profile = await studentQueries.upsertProfile(adminDb as SupabaseClient, {
    id: userId,
    email: input.email,
    name: fullName,
    first_name: input.firstName,
    last_name: input.lastName,
    cwid: input.cwid,
    institution_id: input.institutionId,
    phone: input.phone || null,
    invite_status: 'pending',
    invited_at: new Date().toISOString(),
    invited_by: input.invitedBy,
    onboarding_completed: false,
  })

  if (!profile) {
    logger.error('provisionStudentAccount: Profile upsert failed', null, { userId })
    return { ok: false, error: 'Account created but profile update failed' }
  }

  return { ok: true, profile, userId, password }
}
