// Admin server actions for reviewing TA/grader requests.
// Approve flow: invite-or-link the candidate → insert section_staff → mark request approved → email candidate.
// Reject flow: mark request rejected with note → email the professor who submitted it.
'use server'

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { verifyInstitutionAdmin } from '@/lib/auth/admin-context'
import { assertTenantOwns, assertTenantOwnsVia } from '@/lib/auth/assert-tenant-owns'
import {
  approveStaffRequestSchema,
  rejectStaffRequestSchema,
  revokeStaffSchema,
  resendStaffInviteSchema,
  type ApproveStaffRequestInput,
  type RejectStaffRequestInput,
  type RevokeStaffInput,
  type ResendStaffInviteInput,
} from '@/lib/validations/section-staff'
import { sendStaffWelcome, sendStaffRequestRejected, sendStaffInviteLink } from '@/lib/email'
import { generateSecurePassword } from '@/lib/validations/student'
import { logger } from '@/lib/logger'
import { logEvent } from '@/lib/supabase/event-logger'
import { emitEvent } from '@/lib/events/emit'

/**
 * Finds an existing auth user by email. Used to recover from orphaned auth
 * users (e.g. a previous approve attempt that failed after inviteUserByEmail
 * but before the profile upsert). Supabase admin SDK has no getUserByEmail,
 * so listUsers pagination is the canonical path. Cap is 200 pages × 1000 =
 * 200k users — comfortably above our 30k-user launch target with headroom
 * for multi-institution growth. Short-circuits when a page returns fewer
 * than 1000 results (end of list reached).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function findAuthUserIdByEmail(adminDb: any, email: string): Promise<string | null> {
  const needle = email.toLowerCase()
  for (let page = 1; page <= 200; page++) {
    const { data, error } = await adminDb.auth.admin.listUsers({ page, perPage: 1000 })
    if (error || !data?.users) return null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const match = data.users.find((u: any) => u.email?.toLowerCase() === needle)
    if (match) return match.id
    if (data.users.length < 1000) return null
  }
  return null
}

/**
 * True if the Supabase auth error indicates the email is already registered.
 * Supabase returns this as HTTP 422 with code 'email_exists' or variations
 * of the message text depending on SDK version.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isEmailAlreadyRegistered(err: any): boolean {
  if (!err) return false
  if (err.status === 422) return true
  if (err.code === 'email_exists' || err.code === 'user_already_exists') return true
  return /already (been )?registered|already exists/i.test(err.message || '')
}

/**
 * Approves a pending staff request:
 *   1. Link to existing profile if email matches, else invite via auth.admin.inviteUserByEmail
 *   2. Insert section_staff row (status=active)
 *   3. Update request (status=approved, section_staff_id set)
 *   4. Send welcome email to the candidate
 */
export async function approveStaffRequest(input: ApproveStaffRequestInput) {
  try {
    const auth = await verifyInstitutionAdmin('staff-requests')
    if ('error' in auth) return { error: auth.error }

    const parsed = approveStaffRequestSchema.safeParse(input)
    if (!parsed.success) return { error: 'Invalid input' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    /* Tenant guard via the request's section. Without this an admin in
     * tenant A could approve a tenant-B TA request, dragging a tenant-B
     * candidate into a section staff role under their tenant. */
    const own = await assertTenantOwnsVia(adminDb, 'section_staff_requests', parsed.data.request_id, 'section_id', 'course_sections', auth.institutionId, { actionName: 'approveStaffRequest' })
    if (!own.ok) return { error: own.error }

    const { data: req, error: reqError } = await adminDb
      .from('section_staff_requests')
      .select(`
        *,
        section:course_sections(id, end_date, professor_id, section_code, course:courses(code, title))
      `)
      .eq('id', parsed.data.request_id)
      .single()

    if (reqError || !req) return { error: 'Request not found' }
    if (req.status !== 'pending') return { error: 'Only pending requests can be approved' }

    const section = Array.isArray(req.section) ? req.section[0] : req.section
    const course = section?.course ? (Array.isArray(section.course) ? section.course[0] : section.course) : null
    const courseLabel = course ? `${course.code} · ${course.title}` : section?.section_code || 'this section'

    /* 1. Resolve or invite the candidate's profile.
     *
     * The lookup stays UNSCOPED but selects institution_id and compares it (#745).
     * It used to have no tenant predicate at all, on the admin client, so a request
     * naming a student in another institution resolved to that person and the
     * promotion branch below would flip their role — breaking their real account in
     * their own institution. The role-conflict refusal further down doubled as a
     * platform-wide "does this email exist, and as what" oracle.
     *
     * Deliberately NOT `.eq('institution_id', ...)`: that would make a foreign email
     * look like a brand-new one and fall through to the invite branch, where
     * createUser reports the address taken, orphan recovery claims that auth user by
     * id, and the profile upsert rewrites the victim's row with OUR institution_id —
     * turning an authorization gap into cross-tenant account takeover. We need to
     * know the row exists in order to refuse it. */
    const { data: existing } = await adminDb
      .from('profiles')
      .select('id, email, role, name, invite_status, institution_id')
      .ilike('email', req.candidate_email)
      .maybeSingle()

    /* Belongs to someone else's institution. The message must not confirm that the
     * account exists or say what it is — same reasoning as the stale-revoke copy in
     * #723: distinguishing "not here" from "here but not yours" IS the oracle. */
    if (existing && existing.institution_id !== auth.institutionId) {
      logger.warn('approveStaffRequest: refused cross-institution candidate', {
        requestId: req.id,
        institutionId: auth.institutionId,
      })
      return { error: 'This email can\'t be added here. Check the address, or contact support.' }
    }

    let staffId: string
    let shouldSendInvite = false
    let tempPassword: string | undefined

    if (existing) {
      /* Safety: block conflicting identities. Naming the role here is fine now —
       * the guard above guarantees this profile is in the caller's own institution,
       * whose users they can already see. Before that guard it disclosed the role of
       * any account on the platform. */
      if (existing.role === 'institution_admin' || existing.role === 'professor') {
        return {
          error: `Cannot approve — ${req.candidate_email} is registered as a ${existing.role}. Remove that role first or use a different email.`,
        }
      }
      /* A student becoming staff requires explicit admin confirmation, because
       * flipping the role revokes their access to /student routes. Signal the
       * client to show a second confirmation dialog, then re-submit with the
       * promote flag. Their existing enrollments stay in the DB untouched. */
      if (existing.role === 'student') {
        if (!parsed.data.promote_existing_student) {
          return {
            requires_student_promotion: true as const,
            candidate: {
              name: existing.name || `${req.candidate_first_name} ${req.candidate_last_name}`,
              email: req.candidate_email,
            },
          }
        }
        /* Admin confirmed — flip role to 'course_assistant'. The profile row
         * and auth user are preserved. onboarding_completed stays true so they
         * skip the set-password step on next login. */
        const { error: promoteError } = await adminDb
          .from('profiles')
          .update({ role: 'course_assistant' })
          .eq('id', existing.id)
        if (promoteError) {
          logger.error('approveStaffRequest: Student promotion failed', promoteError, { profileId: existing.id })
          return { error: 'Failed to promote student to course assistant. Please try again.' }
        }
        logger.info('approveStaffRequest: Promoted student to course_assistant', { profileId: existing.id, email: req.candidate_email })
        logEvent({
          userId: auth.userId,
          eventType: 'staff.promoted_from_student',
          metadata: { profileId: existing.id, email: req.candidate_email },
        })
      }
      staffId = existing.id
    } else {
      /* Temp-password flow: create the auth user with a known password,
       * email_confirm:true so they can log in immediately, and
       * requires_password_set:true so middleware bounces them through
       * SetPasswordDialog on first navigation. Cleared by completeOnboarding().
       *
       * We dropped the magic-link invite flow because email scanners
       * (Gmail Safe-Browsing, Outlook ATP, Resend click-tracking) silently
       * redeem the single-use action_link during pre-fetch scans, breaking
       * the first click for the invitee. Temp passwords have nothing to consume. */
      const fullName = `${req.candidate_first_name} ${req.candidate_last_name}`
      tempPassword = generateSecurePassword()

      const { data: createData, error: createError } = await adminDb.auth.admin.createUser({
        email: req.candidate_email,
        password: tempPassword,
        email_confirm: true,
        /* institution_id records who created this auth user, so the orphan-recovery
         * branch below can tell OUR half-finished invite from another tenant's (#745).
         * A profiles row is the usual provenance record, but an orphan is precisely
         * the case where that row does not exist yet. */
        app_metadata: { requires_password_set: true, institution_id: auth.institutionId },
        user_metadata: { name: fullName, role: 'course_assistant' },
      })

      if (createError && isEmailAlreadyRegistered(createError)) {
        /* Orphan auth user from a previous failed approve attempt. Recover
         * by reusing the existing user ID and rotating the password. */
        const orphanId = await findAuthUserIdByEmail(adminDb, req.candidate_email)
        if (!orphanId) {
          logger.error('approveStaffRequest: Could not locate orphan auth user', createError, { email: req.candidate_email })
          return { error: 'Email already registered in auth but user record is not accessible. Contact support.' }
        }
        /* Only recover an orphan we can prove is ours (#745). An auth user with no
         * profiles row is NOT automatically a leftover of our own failed attempt — it
         * is equally the shape of another institution's invite whose profile insert
         * failed, and claiming it would hand them our tenant. Missing provenance is
         * treated as foreign: fail closed. Orphans predating this stamp land here and
         * need a human, which is the right outcome for an ambiguous account. */
        const { data: stamped } = await adminDb.auth.admin.getUserById(orphanId)
        const existingAppMeta = stamped?.user?.app_metadata || {}
        if (existingAppMeta.institution_id !== auth.institutionId) {
          logger.warn('approveStaffRequest: refused orphan of unknown provenance', {
            requestId: req.id,
            orphanId,
            institutionId: auth.institutionId,
          })
          return { error: 'This email can\'t be added here. Check the address, or contact support.' }
        }

        logger.warn('approveStaffRequest: Recovered orphan auth user', { email: req.candidate_email, orphanId })
        staffId = orphanId

        /* Rotate password + re-stamp the password gate + confirm email so the
         * orphan can log in with the fresh temp password. */
        const { error: rotateError } = await adminDb.auth.admin.updateUserById(orphanId, {
          password: tempPassword,
          email_confirm: true,
          app_metadata: { ...existingAppMeta, requires_password_set: true },
        })
        if (rotateError) {
          logger.error('approveStaffRequest: Failed to rotate password on orphan', rotateError, { orphanId })
          return { error: 'Could not reset orphaned account password. Contact support.' }
        }
        shouldSendInvite = true
      } else if (createError || !createData?.user) {
        logger.error('approveStaffRequest: Auth user creation failed', createError, { email: req.candidate_email })
        return { error: `Failed to create user: ${createError?.message || 'unknown error'}` }
      } else {
        staffId = createData.user.id
        shouldSendInvite = true
      }

      /* Upsert profile. Works for both fresh invites and orphan recovery —
       * onConflict:id means a pre-existing row is updated in place.
       * institution_id ties this CA to the requesting admin's institution. */
      const { error: profileError } = await adminDb
        .from('profiles')
        .upsert(
          {
            id: staffId,
            email: req.candidate_email,
            name: fullName,
            first_name: req.candidate_first_name,
            last_name: req.candidate_last_name,
            role: 'course_assistant',
            institution_id: auth.institutionId,
            invite_status: 'pending',
            invited_at: new Date().toISOString(),
            invited_by: auth.userId,
            onboarding_completed: false,
          },
          { onConflict: 'id' }
        )
      if (profileError) {
        logger.error('approveStaffRequest: Profile upsert failed', profileError, { staffId })
        return { error: 'Invite sent but profile creation failed. Review manually.' }
      }
    }

    /* 2. Insert section_staff. */
    const startsAt = parsed.data.starts_at || req.starts_at || new Date().toISOString()
    const endsAt = parsed.data.ends_at || req.ends_at
    const { data: staffRow, error: staffError } = await adminDb
      .from('section_staff')
      .insert({
        section_id: req.section_id,
        staff_id: staffId,
        role: req.requested_role,
        status: 'active',
        starts_at: startsAt,
        ends_at: endsAt,
        approved_by: auth.userId,
      })
      .select('id')
      .single()

    if (staffError) {
      logger.error('approveStaffRequest: Insert section_staff failed', staffError, { requestId: req.id })
      return { error: 'Failed to activate staff assignment. They may already be active on this section.' }
    }

    /* 3. Update request. */
    const { error: updateError } = await adminDb
      .from('section_staff_requests')
      .update({
        status: 'approved',
        reviewed_by: auth.userId,
        reviewed_at: new Date().toISOString(),
        review_note: parsed.data.note || null,
        section_staff_id: staffRow.id,
      })
      .eq('id', req.id)

    if (updateError) {
      logger.error('approveStaffRequest: Update request failed', updateError, { requestId: req.id })
    }

    /* 4. Welcome email (best-effort). For fresh invites / orphan recovery we
     * pass tempPassword so the email shows the credentials block and CTA to
     * log in. For promoted students (no invite needed) we omit it — the
     * template reverts to a "sign in with your existing password" message. */
    const welcomeFullName = `${req.candidate_first_name} ${req.candidate_last_name}`
    const emailOk = await sendStaffWelcome(req.candidate_email, welcomeFullName, {
      role: req.requested_role,
      courseLabel,
      professorName:
        (await adminDb.from('profiles').select('name').eq('id', req.requested_by).single())?.data?.name || 'your professor',
      endsAt,
      tempPassword,
    })

    logger.info('approveStaffRequest: Success', {
      requestId: req.id,
      staffId,
      role: req.requested_role,
      invited: shouldSendInvite,
      emailOk,
    })
    logEvent({
      userId: auth.userId,
      eventType: 'staff_request.approved',
      sectionId: req.section_id,
      metadata: { requestId: req.id, staffId, role: req.requested_role },
    })

    // Notify the professor who submitted the request that it was approved (in-app).
    // The candidate gets the welcome email above; the requester previously got nothing.
    const candidateName = `${req.candidate_first_name} ${req.candidate_last_name}`
    await emitEvent({
      type: 'staff_request_approved',
      sectionId: req.section_id,
      actorId: auth.userId,
      audience: [req.requested_by].filter(Boolean) as string[],
      entity: { type: 'staff_request', id: req.id },
      title: 'Staff request approved',
      body: `Your request to add ${candidateName} to ${courseLabel} was approved.`,
      linkUrl: `/professor/courses/${req.section_id}/staff`,
      actionable: false,
    })

    revalidatePath('/admin/staff')
    revalidatePath(`/professor/courses/${req.section_id}/staff`)
    return {
      success: true,
      emailWarning: emailOk
        ? undefined
        : ('Welcome email could not be sent — the invitee will only see the generic Supabase auth email. Consider contacting them directly.' as const),
    }
  } catch (error) {
    logger.error('approveStaffRequest', error)
    return { error: 'Unexpected error' }
  }
}

/** Rejects a pending request with a required note. Emails the professor. */
export async function rejectStaffRequest(input: RejectStaffRequestInput) {
  try {
    const auth = await verifyInstitutionAdmin('staff-requests')
    if ('error' in auth) return { error: auth.error }

    const parsed = rejectStaffRequestSchema.safeParse(input)
    if (!parsed.success) {
      const fieldErrors = parsed.error.flatten().fieldErrors
      return { error: Object.values(fieldErrors).flat()[0] || 'Invalid input' }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    /* Tenant guard via the request's section. */
    const own = await assertTenantOwnsVia(adminDb, 'section_staff_requests', parsed.data.request_id, 'section_id', 'course_sections', auth.institutionId, { actionName: 'rejectStaffRequest' })
    if (!own.ok) return { error: own.error }

    const { data: req, error: reqError } = await adminDb
      .from('section_staff_requests')
      .select(`
        *,
        requester:profiles!section_staff_requests_requested_by_fkey(id, name, email),
        section:course_sections(section_code, course:courses(code, title))
      `)
      .eq('id', parsed.data.request_id)
      .single()
    if (reqError || !req) return { error: 'Request not found' }
    if (req.status !== 'pending') return { error: 'Only pending requests can be rejected' }

    const { error: updateError } = await adminDb
      .from('section_staff_requests')
      .update({
        status: 'rejected',
        reviewed_by: auth.userId,
        reviewed_at: new Date().toISOString(),
        review_note: parsed.data.note,
      })
      .eq('id', req.id)

    if (updateError) {
      logger.error('rejectStaffRequest: Update failed', updateError, { requestId: req.id })
      return { error: 'Failed to reject request' }
    }

    /* Email the professor who submitted it. */
    const requester = Array.isArray(req.requester) ? req.requester[0] : req.requester
    const section = Array.isArray(req.section) ? req.section[0] : req.section
    const course = section?.course ? (Array.isArray(section.course) ? section.course[0] : section.course) : null
    const courseLabel = course ? `${course.code} · ${course.title}` : section?.section_code || 'your section'
    if (requester?.email) {
      await sendStaffRequestRejected(requester.email, requester.name || 'Professor', {
        candidateName: `${req.candidate_first_name} ${req.candidate_last_name}`,
        courseLabel,
        reason: parsed.data.note,
      })
    }

    logger.info('rejectStaffRequest: Success', { requestId: req.id })
    logEvent({
      userId: auth.userId,
      eventType: 'staff_request.rejected',
      sectionId: req.section_id,
      metadata: { requestId: req.id, reason: parsed.data.note },
    })

    // In-app notice to the professor to match the rejection email sent above. The email
    // existed; the bell item did not.
    await emitEvent({
      type: 'staff_request_rejected',
      sectionId: req.section_id,
      actorId: auth.userId,
      audience: [requester?.id].filter(Boolean) as string[],
      entity: { type: 'staff_request', id: req.id },
      title: 'Staff request declined',
      body: `Your request to add ${req.candidate_first_name} ${req.candidate_last_name} to ${courseLabel} was declined.`,
      linkUrl: `/professor/courses/${req.section_id}/staff`,
      actionable: false,
    })

    revalidatePath('/admin/staff')
    revalidatePath(`/professor/courses/${req.section_id}/staff`)
    return { success: true }
  } catch (error) {
    logger.error('rejectStaffRequest', error)
    return { error: 'Unexpected error' }
  }
}

/** Revokes an active assignment early (sets status='removed'). */
export async function revokeStaffAssignment(input: RevokeStaffInput) {
  try {
    const auth = await verifyInstitutionAdmin('staff-requests')
    if ('error' in auth) return { error: auth.error }

    const parsed = revokeStaffSchema.safeParse(input)
    if (!parsed.success) return { error: 'Invalid input' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    /* Tenant guard via the staff row's section. */
    const own = await assertTenantOwnsVia(adminDb, 'section_staff', parsed.data.staff_id, 'section_id', 'course_sections', auth.institutionId, { actionName: 'revokeStaffAssignment' })
    if (!own.ok) return { error: own.error }

    const { data: staff } = await adminDb
      .from('section_staff')
      .select('id, section_id, staff_id, status, ends_at')
      .eq('id', parsed.data.staff_id)
      .single()
    if (!staff) return { error: 'Staff assignment not found' }
    if (staff.status !== 'active') return { error: 'Only active assignments can be revoked' }

    /* Keep a genuine past end date. Nothing in this codebase ever writes status='ended', so an
       assignment that simply ran its course sits at status='active' with ends_at in the past
       indefinitely, and this action is the only thing that can close it out. Stamping today
       over that date would rewrite the person's real service dates, which they are shown back
       as "Through {ends_at}" on their own dashboard. It is the one effect here that cannot be
       undone.

       DECIDED IN SQL, not here. The first version compared `ends_at` against the Node clock and
       wrote the result back, which a consultant review showed corrupts data in one direction: if
       the app clock runs BEHIND the database, a genuinely expired date reads as still-running and
       gets overwritten with the app's lagging time. One clock removes the split, and it collapses
       the read-decide-write into a single atomic statement, so the status guard no longer depends
       on the SELECT above being fresh. The SELECT is kept only to tell "not found" apart from
       "already closed" in the message. */
    const { data: closed, error: updateError } = await adminDb
      .rpc('revoke_staff_assignment', { p_staff_id: staff.id })
      .maybeSingle()

    if (updateError) {
      logger.error('revokeStaffAssignment: Update failed', updateError, { staffId: staff.id })
      return { error: 'Failed to revoke assignment' }
    }
    if (!closed) {
      /* Logged, because the row ends up in the same state either way: without this, a second
         admin who believes their reason was recorded leaves no trace to find later. */
      logger.warn('revokeStaffAssignment: lost the compare-and-swap', {
        staffId: staff.id,
        actorId: auth.userId,
      })
      return { error: 'Someone else closed this assignment while you were looking at it.' }
    }

    logEvent({
      userId: auth.userId,
      eventType: 'staff.revoked',
      sectionId: staff.section_id,
      metadata: { staffId: staff.staff_id, reason: parsed.data.reason || null },
    })

    revalidatePath('/admin/staff')
    revalidatePath(`/professor/courses/${staff.section_id}/staff`)
    return { success: true }
  } catch (error) {
    logger.error('revokeStaffAssignment', error)
    return { error: 'Unexpected error' }
  }
}

/**
 * Counts what deleting a course-assistant profile would remove, for the confirm dialog.
 *
 * Returns null on ANY failure, never zeros — the dialog reads zeros as "nothing attached",
 * and reassuring an admin on a failed lookup is what made #715 critical.
 */
export async function getCourseAssistantCascadeCounts(
  assistantId: string,
): Promise<{ activeAssignments: number; pastAssignments: number } | null> {
  try {
    const auth = await verifyInstitutionAdmin('staff-requests')
    if ('error' in auth) return null

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    const own = await assertTenantOwns(adminDb, 'profiles', assistantId, auth.institutionId, {
      actionName: 'getCourseAssistantCascadeCounts',
    })
    if (!own.ok) return null

    const { data: rows, error } = await adminDb
      .from('section_staff')
      .select('status')
      .eq('staff_id', assistantId)
    if (error) {
      logger.error('getCourseAssistantCascadeCounts: read failed', error, { assistantId })
      return null
    }

    const all = (rows ?? []) as Array<{ status: string }>
    const active = all.filter((r) => r.status === 'active').length
    return { activeAssignments: active, pastAssignments: all.length - active }
  } catch (error) {
    logger.error('getCourseAssistantCascadeCounts', error, { assistantId })
    return null
  }
}

/**
 * Deletes a course-assistant profile outright.
 *
 * Professors and students both had a delete path; course assistants did not (#725 part 2).
 * They could be revoked from their sections, but the profile itself stayed forever, so test
 * and mistaken accounts accumulated with no way to clear them short of a direct DB delete.
 *
 * Refuses while any assignment is still active: revoke first, so deletion is never the thing
 * that silently ends someone's access to a live course. Mirrors deleteProfessor, which
 * refuses while sections are assigned.
 *
 * ORDER MATTERS. deleteProfessor deletes the auth user FIRST and then the profile row, and
 * profiles cascade from auth.users — so the profile is already gone by the time the second
 * delete runs, it reports zero rows, and the action returns "Failed to delete" for work that
 * actually succeeded (#723). Here the profile row goes first and the auth user last: a
 * failure at that point leaves an orphaned auth user, which is harmless and recoverable,
 * rather than a lie about the outcome.
 */
export async function deleteCourseAssistant(assistantId: string) {
  try {
    const auth = await verifyInstitutionAdmin('staff-requests')
    if ('error' in auth) return { error: auth.error }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    const own = await assertTenantOwns(adminDb, 'profiles', assistantId, auth.institutionId, {
      actionName: 'deleteCourseAssistant',
    })
    if (!own.ok) return { error: own.error }

    /* Only ever a course assistant. Without this an admin could delete a professor or a
       student through the staff surface, bypassing the guards those paths carry. */
    const { data: profile } = await adminDb
      .from('profiles')
      .select('id, role')
      .eq('id', assistantId)
      .maybeSingle()
    if (!profile) return { error: 'That account no longer exists.' }
    if (profile.role !== 'course_assistant') {
      return { error: 'That account is not a course assistant.' }
    }

    const { data: activeRows, error: activeError } = await adminDb
      .from('section_staff')
      .select('id')
      .eq('staff_id', assistantId)
      .eq('status', 'active')
    if (activeError) {
      logger.error('deleteCourseAssistant: assignment check failed', activeError, { assistantId })
      return { error: 'Could not check their course assignments. Please try again.' }
    }
    if ((activeRows ?? []).length > 0) {
      return {
        error: `Cannot delete: they are still assigned to ${activeRows.length} course section(s). Revoke those first.`,
      }
    }

    const { error: profileError } = await adminDb.from('profiles').delete().eq('id', assistantId)
    if (profileError) {
      logger.error('deleteCourseAssistant: profile deletion failed', profileError, { assistantId })
      return { error: 'Failed to delete this course assistant.' }
    }

    /* Last, and non-fatal. See the ordering note above. */
    const { error: authError } = await adminDb.auth.admin.deleteUser(assistantId)
    if (authError) {
      logger.error('deleteCourseAssistant: auth user deletion failed', authError, { assistantId })
    }

    logEvent({
      userId: auth.userId,
      eventType: 'staff.profile_deleted',
      metadata: { assistantId },
    })
    revalidatePath('/admin/staff')
    return { success: true }
  } catch (error) {
    logger.error('deleteCourseAssistant', error, { assistantId })
    return { error: 'Unexpected error' }
  }
}

/**
 * Issues a fresh temporary password to a staff profile whose original
 * credentials expired or never landed (Resend bounce, user lost the email,
 * etc). Resolves the latest active section_staff row for context, rotates
 * the auth password, re-stamps the requires_password_set gate, and emails
 * the new credentials. Safe to call repeatedly.
 */
export async function resendStaffInvite(input: ResendStaffInviteInput) {
  try {
    const auth = await verifyInstitutionAdmin('staff-requests')
    if ('error' in auth) return { error: auth.error }

    const parsed = resendStaffInviteSchema.safeParse(input)
    if (!parsed.success) return { error: 'Invalid input' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    /* Tenant guard — without this an admin in tenant A could rotate the
     * password of a tenant-B course_assistant and read the welcome email,
     * a trivial account takeover. */
    const own = await assertTenantOwns(adminDb, 'profiles', parsed.data.profile_id, auth.institutionId, { actionName: 'resendStaffInvite' })
    if (!own.ok) return { error: own.error }

    const { data: profile } = await adminDb
      .from('profiles')
      .select('id, email, name, role, invite_status')
      .eq('id', parsed.data.profile_id)
      .single()

    if (!profile) return { error: 'Profile not found' }
    if (profile.role !== 'course_assistant') return { error: 'Only course-assistant profiles can be re-invited through this action' }
    if (profile.invite_status !== 'pending') {
      return { error: `Invite is already ${profile.invite_status} — no resend needed` }
    }

    /* Pull the most recent active assignment for context in the email. */
    const { data: latestStaff } = await adminDb
      .from('section_staff')
      .select(`
        role,
        section:course_sections(section_code, course:courses(code, title))
      `)
      .eq('staff_id', profile.id)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    const section = latestStaff?.section
      ? Array.isArray(latestStaff.section)
        ? latestStaff.section[0]
        : latestStaff.section
      : null
    const course = section?.course
      ? Array.isArray(section.course)
        ? section.course[0]
        : section.course
      : null
    const courseLabel = course ? `${course.code} · ${course.title}` : section?.section_code || 'your section'
    const assignmentRole = (latestStaff?.role as 'ta' | 'grader') || 'ta'

    /* Rotate the temp password + ensure the requires_password_set gate is on
     * + confirm email so the staff member can log in immediately. */
    const tempPassword = generateSecurePassword()
    const { data: stamped } = await adminDb.auth.admin.getUserById(profile.id)
    const existingAppMeta = stamped?.user?.app_metadata || {}
    const { error: rotateError } = await adminDb.auth.admin.updateUserById(profile.id, {
      password: tempPassword,
      email_confirm: true,
      app_metadata: { ...existingAppMeta, requires_password_set: true },
    })
    if (rotateError) {
      logger.error('resendStaffInvite: Failed to rotate temp password', rotateError, { profileId: profile.id })
      return { error: 'Could not reset the password. Please try again.' }
    }

    const emailOk = await sendStaffInviteLink(profile.email, profile.name || profile.email, {
      tempPassword,
      role: assignmentRole,
      courseLabel,
    })

    /* Reset invited_at so the admin directory sorts this row as freshly invited. */
    await adminDb
      .from('profiles')
      .update({ invited_at: new Date().toISOString(), invited_by: auth.userId })
      .eq('id', profile.id)

    logEvent({
      userId: auth.userId,
      eventType: 'staff_invite.resent',
      metadata: { profileId: profile.id, emailOk },
    })

    revalidatePath('/admin/staff')
    return {
      success: true,
      emailWarning: emailOk
        ? undefined
        : ('Password reset, but the credentials email could not be sent. Try again in a minute; if it still fails, contact support.' as const),
    }
  } catch (error) {
    logger.error('resendStaffInvite', error)
    return { error: 'Unexpected error' }
  }
}
