/**
 * Student Discussion Server Actions — send messages into a course-scope
 * channel on a section the student is enrolled in.
 *
 * Team-scope channels are managed through the per-project Discussions
 * tab's own server actions; this module only speaks to course channels.
 *
 * Auth flow: getAuthUser → verifyEnrollment → channel-scope check → DB op
 */
'use server'

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import { purgeChatAttachment } from '@/lib/supabase/chat-storage-server'
import {
  sendDiscussionMessageSchema,
  type SendDiscussionMessageInput,
} from '@/lib/validations/discussion'

type ActionResult = { success?: boolean; error?: string; data?: unknown }

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

/**
 * Send a message to a discussion channel. Works for both course and team
 * scope — team-scope writes are kept here (rather than split into a
 * team-only module) because the one shared `discussion_messages` table
 * still backs both, and the authorization boundary is the same code path.
 */
export async function sendDiscussionMessage(
  channelId: string,
  sectionId: string,
  input: SendDiscussionMessageInput,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = sendDiscussionMessageSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    const { data: channel } = await adminDb
      .from('discussion_channels')
      .select('id, section_id, team_id, scope, status')
      .eq('id', channelId)
      .single()

    if (!channel) return { error: 'Channel not found' }
    if (channel.section_id !== sectionId) return { error: 'Channel not in this section' }
    if (channel.status === 'archived') return { error: 'This channel is archived and read-only' }

    if (channel.scope === 'team') {
      const role = await verifyTeamAccess(adminDb, channel.team_id, user.id)
      if (!role) return { error: 'Not a member of this team' }
    }

    const { data: message, error } = await adminDb
      .from('discussion_messages')
      .insert({
        channel_id: channelId,
        author_id: user.id,
        content: parsed.data.content || '',
        attachment_url: parsed.data.attachment_url || null,
        attachment_path: parsed.data.attachment_path || null,
        attachment_name: parsed.data.attachment_name || null,
        attachment_size: parsed.data.attachment_size || null,
        attachment_type: parsed.data.attachment_type || null,
      })
      .select('id')
      .single()

    if (error) {
      logger.error('sendDiscussionMessage', error, { channelId })
      return { error: 'Failed to send message' }
    }

    return { success: true, data: message }
  } catch (error) {
    logger.error('sendDiscussionMessage', error, { channelId })
    return { error: 'Something went wrong' }
  }
}

/**
 * Soft-delete a discussion message the student wrote. Students can only
 * retract their own posts — moderation (deleting someone else's message)
 * is handled by the professor-side action.
 */
export async function deleteDiscussionMessage(
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
      .from('discussion_messages')
      .select(
        'id, author_id, channel_id, deleted_at, attachment_path, discussion_channels!inner(section_id, team_id, scope)',
      )
      .eq('id', messageId)
      .single()

    if (!message) return { error: 'Message not found' }
    const channel = Array.isArray(message.discussion_channels)
      ? message.discussion_channels[0]
      : message.discussion_channels
    if (channel?.section_id !== sectionId) {
      return { error: 'Message not in this section' }
    }
    if (message.author_id !== user.id) {
      return { error: 'You can only delete your own messages' }
    }
    if (message.deleted_at) return { success: true }

    if (channel?.scope === 'team') {
      const role = await verifyTeamAccess(adminDb, channel.team_id, user.id)
      if (!role) return { error: 'Not a member of this team' }
    }

    const { error } = await adminDb
      .from('discussion_messages')
      .update({ deleted_at: new Date().toISOString(), deleted_by_id: user.id })
      .eq('id', messageId)

    if (error) {
      logger.error('student.deleteDiscussionMessage', error, { messageId })
      return { error: 'Failed to delete message' }
    }

    /* The row is redacted by the DB trigger; the FILE is not, because Postgres cannot reach
       object storage (#678). `message` is the pre-delete copy — the trigger has already nulled
       the column by now. Best-effort: a failure must not fail the delete. */
    await purgeChatAttachment(adminDb, message.attachment_path)

    return { success: true }
  } catch (error) {
    logger.error('student.deleteDiscussionMessage', error, { messageId })
    return { error: 'Something went wrong' }
  }
}
