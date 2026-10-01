/**
 * Project Chat Realtime Hooks — live channel and message subscriptions.
 *
 * Follows the classroom hooks pattern: initial fetch + useRealtimeSubscription.
 * Realtime payloads don't include joined profile data, so we fetch the author
 * profile on INSERT and merge it into the message before adding to state.
 */
'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useRealtimeSubscription } from '@/lib/supabase/realtime'
import { createClient } from '@/lib/supabase/client'
import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js'

// ── Types ────────────────────────────────────────────────────────

export interface ChatChannel {
  id: string
  team_id: string
  name: string
  created_by: string
  is_default: boolean
  position: number
  created_at: string
  updated_at: string
}

export interface AuthorProfile {
  id: string
  name: string | null
  email: string
  avatar_url: string | null
}

export type MessageKind = 'user' | 'system'

// Canonical names for the small set of lifecycle events we surface
// inline in chat. Kept in sync with
// `project_chat_messages.system_event` (no DB CHECK — extensible).
export type SystemEvent =
  | 'phase_assigned'
  | 'phase_status_changed'
  | 'doc_created'
  | 'member_joined'

// Minimal shape of the structured payload written by
// `emitSystemMessage`. The renderer tolerates missing fields — not
// every event carries every key.
export interface SystemPayload {
  actor_id?: string
  assignee_id?: string
  phase_id?: string
  phase_title?: string
  old_status?: string
  new_status?: string
  doc_id?: string
  doc_title?: string
  member_id?: string
  role?: string
}

export interface ChatMessage {
  id: string
  channel_id: string
  // System messages (`kind='system'`) are authored by the platform,
  // not a user — `author_id` is NULL on those rows.
  author_id: string | null
  content: string
  attachment_url: string | null
  attachment_path: string | null
  attachment_name: string | null
  attachment_size: number | null
  attachment_type: string | null
  // UUIDs of team members the author @-mentioned. Populated by the
  // server after it verifies each id is a team member. Empty array
  // when the message has no mentions.
  mentioned_user_ids: string[]
  // UUIDs of project_phases the author @-mentioned. Populated by the
  // server after it verifies each phase belongs to the channel's team.
  // Empty array when no phase mentions.
  mentioned_phase_ids: string[]
  // UUIDs of project_docs the author @-mentioned. Populated by the
  // server after it verifies each doc belongs to the channel's team.
  // Empty array when no doc mentions.
  mentioned_doc_ids: string[]
  // "user" for normal chat, "system" for inline WhatsApp-style events.
  kind: MessageKind
  system_event: SystemEvent | null
  system_payload: SystemPayload | null
  created_at: string
  // Soft-delete. When `deleted_at` is set, the row is rendered as a
  // tombstone ("This message was deleted") in the UI and the original
  // content/attachment is hidden.
  deleted_at?: string | null
  deleted_by_id?: string | null
  author?: AuthorProfile
}

// ── useTeamChannels ──────────────────────────────────────────────

async function fetchTeamChannelRows(teamId: string): Promise<ChatChannel[]> {
  const supabase = createClient()
  const { data } = await supabase
    .from('project_chat_channels')
    .select('*')
    .eq('team_id', teamId)
    .order('position', { ascending: true })
    .order('created_at', { ascending: true })
  return (data as unknown as ChatChannel[]) ?? []
}

export function useTeamChannels(teamId: string) {
  const [channels, setChannels] = useState<ChatChannel[]>([])
  const [loading, setLoading] = useState(true)

  // Exposed so callers can re-fetch after creating the default channel,
  // rather than depending solely on the realtime INSERT echo (which can be
  // delayed or fail on a flaky realtime connection → the tab would hang on
  // "Setting up…").
  const refetch = useCallback(async () => {
    const rows = await fetchTeamChannelRows(teamId)
    setChannels(rows)
    setLoading(false)
  }, [teamId])

  useEffect(() => {
    let active = true
    fetchTeamChannelRows(teamId).then((rows) => {
      if (!active) return
      setChannels(rows)
      setLoading(false)
    })
    return () => {
      active = false
    }
  }, [teamId])

  useRealtimeSubscription(
    { table: 'project_chat_channels', filter: `team_id=eq.${teamId}` },
    useCallback((payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => {
      if (payload.eventType === 'INSERT') {
        const newChannel = payload.new as unknown as ChatChannel
        setChannels((prev) => {
          if (prev.some((c) => c.id === newChannel.id)) return prev
          return [...prev, newChannel]
        })
      } else if (payload.eventType === 'UPDATE') {
        const updated = payload.new as unknown as ChatChannel
        setChannels((prev) =>
          prev.map((c) => (c.id === updated.id ? { ...c, ...updated } : c))
        )
      } else if (payload.eventType === 'DELETE') {
        const deleted = payload.old as Partial<ChatChannel>
        setChannels((prev) => prev.filter((c) => c.id !== deleted.id))
      }
    }, [])
  )

  return { channels, loading, refetch }
}

// ── useChannelMessages ───────────────────────────────────────────

const MESSAGES_PER_PAGE = 50

/**
 * Hook for channel messages with realtime updates.
 *
 * Accepts currentUserProfile so we can:
 * 1. Optimistically add messages with author info before server confirms
 * 2. Enrich realtime payloads (which lack joined profile data) with cached profiles
 */
export function useChannelMessages(channelId: string | null, currentUserProfile?: AuthorProfile) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [hasMore, setHasMore] = useState(false)

  // Cache author profiles we've seen to enrich realtime payloads
  const profileCacheRef = useRef<Map<string, AuthorProfile>>(new Map())

  // Seed cache with current user
  useEffect(() => {
    if (currentUserProfile) {
      profileCacheRef.current.set(currentUserProfile.id, currentUserProfile)
    }
  }, [currentUserProfile])

  // Reset when channel changes
  useEffect(() => {
    if (!channelId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMessages([])
      setLoading(false)
      return
    }

    setLoading(true)
    const supabase = createClient()
    const fetchMessages = async () => {
      const { data } = await supabase
        .from('project_chat_messages')
        .select('*, author:profiles!project_chat_messages_author_id_fkey(id, name, email, avatar_url)')
        .eq('channel_id', channelId)
        .order('created_at', { ascending: false })
        .limit(MESSAGES_PER_PAGE)

      if (data) {
        const msgs = (data as unknown as ChatMessage[]).reverse()
        // Cache all fetched profiles — system messages have no author,
        // so guard on author_id being non-null.
        for (const msg of msgs) {
          if (msg.author && msg.author_id) {
            profileCacheRef.current.set(msg.author_id, msg.author)
          }
        }
        setMessages(msgs)
        setHasMore(data.length === MESSAGES_PER_PAGE)
      }
      setLoading(false)
    }
    fetchMessages()
  }, [channelId])

  // Realtime — only subscribe when channelId is truthy
  useRealtimeSubscription(
    { table: 'project_chat_messages', filter: channelId ? `channel_id=eq.${channelId}` : undefined },
    useCallback((payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => {
      if (payload.eventType === 'INSERT') {
        const raw = payload.new as unknown as ChatMessage

        // System messages (kind='system') have no author — skip all
        // profile enrichment. The renderer resolves actor/entity
        // references from system_payload via a separate lookup.
        const isSystem = raw.kind === 'system' || raw.author_id == null

        const cachedProfile = !isSystem && raw.author_id
          ? profileCacheRef.current.get(raw.author_id)
          : undefined
        if (cachedProfile) {
          raw.author = cachedProfile
        }

        setMessages((prev) => {
          // Skip if already present (from optimistic add)
          if (prev.some((m) => m.id === raw.id)) return prev
          // Replace optimistic message (matched by author + close timestamp).
          // System messages are never optimistic, so skip that branch.
          if (!isSystem && raw.author_id) {
            const optimisticIdx = prev.findIndex(
              (m) => m.id.startsWith('optimistic-') && m.author_id === raw.author_id,
            )
            if (optimisticIdx >= 0) {
              const next = [...prev]
              next[optimisticIdx] = raw
              return next
            }
          }
          return [...prev, raw]
        })

        // If we didn't have the profile, fetch it and update the message
        if (!isSystem && !cachedProfile && raw.author_id) {
          const supabase = createClient()
          const authorIdForFetch = raw.author_id
          supabase
            .from('profiles')
            .select('id, name, email, avatar_url')
            .eq('id', authorIdForFetch)
            .single()
            .then(({ data: profile }) => {
              if (profile) {
                const authorProfile = profile as unknown as AuthorProfile
                profileCacheRef.current.set(authorIdForFetch, authorProfile)
                setMessages((prev) =>
                  prev.map((m) => m.id === raw.id ? { ...m, author: authorProfile } : m)
                )
              }
            })
        }
      } else if (payload.eventType === 'UPDATE') {
        // Soft-delete lands as an UPDATE with deleted_at set.
        const raw = payload.new as unknown as ChatMessage
        setMessages((prev) =>
          prev.map((m) =>
            m.id === raw.id
              ? {
                  ...m,
                  deleted_at: raw.deleted_at ?? null,
                  deleted_by_id: raw.deleted_by_id ?? null,
                }
              : m,
          ),
        )
      }
    }, [])
  )

  // Optimistically add a message (called from ChatArea before server action)
  const addOptimisticMessage = useCallback((msg: ChatMessage) => {
    if (msg.author && msg.author_id) {
      profileCacheRef.current.set(msg.author_id, msg.author)
    }
    setMessages((prev) => [...prev, msg])
  }, [])

  /* Roll an optimistic message back when the send is REJECTED (#677, #681). Without
     this there was no way to un-add one, so all four chat surfaces left the bubble on
     screen with a timestamp, looking sent, until the next page load — and on the
     over-length DM path there was no toast either, so the user had no reason to doubt it.
     Verified in the reports that nothing was persisted: the row never existed. */
  const removeOptimisticMessage = useCallback((messageId: string) => {
    setMessages((prev) => prev.filter((m) => m.id !== messageId))
  }, [])

  // Optimistically mark a message as deleted; realtime UPDATE will
  // confirm with the canonical timestamp once the server write lands.
  const markMessageDeleted = useCallback(
    (messageId: string, deletedById: string) => {
      const deletedAt = new Date().toISOString()
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? { ...m, deleted_at: deletedAt, deleted_by_id: deletedById }
            : m,
        ),
      )
    },
    [],
  )

  // Load older messages
  const loadMore = useCallback(async () => {
    if (!channelId || messages.length === 0) return

    const supabase = createClient()
    const oldest = messages[0]
    const { data } = await supabase
      .from('project_chat_messages')
      .select('*, author:profiles!project_chat_messages_author_id_fkey(id, name, email, avatar_url)')
      .eq('channel_id', channelId)
      .lt('created_at', oldest.created_at)
      .order('created_at', { ascending: false })
      .limit(MESSAGES_PER_PAGE)

    if (data) {
      const older = (data as unknown as ChatMessage[]).reverse()
      for (const msg of older) {
        if (msg.author && msg.author_id) {
          profileCacheRef.current.set(msg.author_id, msg.author)
        }
      }
      setMessages((prev) => [...older, ...prev])
      setHasMore(data.length === MESSAGES_PER_PAGE)
    }
  }, [channelId, messages])

  return {
    messages,
    loading,
    hasMore,
    loadMore,
    addOptimisticMessage,
    removeOptimisticMessage,
    markMessageDeleted,
  }
}
