/**
 * Professor Discussion Server Actions — course-level channel management
 * and message sending. Team workspaces are owned per-project (see the
 * student team-detail Discussions tab), so there's no course-level
 * workspace toggle any more.
 *
 * Professors and active TAs can manage course-scope channels and send
 * messages; graders are read-only for v1 per the TA access scope.
 */
'use server'

import { revalidatePath } from 'next/cache'
import { checkEntitlementBySection } from '@/lib/entitlements/check'
import { entitlementRefusalMessage } from '@/lib/entitlements/entitled-features'
import { createClient } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import { purgeChatAttachment } from '@/lib/supabase/chat-storage-server'
import { logEvent } from '@/lib/supabase/event-logger'
import {
  createDiscussionChannelSchema,
  renameDiscussionChannelSchema,
  sendDiscussionMessageSchema,
  MAX_COURSE_CHANNELS,
  type CreateDiscussionChannelInput,
  type RenameDiscussionChannelInput,
  type SendDiscussionMessageInput,
} from '@/lib/validations/discussion'
import {
  verifySectionAccess,
  canWriteAsStaff,
} from '@/lib/auth/section-access'

// ── Types ───────────────────────────────────────────────────────

type ActionResult = { success?: boolean; error?: string; data?: unknown }

// ── Helpers ─────────────────────────────────────────────────────

async function getAuthUser() {
  const supabase = await createClient()
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) return null
  return user
}

function sectionPath(sectionId: string) {
  return `/professor/courses/${sectionId}/discussions`
}

// ── Message Actions ─────────────────────────────────────────────

/**
 * Professor or TA sends a message to a course-scope channel only.
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

    const access = await verifySectionAccess(sectionId, user.id)
    if (!access.ok) return { error: 'You do not have access to this section' }
    if (!canWriteAsStaff(access.role)) {
      return { error: 'You do not have permission to perform this action' }
    }
    const { adminDb } = access

    // Verify channel is course-scope and active
    const { data: channel } = await adminDb
      .from('discussion_channels')
      .select('id, section_id, scope, status')
      .eq('id', channelId)
      .single()

    if (!channel) return { error: 'Channel not found' }
    if (channel.section_id !== sectionId) return { error: 'Channel not in this section' }
    if (channel.scope !== 'course') return { error: 'Staff can only message course channels' }
    if (channel.status === 'archived') return { error: 'This channel is archived and read-only' }

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
      logger.error('professor.sendDiscussionMessage', error, { channelId })
      return { error: 'Failed to send message' }
    }

    return { success: true, data: message }
  } catch (error) {
    logger.error('professor.sendDiscussionMessage', error, { channelId })
    return { error: 'Something went wrong' }
  }
}

/**
 * Soft-delete a course discussion message. Authors can always retract
 * their own post; staff (professor / active TA) can moderate anyone's
 * message in a section they own.
 */
export async function deleteDiscussionMessage(
  messageId: string,
  sectionId: string,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }
    if (!messageId) return { error: 'Missing message id' }

    const access = await verifySectionAccess(sectionId, user.id)
    if (!access.ok) return { error: 'You do not have access to this section' }
    const { adminDb } = access

    const { data: message } = await adminDb
      .from('discussion_messages')
      .select('id, author_id, channel_id, deleted_at, attachment_path, discussion_channels!inner(section_id)')
      .eq('id', messageId)
      .single()

    if (!message) return { error: 'Message not found' }
    const channel = Array.isArray(message.discussion_channels)
      ? message.discussion_channels[0]
      : message.discussion_channels
    if (channel?.section_id !== sectionId) {
      return { error: 'Message not in this section' }
    }

    const isAuthor = message.author_id === user.id
    const canModerate = canWriteAsStaff(access.role)
    if (!isAuthor && !canModerate) {
      return { error: 'You can only delete your own messages' }
    }
    if (message.deleted_at) return { success: true }

    const { error } = await adminDb
      .from('discussion_messages')
      .update({ deleted_at: new Date().toISOString(), deleted_by_id: user.id })
      .eq('id', messageId)

    if (error) {
      logger.error('professor.deleteDiscussionMessage', error, { messageId })
      return { error: 'Failed to delete message' }
    }

    /* The row is redacted by the DB trigger; the FILE is not, because Postgres cannot reach
       object storage (#678). `message` is the pre-delete copy — the trigger has already nulled
       the column by now. Best-effort: a failure must not fail the delete. */
    await purgeChatAttachment(adminDb, message.attachment_path)

    logEvent({
      userId: user.id,
      eventType: 'discussion_message_deleted',
      sectionId,
      metadata: {
        message_id: messageId,
        channel_id: message.channel_id,
        moderated: !isAuthor,
      },
    })

    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('professor.deleteDiscussionMessage', error, { messageId })
    return { error: 'Something went wrong' }
  }
}

// ── Course Channel CRUD ─────────────────────────────────────────

/**
 * Create a course-level channel. Max 5 per section.
 */
export async function createCourseChannel(
  sectionId: string,
  input: CreateDiscussionChannelInput,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = createDiscussionChannelSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    const access = await verifySectionAccess(sectionId, user.id)
    if (!access.ok) return { error: 'You do not have access to this section' }
    if (!canWriteAsStaff(access.role)) {
      return { error: 'You do not have permission to perform this action' }
    }
    const { adminDb } = access

    const entitlement = await checkEntitlementBySection(adminDb, sectionId, 'discussions')
    if (!entitlement.allowed) return { error: entitlementRefusalMessage('discussions') }

    // Check count
    const { count } = await adminDb
      .from('discussion_channels')
      .select('id', { count: 'exact', head: true })
      .eq('section_id', sectionId)
      .eq('scope', 'course')

    if ((count ?? 0) >= MAX_COURSE_CHANNELS) {
      return { error: `Maximum ${MAX_COURSE_CHANNELS} course channels allowed` }
    }

    // Check duplicate name
    const { data: duplicate } = await adminDb
      .from('discussion_channels')
      .select('id')
      .eq('section_id', sectionId)
      .eq('scope', 'course')
      .eq('name', parsed.data.name)
      .maybeSingle()

    if (duplicate) return { error: 'A channel with this name already exists' }

    const { data: channel, error } = await adminDb
      .from('discussion_channels')
      .insert({
        section_id: sectionId,
        scope: 'course',
        name: parsed.data.name,
        created_by: user.id,
        position: count ?? 0,
      })
      .select('id, name')
      .single()

    if (error) {
      logger.error('createCourseChannel', error, { sectionId })
      return { error: 'Failed to create channel' }
    }

    logEvent({
      userId: user.id,
      eventType: 'discussion.course_channel_created',
      sectionId,
      metadata: { channelId: channel.id, channelName: parsed.data.name },
    })

    revalidatePath(sectionPath(sectionId))
    return { success: true, data: channel }
  } catch (error) {
    logger.error('createCourseChannel', error, { sectionId })
    return { error: 'Something went wrong' }
  }
}

/**
 * Rename a non-default course channel.
 */
export async function renameCourseChannel(
  channelId: string,
  sectionId: string,
  input: RenameDiscussionChannelInput,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = renameDiscussionChannelSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    const access = await verifySectionAccess(sectionId, user.id)
    if (!access.ok) return { error: 'You do not have access to this section' }
    if (!canWriteAsStaff(access.role)) {
      return { error: 'You do not have permission to perform this action' }
    }
    const { adminDb } = access

    const { data: channel } = await adminDb
      .from('discussion_channels')
      .select('id, section_id, scope, is_default')
      .eq('id', channelId)
      .single()

    if (!channel) return { error: 'Channel not found' }
    // IDOR guard: bind the channel to the verified section — a professor of one
    // section must not be able to rename a channel in another section/tenant by
    // passing a foreign channelId (the admin client bypasses RLS).
    if (channel.section_id !== sectionId) return { error: 'Channel not found' }
    if (channel.scope !== 'course') return { error: 'Can only rename course channels' }
    if (channel.is_default) return { error: 'Cannot rename the default channel' }

    // Check duplicate name
    const { data: duplicate } = await adminDb
      .from('discussion_channels')
      .select('id')
      .eq('section_id', sectionId)
      .eq('scope', 'course')
      .eq('name', parsed.data.name)
      .neq('id', channelId)
      .maybeSingle()

    if (duplicate) return { error: 'A channel with this name already exists' }

    const { error } = await adminDb
      .from('discussion_channels')
      .update({ name: parsed.data.name, updated_at: new Date().toISOString() })
      .eq('id', channelId)

    if (error) {
      logger.error('renameCourseChannel', error, { channelId })
      return { error: 'Failed to rename channel' }
    }

    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('renameCourseChannel', error, { channelId })
    return { error: 'Something went wrong' }
  }
}

/**
 * Delete a non-default course channel and all its messages.
 */
export async function deleteCourseChannel(
  channelId: string,
  sectionId: string,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const access = await verifySectionAccess(sectionId, user.id)
    if (!access.ok) return { error: 'You do not have access to this section' }
    if (!canWriteAsStaff(access.role)) {
      return { error: 'You do not have permission to perform this action' }
    }
    const { adminDb } = access

    const { data: channel } = await adminDb
      .from('discussion_channels')
      .select('id, section_id, scope, is_default, name')
      .eq('id', channelId)
      .single()

    if (!channel) return { error: 'Channel not found' }
    // IDOR guard: bind the channel to the verified section before deleting — a
    // professor must not be able to delete a channel (and cascade its messages)
    // in another section/tenant by passing a foreign channelId.
    if (channel.section_id !== sectionId) return { error: 'Channel not found' }
    if (channel.scope !== 'course') return { error: 'Can only delete course channels' }
    if (channel.is_default) return { error: 'Cannot delete the default channel' }

    const { error } = await adminDb
      .from('discussion_channels')
      .delete()
      .eq('id', channelId)

    if (error) {
      logger.error('deleteCourseChannel', error, { channelId })
      return { error: 'Failed to delete channel' }
    }

    logEvent({
      userId: user.id,
      eventType: 'discussion.course_channel_deleted',
      sectionId,
      metadata: { channelId, channelName: channel.name },
    })

    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('deleteCourseChannel', error, { channelId })
    return { error: 'Something went wrong' }
  }
}

