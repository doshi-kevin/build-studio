/**
 * Chat System Messages — helper for emitting WhatsApp-style inline
 * system events into a team's default chat channel.
 *
 * System messages are rows in project_chat_messages with
 * kind='system', author_id=NULL, content='', and structured data in
 * system_event + system_payload. Server actions call emitSystemMessage
 * inline at the end of mutating actions (fire-and-forget — a failure
 * to post a system message must NOT fail the underlying action).
 *
 * The one lifecycle event we do NOT emit here is "member joined" —
 * that's handled by a Postgres trigger on project_members INSERT so
 * it fires regardless of which code path adds the member (invite
 * accept, admin add, etc.).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'

export type SystemEvent =
  | 'phase_assigned'
  | 'phase_status_changed'
  | 'doc_created'
  | 'member_joined'

export interface SystemPayload {
  actor_id?: string
  // Phase events
  phase_id?: string
  phase_title?: string
  assignee_id?: string
  // Phase status
  old_status?: string
  new_status?: string
  // Doc events
  doc_id?: string
  doc_title?: string
  // Member joined (written by trigger; shape mirrors this)
  member_id?: string
  role?: string
  team_id?: string
}

/**
 * Look up the team's default (#general) channel id. Returns null if
 * the team has no default channel yet — in that rare case we silently
 * skip the emission (chat system messages are ambient context, not
 * load-bearing).
 */
async function getDefaultChannelId(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminDb: SupabaseClient<any> | any,
  teamId: string,
): Promise<string | null> {
  const { data, error } = await adminDb
    .from('project_chat_channels')
    .select('id')
    .eq('team_id', teamId)
    .eq('is_default', true)
    .maybeSingle()

  if (error) {
    logger.warn('system-messages: default channel lookup failed', {
      teamId,
      error: error.message,
    })
    return null
  }
  return (data?.id as string | undefined) ?? null
}

/**
 * Emit a system message into the given team's default chat channel.
 *
 * Best-effort: logs a warning on failure but does not throw — callers
 * should not treat system-message emission as a critical path.
 */
export async function emitSystemMessage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminDb: SupabaseClient<any> | any,
  teamId: string,
  event: SystemEvent,
  payload: SystemPayload,
): Promise<void> {
  try {
    const channelId = await getDefaultChannelId(adminDb, teamId)
    if (!channelId) return

    const { error } = await adminDb.from('project_chat_messages').insert({
      channel_id: channelId,
      author_id: null,
      content: '',
      kind: 'system',
      system_event: event,
      system_payload: payload,
    })

    if (error) {
      logger.warn('emitSystemMessage: insert failed', {
        teamId,
        event,
        error: error.message,
      })
    }
  } catch (error) {
    logger.warn('emitSystemMessage: unexpected exception', {
      teamId,
      event,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
