/**
 * Team Meeting Hub server actions — a coordination layer over meetings
 * students run themselves (their own Google Meet + own Fathom). We store
 * only URLs they choose to share + availability slots. No external APIs,
 * no secrets, no recordings.
 *
 * Students-only: every action verifies team membership (the true gate)
 * and derives project/section from the verified team — never trusts the
 * client for those. All writes use the admin client (RLS is SELECT-only).
 */
'use server'

import { revalidatePath } from 'next/cache'
import type { SupabaseClient, User } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import { logEvent } from '@/lib/supabase/event-logger'
import {
  meetRoomSchema,
  logMeetingSchema,
  attachNotesSchema,
  availabilitySchema,
  type MeetRoomInput,
  type LogMeetingInput,
  type AttachNotesInput,
  type AvailabilityInput,
} from '@/lib/validations/team-meeting'

type ActionResult = { success?: boolean; error?: string; data?: unknown }

async function getAuthUser(): Promise<User | null> {
  const supabase = await createClient()
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser()
  if (error || !user) return null
  return user
}

async function verifyTeamAccess(
  adminDb: SupabaseClient,
  teamId: string,
  userId: string,
): Promise<boolean> {
  const { data } = await adminDb
    .from('project_members')
    .select('id')
    .eq('team_id', teamId)
    .eq('user_id', userId)
    .maybeSingle()
  return Boolean(data)
}

async function deriveTeamContext(
  adminDb: SupabaseClient,
  teamId: string,
): Promise<{ projectId: string; sectionId: string } | null> {
  const { data } = await adminDb
    .from('project_teams')
    .select('project_id, project:projects!project_teams_project_id_fkey(section_id)')
    .eq('id', teamId)
    .single()
  if (!data) return null
  const rel = (data as { project: { section_id: string } | { section_id: string }[] | null })
    .project
  const project = Array.isArray(rel) ? rel[0] : rel
  const projectId = (data as { project_id?: string }).project_id
  const sectionId = project?.section_id
  if (!projectId || !sectionId) return null
  return { projectId, sectionId }
}

async function isEnrolled(
  adminDb: SupabaseClient,
  sectionId: string,
  userId: string,
): Promise<boolean> {
  const { data } = await adminDb
    .from('enrollments')
    .select('id')
    .eq('section_id', sectionId)
    .eq('student_id', userId)
    .in('status', ['enrolled', 'completed'])
    .maybeSingle()
  return Boolean(data)
}

type TeamAuth = {
  user: User
  adminDb: SupabaseClient
  projectId: string
  sectionId: string
}

/** Full authorize + context resolve for a team-scoped action. */
async function authorizeTeam(teamId: string): Promise<TeamAuth | { error: string }> {
  const user = await getAuthUser()
  if (!user) return { error: 'Not authenticated' }
  const adminDb = createAdminClient()
  if (!(await verifyTeamAccess(adminDb, teamId, user.id))) {
    return { error: 'Not a member of this team' }
  }
  const ctx = await deriveTeamContext(adminDb, teamId)
  if (!ctx) return { error: 'Team not found' }
  if (!(await isEnrolled(adminDb, ctx.sectionId, user.id))) {
    return { error: 'Not enrolled in this course' }
  }
  return { user, adminDb, projectId: ctx.projectId, sectionId: ctx.sectionId }
}

function sectionPath(sectionId: string) {
  return `/student/courses/${sectionId}`
}

// ── Reusable room link ───────────────────────────────────────────

export async function setTeamMeetingRoom(
  teamId: string,
  input: MeetRoomInput,
): Promise<ActionResult> {
  try {
    const parsed = meetRoomSchema.safeParse(input)
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid link' }

    const auth = await authorizeTeam(teamId)
    if ('error' in auth) return auth
    const { user, adminDb, sectionId } = auth

    const { error } = await adminDb.from('team_meeting_rooms').upsert(
      {
        team_id: teamId,
        meet_url: parsed.data.meetUrl,
        updated_by: user.id,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'team_id' },
    )
    if (error) {
      logger.error('setTeamMeetingRoom', error, { teamId })
      return { error: 'Could not save the meeting link' }
    }

    logEvent({ userId: user.id, eventType: 'project.meeting_room_set', sectionId, metadata: { teamId } })
    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('setTeamMeetingRoom', error, { teamId })
    return { error: 'Something went wrong' }
  }
}

export async function clearTeamMeetingRoom(teamId: string): Promise<ActionResult> {
  try {
    const auth = await authorizeTeam(teamId)
    if ('error' in auth) return auth
    const { user, adminDb, sectionId } = auth
    const { error } = await adminDb.from('team_meeting_rooms').delete().eq('team_id', teamId)
    if (error) {
      logger.error('clearTeamMeetingRoom', error, { teamId })
      return { error: 'Could not clear the meeting link' }
    }
    logEvent({ userId: user.id, eventType: 'project.meeting_room_cleared', sectionId, metadata: { teamId } })
    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('clearTeamMeetingRoom', error, { teamId })
    return { error: 'Something went wrong' }
  }
}

// ── Meetings (sessions) ──────────────────────────────────────────

export async function logTeamMeeting(
  teamId: string,
  input: LogMeetingInput,
): Promise<ActionResult> {
  try {
    const parsed = logMeetingSchema.safeParse(input)
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid input' }

    const auth = await authorizeTeam(teamId)
    if ('error' in auth) return auth
    const { user, adminDb, projectId, sectionId } = auth

    const { data, error } = await adminDb
      .from('team_meetings')
      .insert({
        team_id: teamId,
        project_id: projectId,
        section_id: sectionId,
        created_by: user.id,
        title: parsed.data.title,
        scheduled_start: parsed.data.scheduledStart ?? null,
        meet_url: parsed.data.meetUrl ?? null,
      })
      .select('id')
      .single()
    if (error) {
      logger.error('logTeamMeeting', error, { teamId })
      return { error: 'Could not save the meeting' }
    }

    logEvent({
      userId: user.id,
      eventType: 'project.meeting_logged',
      sectionId,
      metadata: { teamId, meetingId: data.id, scheduled: Boolean(parsed.data.scheduledStart) },
    })
    revalidatePath(sectionPath(sectionId))
    return { success: true, data: { meetingId: data.id } }
  } catch (error) {
    logger.error('logTeamMeeting', error, { teamId })
    return { error: 'Something went wrong' }
  }
}

/** Fetch a meeting's team, then authorize the caller against it. */
async function authorizeMeeting(
  meetingId: string,
): Promise<(TeamAuth & { teamId: string }) | { error: string }> {
  const user = await getAuthUser()
  if (!user) return { error: 'Not authenticated' }
  const adminDb = createAdminClient()
  const { data: meeting } = await adminDb
    .from('team_meetings')
    .select('team_id')
    .eq('id', meetingId)
    .maybeSingle()
  const teamId = (meeting as { team_id?: string } | null)?.team_id
  if (!teamId) return { error: 'Meeting not found' }
  const auth = await authorizeTeam(teamId)
  if ('error' in auth) return auth
  return { ...auth, teamId }
}

export async function attachMeetingNotes(
  meetingId: string,
  input: AttachNotesInput,
): Promise<ActionResult> {
  try {
    const parsed = attachNotesSchema.safeParse(input)
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid link' }

    const auth = await authorizeMeeting(meetingId)
    if ('error' in auth) return auth
    const { user, adminDb, sectionId } = auth

    const { error } = await adminDb
      .from('team_meetings')
      .update({ notes_url: parsed.data.notesUrl, notes_label: parsed.data.notesLabel ?? null })
      .eq('id', meetingId)
    if (error) {
      logger.error('attachMeetingNotes', error, { meetingId })
      return { error: 'Could not attach the notes link' }
    }

    logEvent({ userId: user.id, eventType: 'project.meeting_notes_attached', sectionId, metadata: { meetingId } })
    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('attachMeetingNotes', error, { meetingId })
    return { error: 'Something went wrong' }
  }
}

export async function deleteTeamMeeting(meetingId: string): Promise<ActionResult> {
  try {
    const auth = await authorizeMeeting(meetingId)
    if ('error' in auth) return auth
    const { user, adminDb, sectionId } = auth
    const { error } = await adminDb.from('team_meetings').delete().eq('id', meetingId)
    if (error) {
      logger.error('deleteTeamMeeting', error, { meetingId })
      return { error: 'Could not delete the meeting' }
    }
    logEvent({ userId: user.id, eventType: 'project.meeting_deleted', sectionId, metadata: { meetingId } })
    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('deleteTeamMeeting', error, { meetingId })
    return { error: 'Something went wrong' }
  }
}

// ── Availability ─────────────────────────────────────────────────

export async function saveMyAvailability(
  teamId: string,
  input: AvailabilityInput,
): Promise<ActionResult> {
  try {
    const parsed = availabilitySchema.safeParse(input)
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid selection' }

    const auth = await authorizeTeam(teamId)
    if ('error' in auth) return auth
    const { user, adminDb, sectionId } = auth

    // Replace the caller's whole selection for this team.
    const { error: delError } = await adminDb
      .from('team_availability')
      .delete()
      .eq('team_id', teamId)
      .eq('user_id', user.id)
    if (delError) {
      logger.error('saveMyAvailability.delete', delError, { teamId })
      return { error: 'Could not save your availability' }
    }

    if (parsed.data.slotStarts.length > 0) {
      const rows = parsed.data.slotStarts.map((slot_start) => ({
        team_id: teamId,
        user_id: user.id,
        slot_start,
      }))
      const { error: insError } = await adminDb.from('team_availability').insert(rows)
      if (insError) {
        logger.error('saveMyAvailability.insert', insError, { teamId })
        return { error: 'Could not save your availability' }
      }
    }

    logEvent({
      userId: user.id,
      eventType: 'project.availability_saved',
      sectionId,
      metadata: { teamId, slots: parsed.data.slotStarts.length },
    })
    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('saveMyAvailability', error, { teamId })
    return { error: 'Something went wrong' }
  }
}
