// Shared server actions for toggling message reactions across both
// discussion_messages and project_chat_messages tables. Auth-gated:
// the caller must be a participant of the channel the message belongs to.
'use server'

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { verifySectionAccess } from '@/lib/auth/section-access'
import { logger } from '@/lib/logger'

type ActionResult = { success?: boolean; error?: string }

async function getAuthUser() {
  const supabase = await createClient()
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) return null
  return user
}

/** Helper: resolve an embedded single relation that PostgREST may return as
 *  either an object or a one-element array. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveJoin(val: any) {
  return Array.isArray(val) ? val[0] : val
}

/**
 * Toggle a reaction on a discussion message. Adds if not present,
 * removes if the caller already reacted with this emoji.
 */
export async function toggleDiscussionReaction(
  messageId: string,
  emoji: string,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }
    if (!messageId || !emoji) return { error: 'Missing input' }
    if (emoji.length > 16) return { error: 'Invalid emoji' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    const { data: message } = await adminDb
      .from('discussion_messages')
      .select('id, channel_id, discussion_channels!inner(scope, section_id, team_id)')
      .eq('id', messageId)
      .is('deleted_at', null)
      .maybeSingle()

    if (!message) return { error: 'Message not found' }

    // Authorize against the channel scope, mirroring the discussion_messages
    // read policy / sendDiscussionMessage: a course channel requires section
    // enrollment OR professor/staff; a private team channel requires team
    // membership (and deliberately excludes the professor). Without this any
    // authenticated user could react on any message in any tenant.
    const channel = resolveJoin(message.discussion_channels) as
      | { scope?: string; section_id?: string; team_id?: string }
      | undefined
    if (!channel) return { error: 'Message not found' }

    let authorized = false
    if (channel.scope === 'team') {
      const { data: member } = await adminDb
        .from('project_members')
        .select('id')
        .eq('team_id', channel.team_id)
        .eq('user_id', user.id)
        .maybeSingle()
      authorized = !!member
    } else if (channel.section_id) {
      const { data: enrollment } = await adminDb
        .from('enrollments')
        .select('id')
        .eq('section_id', channel.section_id)
        .eq('student_id', user.id)
        .in('status', ['enrolled', 'completed'])
        .maybeSingle()
      authorized = !!enrollment
      if (!authorized) {
        const access = await verifySectionAccess(channel.section_id, user.id)
        authorized = access.ok
      }
    }
    if (!authorized) return { error: 'Message not found' }

    // Enforce one reaction per user per message: any prior reaction
    // by this user gets cleared first. Same emoji = toggle off; new
    // emoji = replace.
    const { data: prior } = await adminDb
      .from('discussion_message_reactions')
      .select('id, emoji')
      .eq('message_id', messageId)
      .eq('user_id', user.id)

    const sameEmoji = (prior ?? []).find(
      (r: { emoji: string }) => r.emoji === emoji,
    )

    if (prior && prior.length > 0) {
      await adminDb
        .from('discussion_message_reactions')
        .delete()
        .eq('message_id', messageId)
        .eq('user_id', user.id)
    }

    if (!sameEmoji) {
      const { error } = await adminDb
        .from('discussion_message_reactions')
        .insert({ message_id: messageId, user_id: user.id, emoji })

      if (error) {
        logger.error('toggleDiscussionReaction insert', error, { messageId })
        return { error: 'Failed to add reaction' }
      }
    }

    return { success: true }
  } catch (error) {
    logger.error('toggleDiscussionReaction', error, { messageId })
    return { error: 'Something went wrong' }
  }
}

/**
 * Toggle a reaction on a project chat message.
 */
export async function toggleProjectChatReaction(
  messageId: string,
  emoji: string,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }
    if (!messageId || !emoji) return { error: 'Missing input' }
    if (emoji.length > 16) return { error: 'Invalid emoji' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    const { data: message } = await adminDb
      .from('project_chat_messages')
      .select('id, channel_id, project_chat_channels!inner(team_id)')
      .eq('id', messageId)
      .is('deleted_at', null)
      .maybeSingle()

    if (!message) return { error: 'Message not found' }

    // Authorize: the caller must be a member of the channel's team. Without
    // this, any authenticated user could react on any project-chat message.
    const channelTeamId = resolveJoin(message.project_chat_channels)?.team_id as string | undefined
    if (!channelTeamId) return { error: 'Message not found' }
    const { data: member } = await adminDb
      .from('project_members')
      .select('id')
      .eq('team_id', channelTeamId)
      .eq('user_id', user.id)
      .maybeSingle()
    if (!member) return { error: 'Message not found' }

    // Enforce one reaction per user per message — same logic as the
    // discussion variant above.
    const { data: prior } = await adminDb
      .from('project_chat_message_reactions')
      .select('id, emoji')
      .eq('message_id', messageId)
      .eq('user_id', user.id)

    const sameEmoji = (prior ?? []).find(
      (r: { emoji: string }) => r.emoji === emoji,
    )

    if (prior && prior.length > 0) {
      await adminDb
        .from('project_chat_message_reactions')
        .delete()
        .eq('message_id', messageId)
        .eq('user_id', user.id)
    }

    if (!sameEmoji) {
      const { error } = await adminDb
        .from('project_chat_message_reactions')
        .insert({ message_id: messageId, user_id: user.id, emoji })

      if (error) {
        logger.error('toggleProjectChatReaction insert', error, { messageId })
        return { error: 'Failed to add reaction' }
      }
    }

    return { success: true }
  } catch (error) {
    logger.error('toggleProjectChatReaction', error, { messageId })
    return { error: 'Something went wrong' }
  }
}
