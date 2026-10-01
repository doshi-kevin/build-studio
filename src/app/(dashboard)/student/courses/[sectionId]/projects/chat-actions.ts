/**
 * Project Chat Server Actions — channel CRUD and message sending.
 *
 * Students-only: verifies enrollment + team membership before any mutation.
 * No professor access. Uses admin client for DB operations.
 */
'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import { purgeChatAttachment } from '@/lib/supabase/chat-storage-server'
import { logEvent } from '@/lib/supabase/event-logger'
import {
  createChannelSchema,
  renameChannelSchema,
  sendMessageSchema,
  MAX_CHANNELS_PER_TEAM,
  type CreateChannelInput,
  type RenameChannelInput,
  type SendMessageInput,
} from '@/lib/validations/project-chat'

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

// ── Channel Actions ─────────────────────────────────────────────

/**
 * Create the default #general channel for a team.
 * Called when a team is first created or when discussions tab is first opened.
 */
export async function ensureDefaultChannel(
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

    // Confirm the team's project allows workspace + is a group project
    // before we spin up any channels. Individual projects and
    // workspace-disabled projects never get team chat.
    const { data: teamRow } = await adminDb
      .from('project_teams')
      .select(
        'id, project:projects!project_teams_project_id_fkey(allow_team_workspace, max_team_size)',
      )
      .eq('id', teamId)
      .single()

    const projectRow = (teamRow as unknown as {
      project: { allow_team_workspace: boolean; max_team_size: number } | null
    } | null)?.project
    if (!projectRow) return { error: 'Team not found' }
    if ((projectRow.max_team_size ?? 1) <= 1) {
      return { error: 'Team chat is only available for group projects' }
    }
    if (projectRow.allow_team_workspace === false) {
      return { error: 'Team chat is disabled for this project' }
    }

    // Check if default channel already exists
    const { data: existing } = await adminDb
      .from('project_chat_channels')
      .select('id')
      .eq('team_id', teamId)
      .eq('is_default', true)
      .maybeSingle()

    if (existing) return { success: true, data: existing }

    // Create the default #general channel
    const { data: channel, error } = await adminDb
      .from('project_chat_channels')
      .insert({
        team_id: teamId,
        name: 'general',
        created_by: user.id,
        is_default: true,
        position: 0,
      })
      .select('id')
      .single()

    if (error) {
      logger.error('ensureDefaultChannel', error, { teamId })
      return { error: 'Failed to create default channel' }
    }

    return { success: true, data: channel }
  } catch (error) {
    logger.error('ensureDefaultChannel', error, { teamId })
    return { error: 'Something went wrong' }
  }
}

/**
 * Create a new channel in the team. Max 10 per team.
 */
export async function createChannel(
  teamId: string,
  sectionId: string,
  input: CreateChannelInput,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = createChannelSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    const role = await verifyTeamAccess(adminDb, teamId, user.id)
    if (!role) return { error: 'Not a member of this team' }

    // Check channel count limit
    const { count } = await adminDb
      .from('project_chat_channels')
      .select('id', { count: 'exact', head: true })
      .eq('team_id', teamId)

    if ((count ?? 0) >= MAX_CHANNELS_PER_TEAM) {
      return { error: `Maximum ${MAX_CHANNELS_PER_TEAM} channels per team` }
    }

    // Check for duplicate name
    const { data: duplicate } = await adminDb
      .from('project_chat_channels')
      .select('id')
      .eq('team_id', teamId)
      .eq('name', parsed.data.name)
      .maybeSingle()

    if (duplicate) {
      return { error: 'A channel with this name already exists' }
    }

    const { data: channel, error } = await adminDb
      .from('project_chat_channels')
      .insert({
        team_id: teamId,
        name: parsed.data.name,
        created_by: user.id,
        position: (count ?? 0),
      })
      .select('id, name')
      .single()

    if (error) {
      logger.error('createChannel', error, { teamId })
      return { error: 'Failed to create channel' }
    }

    logEvent({
      userId: user.id,
      eventType: 'chat_channel_created',
      sectionId,
      metadata: { teamId, channelId: channel.id, channelName: parsed.data.name },
    })

    revalidatePath(sectionPath(sectionId))
    return { success: true, data: channel }
  } catch (error) {
    logger.error('createChannel', error, { teamId })
    return { error: 'Something went wrong' }
  }
}

/**
 * Rename a non-default channel.
 */
export async function renameChannel(
  channelId: string,
  sectionId: string,
  input: RenameChannelInput,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = renameChannelSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    // Get channel and verify it's not default
    const { data: channel } = await adminDb
      .from('project_chat_channels')
      .select('id, team_id, is_default')
      .eq('id', channelId)
      .single()

    if (!channel) return { error: 'Channel not found' }
    if (channel.is_default) return { error: 'Cannot rename the default channel' }

    const role = await verifyTeamAccess(adminDb, channel.team_id, user.id)
    if (!role) return { error: 'Not a member of this team' }

    // Check for duplicate name
    const { data: duplicate } = await adminDb
      .from('project_chat_channels')
      .select('id')
      .eq('team_id', channel.team_id)
      .eq('name', parsed.data.name)
      .neq('id', channelId)
      .maybeSingle()

    if (duplicate) {
      return { error: 'A channel with this name already exists' }
    }

    const { error } = await adminDb
      .from('project_chat_channels')
      .update({ name: parsed.data.name, updated_at: new Date().toISOString() })
      .eq('id', channelId)

    if (error) {
      logger.error('renameChannel', error, { channelId })
      return { error: 'Failed to rename channel' }
    }

    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('renameChannel', error, { channelId })
    return { error: 'Something went wrong' }
  }
}

/**
 * Delete a non-default channel and all its messages.
 */
export async function deleteChannel(
  channelId: string,
  sectionId: string,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    // Get channel and verify it's not default
    const { data: channel } = await adminDb
      .from('project_chat_channels')
      .select('id, team_id, is_default, name')
      .eq('id', channelId)
      .single()

    if (!channel) return { error: 'Channel not found' }
    if (channel.is_default) return { error: 'Cannot delete the default channel' }

    const role = await verifyTeamAccess(adminDb, channel.team_id, user.id)
    if (!role) return { error: 'Not a member of this team' }

    const { error } = await adminDb
      .from('project_chat_channels')
      .delete()
      .eq('id', channelId)

    if (error) {
      logger.error('deleteChannel', error, { channelId })
      return { error: 'Failed to delete channel' }
    }

    logEvent({
      userId: user.id,
      eventType: 'chat_channel_deleted',
      sectionId,
      metadata: { teamId: channel.team_id, channelId, channelName: channel.name },
    })

    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('deleteChannel', error, { channelId })
    return { error: 'Something went wrong' }
  }
}

// ── Team member lookup (for @mention picker) ────────────────────

export interface TeamMemberOption {
  id: string
  name: string | null
  email: string
  avatar_url: string | null
}

/**
 * List team members for the @user mention picker. Verifies the caller
 * is a member of the team before returning any profiles.
 */
export async function listTeamMembersForMention(
  teamId: string,
  sectionId: string,
): Promise<{ data?: TeamMemberOption[]; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    const role = await verifyTeamAccess(adminDb, teamId, user.id)
    if (!role) return { error: 'Not a member of this team' }

    const { data, error } = await adminDb
      .from('project_members')
      .select('user:profiles!project_members_user_id_fkey(id, name, email, avatar_url)')
      .eq('team_id', teamId)

    if (error) {
      logger.error('listTeamMembersForMention', error, { teamId })
      return { error: 'Failed to load team members' }
    }

    type Row = { user: TeamMemberOption | TeamMemberOption[] | null }
    const members: TeamMemberOption[] = []
    for (const row of (data ?? []) as Row[]) {
      const u = Array.isArray(row.user) ? row.user[0] : row.user
      if (u) members.push(u)
    }

    return { data: members }
  } catch (error) {
    logger.error('listTeamMembersForMention', error, { teamId })
    return { error: 'Something went wrong' }
  }
}

// ── Team phase lookup (for @phase mention picker) ───────────────

export interface TeamPhaseOption {
  id: string
  title: string
  position: number
  status: string
}

/**
 * List a team's project phases for the @phase mention picker.
 * Verifies the caller is a team member before returning anything.
 */
export async function listTeamPhasesForMention(
  teamId: string,
  sectionId: string,
): Promise<{ data?: TeamPhaseOption[]; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    const role = await verifyTeamAccess(adminDb, teamId, user.id)
    if (!role) return { error: 'Not a member of this team' }

    const { data, error } = await adminDb
      .from('project_phases')
      .select('id, title, position, status')
      .eq('team_id', teamId)
      .order('position', { ascending: true })

    if (error) {
      logger.error('listTeamPhasesForMention', error, { teamId })
      return { error: 'Failed to load phases' }
    }

    return { data: (data ?? []) as TeamPhaseOption[] }
  } catch (error) {
    logger.error('listTeamPhasesForMention', error, { teamId })
    return { error: 'Something went wrong' }
  }
}

export interface PhasePreviewItem {
  id: string
  title: string
  is_completed: boolean
  position: number
}

export interface PhasePreview {
  id: string
  title: string
  description: string
  status: string
  start_date: string | null
  due_date: string | null
  items: PhasePreviewItem[]
}

/**
 * Fetch a single phase's preview payload (header + checklist items)
 * for the hover card rendered next to a @phase chip in chat. Verifies
 * the viewer is enrolled and a member of the phase's team.
 */
export async function getPhasePreview(
  phaseId: string,
  sectionId: string,
): Promise<{ data?: PhasePreview; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    const { data: phase, error: phaseErr } = await adminDb
      .from('project_phases')
      .select('id, title, description, status, start_date, due_date, team_id')
      .eq('id', phaseId)
      .maybeSingle()

    if (phaseErr || !phase) return { error: 'Phase not found' }

    const role = await verifyTeamAccess(adminDb, phase.team_id, user.id)
    if (!role) return { error: 'Not a member of this team' }

    const { data: items } = await adminDb
      .from('phase_items')
      .select('id, title, is_completed, position')
      .eq('phase_id', phaseId)
      .order('position', { ascending: true })

    return {
      data: {
        id: phase.id,
        title: phase.title,
        description: phase.description ?? '',
        status: phase.status,
        start_date: phase.start_date ?? null,
        due_date: phase.due_date ?? null,
        items: (items ?? []) as PhasePreviewItem[],
      },
    }
  } catch (error) {
    logger.error('getPhasePreview', error, { phaseId })
    return { error: 'Something went wrong' }
  }
}

// ── Team doc lookup (for @doc mention picker) ───────────────────

export interface TeamDocOption {
  id: string
  title: string
  is_pinned: boolean
  position: number
}

/**
 * List a team's project docs (canvases) for the @doc mention picker.
 * Pinned docs (Planning) sort first, then by position. Verifies the
 * caller is a team member before returning anything.
 */
export async function listTeamDocsForMention(
  teamId: string,
  sectionId: string,
): Promise<{ data?: TeamDocOption[]; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    const role = await verifyTeamAccess(adminDb, teamId, user.id)
    if (!role) return { error: 'Not a member of this team' }

    const { data, error } = await adminDb
      .from('project_docs')
      .select('id, title, is_pinned, position')
      .eq('team_id', teamId)
      .order('is_pinned', { ascending: false })
      .order('position', { ascending: true })

    if (error) {
      logger.error('listTeamDocsForMention', error, { teamId })
      return { error: 'Failed to load docs' }
    }

    return { data: (data ?? []) as TeamDocOption[] }
  } catch (error) {
    logger.error('listTeamDocsForMention', error, { teamId })
    return { error: 'Something went wrong' }
  }
}

export interface DocPreview {
  id: string
  title: string
  is_pinned: boolean
  excerpt: string
  updated_at: string
}

// Cap on how much plain-text we surface in the hover card. Doc bodies
// can be 50K chars; the preview is a quick "is this what I expected"
// glance, not a reader, so we keep it tight.
const DOC_PREVIEW_EXCERPT_CHARS = 280

function htmlToPlainText(html: string): string {
  // Cheap server-side strip: drop tags, decode the handful of entities
  // tiptap/contenteditable typically emits, collapse whitespace. We
  // don't need a full HTML parser here — the result is truncated for a
  // hover preview anyway.
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6])>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Fetch a single doc's preview payload (title + short text excerpt)
 * for the hover card next to a @doc chip in chat. Verifies the viewer
 * is enrolled and a member of the doc's team.
 */
export async function getDocPreview(
  docId: string,
  sectionId: string,
): Promise<{ data?: DocPreview; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    const { data: doc, error: docErr } = await adminDb
      .from('project_docs')
      .select('id, team_id, title, content, is_pinned, updated_at')
      .eq('id', docId)
      .maybeSingle()

    if (docErr || !doc) return { error: 'Doc not found' }

    const role = await verifyTeamAccess(adminDb, doc.team_id, user.id)
    if (!role) return { error: 'Not a member of this team' }

    // Content is JSONB { format: 'html', html: string }; tolerate
    // legacy / empty shapes by defaulting to ''.
    const content = doc.content as { format?: string; html?: string } | null
    const html = content?.format === 'html' && typeof content.html === 'string' ? content.html : ''
    const plain = htmlToPlainText(html)
    const excerpt =
      plain.length > DOC_PREVIEW_EXCERPT_CHARS
        ? plain.slice(0, DOC_PREVIEW_EXCERPT_CHARS - 1).trimEnd() + '…'
        : plain

    return {
      data: {
        id: doc.id,
        title: doc.title,
        is_pinned: !!doc.is_pinned,
        excerpt,
        updated_at: doc.updated_at,
      },
    }
  } catch (error) {
    logger.error('getDocPreview', error, { docId })
    return { error: 'Something went wrong' }
  }
}

// ── Message Actions ─────────────────────────────────────────────

/**
 * Send a message (text, attachment, or both) to a channel.
 *
 * If the message contains @user mentions (mentioned_user_ids on the
 * input), we:
 *   1. Filter the list down to users who are actually members of the
 *      same team (protects against crafted requests naming arbitrary
 *      UUIDs).
 *   2. Drop the sender's own id so we don't self-notify.
 *   3. Persist the filtered list onto project_chat_messages.mentioned_user_ids
 *      so MessageBubble can render pills deterministically.
 *   4. Fan out one app_notifications row per recipient (best-effort —
 *      a notification-insert failure must not block the message).
 */
export async function sendMessage(
  channelId: string,
  sectionId: string,
  input: SendMessageInput,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = sendMessageSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    // Get channel to verify team access + fetch team/project for notification context
    const { data: channel } = await adminDb
      .from('project_chat_channels')
      .select('id, team_id, name')
      .eq('id', channelId)
      .single()

    if (!channel) return { error: 'Channel not found' }

    const role = await verifyTeamAccess(adminDb, channel.team_id, user.id)
    if (!role) return { error: 'Not a member of this team' }

    // Verify mentioned user IDs are real team members.
    // Drop self-mentions — users don't need to be notified about their own pings.
    const requestedMentionIds = Array.from(
      new Set((parsed.data.mentioned_user_ids ?? []).filter((id) => id !== user.id)),
    )
    let verifiedMentionIds: string[] = []
    if (requestedMentionIds.length > 0) {
      const { data: members } = await adminDb
        .from('project_members')
        .select('user_id')
        .eq('team_id', channel.team_id)
        .in('user_id', requestedMentionIds)
      verifiedMentionIds =
        (members as Array<{ user_id: string }> | null)?.map((m) => m.user_id) ?? []
    }

    // Verify mentioned phase IDs belong to the channel's team — defense
    // in depth so a crafted payload can't reference foreign phases.
    const requestedPhaseIds = Array.from(
      new Set(parsed.data.mentioned_phase_ids ?? []),
    )
    let verifiedPhaseIds: string[] = []
    if (requestedPhaseIds.length > 0) {
      const { data: phases } = await adminDb
        .from('project_phases')
        .select('id')
        .eq('team_id', channel.team_id)
        .in('id', requestedPhaseIds)
      verifiedPhaseIds =
        (phases as Array<{ id: string }> | null)?.map((p) => p.id) ?? []
    }

    // Verify mentioned doc IDs belong to the channel's team.
    const requestedDocIds = Array.from(
      new Set(parsed.data.mentioned_doc_ids ?? []),
    )
    let verifiedDocIds: string[] = []
    if (requestedDocIds.length > 0) {
      const { data: docs } = await adminDb
        .from('project_docs')
        .select('id')
        .eq('team_id', channel.team_id)
        .in('id', requestedDocIds)
      verifiedDocIds =
        (docs as Array<{ id: string }> | null)?.map((d) => d.id) ?? []
    }

    const { data: message, error } = await adminDb
      .from('project_chat_messages')
      .insert({
        channel_id: channelId,
        author_id: user.id,
        content: parsed.data.content || '',
        attachment_url: parsed.data.attachment_url || null,
        attachment_path: parsed.data.attachment_path || null,
        attachment_name: parsed.data.attachment_name || null,
        attachment_size: parsed.data.attachment_size || null,
        attachment_type: parsed.data.attachment_type || null,
        mentioned_user_ids: verifiedMentionIds,
        mentioned_phase_ids: verifiedPhaseIds,
        mentioned_doc_ids: verifiedDocIds,
      })
      .select('id')
      .single()

    if (error) {
      logger.error('sendMessage', error, { channelId })
      return { error: 'Failed to send message' }
    }

    // Fan out notifications (best-effort — failures here don't fail the send)
    if (verifiedMentionIds.length > 0) {
      try {
        // Look up sender's display name for the notification title.
        const { data: authorProfile } = await adminDb
          .from('profiles')
          .select('name, email')
          .eq('id', user.id)
          .single()
        const authorName =
          (authorProfile?.name as string | null) ||
          (authorProfile?.email as string | null) ||
          'Someone'

        // Build a short preview of the message body for the notification.
        const preview = (parsed.data.content || '').replace(/\s+/g, ' ').trim()
        const truncatedPreview =
          preview.length > 200 ? preview.slice(0, 197) + '…' : preview

        const linkUrl = `/student/courses/${sectionId}?open_message=${message.id}`
        const rows = verifiedMentionIds.map((recipientId) => ({
          recipient_id: recipientId,
          actor_id: user.id,
          kind: 'chat_mention',
          title: `${authorName} mentioned you in #${channel.name}`,
          body: truncatedPreview || null,
          link_url: linkUrl,
          metadata: {
            team_id: channel.team_id,
            channel_id: channelId,
            channel_name: channel.name,
            message_id: message.id,
            section_id: sectionId,
          },
        }))

        const { error: notifErr } = await adminDb.from('app_notifications').insert(rows)
        if (notifErr) {
          logger.warn('sendMessage: notification fanout failed', {
            channelId,
            messageId: message.id,
            error: notifErr.message,
          })
        }
      } catch (notifException) {
        logger.warn('sendMessage: notification fanout exception', {
          channelId,
          messageId: message.id,
          error: notifException instanceof Error ? notifException.message : String(notifException),
        })
      }
    }

    return {
      success: true,
      data: {
        id: message.id,
        mentioned_user_ids: verifiedMentionIds,
        mentioned_phase_ids: verifiedPhaseIds,
        mentioned_doc_ids: verifiedDocIds,
      },
    }
  } catch (error) {
    logger.error('sendMessage', error, { channelId })
    return { error: 'Something went wrong' }
  }
}

/**
 * Soft-delete a team chat message. Author can always retract their own
 * post; team leads can moderate anyone's message within the team. Marks
 * `deleted_at` so bystanders get a tombstone via realtime UPDATE.
 */
export async function deleteMessage(
  messageId: string,
  sectionId: string,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }
    if (!messageId) return { error: 'Missing message id' }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    const { data: message } = await adminDb
      .from('project_chat_messages')
      .select(
        'id, author_id, channel_id, deleted_at, attachment_path, project_chat_channels!inner(team_id)',
      )
      .eq('id', messageId)
      .single()

    if (!message) return { error: 'Message not found' }
    const channel = Array.isArray(message.project_chat_channels)
      ? message.project_chat_channels[0]
      : message.project_chat_channels
    const teamId = channel?.team_id
    if (!teamId) return { error: 'Channel not found' }

    const role = await verifyTeamAccess(adminDb, teamId, user.id)
    if (!role) return { error: 'Not a member of this team' }

    const isAuthor = message.author_id === user.id
    const isLead = role === 'lead'
    if (!isAuthor && !isLead) {
      return { error: 'You can only delete your own messages' }
    }
    if (message.deleted_at) return { success: true }

    // Soft-delete AND scrub the body/attachments: a "deleted" message must
    // not remain recoverable by teammates via the REST payload or realtime
    // broadcast. Keep deleted_at + deleted_by_id for the tombstone + audit.
    const { error } = await adminDb
      .from('project_chat_messages')
      .update({
        deleted_at: new Date().toISOString(),
        deleted_by_id: user.id,
        content: '',
        attachment_url: null,
        attachment_path: null,
        attachment_name: null,
        attachment_size: null,
        attachment_type: null,
      })
      .eq('id', messageId)

    if (error) {
      logger.error('deleteMessage', error, { messageId })
      return { error: 'Failed to delete message' }
    }

    /* The row is redacted above and by the DB trigger; the FILE is not, because Postgres cannot
       reach object storage (#678). `message` is the pre-delete copy — the column is null by now.
       Best-effort: a failure must not fail the delete. */
    await purgeChatAttachment(adminDb, message.attachment_path)

    // Best-effort: clear any chat_mention notifications fanned out for this
    // message so each mentioned recipient's bell + unread count drop in
    // realtime via the existing DELETE subscription. A failure here must not
    // roll back the soft-delete.
    try {
      const { error: notifErr } = await adminDb
        .from('app_notifications')
        .delete()
        .eq('kind', 'chat_mention')
        .filter('metadata->>message_id', 'eq', messageId)
      if (notifErr) {
        logger.warn('deleteMessage: notification cleanup failed', {
          messageId,
          error: notifErr.message,
        })
      }
    } catch (notifException) {
      logger.warn('deleteMessage: notification cleanup exception', {
        messageId,
        error:
          notifException instanceof Error
            ? notifException.message
            : String(notifException),
      })
    }

    logEvent({
      userId: user.id,
      eventType: 'project_chat_message_deleted',
      sectionId,
      metadata: {
        message_id: messageId,
        channel_id: message.channel_id,
        team_id: teamId,
        moderated: !isAuthor,
      },
    })

    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('deleteMessage', error, { messageId })
    return { error: 'Something went wrong' }
  }
}
