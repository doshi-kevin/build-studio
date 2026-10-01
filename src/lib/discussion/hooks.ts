/**
 * Discussion Realtime Hooks — live channel and message subscriptions for
 * course-level discussions. Follows the same pattern as project chat hooks
 * but queries discussion_channels and discussion_messages tables.
 */
'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useRealtimeSubscription } from '@/lib/supabase/realtime'
import { createClient } from '@/lib/supabase/client'
import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js'
import type { ChatMessageData, MessageAuthor } from '@/components/shared/chat/MessageBubble'

// ── Types ────────────────────────────────────────────────────────

export interface DiscussionChannel {
  id: string
  section_id: string
  team_id: string | null
  scope: 'course' | 'team'
  name: string
  created_by: string
  is_default: boolean
  status: 'active' | 'archived'
  position: number
  created_at: string
  updated_at: string
}

// Re-export shared types for convenience
export type { ChatMessageData as DiscussionMessage, MessageAuthor }

// ── useDiscussionChannels ───────────────────────────────────────

/**
 * Fetch and subscribe to discussion channels.
 * For scope=course: all course-level channels for this section.
 * For scope=team: channels for a specific team workspace.
 */
export function useDiscussionChannels(
  sectionId: string,
  scope: 'course' | 'team',
  teamId?: string,
) {
  const [channels, setChannels] = useState<DiscussionChannel[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // Skip fetching team channels if no teamId provided
    if (scope === 'team' && !teamId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setChannels([])
      setLoading(false)
      return
    }

    const supabase = createClient()
    const fetchChannels = async () => {
      let query = supabase
        .from('discussion_channels')
        .select('*')
        .eq('section_id', sectionId)
        .eq('scope', scope)
        .order('position', { ascending: true })
        .order('created_at', { ascending: true })

      if (scope === 'team' && teamId) {
        query = query.eq('team_id', teamId)
      }

      const { data } = await query
      if (data) setChannels(data as unknown as DiscussionChannel[])
      setLoading(false)
    }
    fetchChannels()
  }, [sectionId, scope, teamId])

  // Build realtime filter based on scope
  const filter = scope === 'team' && teamId
    ? `team_id=eq.${teamId}`
    : `section_id=eq.${sectionId}`

  useRealtimeSubscription(
    { table: 'discussion_channels', filter },
    useCallback((payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => {
      if (payload.eventType === 'INSERT') {
        const newChannel = payload.new as unknown as DiscussionChannel
        // Only add if it matches our scope
        if (newChannel.scope !== scope) return
        if (scope === 'team' && newChannel.team_id !== teamId) return
        setChannels((prev) => {
          if (prev.some((c) => c.id === newChannel.id)) return prev
          return [...prev, newChannel]
        })
      } else if (payload.eventType === 'UPDATE') {
        const updated = payload.new as unknown as DiscussionChannel
        setChannels((prev) =>
          prev.map((c) => (c.id === updated.id ? { ...c, ...updated } : c))
        )
      } else if (payload.eventType === 'DELETE') {
        const deleted = payload.old as Partial<DiscussionChannel>
        setChannels((prev) => prev.filter((c) => c.id !== deleted.id))
      }
    }, [scope, teamId])
  )

  return { channels, loading }
}

// ── useDiscussionMessages ───────────────────────────────────────

const MESSAGES_PER_PAGE = 50

/**
 * Hook for discussion messages with realtime updates. Same pattern as
 * useChannelMessages but queries discussion_messages table.
 */
/* Belt only. #678 is closed in the DATABASE, and this is no longer the guarantee.
 *
 * A BEFORE UPDATE trigger snapshots a soft-deleted row into the `audit` schema and blanks `content`
 * plus every attachment column, so the text is not in the table for anyone to read. That matters
 * because these reads are CLIENT-side: `select('*')` used to ship the original words of every
 * moderated message, and an interim view could not fix it, since `authenticated` still holds SELECT
 * on the table and PostgREST exposes every relation a role can read.
 *
 * Verified on production: the attack that defeated the view now returns an empty string, all 34
 * pre-existing deleted rows are archived with their 13,127 characters intact, and the `audit`
 * schema is not exposed over PostgREST at all.
 *
 * Because the trigger runs BEFORE the write, the realtime frame for a soft-delete already carries
 * the blanked row, which closes the one path no view could cover.
 *
 * Kept because it costs nothing and it is honest about ordering: if the trigger were ever dropped,
 * this at least stops OUR client rendering text it should not have. It is not a substitute.
 */
function redactIfDeleted<T extends { deleted_at?: string | null; content?: string | null }>(m: T): T {
  return m.deleted_at ? { ...m, content: '' } : m
}

export function useDiscussionMessages(
  channelId: string | null,
  currentUserProfile?: MessageAuthor,
) {
  const [messages, setMessages] = useState<ChatMessageData[]>([])
  const [loading, setLoading] = useState(true)
  const [hasMore, setHasMore] = useState(false)

  const profileCacheRef = useRef<Map<string, MessageAuthor>>(new Map())

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
        .from('discussion_messages')
        .select('*, author:profiles!discussion_messages_author_id_fkey(id, name, email, avatar_url)')
        .eq('channel_id', channelId)
        .order('created_at', { ascending: false })
        .limit(MESSAGES_PER_PAGE)

      if (data) {
        const msgs = (data as unknown as ChatMessageData[]).map(redactIfDeleted).reverse()
        for (const msg of msgs) {
          if (msg.author) {
            profileCacheRef.current.set(msg.author_id, msg.author as MessageAuthor)
          }
        }
        setMessages(msgs)
        setHasMore(data.length === MESSAGES_PER_PAGE)
      }
      setLoading(false)
    }
    fetchMessages()
  }, [channelId])

  // Realtime subscription
  useRealtimeSubscription(
    { table: 'discussion_messages', filter: channelId ? `channel_id=eq.${channelId}` : undefined },
    useCallback((payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => {
      if (payload.eventType === 'INSERT') {
        const raw = payload.new as unknown as ChatMessageData

        const cachedProfile = profileCacheRef.current.get(raw.author_id)
        if (cachedProfile) {
          raw.author = cachedProfile
        }

        setMessages((prev) => {
          if (prev.some((m) => m.id === raw.id)) return prev
          // Replace optimistic message
          const optimisticIdx = prev.findIndex(
            (m) => m.id.startsWith('optimistic-') && m.author_id === raw.author_id
          )
          if (optimisticIdx >= 0) {
            const next = [...prev]
            next[optimisticIdx] = raw
            return next
          }
          return [...prev, raw]
        })

        // Fetch missing profiles
        if (!cachedProfile) {
          const supabase = createClient()
          supabase
            .from('profiles')
            .select('id, name, email, avatar_url')
            .eq('id', raw.author_id)
            .single()
            .then(({ data: profile }) => {
              if (profile) {
                const authorProfile = profile as unknown as MessageAuthor
                profileCacheRef.current.set(raw.author_id, authorProfile)
                setMessages((prev) =>
                  prev.map((m) => m.id === raw.id ? { ...m, author: authorProfile } : m)
                )
              }
            })
        }
      } else if (payload.eventType === 'UPDATE') {
        // Soft-delete flows through as an UPDATE with deleted_at set.
        const raw = payload.new as unknown as ChatMessageData
        setMessages((prev) =>
          prev.map((m) =>
            m.id === raw.id
              ? {
                  ...m,
                  deleted_at: raw.deleted_at ?? null,
                  deleted_by_id: raw.deleted_by_id ?? null,
                  /* Drop the text we already hold once it is deleted (#678). This handler
                     never copied content from the payload, so the live path was safe —
                     but the message ALREADY in state still carries the original words
                     until a reload, and the tombstone should not be holding them. */
                  ...(raw.deleted_at ? { content: '' } : {}),
                }
              : m,
          ),
        )
      }
    }, [])
  )

  const addOptimisticMessage = useCallback((msg: ChatMessageData) => {
    if (msg.author) {
      profileCacheRef.current.set(msg.author_id, msg.author as MessageAuthor)
    }
    setMessages((prev) => [...prev, msg])
  }, [])

  /* Roll an optimistic message back when the send is REJECTED (#677). Confirmed on three
     rejection paths — over-length, archived channel, and the same under concurrency —
     where nothing was persisted but the bubble stayed on screen looking sent. */
  const removeOptimisticMessage = useCallback((messageId: string) => {
    setMessages((prev) => prev.filter((m) => m.id !== messageId))
  }, [])

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

  const loadMore = useCallback(async () => {
    if (!channelId || messages.length === 0) return

    const supabase = createClient()
    const oldest = messages[0]
    const { data } = await supabase
      .from('discussion_messages')
      .select('*, author:profiles!discussion_messages_author_id_fkey(id, name, email, avatar_url)')
      .eq('channel_id', channelId)
      .lt('created_at', oldest.created_at)
      .order('created_at', { ascending: false })
      .limit(MESSAGES_PER_PAGE)

    if (data) {
      const older = (data as unknown as ChatMessageData[]).reverse()
      for (const msg of older) {
        if (msg.author) profileCacheRef.current.set(msg.author_id, msg.author as MessageAuthor)
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
