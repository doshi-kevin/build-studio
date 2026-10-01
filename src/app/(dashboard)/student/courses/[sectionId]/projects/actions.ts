/**
 * Student Project Server Actions — Team-driven project workspace.
 *
 * Students create teams under professor-created project assignments.
 * Each team manages its own overview, members, phases, videos, and showcase.
 *
 * Verifies enrollment and team membership before any mutation.
 * Uses admin client for DB operations (bypasses RLS).
 */
'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import { logEvent } from '@/lib/supabase/event-logger'
import { emitEvent } from '@/lib/events/emit'
import {
  createTeamSchema,
  updateTeamSchema,
  createPhaseSchema,
  updatePhaseSchema,
  updateShowcaseSchema,
  savePlanningDocSchema,
  createPhaseItemSchema,
  updatePhaseItemSchema,
  type CreateTeamInput,
  type UpdateTeamInput,
  type CreatePhaseInput,
  type UpdatePhaseInput,
  type UpdateShowcaseInput,
  type CreatePhaseItemInput,
  type UpdatePhaseItemInput,
} from '@/lib/validations/project'
import { generateProjectPhases, type GeneratedPhaseResult } from '@/lib/ai/llm-client'
import { checkAiFeatureBySection } from '@/lib/ai/kill-switch'
import { aiRefusalMessage } from '@/lib/ai/ai-features'
import { emitSystemMessage } from '@/lib/chat/system-messages'
import { docContentToHtml } from '@/lib/validations/project-docs'

// Strip HTML tags for the LLM context — preserve text flow with spaces so
// `<p>a</p><p>b</p>` becomes `a b`, not `ab`.
function stripHtml(html: string): string {
  return html
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\/?(p|div|h[1-6]|li|ul|ol|blockquote|pre|tr|td|th)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ── Types ───────────────────────────────────────────────────────

type ActionResult = { success?: boolean; error?: string; data?: unknown }

// ── Helpers ─────────────────────────────────────────────────────

async function getAuthUser() {
  const supabase = await createClient()
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) return null
  return user
}

async function verifyEnrollment(sectionId: string, userId: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any

  const { data: enrollment } = await adminDb
    .from('enrollments')
    .select('id')
    .eq('section_id', sectionId)
    .eq('student_id', userId)
    .in('status', ['enrolled', 'completed'])
    .single()

  if (!enrollment) return { enrolled: false as const, adminDb }
  return { enrolled: true as const, adminDb }
}

/** Verify the user is a member of the team and return their role. */
async function verifyTeamAccess(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminDb: any,
  teamId: string,
  userId: string,
): Promise<string | null> {
  const { data: member } = await adminDb
    .from('project_members')
    .select('id, role')
    .eq('team_id', teamId)
    .eq('user_id', userId)
    .single()

  return member?.role ?? null
}

function sectionPath(sectionId: string) {
  return `/student/courses/${sectionId}`
}

// ── Team Actions ────────────────────────────────────────────────

/**
 * Create a new team under a project assignment.
 * Requires active enrollment. Auto-adds creator as team owner.
 * A student can only be in one team per project.
 */
export async function createTeam(
  projectId: string,
  sectionId: string,
  input: CreateTeamInput,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = createTeamSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    // Verify project exists and is active
    const { data: project } = await adminDb
      .from('projects')
      .select('id, status, section_id')
      .eq('id', projectId)
      .eq('section_id', sectionId)
      .single()

    if (!project) return { error: 'Project assignment not found' }
    if (project.status !== 'active') return { error: 'This project assignment is not active' }

    // Check student doesn't already have a team in this project
    const { data: existingMembers } = await adminDb
      .from('project_members')
      .select('team_id')
      .eq('user_id', user.id)
      .not('team_id', 'is', null)

    if (existingMembers && existingMembers.length > 0) {
      const teamIds = existingMembers.map((m: { team_id: string }) => m.team_id)
      const { data: existingTeams } = await adminDb
        .from('project_teams')
        .select('id')
        .eq('project_id', projectId)
        .in('id', teamIds)
        .limit(1)

      if (existingTeams && existingTeams.length > 0) {
        return { error: 'You are already in a team for this project' }
      }
    }

    // Insert the team
    const { data: team, error: insertError } = await adminDb
      .from('project_teams')
      .insert({
        project_id: projectId,
        created_by: user.id,
        name: parsed.data.name,
        description: parsed.data.description || '',
      })
      .select('id')
      .single()

    if (insertError || !team) {
      if (insertError?.code === '23505') {
        return { error: 'A team with this name already exists in this project' }
      }
      logger.error('createTeam: Insert failed', insertError, { projectId })
      return { error: 'Failed to create team' }
    }

    // Auto-add creator as owner
    const { error: memberError } = await adminDb
      .from('project_members')
      .insert({
        project_id: projectId,
        team_id: team.id,
        user_id: user.id,
        role: 'owner',
      })

    if (memberError) {
      logger.error('createTeam: Failed to add owner', memberError, { teamId: team.id })
      await adminDb.from('project_teams').delete().eq('id', team.id)
      return { error: 'Failed to create team' }
    }

    logEvent({
      userId: user.id,
      eventType: 'project.team_created',
      eventCategory: 'student',
      metadata: { sectionId, projectId, teamId: team.id, name: parsed.data.name },
      sectionId,
    })

    revalidatePath(sectionPath(sectionId))
    return { success: true, data: { teamId: team.id } }
  } catch (error) {
    logger.error('createTeam: Unexpected error', error, { projectId, sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

/**
 * Update team name/description. Only the team owner can update.
 */
export async function updateTeam(
  teamId: string,
  sectionId: string,
  input: UpdateTeamInput,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = updateTeamSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    const role = await verifyTeamAccess(adminDb, teamId, user.id)
    if (role !== 'owner') return { error: 'Only team owners can update the team' }

    const { error: updateError } = await adminDb
      .from('project_teams')
      .update({
        ...parsed.data,
        updated_at: new Date().toISOString(),
      })
      .eq('id', teamId)

    if (updateError) {
      if (updateError.code === '23505') {
        return { error: 'A team with this name already exists in this project' }
      }
      logger.error('updateTeam: Update failed', updateError, { teamId })
      return { error: 'Failed to update team' }
    }

    logEvent({
      userId: user.id,
      eventType: 'project.team_updated',
      eventCategory: 'student',
      metadata: { sectionId, teamId },
      sectionId,
    })

    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('updateTeam: Unexpected error', error, { teamId, sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

// ── Member Actions ──────────────────────────────────────────────

/**
 * Add a member to the team. Only the team owner can add members.
 * Enforces max_team_size from the parent project.
 */
export async function addTeamMember(
  teamId: string,
  projectId: string,
  sectionId: string,
  userId: string,
  role: string,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    const callerRole = await verifyTeamAccess(adminDb, teamId, user.id)
    if (callerRole !== 'owner') return { error: 'Only team owners can add members' }

    // Check max_team_size from parent project
    const { data: project } = await adminDb
      .from('projects')
      .select('max_team_size')
      .eq('id', projectId)
      .single()

    if (!project) return { error: 'Project not found' }

    const { data: currentMembers } = await adminDb
      .from('project_members')
      .select('id')
      .eq('team_id', teamId)

    const currentCount = currentMembers?.length ?? 0
    if (currentCount >= (project.max_team_size ?? 5)) {
      return { error: `Team is full (max ${project.max_team_size} members)` }
    }

    // Verify target user is enrolled
    const { data: targetEnrollment } = await adminDb
      .from('enrollments')
      .select('id')
      .eq('section_id', sectionId)
      .eq('student_id', userId)
      .in('status', ['enrolled', 'completed'])
      .single()

    if (!targetEnrollment) return { error: 'User is not enrolled in this course' }

    // Check user is not already in any team for this project
    const { data: existingMembers } = await adminDb
      .from('project_members')
      .select('team_id')
      .eq('user_id', userId)
      .not('team_id', 'is', null)

    if (existingMembers && existingMembers.length > 0) {
      const existTeamIds = existingMembers.map((m: { team_id: string }) => m.team_id)
      const { data: existingTeams } = await adminDb
        .from('project_teams')
        .select('id')
        .eq('project_id', projectId)
        .in('id', existTeamIds)
        .limit(1)

      if (existingTeams && existingTeams.length > 0) {
        return { error: 'User is already in a team for this project' }
      }
    }

    const { error: insertError } = await adminDb
      .from('project_members')
      .insert({
        project_id: projectId,
        team_id: teamId,
        user_id: userId,
        role: role || 'member',
      })

    if (insertError) {
      logger.error('addTeamMember: Insert failed', insertError, { teamId, userId })
      return { error: 'Failed to add member' }
    }

    logEvent({
      userId: user.id,
      eventType: 'project.member_added',
      eventCategory: 'student',
      metadata: { sectionId, projectId, teamId, addedUserId: userId, role },
      sectionId,
    })

    // Notify the added student they're now on the team (a notice, not a to-do).
    const { data: team } = await adminDb
      .from('project_teams')
      .select('name')
      .eq('id', teamId)
      .maybeSingle()
    await emitEvent({
      type: 'team_assigned',
      sectionId,
      actorId: user.id,
      audience: [userId],
      entity: { type: 'team', id: teamId },
      title: `Added to team: ${team?.name ?? 'a project team'}`,
      linkUrl: `/student/courses/${sectionId}/projects`,
    })

    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('addTeamMember: Unexpected error', error, { teamId, sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

/**
 * Remove a member from the team. Only the team owner can remove members.
 * Prevents removing the last owner.
 */
/**
 * Leave a team you are in (#699).
 *
 * Distinct from removeTeamMember, which is an owner acting on someone else. Here the actor is
 * the subject, so there is no owner check to pass — but there are two refusals, and both live in
 * the `leave_project_team` RPC rather than here, because the decision and the delete have to
 * happen under one lock. Doing it in three round trips from this action would let two members
 * leaving at the same instant each see the other still present, and strand an empty team.
 *
 * The refusals, in the RPC's words:
 *  - `owner_must_transfer` — an owner with teammates hands over first.
 *  - `has_academic_record` — the last member cannot take a graded or submitted team down with
 *    them. Deleting a team cascades to 14 tables including project_grades, so this would
 *    otherwise be a student-initiated deletion of an academic record.
 */
export async function leaveTeam(teamId: string, sectionId: string): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    const { data: outcome, error } = await adminDb.rpc('leave_project_team', {
      p_team_id: teamId,
      p_user_id: user.id,
    })

    if (error) {
      logger.error('leaveTeam: RPC failed', error, { teamId, sectionId })
      return { error: 'Failed to leave the team' }
    }

    switch (outcome) {
      case 'left':
      case 'left_and_team_deleted':
        break
      case 'owner_must_transfer':
        return {
          error:
            'Make someone else the owner before you leave, so the team still has one.',
        }
      case 'has_academic_record':
        return {
          error:
            'This team has submitted work or a grade, so it can\'t be dissolved. Ask your professor to move you.',
        }
      case 'not_member':
      case 'team_not_found':
        /* Same message for both: distinguishing them would confirm whether an arbitrary team id
           is real to someone who is not in it. */
        return { error: 'Team not found' }
      default:
        logger.error('leaveTeam: unexpected outcome', new Error(String(outcome)), { teamId })
        return { error: 'Failed to leave the team' }
    }

    logEvent({
      userId: user.id,
      eventType: outcome === 'left_and_team_deleted' ? 'project.team_dissolved' : 'project.member_left',
      eventCategory: 'student',
      metadata: { sectionId, teamId },
      sectionId,
    })

    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('leaveTeam: Unexpected error', error, { teamId, sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

export async function removeTeamMember(
  memberId: string,
  teamId: string,
  sectionId: string,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    const callerRole = await verifyTeamAccess(adminDb, teamId, user.id)
    if (callerRole !== 'owner') return { error: 'Only team owners can remove members' }

    const { data: targetMember } = await adminDb
      .from('project_members')
      .select('id, user_id, role')
      .eq('id', memberId)
      .eq('team_id', teamId)
      .single()

    if (!targetMember) return { error: 'Member not found' }

    if (targetMember.role === 'owner') {
      const { data: owners } = await adminDb
        .from('project_members')
        .select('id')
        .eq('team_id', teamId)
        .eq('role', 'owner')

      if ((owners?.length ?? 0) <= 1) {
        return { error: 'Cannot remove the last team owner' }
      }
    }

    const { error: deleteError } = await adminDb
      .from('project_members')
      .delete()
      .eq('id', memberId)

    if (deleteError) {
      logger.error('removeTeamMember: Delete failed', deleteError, { memberId, teamId })
      return { error: 'Failed to remove member' }
    }

    logEvent({
      userId: user.id,
      eventType: 'project.member_removed',
      eventCategory: 'student',
      metadata: { sectionId, teamId, removedUserId: targetMember.user_id },
      sectionId,
    })

    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('removeTeamMember: Unexpected error', error, { teamId, sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

// ── Join Request Actions ─────────────────────────────────────────

/**
 * Request to join an existing team. Creates a pending join request.
 * Validates: enrolled, not already in a team, team not full, no duplicate request.
 */
export async function requestToJoinTeam(
  teamId: string,
  projectId: string,
  sectionId: string,
  message: string = '',
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    // Verify team belongs to the specified project
    const { data: teamCheck } = await adminDb
      .from('project_teams')
      .select('id')
      .eq('id', teamId)
      .eq('project_id', projectId)
      .maybeSingle()

    if (!teamCheck) return { error: 'Team not found in this project' }

    // Check student is not already in a team for this project
    const { data: existingMembership } = await adminDb
      .from('project_members')
      .select('id, team_id')
      .eq('user_id', user.id)
      .eq('team_id', teamId)
      .maybeSingle()

    if (existingMembership) return { error: 'You are already a member of this team' }

    // Check student is not in another team
    const { data: otherTeamMember } = await adminDb
      .from('project_members')
      .select('id, team_id, project_teams!inner(project_id)')
      .eq('user_id', user.id)
      .eq('project_teams.project_id', projectId)
      .maybeSingle()

    if (otherTeamMember) return { error: 'You are already in a team for this project' }

    // Check team is not full
    const { data: project } = await adminDb
      .from('projects')
      .select('max_team_size')
      .eq('id', projectId)
      .single()

    if (!project) return { error: 'Project not found' }

    const { data: currentMembers } = await adminDb
      .from('project_members')
      .select('id')
      .eq('team_id', teamId)

    if ((currentMembers?.length ?? 0) >= (project.max_team_size ?? 5)) {
      return { error: 'This team is full' }
    }

    // Check for existing pending request
    const { data: existingRequest } = await adminDb
      .from('team_join_requests')
      .select('id, status')
      .eq('team_id', teamId)
      .eq('user_id', user.id)
      .maybeSingle()

    if (existingRequest) {
      if (existingRequest.status === 'pending') {
        return { error: 'You already have a pending request for this team' }
      }
      if (existingRequest.status === 'declined') {
        // Allow re-requesting after decline — update the existing row
        const { error: updateError } = await adminDb
          .from('team_join_requests')
          .update({ status: 'pending', message: message.trim().slice(0, 500), responded_by: null, responded_at: null, updated_at: new Date().toISOString() })
          .eq('id', existingRequest.id)

        if (updateError) {
          logger.error('requestToJoinTeam: Re-request failed', updateError, { teamId })
          return { error: 'Failed to send request' }
        }

        logEvent({
          userId: user.id,
          eventType: 'project.join_requested',
          eventCategory: 'student',
          metadata: { sectionId, projectId, teamId, reRequest: true },
          sectionId,
        })

        revalidatePath(sectionPath(sectionId))
        return { success: true }
      }
    }

    // Insert new request
    const { error: insertError } = await adminDb
      .from('team_join_requests')
      .insert({
        team_id: teamId,
        project_id: projectId,
        section_id: sectionId,
        user_id: user.id,
        message: message.trim().slice(0, 500),
      })

    if (insertError) {
      logger.error('requestToJoinTeam: Insert failed', insertError, { teamId })
      return { error: 'Failed to send join request' }
    }

    logEvent({
      userId: user.id,
      eventType: 'project.join_requested',
      eventCategory: 'student',
      metadata: { sectionId, projectId, teamId },
      sectionId,
    })

    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('requestToJoinTeam: Unexpected error', error, { teamId, sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

/**
 * Withdraw a pending join request. Only the requester can withdraw.
 */
export async function withdrawJoinRequest(
  requestId: string,
  sectionId: string,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    const { error: deleteError } = await adminDb
      .from('team_join_requests')
      .delete()
      .eq('id', requestId)
      .eq('user_id', user.id)
      .eq('status', 'pending')

    if (deleteError) {
      logger.error('withdrawJoinRequest: Delete failed', deleteError, { requestId })
      return { error: 'Failed to withdraw request' }
    }

    logEvent({
      userId: user.id,
      eventType: 'project.join_request_withdrawn',
      eventCategory: 'student',
      metadata: { sectionId, requestId },
      sectionId,
    })

    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('withdrawJoinRequest: Unexpected error', error, { requestId, sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

/**
 * Accept or decline a join request. Only team owners can respond.
 * Accepting auto-adds the requester as a team member.
 */
export async function respondToJoinRequest(
  requestId: string,
  teamId: string,
  sectionId: string,
  accept: boolean,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    const callerRole = await verifyTeamAccess(adminDb, teamId, user.id)
    if (callerRole !== 'owner') return { error: 'Only team owners can respond to join requests' }

    // Fetch the request
    const { data: request, error: fetchError } = await adminDb
      .from('team_join_requests')
      .select('id, team_id, project_id, user_id, status')
      .eq('id', requestId)
      .eq('team_id', teamId)
      .single()

    if (fetchError || !request) return { error: 'Request not found' }
    if (request.status !== 'pending') return { error: 'This request has already been handled' }

    // CAS (compare-and-swap): claim this request by updating status atomically.
    // Only the first handler to update from 'pending' will succeed; concurrent
    // handlers will update 0 rows and exit early. This prevents duplicate processing.
    const newStatus = accept ? 'accepted' : 'declined'
    const { data: claimed, error: claimError } = await adminDb
      .from('team_join_requests')
      .update({
        status: newStatus,
        responded_by: user.id,
        responded_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', requestId)
      .eq('status', 'pending')
      .select('id')

    if (claimError) {
      logger.error('respondToJoinRequest: Claim failed', claimError, { requestId })
      return { error: 'Failed to update request' }
    }

    if (!claimed || claimed.length === 0) {
      return { error: 'This request has already been handled' }
    }

    if (accept) {
      /* Same locked transaction as the invitation path (#698). The claim above is a real
         guard but a different one — it stops THIS request being handled twice; it does
         nothing about two different requests taking the last slot, since each claims its
         own row and then both read the same count. Capacity, the already-in-a-team check
         and the insert therefore all happen inside the RPC, under the team row lock. */
      const { data: joinResult, error: joinError } = await adminDb.rpc('join_project_team_atomic', {
        p_team_id: teamId,
        p_project_id: request.project_id,
        p_user_id: request.user_id,
        p_role: 'member',
      })

      const outcome = (joinResult ?? {}) as { ok?: boolean; reason?: string }

      if (joinError || !outcome.ok) {
        if (joinError) logger.error('respondToJoinRequest: atomic join failed', joinError, { requestId, teamId })
        // Revert the claim so the request can be re-evaluated once a slot frees up —
        // the same recovery the previous code did for a full team.
        await adminDb
          .from('team_join_requests')
          .update({ status: 'pending', responded_by: null, responded_at: null, updated_at: new Date().toISOString() })
          .eq('id', requestId)
        if (outcome.reason === 'full') return { error: 'Team is full — cannot accept more members' }
        if (outcome.reason === 'already_member') return { error: 'This student has already joined another team' }
        return { error: 'Failed to add member' }
      }

      // Auto-decline all other pending requests from this user for the same project
      const { error: autoDeclineError } = await adminDb
        .from('team_join_requests')
        .update({
          status: 'declined',
          responded_by: user.id,
          responded_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', request.user_id)
        .eq('project_id', request.project_id)
        .eq('status', 'pending')
        .neq('id', requestId)

      if (autoDeclineError) {
        logger.warn('respondToJoinRequest: Auto-decline other requests failed', { error: autoDeclineError, requestId, teamId })
      }

      logEvent({
        userId: user.id,
        eventType: 'project.join_accepted',
        eventCategory: 'student',
        metadata: { sectionId, teamId, requestId, acceptedUserId: request.user_id },
        sectionId,
      })
    } else {
      logEvent({
        userId: user.id,
        eventType: 'project.join_declined',
        eventCategory: 'student',
        metadata: { sectionId, teamId, requestId, declinedUserId: request.user_id },
        sectionId,
      })
    }

    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('respondToJoinRequest: Unexpected error', error, { requestId, sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

/**
 * Fetch pending join requests for a team. Only team members can view.
 */
export async function getTeamJoinRequests(
  teamId: string,
  sectionId: string,
): Promise<{ data?: JoinRequestWithProfile[]; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    const callerRole = await verifyTeamAccess(adminDb, teamId, user.id)
    if (!callerRole) return { error: 'Not a member of this team' }

    const { data, error } = await adminDb
      .from('team_join_requests')
      .select('id, team_id, project_id, user_id, message, status, created_at, profiles!team_join_requests_user_id_fkey(id, name, email, avatar_url)')
      .eq('team_id', teamId)
      .eq('status', 'pending')
      .order('created_at', { ascending: true })

    if (error) {
      logger.error('getTeamJoinRequests: Query failed', error, { teamId })
      return { error: 'Failed to fetch join requests' }
    }

    return { data: data ?? [] }
  } catch (error) {
    logger.error('getTeamJoinRequests: Unexpected error', error, { teamId, sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

export interface JoinRequestWithProfile {
  id: string
  team_id: string
  project_id: string
  user_id: string
  message: string
  status: string
  created_at: string
  profiles: { id: string; name: string | null; email: string | null; avatar_url: string | null } | null
}

/**
 * Fetch the current user's join requests for a project (to show status).
 */
export async function getMyJoinRequests(
  projectId: string,
  sectionId: string,
): Promise<{ data?: MyJoinRequest[]; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    const { data, error } = await adminDb
      .from('team_join_requests')
      .select('id, team_id, status, created_at')
      .eq('project_id', projectId)
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })

    if (error) {
      logger.error('getMyJoinRequests: Query failed', error, { projectId })
      return { error: 'Failed to fetch your requests' }
    }

    return { data: data ?? [] }
  } catch (error) {
    logger.error('getMyJoinRequests: Unexpected error', error, { projectId, sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

export interface MyJoinRequest {
  id: string
  team_id: string
  status: string
  created_at: string
}

/**
 * Update the current user's contribution summary.
 * Any team member can update their own contribution.
 */
export async function updateContribution(
  teamId: string,
  sectionId: string,
  contribution: string,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    const role = await verifyTeamAccess(adminDb, teamId, user.id)
    if (!role) return { error: 'You are not a member of this team' }

    const trimmed = (contribution || '').trim()
    if (trimmed.length > 2000) {
      return { error: 'Contribution summary must be at most 2,000 characters' }
    }

    const { error: updateError } = await adminDb
      .from('project_members')
      .update({
        contribution_summary: trimmed,
        updated_at: new Date().toISOString(),
      })
      .eq('team_id', teamId)
      .eq('user_id', user.id)

    if (updateError) {
      logger.error('updateContribution: Update failed', updateError, { teamId })
      return { error: 'Failed to update contribution' }
    }

    logEvent({
      userId: user.id,
      eventType: 'project.contribution_updated',
      eventCategory: 'student',
      metadata: { sectionId, teamId },
      sectionId,
    })

    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('updateContribution: Unexpected error', error, { teamId, sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

// ── Phase Actions ───────────────────────────────────────────────

/**
 * Create a new phase for the team. Only the team owner can create phases.
 *
 * `insertAfterPhaseId` lets the caller splice a new phase into the middle
 * of the list:
 *  - `undefined` → append at the end (default).
 *  - `null`      → insert at position 0 (before all other phases).
 *  - a phase id  → insert immediately after that phase.
 * When splicing, positions of subsequent phases are bumped by one.
 */
export async function createStudentPhase(
  teamId: string,
  projectId: string,
  sectionId: string,
  input: CreatePhaseInput,
  insertAfterPhaseId?: string | null,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = createPhaseSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    const role = await verifyTeamAccess(adminDb, teamId, user.id)
    if (!role || role === 'viewer') return { error: 'Only team members can create phases' }

    // Translate the tri-state anchor (undefined | null | string) into the
    // two RPC arguments. Doing this here keeps the DB surface minimal.
    const insertMode =
      insertAfterPhaseId === undefined
        ? 'append'
        : insertAfterPhaseId === null
          ? 'top'
          : 'after'

    // The RPC runs the read-anchor / bump-positions / insert sequence in
    // one transaction so partial failures can't leave gaps or overlaps in
    // project_phases.position.
    const { error: rpcError } = await adminDb.rpc('insert_project_phase', {
      p_project_id: projectId,
      p_team_id: teamId,
      p_title: parsed.data.title,
      p_description: parsed.data.description || '',
      p_status: parsed.data.status ?? 'not_started',
      p_start_date: parsed.data.start_date || null,
      p_due_date: parsed.data.due_date || null,
      p_insert_mode: insertMode,
      p_anchor_phase_id: insertMode === 'after' ? insertAfterPhaseId : null,
    })

    if (rpcError) {
      logger.error('createStudentPhase: RPC failed', rpcError, { teamId, insertMode })
      // The RPC surfaces the missing-anchor case via RAISE EXCEPTION; map it
      // back to a clean user-facing message.
      if (rpcError.message?.includes('anchor phase not found')) {
        return { error: 'Anchor phase not found in this team' }
      }
      return { error: 'Failed to create phase' }
    }

    logEvent({
      userId: user.id,
      eventType: 'project.phase_created',
      eventCategory: 'student',
      metadata: { sectionId, projectId, teamId, title: parsed.data.title },
      sectionId,
    })

    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('createStudentPhase: Unexpected error', error, { teamId, sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

/**
 * List published assignments in a section that can be linked into a phase.
 * Any enrolled team member may read these — they mirror what students already
 * see in the assignments area. Returns { data } on success or { error }.
 */
export async function getLinkableAssignments(sectionId: string): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    const { data, error } = await adminDb
      .from('assignments')
      .select('id, title, due_at, points')
      .eq('section_id', sectionId)
      .eq('status', 'published')
      .order('created_at', { ascending: false })

    if (error) {
      logger.error('getLinkableAssignments: Query failed', error, { sectionId })
      return { error: 'Failed to load assignments' }
    }

    return { success: true, data: data ?? [] }
  } catch (error) {
    logger.error('getLinkableAssignments: Unexpected error', error, { sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

/**
 * Create a project phase by copying a published assignment's details.
 *
 * One-time copy: title / description / due date are snapshotted into a new
 * phase, which is freely editable afterward and NOT kept in sync with the
 * assignment. The phase records assignment_id so the UI can tag it and so
 * deleting the assignment cascade-deletes the phase.
 */
export async function createPhaseFromAssignment(
  teamId: string,
  projectId: string,
  sectionId: string,
  assignmentId: string,
  insertAfterPhaseId?: string | null,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    const role = await verifyTeamAccess(adminDb, teamId, user.id)
    if (!role || role === 'viewer') return { error: 'Only team members can create phases' }

    // Integrity guard: the team must belong to the project the caller named,
    // otherwise a crafted request could splice a phase into a mismatched pair.
    const { data: team } = await adminDb
      .from('project_teams')
      .select('id, project_id')
      .eq('id', teamId)
      .single()
    if (!team || team.project_id !== projectId) {
      return { error: 'Team does not belong to this project' }
    }

    // IDOR + published guard: the assignment must live in THIS section and be
    // published (students may only link assignments they can already see).
    const { data: assignment } = await adminDb
      .from('assignments')
      .select('id, title, description, due_at, status, section_id')
      .eq('id', assignmentId)
      .single()
    if (!assignment || assignment.section_id !== sectionId) {
      return { error: 'Assignment not found' }
    }
    if (assignment.status !== 'published') {
      return { error: 'Only published assignments can be linked' }
    }

    // due_at is TIMESTAMPTZ; project_phases.due_date is DATE.
    const dueDate = assignment.due_at
      ? new Date(assignment.due_at).toISOString().split('T')[0]
      : null

    // Tri-state anchor → RPC insert mode (same convention as createStudentPhase):
    //   undefined → append at the end, null → insert at top, id → after that phase.
    const insertMode =
      insertAfterPhaseId === undefined
        ? 'append'
        : insertAfterPhaseId === null
          ? 'top'
          : 'after'

    // Reuse the phase-insert RPC (transactional position handling) and capture
    // the returned id so we can attach the assignment link in a follow-up write.
    const { data: newPhaseId, error: rpcError } = await adminDb.rpc('insert_project_phase', {
      p_project_id: projectId,
      p_team_id: teamId,
      p_title: assignment.title.slice(0, 200),
      p_description: (assignment.description || '').slice(0, 2000),
      p_status: 'not_started',
      p_start_date: null,
      p_due_date: dueDate,
      p_insert_mode: insertMode,
      p_anchor_phase_id: insertMode === 'after' ? insertAfterPhaseId : null,
    })

    if (rpcError || !newPhaseId) {
      logger.error('createPhaseFromAssignment: RPC failed', rpcError, { teamId, assignmentId })
      return { error: 'Failed to create phase' }
    }

    const { error: linkError } = await adminDb
      .from('project_phases')
      .update({ assignment_id: assignmentId })
      .eq('id', newPhaseId)

    if (linkError) {
      logger.error('createPhaseFromAssignment: Link update failed', linkError, { newPhaseId, assignmentId })
      return { error: 'Failed to link assignment' }
    }

    logEvent({
      userId: user.id,
      eventType: 'project.phase_created',
      eventCategory: 'student',
      metadata: { sectionId, projectId, teamId, assignmentId, title: assignment.title, source: 'assignment' },
      sectionId,
    })

    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('createPhaseFromAssignment: Unexpected error', error, { teamId, sectionId, assignmentId })
    return { error: 'An unexpected error occurred' }
  }
}

/**
 * Update a phase. Only the team owner can update phases.
 */
export async function updateStudentPhase(
  phaseId: string,
  teamId: string,
  sectionId: string,
  input: UpdatePhaseInput,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = updatePhaseSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    const role = await verifyTeamAccess(adminDb, teamId, user.id)
    if (!role || role === 'viewer') return { error: 'Only team members can update phases' }

    const { error: updateError } = await adminDb
      .from('project_phases')
      .update({
        ...parsed.data,
        updated_at: new Date().toISOString(),
      })
      .eq('id', phaseId)
      .eq('team_id', teamId)

    if (updateError) {
      logger.error('updateStudentPhase: Update failed', updateError, { phaseId, teamId })
      return { error: 'Failed to update phase' }
    }

    logEvent({
      userId: user.id,
      eventType: 'project.phase_updated',
      eventCategory: 'student',
      metadata: { sectionId, teamId, phaseId },
      sectionId,
    })

    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('updateStudentPhase: Unexpected error', error, { teamId, sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

/**
 * Delete a phase. Any team member (owner or member) can delete phases.
 */
export async function deleteStudentPhase(
  phaseId: string,
  teamId: string,
  sectionId: string,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    const role = await verifyTeamAccess(adminDb, teamId, user.id)
    if (!role || role === 'viewer') return { error: 'Only team members can delete phases' }

    const { error: deleteError } = await adminDb
      .from('project_phases')
      .delete()
      .eq('id', phaseId)
      .eq('team_id', teamId)

    if (deleteError) {
      logger.error('deleteStudentPhase: Delete failed', deleteError, { phaseId, teamId })
      return { error: 'Failed to delete phase' }
    }

    logEvent({
      userId: user.id,
      eventType: 'project.phase_deleted',
      eventCategory: 'student',
      metadata: { sectionId, teamId, phaseId },
      sectionId,
    })

    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('deleteStudentPhase: Unexpected error', error, { teamId, sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

// ── Video Actions ───────────────────────────────────────────────

/**
 * Delete a team video. Allowed for the team owner or the original uploader.
 */
export async function deleteStudentVideo(
  videoId: string,
  teamId: string,
  sectionId: string,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    const role = await verifyTeamAccess(adminDb, teamId, user.id)
    if (!role) return { error: 'You are not a member of this team' }

    const { data: video } = await adminDb
      .from('project_videos')
      .select('id, uploaded_by')
      .eq('id', videoId)
      .eq('team_id', teamId)
      .single()

    if (!video) return { error: 'Video not found' }

    if (role !== 'owner' && video.uploaded_by !== user.id) {
      return { error: 'Only team owners or the uploader can delete this video' }
    }

    const { error: deleteError } = await adminDb
      .from('project_videos')
      .delete()
      .eq('id', videoId)

    if (deleteError) {
      logger.error('deleteStudentVideo: Delete failed', deleteError, { videoId, teamId })
      return { error: 'Failed to delete video' }
    }

    logEvent({
      userId: user.id,
      eventType: 'project.video_deleted',
      eventCategory: 'student',
      metadata: { sectionId, teamId, videoId },
      sectionId,
    })

    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('deleteStudentVideo: Unexpected error', error, { teamId, sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

/**
 * Add a video link to a team. Team members and owners can add videos.
 */
export async function addStudentVideo(
  teamId: string,
  projectId: string,
  sectionId: string,
  input: { title: string; description?: string; videoUrl: string },
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    const role = await verifyTeamAccess(adminDb, teamId, user.id)
    if (!role || role === 'viewer') return { error: 'Only team members can add videos' }

    const title = input.title.trim()
    const videoUrl = input.videoUrl.trim()
    if (!title || title.length > 200) return { error: 'Title is required (max 200 characters)' }
    if (!videoUrl) return { error: 'Video URL is required' }

    // Reject non-http(s) schemes — video_url renders as an href in the UI.
    if (!isSafeHttpUrl(videoUrl)) {
      return { error: 'Please enter a valid http(s):// URL' }
    }

    const { error: insertError } = await adminDb
      .from('project_videos')
      .insert({
        project_id: projectId,
        team_id: teamId,
        uploaded_by: user.id,
        title,
        description: (input.description || '').trim(),
        video_url: videoUrl,
        video_path: videoUrl,
      })

    if (insertError) {
      logger.error('addStudentVideo: Insert failed', insertError, { teamId, projectId })
      return { error: 'Failed to add video' }
    }

    logEvent({
      userId: user.id,
      eventType: 'project.video_added',
      eventCategory: 'student',
      metadata: { sectionId, teamId, projectId, title },
      sectionId,
    })

    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('addStudentVideo: Unexpected error', error, { teamId, sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

// ── Showcase Actions ────────────────────────────────────────────

/**
 * Toggle team showcase and update showcase details.
 * Only the team owner can manage the showcase.
 */
export async function toggleTeamShowcase(
  teamId: string,
  projectId: string,
  sectionId: string,
  input: UpdateShowcaseInput,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = updateShowcaseSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    const role = await verifyTeamAccess(adminDb, teamId, user.id)
    if (role !== 'owner') return { error: 'Only team owners can manage the showcase' }

    if (parsed.data.showcase_enabled) {
      // Upsert showcase record
      const { data: existing } = await adminDb
        .from('project_showcase')
        .select('id')
        .eq('team_id', teamId)
        .single()

      if (existing) {
        await adminDb
          .from('project_showcase')
          .update({
            tagline: parsed.data.tagline || '',
            external_url: parsed.data.external_url || null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', existing.id)
      } else {
        await adminDb
          .from('project_showcase')
          .insert({
            project_id: projectId,
            team_id: teamId,
            published_by: user.id,
            tagline: parsed.data.tagline || '',
            external_url: parsed.data.external_url || null,
          })
      }

      // Store description on the team
      await adminDb
        .from('project_teams')
        .update({ description: parsed.data.showcase_description || '' })
        .eq('id', teamId)
    } else {
      // Remove showcase record
      await adminDb
        .from('project_showcase')
        .delete()
        .eq('team_id', teamId)
    }

    logEvent({
      userId: user.id,
      eventType: parsed.data.showcase_enabled ? 'project.showcase_enabled' : 'project.showcase_disabled',
      eventCategory: 'student',
      metadata: { sectionId, projectId, teamId },
      sectionId,
    })

    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('toggleTeamShowcase: Unexpected error', error, { teamId, sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

// ── Planning Doc Actions ────────────────────────────────────────

/**
 * Save the team's planning document.
 * Any team member (owner or member) can update the planning doc.
 */
export async function savePlanningDoc(
  teamId: string,
  sectionId: string,
  content: string,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = savePlanningDocSchema.safeParse({ content })
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    const role = await verifyTeamAccess(adminDb, teamId, user.id)
    if (!role || role === 'viewer') return { error: 'Only team members can edit the planning doc' }

    const { error } = await adminDb
      .from('project_teams')
      .update({ planning_doc: parsed.data.content, updated_at: new Date().toISOString() })
      .eq('id', teamId)

    if (error) {
      logger.error('savePlanningDoc: DB error', error, { teamId, sectionId })
      return { error: 'Failed to save planning doc' }
    }

    logEvent({
      userId: user.id,
      eventType: 'project.planning_doc_saved',
      eventCategory: 'student',
      metadata: { sectionId, teamId, charCount: parsed.data.content.length },
      sectionId,
    })

    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('savePlanningDoc: Unexpected error', error, { teamId, sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

// ── AI Phase Generation Actions ─────────────────────────────────

/**
 * Generate project phases using AI based on the team's planning doc.
 * AI decides the appropriate number of phases. Returns generated phases for preview — does NOT save them.
 */
export async function generatePhasesWithAI(
  teamId: string,
  projectId: string,
  sectionId: string,
  docIds?: string[],
): Promise<{ data?: GeneratedPhaseResult[]; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    const role = await verifyTeamAccess(adminDb, teamId, user.id)
    if (!role || role === 'viewer') return { error: 'Only team members can generate phases' }

    // Institution/platform AI kill switch.
    const aiVerdict = await checkAiFeatureBySection(adminDb, sectionId, 'projects-ai')
    if (!aiVerdict.allowed) return { error: aiRefusalMessage(aiVerdict.lockedBy) }

    // Build the planning context. Prefer the new multi-doc system
    // (project_docs); fall back to the legacy project_teams.planning_doc
    // column so teams that never migrated still work.
    let planningDoc = ''

    if (docIds && docIds.length > 0) {
      const { data: docs, error: docsError } = await adminDb
        .from('project_docs')
        .select('id, title, content')
        .eq('team_id', teamId)
        .in('id', docIds)
        .order('is_pinned', { ascending: false })
        .order('position', { ascending: true })

      if (docsError) {
        logger.error('generatePhasesWithAI: doc fetch failed', docsError, { teamId })
        return { error: 'Failed to load selected canvases' }
      }

      // Team-scope guard: if the client passed IDs from a different team,
      // the adminDb filter above already drops them. But reject outright
      // if *any* requested id was filtered out so a bad request doesn't
      // silently generate off a partial set.
      if (!docs || docs.length !== docIds.length) {
        return { error: 'One or more selected canvases do not belong to this team' }
      }

      planningDoc = docs
        .map((d: { title: string; content: unknown }) => {
          const html = docContentToHtml(d.content)
          const text = stripHtml(html).trim()
          return text ? `# ${d.title}\n\n${text}` : ''
        })
        .filter(Boolean)
        .join('\n\n---\n\n')
    } else {
      const { data: teamRow } = await adminDb
        .from('project_teams')
        .select('planning_doc')
        .eq('id', teamId)
        .single()
      planningDoc = teamRow?.planning_doc || ''
    }

    if (!planningDoc.trim()) {
      return { error: 'No planning content found. Create a canvas or select one with content.' }
    }

    const { data: projectData } = await adminDb
      .from('projects')
      .select('title, description, guidelines, due_date')
      .eq('id', projectId)
      .single()
    const project = projectData

    const result = await generateProjectPhases(
      {
        planningDoc,
        projectDescription: project?.description || undefined,
        projectGuidelines: project?.guidelines || undefined,
        projectDueDate: project?.due_date || null,
      },
      { sectionId, userId: user.id },
    )

    if (result.error) return { error: result.error }

    logEvent({
      userId: user.id,
      eventType: 'project.phases_ai_generated',
      eventCategory: 'student',
      metadata: { sectionId, teamId, projectId, phaseCount: result.phases.length },
      sectionId,
    })

    return { data: result.phases }
  } catch (error) {
    logger.error('generatePhasesWithAI: Unexpected error', error, { teamId, sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

/**
 * Batch-insert multiple AI-generated phases at once.
 * Assigns sequential positions starting after any existing phases.
 */
export async function batchCreateStudentPhases(
  teamId: string,
  projectId: string,
  sectionId: string,
  phases: Array<{ title: string; description: string; start_date?: string | null; due_date?: string | null }>,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    if (!phases.length) return { error: 'No phases to create' }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    const role = await verifyTeamAccess(adminDb, teamId, user.id)
    if (!role || role === 'viewer') return { error: 'Only team members can create phases' }

    // Get current max position
    const { data: existing } = await adminDb
      .from('project_phases')
      .select('position')
      .eq('project_id', projectId)
      .eq('team_id', teamId)
      .order('position', { ascending: false })
      .limit(1)

    const startPosition = (existing?.[0]?.position ?? -1) + 1

    const rows = phases.map((phase, index) => ({
      project_id: projectId,
      team_id: teamId,
      title: phase.title.slice(0, 200),
      description: (phase.description || '').slice(0, 2000),
      status: 'not_started',
      position: startPosition + index,
      start_date: phase.start_date || null,
      due_date: phase.due_date || null,
    }))

    const { error } = await adminDb.from('project_phases').insert(rows)

    if (error) {
      logger.error('batchCreateStudentPhases: DB error', error, { teamId, projectId })
      return { error: 'Failed to save phases' }
    }

    logEvent({
      userId: user.id,
      eventType: 'project.phases_batch_created',
      eventCategory: 'student',
      metadata: { sectionId, teamId, projectId, count: phases.length },
      sectionId,
    })

    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('batchCreateStudentPhases: Unexpected error', error, { teamId, sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

/**
 * Toggle a phase's completion status.
 * Switches between 'completed' and 'not_started'. Any team member can toggle.
 * If the phase has checklist items, status is auto-managed and manual toggle is blocked.
 */
export async function togglePhaseStatus(
  phaseId: string,
  teamId: string,
  sectionId: string,
  completed: boolean,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    const role = await verifyTeamAccess(adminDb, teamId, user.id)
    if (!role) return { error: 'Not a member of this team' }

    // Block manual toggle if phase has checklist items (status is auto-managed)
    const { data: items } = await adminDb
      .from('phase_items')
      .select('id')
      .eq('phase_id', phaseId)
      .limit(1)

    if (items && items.length > 0) {
      return { error: 'Phase status is managed by its checklist items' }
    }

    const newStatus = completed ? 'completed' : 'not_started'
    const completedAt = completed ? new Date().toISOString() : null

    // Capture the previous status + title so we can report the
    // transition in the inline system message.
    const { data: phaseBefore } = await adminDb
      .from('project_phases')
      .select('status, title')
      .eq('id', phaseId)
      .maybeSingle()

    const { error } = await adminDb
      .from('project_phases')
      .update({ status: newStatus, completed_at: completedAt, updated_at: new Date().toISOString() })
      .eq('id', phaseId)
      .eq('team_id', teamId)

    if (error) {
      logger.error('togglePhaseStatus: DB error', error, { phaseId, teamId })
      return { error: 'Failed to update phase status' }
    }

    logEvent({
      userId: user.id,
      eventType: completed ? 'project.phase_completed' : 'project.phase_uncompleted',
      eventCategory: 'student',
      metadata: { sectionId, teamId, phaseId },
      sectionId,
    })

    if (phaseBefore && (phaseBefore.status as string | null) !== newStatus) {
      await emitSystemMessage(adminDb, teamId, 'phase_status_changed', {
        actor_id: user.id,
        phase_id: phaseId,
        phase_title: (phaseBefore.title as string | null) ?? 'a phase',
        old_status: (phaseBefore.status as string | null) ?? undefined,
        new_status: newStatus,
      })
    }

    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('togglePhaseStatus: Unexpected error', error, { phaseId, teamId })
    return { error: 'An unexpected error occurred' }
  }
}

// ── Phase Item Helpers ──────────────────────────────────────────

/**
 * Recalculate and auto-update phase status based on checklist item completion.
 * Called after any phase item toggle/create/delete.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function recalculatePhaseStatus(adminDb: any, phaseId: string, teamId: string) {
  const { data: items } = await adminDb
    .from('phase_items')
    .select('is_completed')
    .eq('phase_id', phaseId)

  if (!items || items.length === 0) {
    // No items — reset to not_started
    await adminDb
      .from('project_phases')
      .update({ status: 'not_started', completed_at: null, updated_at: new Date().toISOString() })
      .eq('id', phaseId)
      .eq('team_id', teamId)
    return
  }

  const completedCount = items.filter((i: { is_completed: boolean }) => i.is_completed).length
  const total = items.length

  let newStatus: string
  if (completedCount === 0) newStatus = 'not_started'
  else if (completedCount === total) newStatus = 'completed'
  else newStatus = 'in_progress'

  const completedAt = newStatus === 'completed' ? new Date().toISOString() : null

  await adminDb
    .from('project_phases')
    .update({ status: newStatus, completed_at: completedAt, updated_at: new Date().toISOString() })
    .eq('id', phaseId)
    .eq('team_id', teamId)
}

// ── Phase Item Actions ──────────────────────────────────────────

/**
 * Create a checklist item within a phase. Any team member can create items.
 */
export async function createPhaseItem(
  phaseId: string,
  teamId: string,
  sectionId: string,
  input: CreatePhaseItemInput,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = createPhaseItemSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    const role = await verifyTeamAccess(adminDb, teamId, user.id)
    if (!role) return { error: 'Not a member of this team' }

    // Verify phase belongs to team
    const { data: phase } = await adminDb
      .from('project_phases')
      .select('id')
      .eq('id', phaseId)
      .eq('team_id', teamId)
      .single()

    if (!phase) return { error: 'Phase not found' }

    // Get next position
    const { data: existing } = await adminDb
      .from('phase_items')
      .select('position')
      .eq('phase_id', phaseId)
      .order('position', { ascending: false })
      .limit(1)

    const nextPosition = existing && existing.length > 0 ? existing[0].position + 1 : 0

    const { error: insertError } = await adminDb
      .from('phase_items')
      .insert({
        phase_id: phaseId,
        title: parsed.data.title,
        position: nextPosition,
        created_by: user.id,
      })

    if (insertError) {
      logger.error('createPhaseItem: Insert failed', insertError, { phaseId, teamId })
      return { error: 'Failed to create item' }
    }

    // Recalculate phase status (new item is unchecked, so may change from completed → in_progress)
    await recalculatePhaseStatus(adminDb, phaseId, teamId)

    logEvent({
      userId: user.id,
      eventType: 'project.phase_item_created',
      eventCategory: 'student',
      metadata: { sectionId, teamId, phaseId, title: parsed.data.title },
      sectionId,
    })

    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('createPhaseItem: Unexpected error', error, { phaseId, teamId, sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

/**
 * Update a checklist item (title). Any team member can edit items.
 */
export async function updatePhaseItem(
  itemId: string,
  phaseId: string,
  teamId: string,
  sectionId: string,
  input: UpdatePhaseItemInput,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = updatePhaseItemSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    const role = await verifyTeamAccess(adminDb, teamId, user.id)
    if (!role) return { error: 'Not a member of this team' }

    // IDOR guard: verifyTeamAccess only proves membership of teamId — bind the
    // phase to that team so a member can't edit another team's checklist items
    // by passing a foreign phaseId/itemId (the admin client bypasses RLS).
    const { data: phase } = await adminDb
      .from('project_phases')
      .select('id')
      .eq('id', phaseId)
      .eq('team_id', teamId)
      .single()
    if (!phase) return { error: 'Phase not found' }

    const { error: updateError } = await adminDb
      .from('phase_items')
      .update({
        ...parsed.data,
        updated_at: new Date().toISOString(),
      })
      .eq('id', itemId)
      .eq('phase_id', phaseId)

    if (updateError) {
      logger.error('updatePhaseItem: Update failed', updateError, { itemId, phaseId })
      return { error: 'Failed to update item' }
    }

    logEvent({
      userId: user.id,
      eventType: 'project.phase_item_updated',
      eventCategory: 'student',
      metadata: { sectionId, teamId, phaseId, itemId },
      sectionId,
    })

    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('updatePhaseItem: Unexpected error', error, { itemId, phaseId, sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

/**
 * Delete a checklist item. Any team member can delete items.
 */
export async function deletePhaseItem(
  itemId: string,
  phaseId: string,
  teamId: string,
  sectionId: string,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    const role = await verifyTeamAccess(adminDb, teamId, user.id)
    if (!role) return { error: 'Not a member of this team' }

    // IDOR guard: bind the phase to the caller's team before deleting its items
    // (verifyTeamAccess only proves membership of teamId; the admin client bypasses RLS).
    const { data: phase } = await adminDb
      .from('project_phases')
      .select('id')
      .eq('id', phaseId)
      .eq('team_id', teamId)
      .single()
    if (!phase) return { error: 'Phase not found' }

    const { error: deleteError } = await adminDb
      .from('phase_items')
      .delete()
      .eq('id', itemId)
      .eq('phase_id', phaseId)

    if (deleteError) {
      logger.error('deletePhaseItem: Delete failed', deleteError, { itemId, phaseId })
      return { error: 'Failed to delete item' }
    }

    // Recalculate phase status after deletion
    await recalculatePhaseStatus(adminDb, phaseId, teamId)

    logEvent({
      userId: user.id,
      eventType: 'project.phase_item_deleted',
      eventCategory: 'student',
      metadata: { sectionId, teamId, phaseId, itemId },
      sectionId,
    })

    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('deletePhaseItem: Unexpected error', error, { itemId, phaseId, sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

/**
 * Toggle a checklist item's completion. Any team member can toggle.
 * Auto-recalculates phase status after toggling.
 */
export async function togglePhaseItem(
  itemId: string,
  phaseId: string,
  teamId: string,
  sectionId: string,
  completed: boolean,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    const role = await verifyTeamAccess(adminDb, teamId, user.id)
    if (!role) return { error: 'Not a member of this team' }

    // IDOR guard: bind the phase to the caller's team before toggling its items
    // (verifyTeamAccess only proves membership of teamId; the admin client bypasses RLS).
    const { data: phase } = await adminDb
      .from('project_phases')
      .select('id')
      .eq('id', phaseId)
      .eq('team_id', teamId)
      .single()
    if (!phase) return { error: 'Phase not found' }

    const { error: updateError } = await adminDb
      .from('phase_items')
      .update({
        is_completed: completed,
        completed_by: completed ? user.id : null,
        completed_at: completed ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', itemId)
      .eq('phase_id', phaseId)

    if (updateError) {
      logger.error('togglePhaseItem: Update failed', updateError, { itemId, phaseId })
      return { error: 'Failed to toggle item' }
    }

    // Auto-recalculate phase status
    await recalculatePhaseStatus(adminDb, phaseId, teamId)

    logEvent({
      userId: user.id,
      eventType: completed ? 'project.phase_item_completed' : 'project.phase_item_uncompleted',
      eventCategory: 'student',
      metadata: { sectionId, teamId, phaseId, itemId },
      sectionId,
    })

    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('togglePhaseItem: Unexpected error', error, { itemId, phaseId, sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

/**
 * Update the assigned team members for a phase.
 * Only team owners can assign/unassign members.
 */
export async function updatePhaseAssignees(
  phaseId: string,
  teamId: string,
  sectionId: string,
  assignedTo: string[],
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    const role = await verifyTeamAccess(adminDb, teamId, user.id)
    if (!role || role === 'viewer') return { error: 'Only team members can assign members to phases' }

    // Read the phase's previous assignees + title so we can detect
    // newly-added members and emit one system message per addition.
    const { data: phaseBefore } = await adminDb
      .from('project_phases')
      .select('assigned_to, title')
      .eq('id', phaseId)
      .maybeSingle()

    const { error } = await adminDb
      .from('project_phases')
      .update({ assigned_to: assignedTo, updated_at: new Date().toISOString() })
      .eq('id', phaseId)
      .eq('team_id', teamId)

    if (error) {
      logger.error('updatePhaseAssignees: DB error', error, { phaseId, teamId })
      return { error: 'Failed to update assignees' }
    }

    logEvent({
      userId: user.id,
      eventType: 'project.phase_assignees_updated',
      eventCategory: 'student',
      metadata: { sectionId, teamId, phaseId, assigneeCount: assignedTo.length },
      sectionId,
    })

    // Emit a system message for each newly-added assignee. No emission
    // for removals (too chatty) or no-op updates.
    if (phaseBefore) {
      const previous = new Set((phaseBefore.assigned_to as string[] | null) ?? [])
      const phaseTitle = (phaseBefore.title as string | null) ?? 'a phase'
      for (const assigneeId of assignedTo) {
        if (!previous.has(assigneeId)) {
          await emitSystemMessage(adminDb, teamId, 'phase_assigned', {
            actor_id: user.id,
            phase_id: phaseId,
            phase_title: phaseTitle,
            assignee_id: assigneeId,
          })
        }
      }
    }

    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('updatePhaseAssignees: Unexpected error', error, { phaseId, teamId })
    return { error: 'An unexpected error occurred' }
  }
}

// ── Submission Actions ──────────────────────────────────────────

/** Submission data shape stored in project_teams.submission JSONB column. */
export interface SubmissionDocument {
  name: string
  url: string
  size: number
  uploaded_at: string
}

export interface SubmissionData {
  title: string
  tagline?: string
  description: string
  inspiration?: string
  what_it_does?: string
  how_we_built_it?: string
  challenges?: string
  accomplishments?: string
  what_we_learned?: string
  whats_next?: string
  built_with?: string[]
  github_url?: string
  demo_url?: string
  video_url?: string
  additional_links?: { label: string; url: string }[]
  cover_image_url?: string
  documents?: SubmissionDocument[]
  status: 'draft' | 'submitted'
  submitted_at?: string
}

/**
 * Reject non-http(s) URLs before persisting. Submission links (github/demo/
 * video/additional/documents) are rendered as <a href> in the professor-facing
 * grading view, so a `javascript:` scheme stored here is a stored-XSS vector
 * into the professor's session. Client-side validation is UX-only and
 * bypassable via a direct server-action call — this is the real guard.
 */
function isSafeHttpUrl(value: string | undefined | null): boolean {
  const v = (value ?? '').trim()
  if (!v) return true
  try {
    const p = new URL(v)
    return p.protocol === 'http:' || p.protocol === 'https:'
  } catch {
    return false
  }
}

/** Returns the name of the first submission link with an unsafe URL, or null. */
function firstUnsafeSubmissionUrl(data: SubmissionData): string | null {
  if (!isSafeHttpUrl(data.github_url)) return 'GitHub'
  if (!isSafeHttpUrl(data.demo_url)) return 'demo'
  if (!isSafeHttpUrl(data.video_url)) return 'video'
  if (data.additional_links?.some((l) => !isSafeHttpUrl(l.url))) return 'additional'
  if (data.documents?.some((d) => !isSafeHttpUrl(d.url))) return 'document'
  return null
}

/**
 * Save a project submission as a draft.
 * Stores submission data in project_teams.submission JSONB column.
 * Any team member can save drafts.
 */
export async function saveSubmission(
  teamId: string,
  projectId: string,
  sectionId: string,
  data: SubmissionData,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    const role = await verifyTeamAccess(adminDb, teamId, user.id)
    if (!role) return { error: 'You are not a member of this team' }

    const badUrlField = firstUnsafeSubmissionUrl(data)
    if (badUrlField) {
      return { error: `Invalid ${badUrlField} link — use a full http(s):// URL` }
    }

    const submissionData: SubmissionData = {
      ...data,
      status: 'draft',
    }

    const { error } = await adminDb
      .from('project_teams')
      .update({ submission: submissionData, updated_at: new Date().toISOString() })
      .eq('id', teamId)

    if (error) {
      logger.error('saveSubmission: DB error', error, { teamId })
      return { error: 'Failed to save submission' }
    }

    logEvent({
      userId: user.id,
      eventType: 'project.submission_draft_saved',
      eventCategory: 'student',
      metadata: { sectionId, teamId, projectId },
      sectionId,
    })

    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('saveSubmission: Unexpected error', error, { teamId })
    return { error: 'An unexpected error occurred' }
  }
}

/**
 * Submit a project for grading.
 * Validates required fields, sets status to 'submitted', records timestamp.
 * Only team owner or members can submit.
 */
export async function submitProject(
  teamId: string,
  projectId: string,
  sectionId: string,
  data: SubmissionData,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    const role = await verifyTeamAccess(adminDb, teamId, user.id)
    if (!role || role === 'viewer') return { error: 'You do not have permission to submit' }

    // Validate required fields
    if (!data.title?.trim()) return { error: 'Project title is required' }
    if (!data.description?.trim()) return { error: 'Project description is required' }

    const badUrlField = firstUnsafeSubmissionUrl(data)
    if (badUrlField) {
      return { error: `Invalid ${badUrlField} link — use a full http(s):// URL` }
    }

    const submissionData: SubmissionData = {
      ...data,
      status: 'submitted',
      submitted_at: new Date().toISOString(),
    }

    const { error } = await adminDb
      .from('project_teams')
      .update({ submission: submissionData, updated_at: new Date().toISOString() })
      .eq('id', teamId)

    if (error) {
      logger.error('submitProject: DB error', error, { teamId })
      return { error: 'Failed to submit project' }
    }

    logEvent({
      userId: user.id,
      eventType: 'project.submitted',
      eventCategory: 'student',
      metadata: { sectionId, teamId, projectId, title: data.title },
      sectionId,
    })

    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('submitProject: Unexpected error', error, { teamId })
    return { error: 'An unexpected error occurred' }
  }
}

// ── Available Students for Invite ──────────────────────────────

export interface AvailableStudent {
  userId: string
  name: string | null
  email: string | null
  avatarUrl: string | null
}

/**
 * Get enrolled students who are not yet in a team for a given project.
 * Used by the AddMemberDialog to show a picker instead of raw ID input.
 */
export async function getAvailableStudents(
  sectionId: string,
  projectId: string,
): Promise<{ error?: string; data?: AvailableStudent[] }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    // Get user IDs already in a team for this project
    const { data: teams } = await adminDb
      .from('project_teams')
      .select('id')
      .eq('project_id', projectId)

    const teamIds = (teams || []).map((t: { id: string }) => t.id)

    let takenUserIds: string[] = []
    if (teamIds.length > 0) {
      const { data: members } = await adminDb
        .from('project_members')
        .select('user_id')
        .in('team_id', teamIds)

      takenUserIds = (members || []).map((m: { user_id: string }) => m.user_id)
    }

    // Get all enrolled students in this section
    const { data: enrollments, error } = await adminDb
      .from('enrollments')
      .select(`
        student_id,
        profile:profiles!enrollments_student_id_fkey(id, name, email, avatar_url)
      `)
      .eq('section_id', sectionId)
      .in('status', ['enrolled', 'completed'])

    if (error) {
      logger.error('getAvailableStudents: Failed to fetch enrollments', error, { sectionId })
      return { error: 'Failed to fetch students' }
    }

    const available: AvailableStudent[] = (enrollments || [])
      .filter((e: { student_id: string }) => !takenUserIds.includes(e.student_id))
      .map((e: { student_id: string; profile: unknown }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const p = (Array.isArray(e.profile) ? e.profile[0] : e.profile) as any
        return {
          userId: e.student_id,
          name: p?.name || null,
          email: p?.email || null,
          avatarUrl: p?.avatar_url || null,
        }
      })

    return { data: available }
  } catch (error) {
    logger.error('getAvailableStudents: Unexpected error', error, { sectionId, projectId })
    return { error: 'An unexpected error occurred' }
  }
}

// ── Phase Comments (Read-only for students) ────────────────────

export interface PhaseCommentData {
  id: string
  content: string
  created_at: string
  author: { name: string | null; avatar_url: string | null } | null
}

/**
 * Fetch professor comments on a phase. Students can only read, not post.
 */
export async function getPhaseCommentsForStudent(
  phaseId: string,
  sectionId: string,
): Promise<{ error?: string; data?: PhaseCommentData[] }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    /* Enrollment is not authorization for a caller-supplied phaseId (#697). Any enrolled
       student could pass another team's phase and read that team's private feedback
       thread. The phase's team is resolved SERVER-side from the row rather than taken
       from the caller — a teamId parameter would just move the same IDOR one argument
       along. Same not-found/not-a-member response either way, so this cannot be used to
       probe which phase ids exist. */
    const { data: phase } = await adminDb
      .from('project_phases')
      .select('team_id')
      .eq('id', phaseId)
      .maybeSingle()
    if (!phase?.team_id) return { error: 'Not a member of this team' }
    const callerRole = await verifyTeamAccess(adminDb, phase.team_id as string, user.id)
    if (!callerRole) return { error: 'Not a member of this team' }

    const { data: comments, error } = await adminDb
      .from('phase_comments')
      .select(`
        id, content, created_at,
        author:profiles!phase_comments_author_id_fkey(name, avatar_url)
      `)
      .eq('phase_id', phaseId)
      .order('created_at', { ascending: true })

    if (error) {
      logger.error('getPhaseCommentsForStudent: Fetch failed', error, { phaseId })
      return { error: 'Failed to fetch comments' }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mapped: PhaseCommentData[] = (comments || []).map((c: any) => ({
      id: c.id,
      content: c.content,
      created_at: c.created_at,
      author: Array.isArray(c.author) ? c.author[0] : c.author,
    }))

    return { data: mapped }
  } catch (error) {
    logger.error('getPhaseCommentsForStudent: Unexpected error', error, { phaseId })
    return { error: 'An unexpected error occurred' }
  }
}

/**
 * Fetch comment counts per phase. Returns a map of phaseId → count.
 * Used to show comment indicators without lazy-loading each phase.
 */
export async function getPhaseCommentCounts(
  phaseIds: string[],
  sectionId: string,
): Promise<{ error?: string; data?: Record<string, number> }> {
  try {
    if (phaseIds.length === 0) return { data: {} }

    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    const { data: rows, error } = await adminDb
      .from('phase_comments')
      .select('phase_id')
      .in('phase_id', phaseIds)

    if (error) {
      logger.error('getPhaseCommentCounts: Fetch failed', error, { phaseIds })
      return { error: 'Failed to fetch comment counts' }
    }

    const counts: Record<string, number> = {}
    for (const row of rows || []) {
      counts[row.phase_id] = (counts[row.phase_id] || 0) + 1
    }

    return { data: counts }
  } catch (error) {
    logger.error('getPhaseCommentCounts: Unexpected error', error, { phaseIds })
    return { error: 'An unexpected error occurred' }
  }
}

// ── Team Invitations ──────────────────────────────────────────

export interface TeamInvitationWithProfile {
  id: string
  team_id: string
  project_id: string
  section_id: string
  invited_by: string
  invited_user_id: string
  message: string | null
  status: string
  created_at: string
  responded_at: string | null
  /** Profile of the invited user (for outbound view) */
  invited_profile?: { name: string | null; email: string | null; avatar_url: string | null } | null
  /** Profile of the inviter (for inbound view) */
  inviter_profile?: { name: string | null; email: string | null; avatar_url: string | null } | null
  /** Team name (for inbound view) */
  team_name?: string | null
}

/**
 * Send an invitation to a classmate. Only team owners can send invites.
 * Validates: enrollment, team ownership, max_team_size, user not already in a team.
 */
export async function sendTeamInvitation(
  teamId: string,
  projectId: string,
  sectionId: string,
  invitedUserId: string,
  message?: string,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    const callerRole = await verifyTeamAccess(adminDb, teamId, user.id)
    if (callerRole !== 'owner') return { error: 'Only team owners can send invitations' }

    // Check max_team_size
    const { data: project } = await adminDb
      .from('projects')
      .select('max_team_size')
      .eq('id', projectId)
      .single()

    if (!project) return { error: 'Project not found' }

    const { data: currentMembers } = await adminDb
      .from('project_members')
      .select('id')
      .eq('team_id', teamId)

    const currentCount = currentMembers?.length ?? 0
    if (currentCount >= (project.max_team_size ?? 5)) {
      return { error: `Team is full (max ${project.max_team_size} members)` }
    }

    // Verify target user is enrolled
    const { data: targetEnrollment } = await adminDb
      .from('enrollments')
      .select('id')
      .eq('section_id', sectionId)
      .eq('student_id', invitedUserId)
      .in('status', ['enrolled', 'completed'])
      .single()

    if (!targetEnrollment) return { error: 'User is not enrolled in this course' }

    // Check user is not already in any team for this project
    const { data: teams } = await adminDb
      .from('project_teams')
      .select('id')
      .eq('project_id', projectId)

    const teamIds = (teams || []).map((t: { id: string }) => t.id)
    if (teamIds.length > 0) {
      const { data: existingMembers } = await adminDb
        .from('project_members')
        .select('user_id')
        .eq('user_id', invitedUserId)
        .in('team_id', teamIds)

      if (existingMembers && existingMembers.length > 0) {
        return { error: 'This student is already in a team for this project' }
      }
    }

    // Check for existing pending invitation from this team
    const { data: existingInvite } = await adminDb
      .from('team_invitations')
      .select('id, status')
      .eq('team_id', teamId)
      .eq('invited_user_id', invitedUserId)
      .single()

    if (existingInvite) {
      if (existingInvite.status === 'pending') {
        return { error: 'An invitation has already been sent to this student' }
      }
      // If previously declined, update to pending (re-invite)
      const { error: updateError } = await adminDb
        .from('team_invitations')
        .update({
          status: 'pending',
          message: message?.trim() || null,
          invited_by: user.id,
          responded_at: null,
          created_at: new Date().toISOString(),
        })
        .eq('id', existingInvite.id)

      if (updateError) {
        logger.error('sendTeamInvitation: Failed to re-invite', updateError)
        return { error: 'Failed to send invitation' }
      }
    } else {
      const { error: insertError } = await adminDb
        .from('team_invitations')
        .insert({
          team_id: teamId,
          project_id: projectId,
          section_id: sectionId,
          invited_by: user.id,
          invited_user_id: invitedUserId,
          message: message?.trim() || null,
        })

      if (insertError) {
        logger.error('sendTeamInvitation: Failed to insert', insertError)
        return { error: 'Failed to send invitation' }
      }
    }

    await logEvent({
      userId: user.id,
      eventType: 'project.invitation_sent',
      sectionId,
      metadata: { teamId, projectId, invitedUserId },
    })

    // Notify the invited student. A notice (respond in the projects UI); dedup keyed
    // on the team id, so a re-invite after a decline won't stack notifications.
    const { data: team } = await adminDb
      .from('project_teams')
      .select('name')
      .eq('id', teamId)
      .maybeSingle()
    await emitEvent({
      type: 'team_invite',
      sectionId,
      actorId: user.id,
      audience: [invitedUserId],
      entity: { type: 'team', id: teamId },
      title: `Team invite: ${team?.name ?? 'a project team'}`,
      body: message?.trim() || null,
      linkUrl: `/student/courses/${sectionId}/projects`,
    })

    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('sendTeamInvitation: Unexpected error', error)
    return { error: 'An unexpected error occurred' }
  }
}

/**
 * Get all pending invitations sent by this team (outbound view for owners).
 */
export async function getSentInvitations(
  teamId: string,
  sectionId: string,
): Promise<{ error?: string; data?: TeamInvitationWithProfile[] }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    /* Enrollment is not authorization for a caller-supplied teamId (#697). Without
       this, any enrolled student could pass another team's id and read that team's
       pending invitees — names and email addresses included. verifyTeamAccess is the
       same helper the sibling functions in this file already use three lines from
       their own query; this one simply never called it. */
    const callerRole = await verifyTeamAccess(adminDb, teamId, user.id)
    if (!callerRole) return { error: 'Not a member of this team' }

    const { data: invitations, error } = await adminDb
      .from('team_invitations')
      .select('id, team_id, project_id, section_id, invited_by, invited_user_id, message, status, created_at, responded_at')
      .eq('team_id', teamId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })

    if (error) {
      logger.error('getSentInvitations: Failed to fetch', error)
      return { error: 'Failed to fetch invitations' }
    }

    // Fetch profiles for invited users (FK goes to auth.users, not profiles)
    const invitedUserIds = (invitations || []).map((inv: { invited_user_id: string }) => inv.invited_user_id)
    const profileMap = new Map<string, { name: string | null; email: string | null; avatar_url: string | null }>()
    if (invitedUserIds.length > 0) {
      const { data: profiles } = await adminDb
        .from('profiles')
        .select('id, name, email, avatar_url')
        .in('id', invitedUserIds)
      for (const p of profiles || []) {
        profileMap.set(p.id, { name: p.name, email: p.email, avatar_url: p.avatar_url })
      }
    }

    const mapped: TeamInvitationWithProfile[] = (invitations || []).map(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (inv: any) => ({
        ...inv,
        invited_profile: profileMap.get(inv.invited_user_id) || null,
      }),
    )

    return { data: mapped }
  } catch (error) {
    logger.error('getSentInvitations: Unexpected error', error)
    return { error: 'An unexpected error occurred' }
  }
}

/**
 * Get invitations received by the current user for a project (inbound view).
 * Used on the project detail page when the student has no team yet.
 */
export async function getMyInvitations(
  projectId: string,
  sectionId: string,
): Promise<{ error?: string; data?: TeamInvitationWithProfile[] }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    const { data: invitations, error } = await adminDb
      .from('team_invitations')
      .select('id, team_id, project_id, section_id, invited_by, invited_user_id, message, status, created_at, responded_at')
      .eq('project_id', projectId)
      .eq('invited_user_id', user.id)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })

    if (error) {
      logger.error('getMyInvitations: Failed to fetch', error)
      return { error: 'Failed to fetch invitations' }
    }

    // Fetch inviter profiles (FK goes to auth.users, not profiles)
    const inviterIds = (invitations || []).map((inv: { invited_by: string }) => inv.invited_by)
    const profileMap = new Map<string, { name: string | null; email: string | null; avatar_url: string | null }>()
    if (inviterIds.length > 0) {
      const { data: profiles } = await adminDb
        .from('profiles')
        .select('id, name, email, avatar_url')
        .in('id', inviterIds)
      for (const p of profiles || []) {
        profileMap.set(p.id, { name: p.name, email: p.email, avatar_url: p.avatar_url })
      }
    }

    // Fetch team names
    const teamIds = [...new Set((invitations || []).map((inv: { team_id: string }) => inv.team_id))]
    const teamMap = new Map<string, string>()
    if (teamIds.length > 0) {
      const { data: teams } = await adminDb
        .from('project_teams')
        .select('id, name')
        .in('id', teamIds)
      for (const t of teams || []) {
        teamMap.set(t.id, t.name)
      }
    }

    const mapped: TeamInvitationWithProfile[] = (invitations || []).map(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (inv: any) => ({
        ...inv,
        inviter_profile: profileMap.get(inv.invited_by) || null,
        team_name: teamMap.get(inv.team_id) || null,
      }),
    )

    return { data: mapped }
  } catch (error) {
    logger.error('getMyInvitations: Unexpected error', error)
    return { error: 'An unexpected error occurred' }
  }
}

/**
 * Respond to a team invitation — accept or decline.
 * On accept: adds user to team as member + declines other pending invitations for the project.
 */
export async function respondToInvitation(
  invitationId: string,
  sectionId: string,
  accept: boolean,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    // Fetch the invitation — CAS on status to prevent race conditions
    const { data: invitation } = await adminDb
      .from('team_invitations')
      .select('id, team_id, project_id, invited_user_id, status')
      .eq('id', invitationId)
      .eq('invited_user_id', user.id)
      .single()

    if (!invitation) return { error: 'Invitation not found' }
    if (invitation.status !== 'pending') return { error: 'Invitation has already been responded to' }

    const now = new Date().toISOString()

    if (accept) {
      /* Capacity + membership + insert happen INSIDE one locked transaction (#698).
         This used to read the member count, decide here, then insert — the read guarded
         the write across an await, so two students accepting the last slot both read the
         same pre-insert count and both passed. Live-reproduced at 5 members against a
         cap of 4, and one production team is over cap because of it.

         Note the sibling respondToJoinRequest's compare-and-set does NOT solve this: it
         claims the REQUEST row, which stops one request being handled twice but not two
         different requests taking one slot. supabase-js has no transaction across
         separate .from() calls, so the decision belongs in the RPC. */
      const { data: joinResult, error: joinError } = await adminDb.rpc('join_project_team_atomic', {
        p_team_id: invitation.team_id,
        p_project_id: invitation.project_id,
        p_user_id: user.id,
        p_role: 'member',
      })

      if (joinError) {
        logger.error('respondToInvitation: atomic join failed', joinError, { invitationId })
        return { error: 'Failed to join team' }
      }

      const outcome = (joinResult ?? {}) as { ok?: boolean; reason?: string }
      if (!outcome.ok) {
        /* Refusals are reported, never swallowed — the student clicked Accept and has to
           know it did not happen. The invitation is deliberately left PENDING so a slot
           freeing up later still lets them in. */
        if (outcome.reason === 'full') return { error: 'Team is now full. Cannot accept this invitation.' }
        if (outcome.reason === 'already_member') return { error: 'You are already in a team for this project' }
        return { error: 'Could not join this team' }
      }

      // Membership is committed; now record the invitation as accepted.
      const { error: updateError } = await adminDb
        .from('team_invitations')
        .update({ status: 'accepted', responded_at: now })
        .eq('id', invitationId)
        .eq('status', 'pending') // CAS

      if (updateError) {
        logger.error('respondToInvitation: Accept update failed', updateError, { invitationId })
        // The student IS in the team — say so rather than reporting a failure that would
        // make them retry a join that already succeeded.
        logger.warn('respondToInvitation: joined but invitation status not updated', { invitationId })
      }

      // Decline all other pending invitations for this project
      await adminDb
        .from('team_invitations')
        .update({ status: 'declined', responded_at: now })
        .eq('project_id', invitation.project_id)
        .eq('invited_user_id', user.id)
        .eq('status', 'pending')
        .neq('id', invitationId)

      // Also decline any pending join requests from this user for this project
      await adminDb
        .from('team_join_requests')
        .update({ status: 'declined', responded_at: now })
        .eq('project_id', invitation.project_id)
        .eq('user_id', user.id)
        .eq('status', 'pending')

      await logEvent({
        userId: user.id,
        eventType: 'project.invitation_accepted',
        sectionId,
        metadata: { teamId: invitation.team_id, projectId: invitation.project_id },
      })
    } else {
      // Decline
      const { error: updateError } = await adminDb
        .from('team_invitations')
        .update({ status: 'declined', responded_at: now })
        .eq('id', invitationId)
        .eq('status', 'pending') // CAS

      if (updateError) {
        logger.error('respondToInvitation: Decline update failed', updateError)
        return { error: 'Failed to decline invitation' }
      }

      await logEvent({
        userId: user.id,
        eventType: 'project.invitation_declined',
        sectionId,
        metadata: { teamId: invitation.team_id, projectId: invitation.project_id },
      })
    }

    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('respondToInvitation: Unexpected error', error)
    return { error: 'An unexpected error occurred' }
  }
}

/**
 * Withdraw (cancel) a pending invitation. Only team owners can withdraw.
 */
export async function withdrawInvitation(
  invitationId: string,
  teamId: string,
  sectionId: string,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    const callerRole = await verifyTeamAccess(adminDb, teamId, user.id)
    if (callerRole !== 'owner') return { error: 'Only team owners can withdraw invitations' }

    const { error: deleteError } = await adminDb
      .from('team_invitations')
      .delete()
      .eq('id', invitationId)
      .eq('team_id', teamId)
      .eq('status', 'pending')

    if (deleteError) {
      logger.error('withdrawInvitation: Delete failed', deleteError)
      return { error: 'Failed to withdraw invitation' }
    }

    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('withdrawInvitation: Unexpected error', error)
    return { error: 'An unexpected error occurred' }
  }
}
